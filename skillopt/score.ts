// SkillOpt eval scorer: render a built project and score it against a task's
// checks. The score-combination math is a pure function (unit-tested); the
// rendering / DOM inspection / interaction-driving uses Playwright.
//
// The scorer's job is to tell a WORKING app from a dead mockup, so it does not
// just check that elements exist — where a task declares an interaction, it
// drives the page (by role / visible text, never by the agent's CSS classes)
// and asserts a post-condition actually holds (usually: the visible text
// changed). Weights are renormalized per task over only the dimensions the task
// declares, so a static task can't collect free "functional" credit.
import { chromium, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** One thing to do to the page. Driven by accessible role / visible text where
 *  possible so a correct app isn't false-failed for choosing a different class. */
export interface InteractionStep {
  /** click a button/link/tab/etc. whose visible text matches (case-insensitive) */
  clickText?: string;
  /** click by CSS selector (escape hatch when text isn't unique) */
  click?: string;
  /** type a value into the first element matching this selector */
  fill?: { selector: string; value: string };
  /** wait this many ms (e.g. to let a clock tick or a transition settle) */
  waitMs?: number;
}

/** A condition that must hold AFTER the steps run. `selector` omitted ⇒ read the
 *  whole document body's innerText (selector-independent, so it can't be gamed or
 *  biased by class naming). */
export interface PostCondition {
  selector?: string;
  /** innerText must equal this (case-insensitive, trimmed) */
  equals?: string;
  /** innerText must contain this (case-insensitive) */
  contains?: string;
  /** innerText must DIFFER from the snapshot taken before the steps (and be non-empty) */
  changed?: boolean;
  /** human label, surfaced to the optimizer when unmet */
  label?: string;
}

export interface Interaction {
  steps: InteractionStep[];
  expect: PostCondition[];
}

export interface TaskCheck {
  /** CSS selectors that must be present in the rendered DOM */
  selectors?: string[];
  /** text fragments the rendered page (body.innerText) must contain (case-insensitive) */
  textIncludes?: string[];
  /** scripted interactions whose post-conditions verify the app actually works */
  interactions?: Interaction[];
}

export interface Task {
  id: string;
  prompt: string;
  checks?: TaskCheck;
}

export interface ScoreBreakdown {
  hasIndex: boolean; // hard gate: false ⇒ score 0 (no additive credit)
  finished: boolean; // did the agent call done()
  noErrors: boolean; // rendered with no (non-network) console/page errors
  selectors: number; // 0..1 fraction of required selectors found
  text: number; // 0..1 fraction of required text present in body.innerText
  functional: number; // 0..1 fraction of interaction post-conditions met
  /** which dimensions the task actually declared — drives per-task weight renorm */
  active: { selectors: boolean; text: boolean; functional: boolean };
  bytes: number;
  errors: string[];
  notes: string[]; // human-readable issues, fed to the optimizer
}

// functional-first weighting (variant A). hasIndex is a hard gate, not a weight.
const WEIGHTS = { finished: 0.1, noErrors: 0.3, selectors: 0.2, text: 0.1, functional: 0.3 };
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Pure: combine a breakdown into a 0..1 score. No index.html ⇒ 0. Weights are
 *  renormalized over the dimensions this task declares (finished + noErrors are
 *  always live), so a non-interactive task never collects free functional credit. */
export function combineScore(b: ScoreBreakdown): number {
  if (!b.hasIndex) return 0;
  const live: Array<[keyof typeof WEIGHTS, number]> = [
    ["finished", b.finished ? 1 : 0],
    ["noErrors", b.noErrors ? 1 : 0],
  ];
  if (b.active.selectors) live.push(["selectors", clamp01(b.selectors)]);
  if (b.active.text) live.push(["text", clamp01(b.text)]);
  if (b.active.functional) live.push(["functional", clamp01(b.functional)]);
  const totalW = live.reduce((a, [k]) => a + WEIGHTS[k], 0);
  const s = live.reduce((a, [k, v]) => a + WEIGHTS[k] * v, 0) / totalW;
  return Math.round(s * 1000) / 1000;
}

async function readText(page: Page, selector?: string): Promise<string> {
  if (!selector) return ((await page.evaluate(() => document.body?.innerText || "").catch(() => "")) as string) || "";
  return await page.locator(selector).first().innerText({ timeout: 1500 }).catch(() => "");
}

/** Click by accessible role/name first (robust to class choices), fall back to text. */
async function clickByText(page: Page, text: string): Promise<void> {
  for (const role of ["button", "link", "tab", "radio", "menuitem"] as const) {
    const loc = page.getByRole(role, { name: text, exact: false });
    if (await loc.count().catch(() => 0)) {
      await loc.first().click({ timeout: 2500 });
      return;
    }
  }
  await page.getByText(text, { exact: false }).first().click({ timeout: 2500 });
}

function stepLabel(s: InteractionStep): string {
  if (s.clickText) return `click "${s.clickText}"`;
  if (s.click) return `click ${s.click}`;
  if (s.fill) return `fill ${s.fill.selector}="${s.fill.value}"`;
  if (s.waitMs) return `wait ${s.waitMs}ms`;
  return "step";
}

/** Run all interactions; return the fraction of post-conditions met + notes. */
async function runInteractions(page: Page, interactions: Interaction[]): Promise<{ frac: number; notes: string[] }> {
  let met = 0;
  let total = 0;
  const notes: string[] = [];
  for (const it of interactions) {
    // snapshot baselines for any `changed` post-conditions BEFORE the steps run
    const baselines: Record<number, string> = {};
    for (let i = 0; i < it.expect.length; i++) {
      if (it.expect[i].changed) baselines[i] = (await readText(page, it.expect[i].selector)).trim();
    }
    for (const step of it.steps) {
      try {
        if (step.fill) await page.locator(step.fill.selector).first().fill(step.fill.value, { timeout: 2500 });
        else if (step.clickText) await clickByText(page, step.clickText);
        else if (step.click) await page.locator(step.click).first().click({ timeout: 2500 });
        if (step.waitMs) await page.waitForTimeout(step.waitMs);
      } catch {
        notes.push(`interaction step failed: ${stepLabel(step)}`);
      }
    }
    await page.waitForTimeout(150);
    for (let i = 0; i < it.expect.length; i++) {
      total++;
      const pc = it.expect[i];
      let ok = false;
      try {
        const after = (await readText(page, pc.selector)).trim();
        if (pc.changed) ok = after.length > 0 && after !== (baselines[i] ?? "");
        else if (pc.equals != null) ok = after.toLowerCase() === pc.equals.trim().toLowerCase();
        else if (pc.contains != null) ok = after.toLowerCase().includes(pc.contains.toLowerCase());
      } catch {
        /* unmet */
      }
      if (ok) met++;
      else notes.push(`unmet: ${pc.label ?? pc.contains ?? pc.equals ?? (pc.changed ? "value should change" : "?")}`);
    }
  }
  return { frac: total ? met / total : 1, notes };
}

const isNetworkError = (s: string) => /net::ERR|ERR_[A-Z]|Failed to load resource|net::/i.test(s);

/** Render once and inspect. Throws on a transport-level failure so the caller can retry. */
async function renderAndInspect(indexPath: string, task: Task, breakdown: ScoreBreakdown): Promise<void> {
  const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
  try {
    const page = await browser.newContext().then((c) => c.newPage());
    const errors: string[] = [];
    let netErrors = 0;
    page.on("pageerror", (e) => (isNetworkError(e.message) ? netErrors++ : errors.push(`pageerror: ${e.message}`)));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      if (isNetworkError(t)) netErrors++;
      else errors.push(`console: ${t}`);
    });
    await page.goto(pathToFileURL(indexPath).href, { waitUntil: "load", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(700);

    const body = await readText(page);
    if (!body && breakdown.bytes > 40) throw new Error("page rendered empty (transport/race)"); // retryable

    breakdown.errors = errors.slice(0, 8);
    breakdown.noErrors = errors.length === 0;
    if (!breakdown.noErrors) breakdown.notes.push(`${errors.length} runtime error(s), e.g. ${errors[0]}`);
    if (netErrors) breakdown.notes.push(`${netErrors} network/resource load issue(s) ignored (hermetic scoring)`);

    const sel = task.checks?.selectors ?? [];
    if (sel.length) {
      const hits: boolean[] = await page.evaluate((sels) => sels.map((s) => !!document.querySelector(s)), sel);
      breakdown.selectors = hits.filter(Boolean).length / sel.length;
      const missing = sel.filter((_, i) => !hits[i]);
      if (missing.length) breakdown.notes.push(`missing required element(s): ${missing.join(", ")}`);
    }

    const txt = task.checks?.textIncludes ?? [];
    if (txt.length) {
      const hay = body.toLowerCase();
      const found = txt.filter((t) => hay.includes(t.toLowerCase()));
      breakdown.text = found.length / txt.length;
      const missing = txt.filter((t) => !hay.includes(t.toLowerCase()));
      if (missing.length) breakdown.notes.push(`missing visible text: ${missing.join(", ")}`);
    }

    const inter = task.checks?.interactions ?? [];
    if (inter.length) {
      const { frac, notes } = await runInteractions(page, inter);
      breakdown.functional = frac;
      if (frac < 1) breakdown.notes.push(`functional checks ${Math.round(frac * 100)}%: ${notes.slice(0, 4).join("; ")}`);
    }
  } finally {
    await browser.close();
  }
}

/** Render the project's index.html and score it against the task's checks. */
export async function scoreProject(projectDir: string, task: Task, opts: { finished: boolean }): Promise<{ score: number; breakdown: ScoreBreakdown }> {
  const indexPath = path.join(projectDir, "index.html");
  const breakdown: ScoreBreakdown = {
    hasIndex: false,
    finished: opts.finished,
    noErrors: false,
    selectors: 0,
    text: 0,
    functional: 0,
    active: {
      selectors: !!task.checks?.selectors?.length,
      text: !!task.checks?.textIncludes?.length,
      functional: !!task.checks?.interactions?.length,
    },
    bytes: 0,
    errors: [],
    notes: [],
  };
  if (!fs.existsSync(indexPath)) {
    breakdown.notes.push("no index.html was produced");
    return { score: 0, breakdown };
  }
  breakdown.hasIndex = true;
  breakdown.bytes = fs.statSync(indexPath).size;

  // retry the render once on a transport-level failure (mirrors the build retry);
  // a flaky render must not silently zero noErrors / functional.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await renderAndInspect(indexPath, task, breakdown);
      break;
    } catch (e: unknown) {
      if (attempt === 2) breakdown.notes.push(`render failed: ${String((e as Error)?.message ?? e).slice(0, 80)}`);
    }
  }

  if (!breakdown.finished) breakdown.notes.push("agent did not call done (may be unfinished)");
  return { score: combineScore(breakdown), breakdown };
}
