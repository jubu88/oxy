// SkillOpt eval scorer: render a built project and score it against a task's
// checks. The score-combination math is a pure function (unit-tested); the
// rendering/DOM inspection uses Playwright.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface TaskCheck {
  /** CSS selectors that must be present in the rendered DOM */
  selectors?: string[];
  /** text fragments the page must contain (case-insensitive) */
  textIncludes?: string[];
}

export interface Task {
  id: string;
  prompt: string;
  checks?: TaskCheck;
}

export interface ScoreBreakdown {
  hasIndex: boolean;
  finished: boolean; // did the agent call done()
  noErrors: boolean; // rendered with no console/page errors
  selectors: number; // 0..1 fraction of required selectors found
  text: number; // 0..1 fraction of required text found
  bytes: number;
  errors: string[];
  notes: string[]; // human-readable issues, fed to the optimizer
}

const WEIGHTS = { hasIndex: 0.2, finished: 0.1, noErrors: 0.3, selectors: 0.3, text: 0.1 };

/** Pure: combine a breakdown into a 0..1 score. No index.html ⇒ 0. */
export function combineScore(b: ScoreBreakdown): number {
  if (!b.hasIndex) return 0;
  let s = WEIGHTS.hasIndex;
  if (b.finished) s += WEIGHTS.finished;
  if (b.noErrors) s += WEIGHTS.noErrors;
  s += WEIGHTS.selectors * Math.max(0, Math.min(1, b.selectors));
  s += WEIGHTS.text * Math.max(0, Math.min(1, b.text));
  return Math.round(s * 1000) / 1000;
}

/** Render the project's index.html and score it against the task's checks. */
export async function scoreProject(projectDir: string, task: Task, opts: { finished: boolean }): Promise<{ score: number; breakdown: ScoreBreakdown }> {
  const indexPath = path.join(projectDir, "index.html");
  const breakdown: ScoreBreakdown = { hasIndex: false, finished: opts.finished, noErrors: false, selectors: 0, text: 0, bytes: 0, errors: [], notes: [] };
  if (!fs.existsSync(indexPath)) {
    breakdown.notes.push("no index.html was produced");
    return { score: 0, breakdown };
  }
  breakdown.hasIndex = true;
  breakdown.bytes = fs.statSync(indexPath).size;

  const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
  try {
    const page = await browser.newContext().then((c) => c.newPage());
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
    await page.goto(pathToFileURL(indexPath).href, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);
    breakdown.errors = errors.slice(0, 8);
    breakdown.noErrors = errors.length === 0;
    if (!breakdown.noErrors) breakdown.notes.push(`${errors.length} runtime error(s), e.g. ${errors[0]}`);

    const sel = task.checks?.selectors ?? [];
    if (sel.length) {
      const hits: boolean[] = await page.evaluate((sels) => sels.map((s) => !!document.querySelector(s)), sel);
      breakdown.selectors = hits.filter(Boolean).length / sel.length;
      const missing = sel.filter((_, i) => !hits[i]);
      if (missing.length) breakdown.notes.push(`missing required element(s): ${missing.join(", ")}`);
    } else {
      breakdown.selectors = 1;
    }

    const txt = task.checks?.textIncludes ?? [];
    if (txt.length) {
      const hay = (await page.content()).toLowerCase();
      const found = txt.filter((t) => hay.includes(t.toLowerCase()));
      breakdown.text = found.length / txt.length;
      const missing = txt.filter((t) => !hay.includes(t.toLowerCase()));
      if (missing.length) breakdown.notes.push(`missing expected text: ${missing.join(", ")}`);
    } else {
      breakdown.text = 1;
    }
  } finally {
    await browser.close();
  }
  if (!breakdown.finished) breakdown.notes.push("agent did not call done (may be unfinished)");
  return { score: combineScore(breakdown), breakdown };
}
