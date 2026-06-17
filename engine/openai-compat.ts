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
}

export class OpenAICompatEngine implements Engine {
  readonly id = "openai-compat";
  private baseUrl: string;
  private model: string;
  private apiKey?: string;

  constructor(opts: OpenAICompatOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.OXY_OPENAI_BASE ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.model = opts.model ?? process.env.OXY_MODEL ?? "";
    this.apiKey = opts.apiKey ?? process.env.OXY_OPENAI_KEY;
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

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`OpenAI-compatible error (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    if (!res.body) throw new Error("no response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
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
        if (!opts.signal?.aborted) opts.onToken?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = toolFrags.get(idx) ?? { name: "", args: "" };
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        toolFrags.set(idx, cur);
      }
    };

    try {
      while (true) {
        if (opts.signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
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
      toolCalls,
      promptTokens,
      evalTokens,
      truncated: finishReason === "length",
    };
  }
}
