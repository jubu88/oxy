// Ollama adapter for the Oxy Engine interface.
//
// An optional backend for people who already run Ollama. Streams /api/chat,
// surfaces NATIVE tool calls (message.tool_calls) without executing them, keeps
// the reasoning trace on a separate channel, and reports exact prompt/eval token
// counts so the agent loop's compaction meter works. Ported from the bench's
// src/api/ollama.ts, reshaped to the Engine contract (engine/engine.ts).
import type { ChatMessage, Engine, EngineModelInfo, GenerateOptions, GenerateResult, ToolCall, ToolDef } from "./engine.ts";

const DEFAULT_HOST = "http://localhost:11434";
const DEFAULT_MODEL = "gemma4:e4b";

export interface OllamaEngineOptions {
  /** Ollama server origin (default http://localhost:11434). */
  host?: string;
  /** active model name, e.g. "gemma4:e4b" */
  model?: string;
}

function toOllamaMessage(m: ChatMessage): any {
  const out: any = { role: m.role, content: m.content };
  // multimodal input (gemma4 = vision + audio). Ollama takes base64 images on the
  // message `images` array. Audio uses `audio` — verified live against the running
  // gemma3n model before relying on it (adjust the field here if Ollama differs).
  if (m.attachments?.length) {
    const imgs = m.attachments.filter((a) => a.kind === "image").map((a) => a.data);
    const auds = m.attachments.filter((a) => a.kind === "audio").map((a) => a.data);
    if (imgs.length) out.images = imgs;
    if (auds.length) out.audio = auds;
  }
  // assistant tool calls go back in Ollama's {function:{name,arguments}} shape
  if (m.role === "assistant" && m.tool_calls?.length) {
    out.tool_calls = m.tool_calls.map((tc) => ({ function: { name: tc.name, arguments: tc.arguments } }));
  }
  if (m.role === "tool" && m.tool_name) out.tool_name = m.tool_name;
  return out;
}

function toOllamaTool(t: ToolDef): any {
  return { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } };
}

export class OllamaEngine implements Engine {
  readonly id = "ollama";
  private host: string;
  private model: string;

  constructor(opts: OllamaEngineOptions = {}) {
    this.host = (opts.host ?? process.env.OLLAMA_HOST ?? DEFAULT_HOST).replace(/\/+$/, "");
    this.model = opts.model ?? process.env.OXY_MODEL ?? DEFAULT_MODEL;
  }

  /** Verify the server is reachable and the active model is present. */
  async ensureReady(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.host}/api/version`);
    } catch (e: any) {
      throw new Error(`Ollama is not reachable at ${this.host} — is it running? (${String(e?.message ?? e)})`);
    }
    if (!res.ok) throw new Error(`Ollama health check failed (HTTP ${res.status}) at ${this.host}`);
    const models = await this.listModels();
    if (models.length && !models.some((m) => m.id === this.model)) {
      throw new Error(`model "${this.model}" is not available in Ollama — pull it with \`ollama pull ${this.model}\`, or pick one of: ${models.map((m) => m.id).join(", ")}`);
    }
    await this.warm();
  }

  /** Pre-load the model so its (often 30s+) cold load happens here, not on the
   *  first real generate. A big model loading under memory pressure can reset the
   *  connection mid-load (surfaces as "fetch failed"), so retry a few times. */
  private async warm(): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${this.host}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: "hi" }], stream: false, keep_alive: "15m", options: { num_predict: 1 } }),
        });
        if (res.ok) {
          await res.json().catch(() => {});
          return;
        }
      } catch {
        /* connection reset while loading — retry */
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }
    // best-effort: don't hard-fail setup; the build path retries too
  }

  async listModels(): Promise<EngineModelInfo[]> {
    const res = await fetch(`${this.host}/api/tags`);
    if (!res.ok) throw new Error(`Ollama list-models failed (HTTP ${res.status})`);
    const data: any = await res.json();
    return (data.models ?? []).map((m: any) => ({ id: m.name, ref: m.name, bytes: m.size }));
  }

  async useModel(ref: string): Promise<void> {
    this.model = ref;
  }

  /** Active model name (for indicators / logging). */
  get activeModel(): string {
    return this.model;
  }

  async generate(messages: ChatMessage[], tools: ToolDef[], opts: GenerateOptions): Promise<GenerateResult> {
    const url = `${this.host}/api/chat`;
    const makeBody = (includeThink: boolean): string =>
      JSON.stringify({
        model: this.model,
        messages: messages.map(toOllamaMessage),
        ...(tools.length ? { tools: tools.map(toOllamaTool) } : {}),
        stream: true,
        ...(includeThink ? { think: !!opts.think } : {}),
        keep_alive: "15m",
        options: {
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.numCtx ? { num_ctx: opts.numCtx } : {}),
          ...(opts.numPredict ? { num_predict: opts.numPredict } : {}),
        },
      });

    const headers = { "Content-Type": "application/json" };
    let res = await fetch(url, { method: "POST", headers, body: makeBody(true), signal: opts.signal });

    // Some models reject the optional `think` param with a 400 — retry once without it.
    if (!res.ok && res.status === 400) {
      const errText = await res.text();
      if (/think/i.test(errText)) {
        res = await fetch(url, { method: "POST", headers, body: makeBody(false), signal: opts.signal });
      } else {
        throw new Error(`Ollama error (HTTP ${res.status}): ${errText.slice(0, 300)}`);
      }
    }
    if (!res.ok) throw new Error(`Ollama error (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
    if (!res.body) throw new Error("no response body from Ollama");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    let thinking = "";
    const rawToolCalls: any[] = [];
    let evalCount: number | undefined;
    let promptEvalCount: number | undefined;
    let doneReason: string | undefined;

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let chunk: any;
      try {
        chunk = JSON.parse(line);
      } catch {
        return; // tolerate malformed lines
      }
      if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
      const m = chunk.message ?? {};
      if (m.content) {
        content += m.content;
        if (!opts.signal?.aborted) opts.onToken?.(m.content);
      }
      if (m.thinking) thinking += m.thinking;
      if (m.tool_calls?.length) rawToolCalls.push(...m.tool_calls);
      if (chunk.done) {
        evalCount = chunk.eval_count ?? evalCount;
        promptEvalCount = chunk.prompt_eval_count ?? promptEvalCount;
        doneReason = chunk.done_reason ?? doneReason;
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
        for (const line of lines) processLine(line);
      }
      if (buf.trim()) processLine(buf);
    } catch (e: any) {
      // an aborted stream surfaces as a read error — return the partial result
      if (!opts.signal?.aborted) throw e;
    }

    const toolCalls: ToolCall[] = rawToolCalls
      .map((tc) => ({ name: tc.function?.name, arguments: tc.function?.arguments ?? {} }))
      .filter((tc): tc is ToolCall => typeof tc.name === "string" && tc.name.length > 0);

    return {
      content,
      thinking: thinking || undefined,
      toolCalls,
      promptTokens: promptEvalCount,
      evalTokens: evalCount,
      truncated: doneReason === "length",
    };
  }
}
