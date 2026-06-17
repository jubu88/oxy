// Headless Oxy build driver — wires an Engine + the jailed backend + the agent
// loop to build one static web app end to end, with zero npm install on the
// Ollama path. It auto-starts the standalone backend if one isn't already
// running, creates a fresh project, runs the loop, and writes last-run.json.
//
//   node driver/run-build.ts
//   OXY_ENGINE=ollama OXY_MODEL=gemma4:e4b OXY_TASK="build a ..." node driver/run-build.ts
//   OXY_ENGINE=node-llama node driver/run-build.ts          # in-process llama.cpp
//
// Env: OXY_ENGINE (ollama|node-llama), OXY_MODEL, OXY_TASK, OXY_MAX_ITER,
//      OXY_TEMP, OXY_BASE (backend origin), OXY_USE_STITCH=1.
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { runAgent } from "../agent/index.ts";
import { HttpToolExecutor, createProject, listProjects } from "../agent/index.ts";
import type { AgentConfig, AgentStep } from "../agent/index.ts";
import type { Engine } from "../engine/engine.ts";
import { OllamaEngine } from "../engine/ollama.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const ENGINE = process.env.OXY_ENGINE || "ollama";
const MODEL = process.env.OXY_MODEL || "gemma4:e4b";
const TASK =
  process.env.OXY_TASK ||
  "Build a polished single-page 'Stillness' meditation timer: a calm hero with a start button, three preset durations (5/10/20 min), and a soft animated breathing circle. Keep it elegant and minimal. Then call done.";
const MAX_ITER = Number(process.env.OXY_MAX_ITER) || 14;
const TEMP = Number(process.env.OXY_TEMP) || 0.6;
const BASE = (process.env.OXY_BASE || "http://localhost:5173").replace(/\/+$/, "");
const USE_STITCH = process.env.OXY_USE_STITCH === "1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function backendReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/codelab/api/projects`);
    return r.ok;
  } catch {
    return false;
  }
}

/** Start the standalone backend if one isn't already up. Returns a stopper. */
async function ensureBackend(): Promise<() => void> {
  if (await backendReachable()) {
    console.log(`[oxy] using existing backend at ${BASE}`);
    return () => {};
  }
  const port = new URL(BASE).port || "5173";
  console.log(`[oxy] starting backend on port ${port} …`);
  const child: ChildProcess = spawn(process.execPath, [path.join(REPO, "server", "serve.mjs")], {
    env: { ...process.env, PORT: port },
    stdio: "inherit",
  });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await backendReachable()) {
      console.log(`[oxy] backend ready`);
      return () => child.kill();
    }
  }
  child.kill();
  throw new Error("backend did not become reachable in time");
}

async function makeEngine(): Promise<Engine> {
  if (ENGINE === "node-llama") {
    const { NodeLlamaEngine } = await import("../engine/node-llama.ts");
    return new NodeLlamaEngine({ modelRef: process.env.OXY_MODEL });
  }
  if (ENGINE === "openai") {
    const { OpenAICompatEngine } = await import("../engine/openai-compat.ts");
    return new OpenAICompatEngine({ baseUrl: process.env.OXY_OPENAI_BASE, model: process.env.OXY_MODEL || MODEL, apiKey: process.env.OXY_OPENAI_KEY });
  }
  return new OllamaEngine({ model: MODEL });
}

function fmtStep(s: AgentStep): string {
  const tools = s.toolCalls.map((t) => `${t.name}${t.args?.path ? `(${t.args.path})` : t.args?.style ? `(${t.args.style})` : ""}`).join(", ") || "—";
  const flags = [s.burst ? "🧠burst" : "", s.compacted ? "♻compact" : "", s.truncated ? "✂trunc" : "", s.done ? "✅done" : ""].filter(Boolean).join(" ");
  return `[iter ${String(s.iteration).padStart(2)}] tools: ${tools} · tok=${s.tokens ?? "?"} ctx=${s.ctxTokens ?? "?"} ${flags}`.trimEnd();
}

async function main() {
  const t0 = Date.now();
  console.log(`\n=== Oxy build ===\nengine: ${ENGINE} · model: ${MODEL} · maxIter: ${MAX_ITER} · stitch: ${USE_STITCH}\ntask: ${TASK}\n`);

  const stopBackend = await ensureBackend();
  let exitCode = 0;
  try {
    const engine = await makeEngine();
    console.log(`[oxy] preparing engine …`);
    await engine.ensureReady();

    const existing = process.env.OXY_PROJECT;
    const iterate = !!existing;
    const project = existing || (await createProject(TASK.slice(0, 40), BASE));
    console.log(`[oxy] project: ${project}${iterate ? " (iterating on existing)" : ""}\n`);

    const executor = new HttpToolExecutor({ baseUrl: BASE });
    const config: AgentConfig = { task: TASK, project, maxIterations: MAX_ITER, temperature: TEMP, useStitch: USE_STITCH, iterate };

    const steps: AgentStep[] = [];
    let lastTokenLog = 0;
    await runAgent(config, {
      engine,
      executor,
      onStep: (s) => {
        steps.push(s);
        console.log(fmtStep(s));
        if (s.thinking) console.log(`        ↳ thinking: ${s.thinking.slice(0, 120).replace(/\s+/g, " ")}…`);
      },
      onProgress: (p) => {
        // heartbeat every ~40 tokens so a long generation doesn't look frozen
        if (p.tokens - lastTokenLog >= 40) {
          lastTokenLog = p.tokens;
          process.stdout.write(`        …generating (${p.tokens} tok)\r`);
        }
      },
    });

    const files = (await listProjects(BASE)).find((p) => p.id === project);
    const durationMs = Date.now() - t0;
    const summary = {
      engine: ENGINE,
      model: MODEL,
      task: TASK,
      project,
      iterations: steps.length,
      compactions: steps.filter((s) => s.compacted).length,
      bursts: steps.filter((s) => s.burst).length,
      toolCalls: steps.flatMap((s) => s.toolCalls.map((t) => t.name)),
      finished: steps.at(-1)?.done ?? false,
      files: files?.files ?? 0,
      hasIndex: files?.hasIndex ?? false,
      durationMs,
    };
    writeFileSync(path.join(REPO, "last-run.json"), JSON.stringify(summary, null, 2));

    console.log(`\n=== done in ${(durationMs / 1000).toFixed(1)}s ===`);
    console.log(`project: ${project} · files: ${summary.files} · hasIndex: ${summary.hasIndex} · finished: ${summary.finished}`);
    console.log(`compactions: ${summary.compactions} · bursts: ${summary.bursts} · iterations: ${summary.iterations}`);
    console.log(`preview: ${BASE}/codelab/preview/${project}/  (run \`npm run dev\` or \`node server/serve.mjs\` to view)`);
    console.log(`summary written to last-run.json`);

    if (!summary.hasIndex) {
      console.error("\n[oxy] WARNING: no index.html was produced");
      exitCode = 2;
    }
  } catch (e: any) {
    console.error(`\n[oxy] build failed: ${String(e?.stack ?? e?.message ?? e)}`);
    exitCode = 1;
  } finally {
    stopBackend();
  }
  process.exit(exitCode);
}

main();
