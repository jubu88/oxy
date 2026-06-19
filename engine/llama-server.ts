// Managed llama-server engine — the "just works, latest models, nothing to
// install" path. On first use Oxy downloads a PREBUILT llama-server from
// llama.cpp's GitHub releases (no compiler) and the requested GGUF, starts the
// server in the background, and drives it through the OpenAI-compatible adapter.
// This runs models the in-process node-llama-cpp engine can't load yet (e.g.
// gemma4, whose architecture needs a newer llama.cpp than node-llama-cpp bundles).
//
// The model GGUF is fetched with node-llama-cpp's resolveModelFile (shared cache,
// progress, HF refs). The binary is cached under ~/.oxy/llama-server/<tag>/.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ChatMessage, Engine, EngineModelInfo, GenerateOptions, GenerateResult, ToolDef } from "./engine.ts";
import { OpenAICompatEngine } from "./openai-compat.ts";

// Turn a model ref into llama-server model args. llama-server fetches HF models
// itself (-hf), so Oxy needs no separate downloader (and no node-llama-cpp):
//   hf:org/repo:quant -> -hf org/repo:quant   (downloaded + cached by llama-server)
//   https://….gguf    -> -mu <url>
//   /local/path.gguf   -> -m <path>
function modelArgs(ref: string): string[] {
  if (ref.startsWith("hf:")) return ["-hf", ref.slice(3)];
  if (/^https?:\/\//i.test(ref)) return ["-mu", ref];
  return ["-m", ref];
}

const execFileP = promisify(execFile);

// gemma4 by default — the capable, latest model the user asked for. Override with OXY_MODEL.
const DEFAULT_MODEL = "hf:ggml-org/gemma-4-E4B-it-GGUF:Q4_K_M";
const CACHE_ROOT = path.join(os.homedir(), ".oxy", "llama-server");
const RELEASES_API = "https://github.com/ggml-org/llama.cpp/releases/latest";
const RELEASES_JSON = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface LlamaServerOptions {
  modelRef?: string;
  /** "auto" (default: detect CUDA → Vulkan → CPU) | cpu | vulkan | cuda-12.4 | cuda-13.3 | metal */
  variant?: string;
  port?: number;
  contextSize?: number;
  /** GPU layers to offload (auto: 0 for cpu, all for gpu variants) */
  gpuLayers?: number;
  /** multimodal projector (.gguf) for vision/audio; auto-detected next to a local model */
  mmproj?: string;
  /** pass through to the OpenAI-compat transport (idle vs total generate timeout) */
  idleTimeout?: boolean;
  /** true (default): only reuse a running server if it serves the requested model;
   *  false: reuse any healthy server regardless of model (legacy, A/B toggle) */
  modelAwareReuse?: boolean;
}

async function extractArchive(archive: string, destDir: string): Promise<void> {
  if (process.platform === "win32") {
    // tar.exe on Windows mis-parses "C:\…" as a remote host:path, so use PowerShell.
    await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`]);
  } else {
    await execFileP("tar", ["-xf", archive, "-C", destDir]); // .tar.gz on mac/linux
  }
}

// Pick the fastest backend the machine can actually run: NVIDIA→CUDA (Windows ships
// a prebuilt CUDA runtime), else a Vulkan loader→Vulkan (covers AMD/Intel/NVIDIA),
// else CPU. macOS uses the Metal-enabled build. Override with OXY_LLAMA_VARIANT.
async function detectWindowsCuda(): Promise<string | null> {
  try {
    const { stdout } = await execFileP("nvidia-smi", [], { timeout: 5000 });
    const m = stdout.match(/CUDA Version:\s*([\d.]+)/);
    const v = m ? parseFloat(m[1]) : 0;
    return v >= 13.3 ? "cuda-13.3" : "cuda-12.4"; // NVIDIA present → CUDA (12.4 baseline)
  } catch {
    return null; // no NVIDIA driver
  }
}

async function hasVulkan(): Promise<boolean> {
  if (process.platform === "win32") {
    return fs.existsSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "vulkan-1.dll"));
  }
  for (const p of ["/usr/lib/x86_64-linux-gnu/libvulkan.so.1", "/usr/lib/libvulkan.so.1", "/usr/lib64/libvulkan.so.1", "/lib/x86_64-linux-gnu/libvulkan.so.1"]) {
    if (fs.existsSync(p)) return true;
  }
  try {
    await execFileP("vulkaninfo", ["--summary"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function detectVariant(): Promise<string> {
  if (process.platform === "darwin") return "metal"; // macOS build has Metal built in (asset has no variant)
  if (process.platform === "win32") {
    return (await detectWindowsCuda()) ?? ((await hasVulkan()) ? "vulkan" : "cpu");
  }
  // linux: prefer Vulkan (vendor-neutral, no system-CUDA assumptions); CUDA via env if wanted
  return (await hasVulkan()) ? "vulkan" : "cpu";
}

function findFile(dir: string, name: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return full;
    }
  }
  return null;
}

// Build the release asset name for this platform + variant, matching llama.cpp's
// scheme: llama-<tag>-bin-<os>-[<variant>-]<arch>.{zip|tar.gz}
function assetNameFor(tag: string, variant: string): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "win32") return `llama-${tag}-bin-win-${variant}-${arch}.zip`;
  if (process.platform === "darwin") return `llama-${tag}-bin-macos-${arch}.tar.gz`; // metal built in
  // linux (ubuntu builds): cpu has no variant segment
  return variant === "cpu" ? `llama-${tag}-bin-ubuntu-${arch}.tar.gz` : `llama-${tag}-bin-ubuntu-${variant}-${arch}.tar.gz`;
}

async function ensureBinary(variant: string): Promise<string> {
  const exe = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  // use any cached build for speed — UNLESS OXY_LLAMA_UPGRADE=1, which forces a
  // check for the latest llama.cpp release (otherwise an old cached build is kept
  // forever even as newer releases ship).
  if (!process.env.OXY_LLAMA_UPGRADE && fs.existsSync(CACHE_ROOT)) {
    const cached = findFile(CACHE_ROOT, exe);
    if (cached) return cached;
  }
  // resolve the latest release + matching asset
  const rel: any = await (await fetch(RELEASES_JSON, { headers: { "User-Agent": "oxy", Accept: "application/vnd.github+json" } })).json();
  const tag = rel.tag_name as string;
  if (!tag) throw new Error(`could not read latest llama.cpp release (see ${RELEASES_API})`);
  // already have the latest tag cached? use it without re-downloading.
  const tagDir = path.join(CACHE_ROOT, tag);
  if (fs.existsSync(tagDir)) {
    const have = findFile(tagDir, exe);
    if (have) return have;
  }
  const wanted = assetNameFor(tag, variant);
  const asset = (rel.assets ?? []).find((a: any) => a.name === wanted);
  if (!asset) {
    const avail = (rel.assets ?? []).map((a: any) => a.name).filter((n: string) => /win|macos|ubuntu/.test(n));
    throw new Error(`no llama-server build "${wanted}" in release ${tag}. Try OXY_LLAMA_VARIANT. Available: ${avail.join(", ")}`);
  }
  const destDir = path.join(CACHE_ROOT, tag);
  fs.mkdirSync(destDir, { recursive: true });
  const archive = path.join(destDir, asset.name);
  if (!fs.existsSync(archive)) {
    const buf = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer());
    fs.writeFileSync(archive, buf);
  }
  await extractArchive(archive, destDir);
  fs.rmSync(archive, { force: true });
  // CUDA builds need the CUDA runtime DLLs next to the server (Windows ships them)
  if (process.platform === "win32" && variant.startsWith("cuda")) {
    const cudartName = `cudart-llama-bin-win-${variant}-x64.zip`;
    const cudart = (rel.assets ?? []).find((a: any) => a.name === cudartName);
    if (cudart) {
      const ca = path.join(destDir, cudartName);
      if (!fs.existsSync(ca)) fs.writeFileSync(ca, Buffer.from(await (await fetch(cudart.browser_download_url)).arrayBuffer()));
      await extractArchive(ca, destDir);
      fs.rmSync(ca, { force: true });
    }
  }
  const found = findFile(destDir, exe);
  if (!found) throw new Error(`extracted ${asset.name} but ${exe} not found inside`);
  if (process.platform !== "win32") fs.chmodSync(found, 0o755);
  return found;
}

export class LlamaServerEngine implements Engine {
  readonly id = "llama-server";
  private modelRef: string;
  private variant: string;
  private port: number;
  private contextSize: number;
  private gpuLayers = 0;
  private nglOverride: number | null;
  private mmproj: string | null;
  private idleTimeout: boolean;
  private modelAware: boolean;
  private child: ChildProcess | null = null;
  private inner: OpenAICompatEngine | null = null;
  private ready = false;

  constructor(opts: LlamaServerOptions = {}) {
    this.modelRef = opts.modelRef ?? process.env.OXY_MODEL ?? DEFAULT_MODEL;
    // "auto" → detected in ensureReady (NVIDIA→CUDA, else Vulkan, else CPU)
    this.variant = opts.variant ?? process.env.OXY_LLAMA_VARIANT ?? "auto";
    this.port = opts.port ?? (process.env.OXY_LLAMA_PORT ? Number(process.env.OXY_LLAMA_PORT) : 8080);
    this.contextSize = opts.contextSize ?? (process.env.OXY_LLAMA_CTX ? Number(process.env.OXY_LLAMA_CTX) : 16384);
    this.nglOverride = opts.gpuLayers ?? (process.env.OXY_LLAMA_NGL ? Number(process.env.OXY_LLAMA_NGL) : null);
    this.mmproj = opts.mmproj ?? process.env.OXY_LLAMA_MMPROJ ?? null;
    this.idleTimeout = opts.idleTimeout !== false;
    this.modelAware = opts.modelAwareReuse !== false;
  }

  // Multimodal projector for vision/audio. Explicit option/env wins; otherwise, for
  // a local -m model, auto-use a sibling mmproj-*.gguf (enables gemma4 vision). For
  // an -hf model, llama.cpp auto-loads the repo's projector, so we pass nothing.
  private resolveMmproj(): string | null {
    if (this.mmproj) return this.mmproj;
    if (this.modelRef.startsWith("hf:") || /^https?:\/\//i.test(this.modelRef)) return null;
    try {
      const dir = path.dirname(this.modelRef);
      const hit = fs.readdirSync(dir).find((f) => /mmproj.*\.gguf$/i.test(f));
      return hit ? path.join(dir, hit) : null;
    } catch {
      return null;
    }
  }

  get activeModel(): string {
    return this.modelRef;
  }

  private base(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async waitForHealth(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.child?.exitCode != null) throw new Error(`llama-server exited early (code ${this.child.exitCode})`);
      try {
        const r = await fetch(`${this.base()}/health`);
        if (r.ok) return;
      } catch {
        /* not up yet */
      }
      await sleep(1000);
    }
    throw new Error("llama-server did not become healthy in time");
  }

  private async healthy(): Promise<boolean> {
    try {
      return (await fetch(`${this.base()}/health`, { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  }

  /** The model id the running server should report for our modelRef. */
  private expectedModelId(): string {
    if (this.modelRef.startsWith("hf:")) return this.modelRef.slice(3);
    if (/^https?:\/\//i.test(this.modelRef)) return this.modelRef;
    return path.basename(this.modelRef);
  }

  /** Is the server already on our port serving the model we actually want? llama-server
   *  loads ONE model per process, so a stale server running a different model would
   *  silently answer with the wrong one (pick a new HF model, still get gemma4). */
  private async servesModel(): Promise<boolean> {
    try {
      const r = await fetch(`${this.base()}/v1/models`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return false;
      const j: any = await r.json();
      const ids: string[] = (j.data ?? j.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean);
      const want = this.expectedModelId();
      return ids.some((id) => id === want || id.endsWith(want) || want.endsWith(id) || id.includes(want));
    } catch {
      return false;
    }
  }

  /** Stop ANY llama-server on this machine — including an orphan from a previous dev
   *  run that THIS instance never spawned (so dispose(), which only kills this.child,
   *  can't reach it). Used to swap models or clear a wedged/zombie server. */
  private async killExisting(): Promise<void> {
    try {
      if (process.platform === "win32") await execFileP("taskkill", ["/F", "/IM", "llama-server.exe"]);
      else await execFileP("pkill", ["-f", "llama-server"]);
    } catch {
      /* none running / already gone */
    }
    this.child = null;
    this.inner = null;
    await sleep(600); // let the OS free the port before we rebind
  }

  async ensureReady(): Promise<void> {
    if (this.ready) return;
    // reuse a llama-server already serving on our port instead of spawning a
    // duplicate (a second model load blows up RAM + fights for the port) — BUT only
    // if it's serving the model we want. Otherwise stop it and boot the right one, so
    // picking a new model / HF ref actually takes effect instead of silently running
    // the old model. One model per port.
    if (await this.healthy()) {
      if (!this.modelAware || (await this.servesModel())) {
        console.log(`[oxy] reusing llama-server already on :${this.port} (${this.expectedModelId()})`);
        this.inner = new OpenAICompatEngine({ baseUrl: `${this.base()}/v1`, idleTimeout: this.idleTimeout });
        await this.inner.ensureReady();
        this.ready = true;
        return;
      }
      console.log(`[oxy] llama-server on :${this.port} runs a different model — restarting for ${this.expectedModelId()}`);
      await this.killExisting();
    }
    if (this.variant === "auto") this.variant = await detectVariant();
    this.gpuLayers = this.nglOverride ?? (this.variant === "cpu" ? 0 : 999);
    try {
      await this.boot();
    } catch (e: any) {
      if (this.variant === "cpu") throw e;
      // a GPU backend can fail (driver/VRAM/loader) — fall back to CPU so a build never blocks
      console.warn(`[oxy] llama-server ${this.variant} backend failed, falling back to CPU: ${String(e?.message ?? e).slice(0, 160)}`);
      await this.dispose();
      this.variant = "cpu";
      this.gpuLayers = 0;
      await this.boot();
    }
    this.ready = true;
  }

  private async boot(): Promise<void> {
    console.log(`[oxy] llama-server backend: ${this.variant} (${this.gpuLayers > 0 ? "GPU-offload" : "CPU"})`);
    const bin = await ensureBinary(this.variant);
    const args = [
      ...modelArgs(this.modelRef),
      "--host", "127.0.0.1",
      "--port", String(this.port),
      "-c", String(this.contextSize),
      "-np", "1", // ONE slot — otherwise llama-server splits -c across N parallel slots
      //            (it defaults to 4), giving each build only n_ctx/4 (e.g. 4096) context.
      //            A real build (skill + tool schemas + a full page) overflows that and
      //            the generate stalls. Oxy is single-user: give the whole context to one slot.
      "-ctk", "q8_0", "-ctv", "q8_0", // quantize the KV cache (~halves it). A full 16384-ctx
      //            f16 cache is ~2.6GB on top of the 4.4GB model = ~7GB → on a 16GB machine
      //            that leaves too little and the build swaps to ~2 tok/s. q8_0 keeps the full
      //            context but fits RAM (negligible quality cost).
      "-ngl", String(this.gpuLayers),
      "--jinja", // use the model's embedded chat template (gemma tool-calling format)
    ];
    const mmproj = this.resolveMmproj();
    if (mmproj) {
      args.push("--mmproj", mmproj);
      console.log(`[oxy] llama-server multimodal projector: ${path.basename(mmproj)}`);
    }
    let stderrTail = "";
    this.child = spawn(bin, args, { windowsHide: true });
    this.child.stderr?.on("data", (d) => (stderrTail = (stderrTail + d).slice(-800)));
    this.child.on("error", (e) => (stderrTail += `\n${e.message}`));
    try {
      // generous: first run may download a multi-GB GGUF via -hf before serving
      await this.waitForHealth(900_000);
    } catch (e: any) {
      this.child?.kill();
      this.child = null;
      throw new Error(`${String(e?.message ?? e)}${stderrTail ? `\nllama-server: ${stderrTail.slice(-400)}` : ""}`);
    }
    // drive the running server through the OpenAI-compatible adapter
    this.inner = new OpenAICompatEngine({ baseUrl: `${this.base()}/v1`, idleTimeout: this.idleTimeout });
    await this.inner.ensureReady();
  }

  async listModels(): Promise<EngineModelInfo[]> {
    if (!this.inner) return [{ id: this.modelRef, ref: this.modelRef }];
    return this.inner.listModels();
  }

  async useModel(ref: string): Promise<void> {
    // llama-server loads one model per process — restart on change
    this.modelRef = ref;
    if (this.ready) {
      await this.dispose();
      await this.ensureReady();
    }
  }

  async generate(messages: ChatMessage[], tools: ToolDef[], opts: GenerateOptions): Promise<GenerateResult> {
    await this.ensureReady();
    try {
      return await this.inner!.generate(messages, tools, opts);
    } catch (e: any) {
      if (opts.signal?.aborted) throw e; // genuine user cancel — don't reboot
      // the managed server may have died or hung (iGPU/Vulkan can crash under
      // sustained load). reboot once and retry so one death doesn't poison the run.
      console.warn(`[oxy] llama-server generate failed (${String(e?.message ?? e).slice(0, 80)}) — rebooting and retrying once`);
      try {
        await this.dispose();
      } catch {
        /* ignore */
      }
      await this.killExisting(); // also clear an orphaned/wedged server this instance didn't spawn
      await this.ensureReady();
      return await this.inner!.generate(messages, tools, opts);
    }
  }

  async dispose(): Promise<void> {
    this.child?.kill();
    this.child = null;
    this.inner = null;
    this.ready = false;
  }
}
