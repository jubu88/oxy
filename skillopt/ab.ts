// Before/after A/B for a tuned skill, on a HELD-OUT app whose interaction class
// (multi-step form with validation/gating) appears in neither train nor val — so
// a win evidences transfer, not memorization of the calculator/counter family.
//
// Each arm builds the SAME prompt N times on the SAME target model / temperature
// / scorer, records the score distribution + interaction pass-rate, and saves a
// Playwright screenshot per build. Screenshots are diagnostics for a human; the
// accept signal is the score + functional-pass deltas, not the pictures.
//
//   OXY_AB_SEED=skill/system.seed.md OXY_AB_OPT=skill/system.md \
//     OXY_AB_N=5 OXY_ENGINE=ollama OXY_MODEL=gemma4:e4b node skillopt/ab.ts
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "playwright";

import { runAgent, HttpToolExecutor, createProject } from "../agent/index.ts";
import type { AgentStep } from "../agent/index.ts";
import type { Engine } from "../engine/engine.ts";
import { scoreProject, type Task } from "./score.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
// per-process default port so two runs don't fight over (or kill) a shared backend
const DEFAULT_PORT = 5188 + (process.pid % 400);
const BASE = (process.env.OXY_BASE || `http://localhost:${DEFAULT_PORT}`).replace(/\/+$/, "");
const ENGINE = process.env.OXY_ENGINE || "ollama";
const MODEL = process.env.OXY_MODEL || "gemma4:e4b";
const N = Math.max(1, Number(process.env.OXY_AB_N) || 5);
const MAXITER = Number(process.env.OXY_AB_MAXITER) || 10;
const SEED_PATH = path.resolve(REPO, process.env.OXY_AB_SEED || "skill/system.seed.md");
const OPT_PATH = path.resolve(REPO, process.env.OXY_AB_OPT || "skill/system.md");
const OUT = path.join(REPO, "skillopt", "ab-report");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(m);

// HELD-OUT probe: gating logic (advance only if a field is filled) — a class the
// benchmark never trains on. The functional check both fills and advances.
const PROBE: Task = {
  id: "signup-2step",
  prompt:
    "Build a 2-step signup form in a single index.html with vanilla JavaScript. Step 1 shows an email text field and a 'Next' button. Clicking 'Next' advances to step 2 (which shows a password field) ONLY if the email field is non-empty; if the email is empty, stay on step 1 and show an error message instead. Then call done.",
  checks: {
    selectors: ["input", "button"],
    textIncludes: ["email", "next"],
    interactions: [
      { steps: [{ fill: { selector: "input", value: "user@example.com" }, }, { clickText: "Next" }], expect: [{ contains: "password", label: "filling email + Next reveals the password step" }] },
    ],
  },
};

async function backendReachable(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/codelab/api/projects`)).ok;
  } catch {
    return false;
  }
}
async function ensureBackend(): Promise<() => void> {
  if (await backendReachable()) return () => {};
  const port = new URL(BASE).port || "5188";
  const child: ChildProcess = spawn(process.execPath, [path.join(REPO, "server", "serve.mjs")], { env: { ...process.env, PORT: port }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await backendReachable()) return () => child.kill();
  }
  child.kill();
  throw new Error("backend did not start");
}
async function makeEngine(): Promise<Engine> {
  if (ENGINE === "openai") {
    const { OpenAICompatEngine } = await import("../engine/openai-compat.ts");
    return new OpenAICompatEngine({ baseUrl: process.env.OXY_BASE_URL, model: MODEL, apiKey: process.env.OXY_API_KEY });
  }
  if (ENGINE === "llama-server") {
    const { LlamaServerEngine } = await import("../engine/llama-server.ts");
    return new LlamaServerEngine({ modelRef: MODEL });
  }
  const { OllamaEngine } = await import("../engine/ollama.ts");
  return new OllamaEngine({ model: MODEL });
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

interface ArmRun {
  score: number;
  functional: number;
  noErrors: boolean;
  finished: boolean;
  notes: string[];
}

async function buildScoreShot(skill: string, engine: Engine, executor: HttpToolExecutor, arm: string, i: number): Promise<ArmRun> {
  const project = await createProject(`ab-${arm}-${i}`, BASE);
  const steps: AgentStep[] = [];
  try {
    await runAgent({ task: PROBE.prompt, project, maxIterations: MAXITER, temperature: 0.6, systemOverride: skill }, { engine, executor, onStep: (s) => steps.push(s) });
  } catch (e: any) {
    log(`    ${arm} #${i}: build error — ${String(e?.message ?? e).slice(0, 70)}`);
  }
  const finished = steps.at(-1)?.done ?? false;
  const projectDir = path.join(REPO, "workspace", "projects", project);
  const { score, breakdown } = await scoreProject(projectDir, PROBE, { finished });

  // diagnostic screenshot (best-effort): initial render + after the interaction
  const indexPath = path.join(projectDir, "index.html");
  if (existsSync(indexPath)) {
    const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
    try {
      const page = await browser.newContext({ viewport: { width: 900, height: 700 } }).then((c) => c.newPage());
      await page.goto(pathToFileURL(indexPath).href, { waitUntil: "load", timeout: 12000 }).catch(() => {});
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, `${arm}-${i}.png`) }).catch(() => {});
      await page.locator("input").first().fill("user@example.com", { timeout: 2000 }).catch(() => {});
      await page.getByRole("button", { name: "Next", exact: false }).first().click({ timeout: 2000 }).catch(() => {});
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, `${arm}-${i}-after.png`) }).catch(() => {});
    } finally {
      await browser.close();
    }
  }
  log(`    ${arm} #${i}: score ${score.toFixed(2)} · func ${breakdown.functional.toFixed(2)} · ${breakdown.noErrors ? "clean" : "errors"} · ${breakdown.notes[0] ?? ""}`);
  return { score, functional: breakdown.functional, noErrors: breakdown.noErrors, finished, notes: breakdown.notes };
}

