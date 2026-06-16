// Oxy engine abstraction.
//
// The agent loop (tool-calling + auto-compact + thinking-burst + future strategies)
// is ENGINE-AGNOSTIC: it drives ONE assistant turn at a time via `Engine.generate`
// and owns the message history itself. That is what keeps the orchestration layer —
// Oxy's actual value — independent of whichever backend produces the tokens.
//
// IMPORTANT design note for the node-llama-cpp adapter:
//   node-llama-cpp's high-level `LlamaChatSession.prompt(text, { functions })`
//   AUTO-EXECUTES tool handlers in an internal loop — which would hide the seam
//   where compaction/burst/strategy decisions happen. So the adapter must NOT use
//   that. Use the lower-level `LlamaChat.generateResponse(...)`, which returns
//   `functionCalls` WITHOUT running them; Oxy's loop executes the tools, appends
//   results, decides on compaction/burst, and calls generate() again. History is
//   held by Oxy (ChatMessage[]), not by a stateful session, so a compaction can
//   replace it wholesale.

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  name: string;
  arguments: any;
}

export interface ChatMessage {
  role: Role;
  content: string;
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
  /** enable a one-shot reasoning burst for this turn (trace returned, NOT persisted) */
  think?: boolean;
  signal?: AbortSignal;
  /** streamed assistant tokens, for a live progress meter */
  onToken?: (chunk: string) => void;
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
  /** "node-llama-cpp" | "ollama" */
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
