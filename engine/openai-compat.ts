// Generic OpenAI-compatible adapter for the Oxy Engine interface.
//
// Talks to ANY server that speaks the OpenAI /v1 chat-completions API:
// llama.cpp's `llama-server`, LM Studio, Jan, vLLM, Ollama's `/v1` endpoint
// (so you can drive even brand-new models like gemma4 through it today), or a
// remote endpoint. This is the escape hatch from the node-llama-vs-Ollama bind —
// one adapter, many backends — without leaving the Engine abstraction.
import type { ChatMessage, Engine, EngineModelInfo, GenerateOptions, GenerateResult, ToolCall, ToolDef } from "./engine.ts";
import { finalizeToolCalls, toOpenAIMessages, toOpenAITools } from "./openai-map.ts";
import { parseTextToolCalls } from "./tool-parse.ts";

const DEFAULT_BASE = "http://localhost:8080/v1"; // llama.cpp llama-server default

export interface OpenAICompatOptions {
  /** OpenAI-compatible base URL, e.g. http://localhost:8080/v1 or http://localhost:11434/v1 */
  baseUrl?: string;
  model?: string;
  /** optional bearer token (LM Studio/llama-server ignore it; remote endpoints need it) */
  apiKey?: string;
  /** true (default): abort a generate only after an idle stretch (slow-but-streaming
   *  generates run to completion). false: legacy total wall-clock cap (A/B toggle). */
  idleTimeout?: boolean;
}

export class OpenAICompatEngine implements Engine {
  readonly id = "openai-compat";
  private baseUrl: string;
  private model: string;
  private apiKey?: string;
  private idleTimeout: boolean;

