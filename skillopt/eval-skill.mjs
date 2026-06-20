// Objectively score ONE skill on the held-out val benchmark (skillopt/tasks.json).
// Builds each val task on the local model with the given skill as the system prompt,
// renders + drives the result with the SkillOpt scorer, and reports per-task + mean.
// Aligned to promote.ts's gate settings (MAXITER, temp, repeats) so results compare.
//
//   node skillopt/eval-skill.mjs                              # A: no skill (built-in baseline)
//   OXY_EVAL_SKILL=skill/system.md       OXY_EVAL_LABEL=current   node skillopt/eval-skill.mjs
//   OXY_EVAL_SKILL=skill/system.candidate.md OXY_EVAL_LABEL=candidate node skillopt/eval-skill.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, HttpToolExecutor, createProject } from "../agent/index.ts";
import { LlamaServerEngine } from "../engine/llama-server.ts";
import { scoreProject } from "./score.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const BASE = process.env.OXY_BASE || "http://localhost:5173";
const REPEATS = Number(process.env.OXY_SO_VAL_REPEATS) || 1;
const MAXITER = Number(process.env.OXY_SO_MAXITER) || 10; // matches promote.ts default
const skillRel = process.env.OXY_EVAL_SKILL || "";
const LABEL = process.env.OXY_EVAL_LABEL || (skillRel ? path.basename(skillRel) : "baseline");
const skill = skillRel ? fs.readFileSync(path.resolve(REPO, skillRel), "utf8") : ""; // "" ⇒ loop's built-in seed

const tasksPath = process.env.OXY_SO_TASKS ? path.resolve(REPO, process.env.OXY_SO_TASKS) : path.join(HERE, "tasks.json");
const valTasks = JSON.parse(fs.readFileSync(tasksPath, "utf8")).val;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// managed engine: boots/reuses :8080 with the default e2b, and reboots+retries if the
// server dies mid-run (the bare HTTP client just failed when the dev server crashed).
const engine = new LlamaServerEngine({ modelRef: process.env.OXY_MODEL || undefined, idleTimeout: true });
const executor = new HttpToolExecutor({ baseUrl: BASE });
await engine.ensureReady();

const buildOnce = async (task) => {
  let project = "";
  let steps = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    project = await createProject(`eval-${LABEL}-${task.id}`, BASE);
    steps = [];
    try {
      await runAgent(
        { task: task.prompt, project, maxIterations: MAXITER, temperature: 0.6, systemOverride: skill, thinking: false, autoCompact: true, recoveryBursts: true },
        { engine, executor, onStep: (s) => steps.push(s) },
      );
      break;
    } catch {
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const finished = steps.at(-1)?.done ?? false;
  const { score, breakdown } = await scoreProject(path.join(REPO, "workspace", "projects", project), task, { finished });
  return { score, finished, iters: steps.length, notes: breakdown.notes.slice(0, 3) };
};

const perTask = [];
for (const task of valTasks) {
  const scores = [];
  const started = Date.now();
  let lastNotes = [];
  let fin = false;
  for (let r = 0; r < REPEATS; r++) {
    const o = await buildOnce(task);
    scores.push(o.score);
    lastNotes = o.notes;
    fin = fin || o.finished;
  }
  const med = median(scores);
  const sec = Math.round((Date.now() - started) / 1000);
  perTask.push({ id: task.id, score: med, scores, finished: fin, sec, notes: lastNotes });
  console.log(`[eval:${LABEL}] ${task.id.padEnd(10)} ${med.toFixed(2)} (${scores.map((s) => s.toFixed(2)).join("/")}) ${sec}s ${lastNotes[0] ? "· " + lastNotes[0] : ""}`);
  fs.writeFileSync(path.join(HERE, `eval-${LABEL}.json`), JSON.stringify({ label: LABEL, skill: skillRel || "(built-in baseline)", repeats: REPEATS, perTask }, null, 2), "utf8");
}
const mean = perTask.reduce((a, t) => a + t.score, 0) / (perTask.length || 1);
fs.writeFileSync(path.join(HERE, `eval-${LABEL}.json`), JSON.stringify({ label: LABEL, skill: skillRel || "(built-in baseline)", repeats: REPEATS, mean, perTask }, null, 2), "utf8");
console.log(`[eval:${LABEL}] ===== MEAN ${mean.toFixed(3)} over ${perTask.length} tasks =====`);
await engine.dispose?.().catch?.(() => {});
