// Gated promote — the "deploy gated" half of continuous improvement. Reads the
// real-build lessons the supervisor journaled (skillopt/journal.jsonl), asks the
// optimizer for ONE skill edit that addresses the recurring failures, and deploys
// it to skill/system.md ONLY if it beats the current skill on the held-out
// benchmark (median-of-K val, margin, no per-task regression). The skill can
// improve from real usage but never silently degrade.
//
//   npm run skillopt:promote
//   OXY_ENGINE=llama-server OXY_MODEL=<gemma4.gguf> OXY_OPT_MODEL=gpt-oss:120b-cloud npm run skillopt:promote
//
// NOTE: the engine/eval setup intentionally mirrors optimize.ts; a shared runner is
// a future refactor (kept separate now to avoid disturbing the offline optimizer).
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { runAgent, HttpToolExecutor, createProject } from "../agent/index.ts";
import type { AgentStep } from "../agent/index.ts";
import type { Engine } from "../engine/engine.ts";
import { scoreProject, type Task } from "./score.ts";
import { journalDigest, markAllConsumed, unconsumedCount } from "./supervisor.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const DEFAULT_PORT = 5188 + (process.pid % 400);
const BASE = (process.env.OXY_BASE || `http://localhost:${DEFAULT_PORT}`).replace(/\/+$/, "");
const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const TARGET_ENGINE = process.env.OXY_ENGINE || "ollama";
const TARGET_MODEL = process.env.OXY_MODEL || "gemma4:e4b";
const OPT_ENGINE = process.env.OXY_OPT_ENGINE || "ollama";
const OPT_MODEL = process.env.OXY_OPT_MODEL || "gpt-oss:120b-cloud";
const MAXITER = num(process.env.OXY_SO_MAXITER, 10);
const VAL_REPEATS = num(process.env.OXY_SO_VAL_REPEATS, 2);
const MARGIN = num(process.env.OXY_SO_MARGIN, 0.03);
const SKILL_PATH = path.join(REPO, "skill", "system.md");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(m);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
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
async function makeEngine(name: string, model: string): Promise<Engine> {
  if (name === "openai") {
    const { OpenAICompatEngine } = await import("../engine/openai-compat.ts");
    return new OpenAICompatEngine({ baseUrl: process.env.OXY_OPT_BASE, model, apiKey: process.env.OXY_OPT_KEY });
  }
  if (name === "llama-server") {
    const { LlamaServerEngine } = await import("../engine/llama-server.ts");
    return new LlamaServerEngine({ modelRef: model });
  }
  const { OllamaEngine } = await import("../engine/ollama.ts");
  return new OllamaEngine({ model });
}