async function runArm(name: string, skillPath: string, engine: Engine, executor: HttpToolExecutor): Promise<ArmRun[]> {
  const skill = readFileSync(skillPath, "utf8");
  log(`\n[${name}] skill: ${path.relative(REPO, skillPath)} (${skill.length} chars) — ${N} builds`);
  const runs: ArmRun[] = [];
  for (let i = 0; i < N; i++) runs.push(await buildScoreShot(skill, engine, executor, name, i));
  return runs;
}

function summarize(name: string, runs: ArmRun[]) {
  const scores = runs.map((r) => r.score);
  return {
    arm: name,
    meanScore: +mean(scores).toFixed(3),
    scores: scores.map((s) => +s.toFixed(2)),
    functionalPassRate: +(runs.filter((r) => r.functional >= 0.999).length / runs.length).toFixed(2),
    errorRate: +(runs.filter((r) => !r.noErrors).length / runs.length).toFixed(2),
    finishedRate: +(runs.filter((r) => r.finished).length / runs.length).toFixed(2),
  };
}

async function main() {
  if (!existsSync(SEED_PATH)) throw new Error(`seed skill not found: ${SEED_PATH} (copy the pre-optimization skill there first)`);
  if (!existsSync(OPT_PATH)) throw new Error(`optimized skill not found: ${OPT_PATH}`);
  mkdirSync(OUT, { recursive: true });

  log(`\n=== Oxy SkillOpt A/B (held-out: ${PROBE.id}) ===`);
  log(`target: ${ENGINE} (${MODEL}) · N=${N} per arm · maxIter ${MAXITER}`);

  const stop = await ensureBackend();
  const engine = await makeEngine();
  const executor = new HttpToolExecutor({ baseUrl: BASE });
  await engine.ensureReady();

  const before = await runArm("before", SEED_PATH, engine, executor);
  const after = await runArm("after", OPT_PATH, engine, executor);

  const sb = summarize("before (seed)", before);
  const sa = summarize("after (optimized)", after);
  const verdict =
    sa.meanScore > sb.meanScore && sa.functionalPassRate >= sb.functionalPassRate && sa.errorRate <= sb.errorRate + 0.2
      ? "IMPROVED on the held-out probe"
      : sa.meanScore < sb.meanScore
        ? "REGRESSED on the held-out probe"
        : "INCONCLUSIVE (within noise)";

  const report = { probe: PROBE.id, model: MODEL, n: N, before: sb, after: sa, verdict, screenshots: path.relative(REPO, OUT) };
  writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));

  log(`\n=== A/B result ===`);
  log(`before (seed):       mean ${sb.meanScore}  func-pass ${sb.functionalPassRate}  err ${sb.errorRate}  [${sb.scores.join(", ")}]`);
  log(`after  (optimized):  mean ${sa.meanScore}  func-pass ${sa.functionalPassRate}  err ${sa.errorRate}  [${sa.scores.join(", ")}]`);
  log(`verdict: ${verdict}`);
  log(`screenshots + report.json → ${path.relative(REPO, OUT)}\n`);

  await (engine as { dispose?: () => Promise<void> }).dispose?.().catch(() => {});
  stop();
  process.exit(0);
}

main().catch((e) => {
  console.error("[ab] failed:", e?.stack ?? e);
  process.exit(1);
});
