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
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

import { runAgent, HttpToolExecutor, createProject } from "../agent/index.ts";
import type { AgentStep } from "../agent/index.ts";
import type { Engine } from "../engine/engine.ts";
import { scoreProject, type Task } from "./score.ts";
import { journalDigest, markAllConsumed, unconsumedCount } from "./supervisor.ts";
import { modelKey } from "./model-config.mjs";
import { libraryHint } from "../server/reference.mjs";
import { repairModuleScripts, mergeDuplicateClasses, fixAttrCallbacks } from "../server/sanitize.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const DEFAULT_PORT = 5188 + (process.pid % 400);
const BASE = (process.env.OXY_BASE || `http://localhost:${DEFAULT_PORT}`).replace(/\/+$/, "");
const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);
const TARGET_ENGINE = process.env.OXY_ENGINE || "ollama";
const TARGET_MODEL = process.env.OXY_MODEL || "gemma4:e4b";
const OPT_ENGINE = process.env.OXY_OPT_ENGINE || "ollama";
const OPT_MODEL = process.env.OXY_OPT_MODEL || "gpt-oss:120b-cloud";
// "manual": Claude (in-session) or a human writes the candidate skill to
// skill/system.candidate.md; the gemma4 benchmark gate still validates it. The best
// possible optimizer ("you"), using no API key — proposals are never blindly trusted.
const MANUAL = OPT_ENGINE === "manual";
const CANDIDATE_PATH = process.env.OXY_SO_CANDIDATE || path.join(REPO, "skill", "system.candidate.md");
const MAXITER = num(process.env.OXY_SO_MAXITER, 10);
const VAL_REPEATS = num(process.env.OXY_SO_VAL_REPEATS, 2);
const MARGIN = num(process.env.OXY_SO_MARGIN, 0.03);
// PER-MODEL: deploy to skill/<modelKey>.md and learn only from THIS model's journal lessons.
// Seed from the model's own skill if it has one yet, else the shared baseline skill/system.md.
const MODEL_KEY = modelKey(TARGET_MODEL);
const BASELINE_SKILL = path.join(REPO, "skill", "system.md");
const SKILL_PATH = path.join(REPO, "skill", `${MODEL_KEY}.md`);
const SEED_PATH = existsSync(SKILL_PATH) ? SKILL_PATH : BASELINE_SKILL;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(m);

