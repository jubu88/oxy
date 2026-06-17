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
  if (fs.existsSync(CACHE_ROOT)) {
    const cached = findFile(CACHE_ROOT, exe);
    if (cached) return cached;
  }
  // resolve the latest release + matching asset
  const rel: any = await (await fetch(RELEASES_JSON, { headers: { "User-Agent": "oxy", Accept: "application/vnd.github+json" } })).json();
  const tag = rel.tag_name as string;
  if (!tag) throw new Error(`could not read latest llama.cpp release (see ${RELEASES_API})`);
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

  async ensureReady(): Promise<void> {
    if (this.ready) return;
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
      "-ngl", String(this.gpuLayers),
      "--jinja", // use the model's embedded chat template (gemma tool-calling format)
    ];
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
    this.inner = new OpenAICompatEngine({ baseUrl: `${this.base()}/v1` });
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
    return this.inner!.generate(messages, tools, opts);
  }

  async dispose(): Promise<void> {
    this.child?.kill();
    this.child = null;
    this.inner = null;
    this.ready = false;
  }
}
