// node-llama-cpp adapter — Oxy's PRIMARY engine: inference fully in-process via
// llama.cpp (bundled prebuilt binaries), no server, no account. Implements the
// Engine interface so the agent loop drives it identically to the Ollama path.
//
// Design note (see engine/engine.ts): we use the LOW-LEVEL
// LlamaChat.generateResponse, NOT LlamaChatSession.prompt. prompt() auto-runs
// tool handlers in an internal loop, which would hide the seam where Oxy's
// compaction/burst/strategy decisions happen. generateResponse returns
// functionCalls WITHOUT executing them; Oxy's loop owns history and orchestration.
//
// ensureReady() downloads a small default coder GGUF from HuggingFace on first
// run (resolveModelFile), so the very first build "just works". The pure mapping
// logic lives in node-llama-map.ts (unit-tested without install); this file is
// the thin native-binding layer.
//
// NOTE: requires `npm install` (pulls node-llama-cpp's prebuilt binaries) and a
// one-time model download. The Ollama adapter is the zero-install alternative.
import { getLlama, LlamaChat, resolveModelFile } from "node-llama-cpp";
import type { ChatMessage, Engine, EngineModelInfo, GenerateOptions, GenerateResult, ToolDef } from "./engine.ts";
import { normalizeToolCalls, parseTextToolCalls, splitReasoning, toLlamaFunctions, toLlamaHistory } from "./node-llama-map.ts";

// A small, capable coder GGUF — good default for "just works" first run.
const DEFAULT_MODEL = "hf:Qwen/Qwen2.5-Coder-3B-Instruct-GGUF:Q4_K_M";
const DEFAULT_CONTEXT_SIZE = 16384;

export interface NodeLlamaEngineOptions {
  /** HuggingFace ref (hf:user/repo:quant), URL, or local .gguf path. */
  modelRef?: string;
  /** directory to download/resolve models into (default node-llama-cpp's cache). */
  modelsDir?: string;
  /** context window; clamped to the model's max. */
  contextSize?: number;
}

export class NodeLlamaEngine implements Engine {
  readonly id = "node-llama-cpp";
  private modelRef: string;
  private modelsDir?: string;
  private contextSize: number;

  private llama: any = null;
  private model: any = null;
  private context: any = null;
  private sequence: any = null;
  private chat: any = null;
  private ready = false;

  constructor(opts: NodeLlamaEngineOptions = {}) {
    this.modelRef = opts.modelRef ?? process.env.OXY_MODEL ?? DEFAULT_MODEL;
    this.modelsDir = opts.modelsDir ?? process.env.OXY_MODELS_DIR;
    this.contextSize = opts.contextSize ?? DEFAULT_CONTEXT_SIZE;
  }

  /** Load (downloading on first run) the default model and build a chat session. */
  async ensureReady(): Promise<void> {
    if (this.ready) return;
    this.llama = await getLlama();
    const modelPath = await resolveModelFile(this.modelRef, this.modelsDir);
    this.model = await this.llama.loadModel({ modelPath });
    // contextSize:{max} lets llama.cpp clamp to the model's trained window.
    this.context = await this.model.createContext({ contextSize: { max: this.contextSize } });
    this.sequence = this.context.getSequence();
    // Reuse ONE LlamaChat/sequence across turns so the KV-cache prefix is reused
    // when the next history extends the previous (big speedup); on compaction the
    // history shrinks and llama.cpp re-evaluates from the first divergence.
    this.chat = new LlamaChat({ contextSequence: this.sequence });
    this.ready = true;
  }

  async listModels(): Promise<EngineModelInfo[]> {
    return [{ id: this.modelRef, ref: this.modelRef }];
  }

  async useModel(ref: string): Promise<void> {
    if (ref === this.modelRef && this.ready) return;
    // dispose the old model/context before switching
    try {
      await this.context?.dispose?.();
      await this.model?.dispose?.();
    } catch {
      /* best-effort */
    }
    this.modelRef = ref;
    this.model = this.context = this.sequence = this.chat = null;
    this.ready = false;
    await this.ensureReady();
  }

  get activeModel(): string {
    return this.modelRef;
  }

  async generate(messages: ChatMessage[], tools: ToolDef[], opts: GenerateOptions): Promise<GenerateResult> {
    await this.ensureReady();
    const functions = toLlamaFunctions(tools);
    const history = toLlamaHistory(messages);

    // token accounting: snapshot the sequence meter around this turn
    const meter = this.sequence.tokenMeter;
    const beforeIn = meter?.usedInputTokens ?? 0;
    const beforeOut = meter?.usedOutputTokens ?? 0;

    let res: any;
    try {
      res = await this.chat.generateResponse(history, {
        functions,
        documentFunctionParams: true,
        maxTokens: opts.numPredict,
        temperature: opts.temperature,
        onTextChunk: (chunk: string) => {
          if (!opts.signal?.aborted) opts.onToken?.(chunk);
        },
        signal: opts.signal,
        stopOnAbortSignal: true,
      });
    } catch (e: any) {
      if (opts.signal?.aborted) {
        // aborted mid-generation — return an empty turn; the loop checks the signal
        return { content: "", toolCalls: [], truncated: false };
      }
      throw e;
    }

    const usedIn = (meter?.usedInputTokens ?? 0) - beforeIn;
    const usedOut = (meter?.usedOutputTokens ?? 0) - beforeOut;
    const split = splitReasoning(res.response ?? "");
    let content = split.content;

    // Prefer node-llama-cpp's structured function calls; if the model instead
    // emitted a tool call as text (common with small GGUFs), parse it out.
    let toolCalls = normalizeToolCalls(res.functionCalls);
    if (!toolCalls.length) {
      const fallback = parseTextToolCalls(content, new Set(tools.map((t) => t.name)));
      if (fallback.toolCalls.length) {
        toolCalls = fallback.toolCalls;
        content = fallback.content;
      }
    }

    return {
      content,
      thinking: split.thinking,
      toolCalls,
      promptTokens: usedIn > 0 ? usedIn : undefined,
      evalTokens: usedOut > 0 ? usedOut : undefined,
      truncated: res.metadata?.stopReason === "maxTokens",
    };
  }

  /** Free native resources. */
  async dispose(): Promise<void> {
    try {
      await this.context?.dispose?.();
      await this.model?.dispose?.();
      await this.llama?.dispose?.();
    } catch {
      /* best-effort */
    }
    this.ready = false;
  }
}
