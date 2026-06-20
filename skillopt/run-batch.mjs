// One-off batch builder: run a list of real build tasks on the LOCAL model (gemma4
// e2b via the warm llama-server on :8080), capturing for each build the tool sequence,
// whether it finished, elapsed time, the files produced, and an index.html snippet —
// WITHOUT journaling. The reviewer (here: Claude, acting as the improvement model)
// then inspects skillopt/batch-results.json and journals lessons via appendJournal.
//
//   node skillopt/run-batch.mjs            # builds the default 7-task ramp
//   OXY_BATCH_TASKS=clock,t2048 node ...   # subset by id
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, HttpToolExecutor, createProject } from "../agent/index.ts";
import { OpenAICompatEngine } from "../engine/openai-compat.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const BASE = process.env.OXY_BASE || "http://localhost:5173"; // dev server's /codelab backend (file tools)
const MODEL_BASE = process.env.OXY_OPENAI_BASE || "http://localhost:8080/v1"; // warm llama-server (e2b)
const MODEL = process.env.OXY_MODEL || "unsloth/gemma-4-E2B-it-GGUF:Q4_K_M";
const SKILL_PATH = path.join(REPO, "skill", "system.md");
const SKILL = fs.existsSync(SKILL_PATH) ? fs.readFileSync(SKILL_PATH, "utf8") : "";
const OUT = path.join(HERE, "batch-results.json");
const MAXITER = Number(process.env.OXY_BATCH_MAXITER) || 14;

const ALL_TASKS = [
  { id: "clock", prompt: "Build a digital clock web app that shows the current time as HH:MM:SS and updates every second, with the current date shown below it. Center it with a clean, modern look." },
  { id: "tip", prompt: "Build a tip calculator: enter the bill amount, pick a tip percentage (buttons for 10/15/20% plus a custom field), and show the tip and the total. Also let me split the total between a number of people." },
  { id: "temp", prompt: "Build a temperature converter between Celsius, Fahrenheit and Kelvin. Three input fields — typing a value in any one updates the other two live." },
  { id: "pomodoro", prompt: "Build a Pomodoro timer: a 25-minute work session and a 5-minute break, with start, pause and reset buttons, a large visual countdown, and a counter of completed sessions." },
  { id: "memory", prompt: "Build a memory card matching game: a 4x4 grid of cards with 8 emoji pairs. Click to flip two cards; if they match they stay face up, otherwise they flip back. Track the number of moves and show a win message when all pairs are matched, plus a restart button." },
  { id: "todo", prompt: "Build a todo list app: add a task, mark it complete, delete it, and filter by All / Active / Completed. Persist the tasks in localStorage so they survive a page refresh." },
  { id: "t2048", prompt: "Build a working 2048 game: a 4x4 grid where the arrow keys slide and merge tiles, a new tile (2 or 4) spawns after each move, the score increases when tiles merge, and a 'Game over' message appears when no moves remain. Include a restart button." },
];

const pick = (process.env.OXY_BATCH_TASKS || "").split(",").map((s) => s.trim()).filter(Boolean);
const TASKS = pick.length ? ALL_TASKS.filter((t) => pick.includes(t.id)) : ALL_TASKS;

const engine = new OpenAICompatEngine({ baseUrl: MODEL_BASE, model: MODEL, idleTimeout: true });
const executor = new HttpToolExecutor({ baseUrl: BASE });
await engine.ensureReady();

const results = [];
for (const t of TASKS) {
  const started = Date.now();
  let project = "";
  let error = "";
  const steps = [];
  try {
    project = await createProject(`batch-${t.id}`, BASE);
    await runAgent(
      { task: t.prompt, project, maxIterations: MAXITER, temperature: 0.6, systemOverride: SKILL, thinking: false, autoCompact: true, recoveryBursts: true },
      { engine, executor, onStep: (s) => steps.push(s) },
    );
  } catch (e) {
    error = String(e?.message ?? e);
  }
  const toolLog = steps.flatMap((s) => (s.toolCalls || []).map((tc) => tc.name));
  const finished = steps.at(-1)?.done ?? false;
  const dir = path.join(REPO, "workspace", "projects", project);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => !f.startsWith(".codelab"));
  } catch {}
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      return "";
    }
  };
  const index = read("index.html");
  // pull in any sibling js/css so the reviewer can judge whether logic was actually wired
  const code = files.filter((f) => /\.(js|css)$/.test(f)).map((f) => `\n/* ${f} */\n${read(f).slice(0, 2500)}`).join("\n");
  results.push({
    id: t.id,
    task: t.prompt,
    project,
    finished,
    error,
    elapsedSec: Math.round((Date.now() - started) / 1000),
    iterations: steps.length,
    toolLog,
    files,
    indexLen: index.length,
    index: index.slice(0, 2600),
    code: code.slice(0, 6000),
  });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2), "utf8"); // incremental
  console.log(`[batch] ${t.id.padEnd(9)} finished=${finished} files=${files.length} iters=${steps.length} tools=${toolLog.length} ${t.elapsedSec || ""}s ${error ? "ERR " + error.slice(0, 70) : ""}`);
}
await engine.dispose?.().catch?.(() => {});
console.log(`[batch] done → ${OUT} (${results.length} builds)`);
