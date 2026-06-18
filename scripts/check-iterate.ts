// Live check: iterate mode. Build a page, then ask for a change and confirm the
// agent edits the EXISTING project in place (not a fresh build).
//   OXY_MODEL=<gemma4.gguf> node scripts/check-iterate.ts
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runAgent, HttpToolExecutor, createProject } from "../agent/index.ts";
import { LlamaServerEngine } from "../engine/llama-server.ts";

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
  const stop = await ensureBackend();
  const engine = new LlamaServerEngine({ modelRef: process.env.OXY_MODEL });
  await engine.ensureReady();
  const executor = new HttpToolExecutor({ baseUrl: BASE });
  const project = await createProject("iterate-check", BASE);
  const idx = path.join(REPO, "workspace", "projects", project, "index.html");

  console.log("[iterate] 1/2 building initial page (heading BANANA)…");
  await runAgent({ task: "Build a single index.html: a page with one big <h1> heading that says exactly BANANA. Then call done.", project, maxIterations: 8, temperature: 0.4 }, { engine, executor, onStep: () => {} });
  const built = existsSync(idx) ? readFileSync(idx, "utf8") : "";
  const hasBanana = /banana/i.test(built);
  console.log(`[iterate]   built ${built.length} bytes · contains BANANA: ${hasBanana}`);

  console.log("[iterate] 2/2 iterating (change heading to MANGO)…");
  await runAgent({ task: "Change the heading text to say MANGO instead of BANANA. Keep everything else.", project, iterate: true, maxIterations: 8, temperature: 0.4 }, { engine, executor, onStep: () => {} });
  const after = existsSync(idx) ? readFileSync(idx, "utf8") : "";
  const hasMango = /mango/i.test(after);
  console.log(`[iterate]   after ${after.length} bytes · contains MANGO: ${hasMango} · still BANANA: ${/banana/i.test(after)}`);

  await engine.dispose().catch(() => {});
  stop();
  const ok = hasBanana && hasMango;
  console.log(ok ? "PASS — iterate edited the existing project in place ✓" : "CHECK — iterate did not apply the change as expected");
  process.exit(ok ? 0 : 2);
}
main().catch((e) => {
  console.error("[iterate] failed:", e?.stack ?? e);
  process.exit(1);
});
