// Score the current seed skill (skill/system.md) on a task set with the gemma4
// target only (no optimizer) — to surface WHERE gemma4 fails on the harder tasks,
// with full per-dimension breakdown + notes. Drives the manual-Claude optimizer.
//   OXY_SO_TASKS=skillopt/tasks-hard.json OXY_MODEL=<gguf> node scripts/score-seed.ts
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runAgent, HttpToolExecutor, createProject } from "../agent/index.ts";
import type { AgentStep } from "../agent/index.ts";
import { LlamaServerEngine } from "../engine/llama-server.ts";
import { scoreProject, type Task } from "../skillopt/score.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const PORT = 5188 + (process.pid % 400);
const BASE = `http://localhost:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reachable() {
  try {
    return (await fetch(`${BASE}/codelab/api/projects`)).ok;
  } catch {
    return false;
  }
}
async function ensureBackend(): Promise<() => void> {
  if (await reachable()) return () => {};
  const c: ChildProcess = spawn(process.execPath, [path.join(REPO, "server", "serve.mjs")], { env: { ...process.env, PORT: String(PORT) }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await reachable()) return () => c.kill();
  }
  c.kill();
  throw new Error("backend did not start");
}

async function main() {
  const tasksPath = path.resolve(REPO, process.env.OXY_SO_TASKS || "skillopt/tasks.json");
  const val: Task[] = JSON.parse(readFileSync(tasksPath, "utf8")).val;
  const skill = readFileSync(path.join(REPO, "skill", "system.md"), "utf8");
  console.log(`[score-seed] ${val.length} tasks from ${path.relative(REPO, tasksPath)} · seed skill ${skill.length} chars\n`);

  const stop = await ensureBackend();
  const engine = new LlamaServerEngine({ modelRef: process.env.OXY_MODEL });
  await engine.ensureReady();
  const executor = new HttpToolExecutor({ baseUrl: BASE });

  const results: Array<{ id: string; score: number }> = [];
  for (const task of val) {
    const steps: AgentStep[] = [];
    const project = await createProject(`seed-${task.id}`, BASE);
    try {
      await runAgent({ task: task.prompt, project, maxIterations: 12, temperature: 0.5, systemOverride: skill }, { engine, executor, onStep: (s) => steps.push(s) });
    } catch (e: any) {
      console.log(`  ${task.id}: build error — ${String(e?.message ?? e).slice(0, 70)}`);
    }
    const finished = steps.at(-1)?.done ?? false;
    const tools = steps.flatMap((s) => s.toolCalls.map((t) => t.name)).join(",");
    const { score, breakdown } = await scoreProject(path.join(REPO, "workspace", "projects", project), task, { finished });
    results.push({ id: task.id, score });
    console.log(`${task.id.padEnd(13)} ${score.toFixed(2)} | done=${finished ? "Y" : "n"} noErr=${breakdown.noErrors ? "Y" : "n"} sel=${breakdown.selectors.toFixed(2)} txt=${breakdown.text.toFixed(2)} func=${breakdown.functional.toFixed(2)}`);
    console.log(`              notes: ${breakdown.notes.join(" · ") || "clean"}`);
    console.log(`              tools: ${tools || "(none)"}\n`);
  }
  const mean = results.reduce((a, r) => a + r.score, 0) / (results.length || 1);
  console.log(`[score-seed] mean ${mean.toFixed(3)} over ${results.length} hard tasks`);

  await engine.dispose().catch(() => {});
  stop();
  process.exit(0);
}
main().catch((e) => {
  console.error("[score-seed] failed:", e?.stack ?? e);
  process.exit(1);
});
