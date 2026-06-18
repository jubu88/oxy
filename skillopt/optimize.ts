// SkillOpt CLI for Oxy — optimizes the agent SYSTEM "skill" against the build
// benchmark and deploys the best to skill/system.md.
//
//   node skillopt/optimize.ts
//   OXY_ENGINE=ollama OXY_MODEL=gemma4:e4b OXY_OPT_MODEL=gpt-oss:120b-cloud \
//     OXY_SO_EPOCHS=2 OXY_SO_MAXITER=10 node skillopt/optimize.ts
//
// Env: OXY_ENGINE/OXY_MODEL (target — runs the builds), OXY_OPT_ENGINE/OXY_OPT_MODEL/
//      OXY_OPT_BASE/OXY_OPT_KEY (optimizer — proposes edits; use a strong model),
//      OXY_SO_EPOCHS, OXY_SO_BATCH, OXY_SO_MAXITER, OXY_BASE (tool backend origin).
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { runAgent, HttpToolExecutor, createProject } from "../agent/index.ts";
import type { AgentStep } from "../agent/index.ts";
import type { Engine } from "../engine/engine.ts";
import { scoreProject, type Task } from "./score.ts";
import { optimizeSkill, type EvalResult, type Rollout } from "./loop.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
// per-process default port so two runs don't fight over (or kill) a shared backend
const DEFAULT_PORT = 5188 + (process.pid % 400);
const BASE = (process.env.OXY_BASE || `http://localhost:${DEFAULT_PORT}`).replace(/\/+$/, "");
const TARGET_ENGINE = process.env.OXY_ENGINE || "ollama";
const TARGET_MODEL = process.env.OXY_MODEL || "gemma4:e4b";
const OPT_ENGINE = process.env.OXY_OPT_ENGINE || "ollama";
const OPT_MODEL = process.env.OXY_OPT_MODEL || TARGET_MODEL;
// NaN-safe env number: keeps an explicit 0 (Number(x)||d would turn 0 into the default)
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const EPOCHS = num(process.env.OXY_SO_EPOCHS, 1); // 0 = baseline only (seed eval, no optimization)
const BATCH = num(process.env.OXY_SO_BATCH, 0); // 0 = whole train set per step
const MAXITER = num(process.env.OXY_SO_MAXITER, 10);
const VAL_REPEATS = num(process.env.OXY_SO_VAL_REPEATS, 3); // median-of-K per val task (gate)
const MARGIN = num(process.env.OXY_SO_MARGIN, 0); // accept only if val beats best by > this noise band
const SKILL_PATH = path.join(REPO, "skill", "system.md");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(m);

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

async function makeEngine(name: string, model: string, baseUrl?: string, apiKey?: string): Promise<Engine> {
  if (name === "openai") {
    const { OpenAICompatEngine } = await import("../engine/openai-compat.ts");
    return new OpenAICompatEngine({ baseUrl, model, apiKey });
  }
  if (name === "llama-server") {
    const { LlamaServerEngine } = await import("../engine/llama-server.ts");
    return new LlamaServerEngine({ modelRef: model });
  }
  const { OllamaEngine } = await import("../engine/ollama.ts");
  return new OllamaEngine({ model });
}

function toolSummary(steps: AgentStep[]): string {
  const parts = steps.flatMap((s) =>
    s.toolCalls.map((t) => {
      const arg = t.args?.path || t.args?.style || t.args?.name || "";
      return arg ? `${t.name}(${arg})` : t.name;
    }),
  );
  return parts.length ? parts.join(" → ") : "(no tool calls)";
}