// Heartbeat/timer status the UI reads (the per-task scores + outcome come from the log,
// which the server parses; this file just preserves startedAt + a liveness heartbeat so the
// "running" indicator and timer survive a dev-server restart mid-run). Best-effort.
const STATUS_PATH = path.join(os.homedir(), ".oxy", "auto-promote-status.json");
let _status: Record<string, unknown> = {};
function writeStatus(patch: Record<string, unknown>): void {
  _status = { ..._status, ...patch, heartbeat: Date.now() };
  try {
    mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
    writeFileSync(STATUS_PATH, JSON.stringify(_status), "utf8");
  } catch {
    /* best-effort */
  }
}
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
  const fresh = unconsumedCount(MODEL_KEY);
  const digest = journalDigest(MODEL_KEY);
  if (!MANUAL && fresh === 0) {
    log("[promote] no new journal lessons — nothing to promote. (run some builds first)");
    process.exit(0);
  }
  // manual mode with no candidate yet: print the failure signal + where to write the
  // candidate, and exit WITHOUT touching the model (so the proposer — Claude — can act).
  if (MANUAL && !existsSync(CANDIDATE_PATH)) {
    log(`\n=== manual optimizer brief ===`);
    log(digest || "(no journal lessons yet — propose a proactive improvement)");
    log(`\ncurrent skill: skill/system.md`);
    log(`Write the improved skill to ${path.relative(REPO, CANDIDATE_PATH)}, then re-run this command to gate + deploy it.\n`);
    process.exit(0);
  }
  const tasksPath = process.env.OXY_SO_TASKS ? path.resolve(REPO, process.env.OXY_SO_TASKS) : path.join(HERE, "tasks.json");
  const tasksFile = JSON.parse(readFileSync(tasksPath, "utf8"));
  const valTasks: Task[] = tasksFile.val;
  const seed = existsSync(SEED_PATH) ? readFileSync(SEED_PATH, "utf8") : "";

  log(`\n=== Oxy SkillOpt · gated promote ===`);
  log(`target: ${TARGET_ENGINE} (${TARGET_MODEL}) · model-key: ${MODEL_KEY} · skill: ${path.relative(REPO, SKILL_PATH)} (seed: ${path.relative(REPO, SEED_PATH)})`);
  log(`optimizer: ${OPT_ENGINE} (${OPT_MODEL})`);
  log(`journal: ${fresh} fresh review(s) · val: ${valTasks.length} · repeats: ${VAL_REPEATS} · margin: ${MARGIN}\n${digest}\n`);

  writeStatus({ startedAt: Date.now(), pid: process.pid, finished: false });
  const stop = await ensureBackend();
  const target = await makeEngine(TARGET_ENGINE, TARGET_MODEL);
  const optimizer = MANUAL ? null : await makeEngine(OPT_ENGINE, OPT_MODEL);
  const executor = new HttpToolExecutor({ baseUrl: BASE });
  await target.ensureReady();
  if (optimizer) await optimizer.ensureReady();

  const buildOnce = async (skill: string, task: Task) => {
    // mirror a real build: library tasks get the same get_reference nudge + extra step budget
    const hint = libraryHint(task.prompt);
    let project = "";
    let steps: AgentStep[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      project = await createProject(`pr-${task.id}`, BASE);
      steps = [];
      try {
        await runAgent({ task: task.prompt, project, maxIterations: MAXITER + (hint ? 8 : 0), temperature: 0.6, systemOverride: skill + hint }, { engine: target, executor, onStep: (s) => steps.push(s) });
        break;
      } catch (e: any) {
        log(`      ${task.id}: build error (${attempt}/2) — ${String(e?.message ?? e).slice(0, 70)}`);
        if (attempt < 2) await sleep(2000);
      }
    }
    const finished = steps.at(-1)?.done ?? false;
    const projectDir = path.join(REPO, "workspace", "projects", project);
    mergeDuplicateClasses(projectDir); // same deterministic repairs the build endpoint runs, before scoring
    fixAttrCallbacks(projectDir);
    repairModuleScripts(projectDir);
    const { score, breakdown } = await scoreProject(projectDir, task, { finished });
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
      writeStatus({}); // heartbeat after each task so "running" + timer stay live
    }
    return { score: perTask.reduce((a, t) => a + t.score, 0) / (perTask.length || 1), perTask };
  };

  log(`[promote] scoring current skill on the held-out benchmark…`);
  const base = await evalSkill(seed);
  log(`[promote] current skill val: ${base.score.toFixed(3)}`);

  let candidate;
  if (MANUAL) {
    candidate = readFileSync(CANDIDATE_PATH, "utf8").trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
    log(`[promote] manual candidate from ${path.relative(REPO, CANDIDATE_PATH)} (${candidate.length} chars) — gating on ${TARGET_MODEL}`);
  } else {
    log(`[promote] asking optimizer for a journal-informed edit…`);
    const res = await optimizer!.generate(
      [
        { role: "system", content: 'You optimize the SYSTEM PROMPT (a reusable "skill") for a small coding agent that builds static web apps by calling tools. Output ONLY the full revised skill text — no preamble, no fences, no commentary.' },
        { role: "user", content: `CURRENT SKILL:\n"""\n${seed}\n"""\n\nLESSONS FROM RECENT REAL BUILDS (the small model's actual failures in production):\n${digest}\n\nPropose ONE focused, GENERAL improvement to the skill that fixes the most impactful recurring failure above. Keep it compact (under ~450 words) and procedural. Output the FULL revised skill.` },
      ],
      [],
      { temperature: 0.4, numCtx: 8192, numPredict: 1400 },
    );
    candidate = (res.content || "").trim().replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  }

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
      log(`[promote] ACCEPTED ✅ — deployed to ${path.relative(REPO, SKILL_PATH)}`);
    } else {
      log(`[promote] rejected — skill/system.md unchanged`);
    }
  }
  // the lessons were considered (accepted or not) — clear them so the next promote
  // works on genuinely new feedback rather than re-proposing the same edit.
  markAllConsumed(MODEL_KEY);
  // consume the manual candidate so a re-run doesn't blindly re-apply it
  if (MANUAL) rmSync(CANDIDATE_PATH, { force: true });

  await (target as { dispose?: () => Promise<void> }).dispose?.().catch(() => {});
  if (optimizer) await (optimizer as { dispose?: () => Promise<void> }).dispose?.().catch(() => {});
  stop();
  writeStatus({ finished: true, deployed });
  log(`\n=== promote done — ${deployed ? "skill improved" : "no change"} ===\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[promote] failed:", e?.stack ?? e);
  process.exit(1);
});
