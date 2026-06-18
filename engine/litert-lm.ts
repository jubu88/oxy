// LiteRT-LM engine — Google AI Edge's runtime, which (unlike llama.cpp) decodes
// gemma4 VISION + audio correctly. Oxy manages a `litert-lm serve` process (an
// OpenAI-compatible server) and drives it through the existing OpenAI-compat
// adapter, so multimodal `image_url` content parts flow straight through.
//
// Requires the `litert-lm` CLI (pip install litert-lm). Point OXY_LITERTLM_BIN at
// it if it isn't on PATH. The model is a `.litertlm` bundle imported into the CLI's
// store (auto-imported on first use from the ungated litert-community HF repo).
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import type { ChatMessage, Engine, EngineModelInfo, GenerateOptions, GenerateResult, ToolDef } from "./engine.ts";
import { OpenAICompatEngine } from "./openai-compat.ts";

const execFileP = promisify(execFile);

// gemma4 E4B in .litertlm form (vision-capable, Apache-2.0, ungated)
const DEFAULT_MODEL = process.env.OXY_LITERTLM_MODEL || "oxy-gemma4";
const HF_REPO = process.env.OXY_LITERTLM_REPO || "litert-community/gemma-4-E4B-it-litert-lm";
const HF_FILE = process.env.OXY_LITERTLM_FILE || "gemma-4-E4B-it.litertlm";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Locate the `litert-lm` CLI: explicit env → PATH → the pip console-scripts dir
// (so a plain `pip install litert-lm` works without touching PATH). Cached.
let cachedBin: string | null = null;
async function resolveBin(): Promise<string> {
  if (process.env.OXY_LITERTLM_BIN) return process.env.OXY_LITERTLM_BIN;
  if (cachedBin) return cachedBin;
  try {
    await execFileP("litert-lm", ["--version"], { timeout: 8000 });
    return (cachedBin = "litert-lm");
  } catch {
    /* not on PATH */
  }
  for (const py of ["python", "py", "python3"]) {
    try {
      const { stdout } = await execFileP(py, ["-c", "import sysconfig,os;print(sysconfig.get_path('scripts','nt_user' if os.name=='nt' else 'posix_user'))"], { timeout: 8000 });
      const cand = stdout.trim() + (process.platform === "win32" ? "\\litert-lm.exe" : "/litert-lm");
      if (fs.existsSync(cand)) return (cachedBin = cand);
    } catch {
      /* try next */
    }
  }
  return (cachedBin = "litert-lm"); // last resort — errors clearly if absent
}

export interface LiteRtLmOptions {
  /** imported model id (litert-lm list), e.g. "oxy-gemma4" or "oxy-gemma4,gpu" */
  model?: string;
  port?: number;
}

export class LiteRtLmEngine implements Engine {
  readonly id = "litert-lm";
  private model: string;
  private port: number;
  private child: ChildProcess | null = null;
  private inner: OpenAICompatEngine | null = null;
  private ready = false;

  constructor(opts: LiteRtLmOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.port = opts.port ?? Number(process.env.OXY_LITERTLM_PORT || 9379);
  }

  get activeModel(): string {
    return this.model;
  }
  private base(): string {
    return `http://localhost:${this.port}`;
  }

  private async healthy(): Promise<boolean> {
    try {
      return (await fetch(`${this.base()}/v1/models`, { signal: AbortSignal.timeout(2500) })).ok;
    } catch {
      return false;
    }
  }

  // import the .litertlm into the CLI's model store if it isn't there yet
  private async ensureModel(): Promise<void> {
    const bin = await resolveBin();
    try {
      const { stdout } = await execFileP(bin, ["list"], { timeout: 20000 });
      if (stdout.includes(this.model.split(",")[0])) return;
    } catch {
      /* list failed (or CLI missing) — try import; surfaces a clear error */
    }
    console.log(`[oxy] litert-lm: importing "${this.model}" from ${HF_REPO} — first-time download (~3.7GB)…`);
    await execFileP(bin, ["import", "--from-huggingface-repo", HF_REPO, HF_FILE, this.model.split(",")[0]], { timeout: 1_800_000 });
  }

  async ensureReady(): Promise<void> {
    if (this.ready) return;
    if (!(await this.healthy())) {
      await this.ensureModel();
      const bin = await resolveBin();
      console.log(`[oxy] litert-lm serve on :${this.port} (gemma4 + vision via LiteRT-LM)`);
      this.child = spawn(bin, ["serve", "--port", String(this.port)], { windowsHide: true, stdio: "ignore" });
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        if (this.child.exitCode != null) throw new Error(`litert-lm serve exited early (code ${this.child.exitCode}) — is the CLI installed? (pip install litert-lm; set OXY_LITERTLM_BIN)`);
        if (await this.healthy()) break;
        await sleep(1000);
      }
      if (!(await this.healthy())) {
        this.child?.kill();
        throw new Error("litert-lm serve did not become healthy in time");
      }
    }
    this.inner = new OpenAICompatEngine({ baseUrl: `${this.base()}/v1`, model: this.model });
    await this.inner.ensureReady();
    this.ready = true;
  }

  async listModels(): Promise<EngineModelInfo[]> {
    return this.inner ? this.inner.listModels() : [{ id: this.model, ref: this.model }];
  }
  async useModel(ref: string): Promise<void> {
    this.model = ref;
    if (this.inner) await this.inner.useModel(ref);
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
