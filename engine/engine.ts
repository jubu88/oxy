// Oxy engine abstraction.
//
// The agent loop (tool-calling + auto-compact + thinking-burst + future strategies)
// is ENGINE-AGNOSTIC: it drives ONE assistant turn at a time via `Engine.generate`
// and owns the message history itself. That is what keeps the orchestration layer —
// Oxy's actual value — independent of whichever backend produces the tokens.
//
// IMPORTANT design note: generate() must NOT execute tools or mutate history.
//   It produces exactly ONE assistant turn (content + any tool calls) and returns.
//   Oxy's loop executes the tools, appends results, decides on compaction/burst,
//   and calls generate() again. History is held by Oxy (ChatMessage[]), not by a
//   stateful session, so a compaction can replace it wholesale. Adapters that wrap
//   a higher-level "auto-run tools" API must bypass it to preserve this seam.
//
// Implementations: engine/llama-server.ts (managed llama.cpp server — the default),
// engine/ollama.ts, engine/openai-compat.ts (any OpenAI-compatible server).

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  name: string;
  arguments: any;
}

/** Multimodal input attached to a (user) message — images/audio for a vision/audio
 *  model like gemma4. `data` is raw base64 (no `data:` URL prefix). */
export interface Attachment {
  kind: "image" | "audio";
  /** MIME type, e.g. "image/png", "audio/wav" */
  mime: string;
  data: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** multimodal input (images/audio) — typically only on the first user turn */
  attachments?: Attachment[];
  /** for role:"tool" — the tool whose result this is */
  tool_name?: string;
  /** for role:"assistant" — tool calls the model emitted this turn */
  tool_calls?: ToolCall[];
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON-schema object for the arguments */
  parameters: any;
}

export interface GenerateOptions {
  temperature?: number;
  numCtx?: number;
  numPredict?: number;
  /** allow the model's reasoning/thinking trace this turn (trace returned, NOT
   *  persisted). false ⇒ ask the backend to suppress thinking so the model acts
   *  immediately (gemma4 otherwise burns its whole budget reasoning). */
  think?: boolean;
  signal?: AbortSignal;
  /** streamed assistant CONTENT tokens (for live display / the Ask answer) */
  onToken?: (chunk: string) => void;
  /** fires once per generated token of ANY kind — content, reasoning/thinking, OR a
   *  tool-call argument fragment. Drives the live token meter so it doesn't read 0
   *  while the model thinks or streams a write_file's body as a tool call. */
  onProgressTick?: () => void;
}

export interface GenerateResult {
  content: string;
  /** reasoning trace if think was on — display only; the loop must NOT push it into history */
  thinking?: string;
  toolCalls: ToolCall[];
  /** exact prefill the model processed (for the auto-compact token meter) */
  promptTokens?: number;
  /** tokens generated this turn */
  evalTokens?: number;
  /** generation hit the token cap (write may be truncated) */
  truncated?: boolean;
}

export interface EngineModelInfo {
  id: string;
  /** local file path or registry ref */
  ref: string;
  bytes?: number;
}

export interface Engine {
  /** "llama-server" | "ollama" | "openai-compat" */
  readonly id: string;

  /**
   * Make the engine usable with zero config: load (and if needed DOWNLOAD) a
   * sensible default GGUF so the very first run "just works". Idempotent.
   */
  ensureReady(): Promise<void>;

  listModels(): Promise<EngineModelInfo[]>;

  /** switch the active model (path or HuggingFace ref); downloads if absent */
  useModel(ref: string): Promise<void>;

  /**
   * Produce ONE assistant turn from the given history + available tools. Does NOT
   * execute tools and does NOT mutate any history — returns the assistant content,
   * any tool calls, token counts, and (if think) the reasoning trace. Oxy's agent
   * loop is responsible for executing tools, appending results, and orchestration.
   */
  generate(messages: ChatMessage[], tools: ToolDef[], opts: GenerateOptions): Promise<GenerateResult>;
}