  constructor(opts: OpenAICompatOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OXY_OPENAI_BASE ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.model = opts.model ?? process.env.OXY_MODEL ?? "";
    this.apiKey = opts.apiKey ?? process.env.OXY_OPENAI_KEY;
    this.idleTimeout = opts.idleTimeout !== false;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  get activeModel(): string {
    return this.model;
  }

  async ensureReady(): Promise<void> {
    let models: EngineModelInfo[] = [];
    try {
      models = await this.listModels();
    } catch (e: any) {
      throw new Error(`OpenAI-compatible server not reachable at ${this.baseUrl} (${String(e?.message ?? e)})`);
    }
    if (!this.model) {
      if (!models.length) throw new Error(`no model set and ${this.baseUrl}/models returned none — pass a model`);
      this.model = models[0].id;
    }
  }

  async listModels(): Promise<EngineModelInfo[]> {
    const res = await fetch(`${this.baseUrl}/models`, { headers: this.headers() });
    if (!res.ok) throw new Error(`models list failed (HTTP ${res.status})`);
    const data: any = await res.json();
    return (data.data ?? []).map((m: any) => ({ id: m.id, ref: m.id }));
  }

  async useModel(ref: string): Promise<void> {
    this.model = ref;
  }

  async generate(messages: ChatMessage[], tools: ToolDef[], opts: GenerateOptions): Promise<GenerateResult> {
    const body: any = {
      model: this.model,
      messages: toOpenAIMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    const t = toOpenAITools(tools);
    if (t) {
      body.tools = t;
      body.tool_choice = "auto";
    }
    if (opts.temperature !== undefined) body.temperature = opts.temperature;
    if (opts.numPredict) body.max_tokens = opts.numPredict;
    // Thinking control. llama.cpp passes chat_template_kwargs into the model's jinja
    // chat template; thinking-capable templates read `enable_thinking` (templates that
    // don't simply ignore it). false ⇒ the model skips its reasoning trace and acts
    // immediately — the difference between a fast build and one that burns the whole
    // budget thinking. Only send when explicitly set, so a plain server keeps default.
    if (opts.think === true || opts.think === false) {
      body.chat_template_kwargs = { ...(body.chat_template_kwargs ?? {}), enable_thinking: opts.think };
    }

    // IDLE (inactivity) timeout — abort only if the stream goes QUIET, never on total
    // wall-clock. A slow-but-streaming generate (the iGPU writing a big file at a few
    // tok/s) keeps resetting the timer via kick() and runs to completion; a dead /
    // suspended / slept server emits nothing and trips it after idleMs. A *total* 600s
    // timeout used to kill legit slow generates here, after which llama-server.ts
    // rebooted and retried the turn from scratch — looping forever on any non-trivial
    // build. That regression is what this replaces.
    const idleMode = this.idleTimeout; // false ⇒ legacy total wall-clock cap (A/B toggle)
    const idleMs = Number(process.env.OXY_GEN_IDLE_TIMEOUT_MS) || 120_000;
    const totalMs = Number(process.env.OXY_GEN_TIMEOUT_MS) || 600_000;
    const ctrl = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      if (!idleMode) return; // total mode: one fixed timer (set below), never reset by activity
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => ctrl.abort(new Error(`generate stalled (no tokens for ${Math.round(idleMs / 1000)}s)`)), idleMs);
    };
    if (idleMode) kick();
    else idleTimer = setTimeout(() => ctrl.abort(new Error(`generate timeout (${Math.round(totalMs / 1000)}s total)`)), totalMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, ctrl.signal]) : ctrl.signal;
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      clearTimeout(idleTimer);
      throw e;
    }
    if (!res.ok) throw new Error(`OpenAI-compatible error (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    if (!res.body) throw new Error("no response body");
    kick(); // headers arrived — the server is alive; (re)arm the idle watchdog

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    let thinking = "";
    const toolFrags = new Map<number, { name: string; args: string }>();
    let promptTokens: number | undefined;
    let evalTokens: number | undefined;
    let finishReason: string | undefined;

    const handle = (payload: string) => {
      if (payload === "[DONE]") return;
      let chunk: any;
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
        evalTokens = chunk.usage.completion_tokens ?? evalTokens;
      }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (delta.content) {
        content += delta.content;
        if (!opts.signal?.aborted) {
          opts.onToken?.(delta.content);
          opts.onProgressTick?.();
        }
      }
      // reasoning trace (llama.cpp emits it on delta.reasoning_content) — count it
      // toward the meter (it's the bulk of the work when thinking is on) but keep it
      // OUT of content so it never lands in the assistant message / Ask answer.
      if (delta.reasoning_content) {
        thinking += delta.reasoning_content;
        if (!opts.signal?.aborted) opts.onProgressTick?.();
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = toolFrags.get(idx) ?? { name: "", args: "" };
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) {
          cur.args += tc.function.arguments;
          // A build's main output (write_file's file body) streams as TOOL-CALL
          // argument fragments, NOT as delta.content — without ticking here the live
          // meter reads 0 for the biggest, slowest part of every build (looks hung).
          if (!opts.signal?.aborted) opts.onProgressTick?.();
        }
        toolFrags.set(idx, cur);
      }
    };

    try {
      while (true) {
        if (opts.signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        kick(); // activity — tokens are flowing, so the server isn't stalled
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data:")) handle(trimmed.slice(5).trim());
        }
      }
    } catch (e: any) {
      if (!opts.signal?.aborted) throw e;
    } finally {
      clearTimeout(idleTimer);
    }

    let toolCalls: ToolCall[] = finalizeToolCalls(toolFrags);
    // fallback for servers/models that emit tool calls as text instead of structured
    if (!toolCalls.length && tools.length) {
      const fb = parseTextToolCalls(content, new Set(tools.map((t) => t.name)));
      if (fb.toolCalls.length) {
        toolCalls = fb.toolCalls;
        content = fb.content;
      }
    }
    return {
      content,
      thinking: thinking || undefined,
      toolCalls,
      promptTokens,
      evalTokens,
      truncated: finishReason === "length",
    };
  }
}