async function main() {
  const fresh = unconsumedCount();
  if (fresh === 0) {
    log("[promote] no new journal lessons — nothing to promote. (run some builds first)");
    process.exit(0);
  }
  const digest = journalDigest();
  const tasksFile = JSON.parse(readFileSync(path.join(HERE, "tasks.json"), "utf8"));
  const valTasks: Task[] = tasksFile.val;
  const seed = existsSync(SKILL_PATH) ? readFileSync(SKILL_PATH, "utf8") : "";

  log(`\n=== Oxy SkillOpt · gated promote ===`);
  log(`target: ${TARGET_ENGINE} (${TARGET_MODEL}) · optimizer: ${OPT_ENGINE} (${OPT_MODEL})`);
  log(`journal: ${fresh} fresh review(s) · val: ${valTasks.length} · repeats: ${VAL_REPEATS} · margin: ${MARGIN}\n${digest}\n`);

  const stop = await ensureBackend();
  const target = await makeEngine(TARGET_ENGINE, TARGET_MODEL);
  const optimizer = await makeEngine(OPT_ENGINE, OPT_MODEL);
  const executor = new HttpToolExecutor({ baseUrl: BASE });
  await target.ensureReady();
  await optimizer.ensureReady();

  const buildOnce = async (skill: string, task: Task) => {
    let project = "";
    let steps: AgentStep[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      project = await createProject(`pr-${task.id}`, BASE);
      steps = [];
      try {
        await runAgent({ task: task.prompt, project, maxIterations: MAXITER, temperature: 0.6, systemOverride: skill }, { engine: target, executor, onStep: (s) => steps.push(s) });
        break;
      } catch (e: any) {
        log(`      ${task.id}: build error (${attempt}/2) — ${String(e?.message ?? e).slice(0, 70)}`);
        if (attempt < 2) await sleep(2000);
      }
    }
    const finished = steps.at(-1)?.done ?? false;
    const { score, breakdown } = await scoreProject(path.join(REPO, "workspace", "projects", project), task, { finished });
    return { score, breakdown };
  };

  const evalSkill = async (skill: string) => {
    const perTask: Array<{ id: string; score: number }> = [];
    for (const task of valTasks) {
      const scores: number[] = [];
      for (let r = 0; r < VAL_REPEATS; r++) scores.push((await buildOnce(skill, task)).score);
      const med = median(scores);
      perTask.push({ id: task.id, score: med });
      log(`      ${task.id}: ${med.toFixed(2)} (${scores.map((s) => s.toFixed(2)).join("/")})`);
    }
    return { score: perTask.reduce((a, t) => a + t.score, 0) / (perTask.length || 1), perTask };
  };

  log(`[promote] scoring current skill on the held-out benchmark…`);
  const base = await evalSkill(seed);
  log(`[promote] current skill val: ${base.score.toFixed(3)}`);

  log(`[promote] asking optimizer for a journal-informed edit…`);
  const res = await optimizer.generate(
    [
      { role: "system", content: 'You optimize the SYSTEM PROMPT (a reusable "skill") for a small coding agent that builds static web apps by calling tools. Output ONLY the full revised skill text — no preamble, no fences, no commentary.' },
      { role: "user", content: `CURRENT SKILL:\n"""\n${seed}\n"""\n\nLESSONS FROM RECENT REAL BUILDS (the small model's actual failures in production):\n${digest}\n\nPropose ONE focused, GENERAL improvement to the skill that fixes the most impactful recurring failure above. Keep it compact (under ~450 words) and procedural. Output the FULL revised skill.` },
    ],
    [],
    { temperature: 0.4, numCtx: 8192, numPredict: 1400 },
  );
  const candidate = (res.content || "").trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();

  let deployed = false;
  if (!candidate || candidate === seed.trim()) {
    log(`[promote] optimizer proposed no change.`);
  } else {
    log(`[promote] scoring the candidate skill…`);
    const cand = await evalSkill(candidate);
    const meanOk = cand.score > base.score + MARGIN;
    const noRegression = cand.perTask.every((ct) => {
      const prev = base.perTask.find((p) => p.id === ct.id);
      return !prev || ct.score >= prev.score - MARGIN;
    });
    log(`[promote] candidate val ${cand.score.toFixed(3)} vs current ${base.score.toFixed(3)} (margin ${MARGIN}) · regression-free: ${noRegression}`);
    if (meanOk && noRegression) {
      writeFileSync(SKILL_PATH, candidate.endsWith("\n") ? candidate : candidate + "\n", "utf8");
      deployed = true;
      log(`[promote] ACCEPTED ✅ — deployed to skill/system.md`);
    } else {
      log(`[promote] rejected — skill/system.md unchanged`);
    }
  }
  // the lessons were considered (accepted or not) — clear them so the next promote
  // works on genuinely new feedback rather than re-proposing the same edit.
  markAllConsumed();

  await (target as { dispose?: () => Promise<void> }).dispose?.().catch(() => {});
  await (optimizer as { dispose?: () => Promise<void> }).dispose?.().catch(() => {});
  stop();
  log(`\n=== promote done — ${deployed ? "skill improved" : "no change"} ===\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[promote] failed:", e?.stack ?? e);
  process.exit(1);
});