async function main() {
  const tasksPath = process.env.OXY_SO_TASKS ? path.resolve(REPO, process.env.OXY_SO_TASKS) : path.join(HERE, "tasks.json");
  const tasksFile = JSON.parse(readFileSync(tasksPath, "utf8"));
  let trainTasks: Task[] = tasksFile.train;
  let valTasks: Task[] = tasksFile.val;
  const limit = num(process.env.OXY_SO_LIMIT, 0); // cap tasks for a quick smoke run
  if (limit) {
    trainTasks = trainTasks.slice(0, limit);
    valTasks = valTasks.slice(0, limit);
  }
  const seedSkill = existsSync(SKILL_PATH) ? readFileSync(SKILL_PATH, "utf8") : "";

  log(`\n=== Oxy SkillOpt ===`);
  log(`target: ${TARGET_ENGINE} (${TARGET_MODEL}) · optimizer: ${OPT_ENGINE} (${OPT_MODEL})`);
  log(`train: ${trainTasks.length} · val: ${valTasks.length} · epochs: ${EPOCHS} · maxIter: ${MAXITER} · valRepeats: ${VAL_REPEATS} · margin: ${MARGIN}\n`);

  const stopBackend = await ensureBackend();
  const target = await makeEngine(TARGET_ENGINE, TARGET_MODEL);
  const optimizer = await makeEngine(OPT_ENGINE, OPT_MODEL, process.env.OXY_OPT_BASE, process.env.OXY_OPT_KEY);
  const executor = new HttpToolExecutor({ baseUrl: BASE });
  log(`[skillopt] preparing engines …`);
  await target.ensureReady();
  await optimizer.ensureReady();

  // build ONE project for a task (retry once on a transient transport error like
  // "fetch failed" so a blip doesn't zero the task and poison the signal), then score it.
  const buildOnce = async (skill: string, task: Task) => {
    let project = "";
    let steps: AgentStep[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      project = await createProject(`so-${task.id}`, BASE);
      steps = [];
      try {
        await runAgent({ task: task.prompt, project, maxIterations: MAXITER, temperature: 0.6, systemOverride: skill }, { engine: target, executor, onStep: (s) => steps.push(s) });
        break;
      } catch (e: any) {
        log(`      ${task.id}: build error (attempt ${attempt}/2) — ${String(e?.message ?? e).slice(0, 80)}`);
        if (attempt < 2) await sleep(2000);
      }
    }
    const finished = steps.at(-1)?.done ?? false;
    const { score, breakdown } = await scoreProject(path.join(REPO, "workspace", "projects", project), task, { finished });
    return { score, breakdown, steps };
  };

  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const evalSkill = async (skill: string, tasks: Task[], opts?: { repeats?: number }): Promise<EvalResult> => {
    const repeats = Math.max(1, opts?.repeats ?? 1);
    const rollouts: Rollout[] = [];
    const perTask: Array<{ id: string; score: number }> = [];
    for (const task of tasks) {
      const runs = [];
      for (let r = 0; r < repeats; r++) runs.push(await buildOnce(skill, task));
      const scores = runs.map((x) => x.score);
      const med = median(scores);
      // representative run for optimizer signal: the one closest to the median
      const rep = runs.reduce((a, b) => (Math.abs(b.score - med) < Math.abs(a.score - med) ? b : a));
      rollouts.push({ task, score: med, breakdown: rep.breakdown, toolSummary: toolSummary(rep.steps) });
      perTask.push({ id: task.id, score: med });
      const spread = repeats > 1 ? ` (median of ${repeats}: ${scores.map((s) => s.toFixed(2)).join("/")})` : "";
      log(`      ${task.id}: ${med.toFixed(2)}${spread}  ${rep.breakdown.notes.join("; ") || "clean"}`);
    }
    const score = perTask.reduce((a, t) => a + t.score, 0) / (perTask.length || 1);
    return { score, rollouts, perTask };
  };

  const proposeEdit = async (skill: string, rollouts: Rollout[]): Promise<string> => {
    const summary = rollouts
      .map((r) => `- [score ${r.score.toFixed(2)}] ${r.task.prompt}\n    ran: ${r.toolSummary}\n    issues: ${r.breakdown.notes.join("; ") || "none"}`)
      .join("\n");
    const res = await optimizer.generate(
      [
        {
          role: "system",
          content:
            'You optimize the SYSTEM PROMPT (a reusable "skill") that instructs a coding agent which builds small static web apps by calling tools (write_file, edit_file, get_design_system, review_design, done, …). Improve the skill so the agent more reliably produces working, complete, good-looking apps. Output ONLY the full revised skill text — no preamble, no markdown fences, no commentary.',
        },
        {
          role: "user",
          content: `CURRENT SKILL:\n"""\n${skill}\n"""\n\nRECENT BUILD ATTEMPTS WITH THIS SKILL:\n${summary}\n\nPropose ONE focused, minimal improvement to the skill that fixes the most impactful recurring failure above. Keep it compact (under ~450 words), procedural, and GENERAL (do not mention these specific tasks). Output the FULL revised skill.`,
        },
      ],
      [],
      { temperature: 0.4, numCtx: 8192, numPredict: 1400 },
    );
    return (res.content || "")
      .trim()
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/\n?```$/, "")
      .trim();
  };

  const result = await optimizeSkill({
    seedSkill,
    trainTasks,
    valTasks,
    epochs: EPOCHS,
    batchSize: BATCH,
    valRepeats: VAL_REPEATS,
    acceptMargin: MARGIN,
    evalSkill,
    proposeEdit,
    deploy: (skill) => writeFileSync(SKILL_PATH, skill.endsWith("\n") ? skill : skill + "\n", "utf8"),
    onEvent: (e) => {
      if (e.type === "seed") log(`\n[skillopt] seed skill val score: ${e.valScore.toFixed(3)}`);
      else if (e.type === "rollout") log(`\n[skillopt] epoch ${e.epoch} batch ${e.batch} — train rollout score ${e.trainScore.toFixed(3)}; asking optimizer…`);
      else if (e.type === "candidate") log(`[skillopt] candidate val ${e.valScore.toFixed(3)} vs best ${e.bestScore.toFixed(3)} → ${e.accepted ? "ACCEPTED ✅ (deployed)" : "rejected"}`);
    },
  });

  writeFileSync(path.join(REPO, "skillopt", "last-opt.json"), JSON.stringify({ ...result, target: TARGET_MODEL, optimizer: OPT_MODEL }, null, 2));
  log(`\n=== done ===`);
  log(`seed val ${result.seedScore.toFixed(3)} → best val ${result.bestScore.toFixed(3)}  (${result.accepted} edit(s) accepted)`);
  log(result.bestScore > result.seedScore ? `improved skill deployed to skill/system.md` : `no improvement found; skill/system.md unchanged`);

  await (target as { dispose?: () => Promise<void> }).dispose?.().catch(() => {});
  await (optimizer as { dispose?: () => Promise<void> }).dispose?.().catch(() => {});
  stopBackend();
  process.exit(0);
}

main().catch((e) => {
  console.error("[skillopt] failed:", e?.stack ?? e);
  process.exit(1);
});
