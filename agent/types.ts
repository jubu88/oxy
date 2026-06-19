// Shared types for the Oxy agent core.
//
// The agent core (loop + compaction + thinking-burst + token accounting + tool
// execution) depends ONLY on these types and on the Engine interface
// (engine/engine.ts) — never on a concrete backend. That independence is the
// whole point of the orchestration layer.
import type { Attachment } from "../engine/engine.ts";

export type { Attachment };

/** One executed tool call plus the short string result fed back to the model. */
export interface ToolCallRecord {
  name: string;
  args: any;
  result: string;
}

/** Emitted once per assistant turn, for the build UI / a headless log. */
export interface AgentStep {
  iteration: number;
  /** reasoning trace if a burst ran this turn — DISPLAY ONLY, never in history */
  thinking?: string;
  message: string;
  toolCalls: ToolCallRecord[];
  done: boolean;
  tokens?: number;
  /** true if the generation hit the token cap (likely a truncated/garbled write) */
  truncated?: boolean;
  /** estimated context (prefill) tokens the NEXT turn will carry — pressure meter */
  ctxTokens?: number;
  /** this turn ran with a one-shot thinking burst on */
  burst?: boolean;
  /** context was compacted (reset to a fresh seed) after this turn */
  compacted?: boolean;
}

/** Live streaming progress within a turn, for a "not frozen" UI. */
export interface AgentProgress {
  iteration: number;
  /** live-streamed assistant text so far this turn */
  text: string;
  /** approximate tokens generated this turn (one stream chunk ≈ one token) */
  tokens: number;
}

/**
 * One build run's configuration. NOTE: there is no `model` field — the active
 * model is owned by the Engine (engine.useModel / ensureReady), not the loop.
 */
export interface AgentConfig {
  /** what to build */
  task: string;
  /** the jail / workspace id — NEVER derived from model text */
  project: string;
  maxIterations: number;
  temperature: number;
  /** runtime errors captured from the preview iframe, fed in to seed a fix */
  consoleErrors?: string[];
  /** offer the cloud design_with_stitch tool (off = fully local) */
  useStitch?: boolean;
  /** a design system the USER pre-picked (a key in DESIGN_SYSTEMS). When set, the loop
   *  injects its CSS up front and the model uses it directly (skipping get_design_system).
   *  Empty/unset ⇒ the model chooses the style itself. */
  designStyle?: string;
  /**
   * Continue/modify an EXISTING project rather than building from scratch: the
   * loop seeds the model with the current file list and frames `task` as a change
   * to make (read before editing, prefer edit_file, keep what works).
   */
  iterate?: boolean;
  /**
   * Override the system prompt — the optimizable "skill" (SkillOpt). When unset,
   * the loop uses the built-in SYSTEM seed (or a deployed skill/system.md).
   */
  systemOverride?: string;
  /** images/audio attached to the build prompt (for a multimodal model, e.g. gemma4) */
  attachments?: Attachment[];
  /** which gateable tools (web_search/web_fetch/generate_image/run_command) are enabled */
  enabledTools?: Record<string, boolean>;
  /**
   * Enable the model's reasoning/thinking trace (default OFF). Off ⇒ the model goes
   * straight to tool calls (fast — what made the reasoning-lab builds quick); on ⇒ it
   * reasons each turn first (slower, can help hard logic). gemma4 thinks by default
   * and will spend its whole budget reasoning, so Oxy suppresses it unless asked.
   */
  thinking?: boolean;
  /** auto-compact: checkpoint + reseed a fresh small context when it fills (default ON).
   *  Off ⇒ let the context grow until truncation (for A/B testing the feature). */
  autoCompact?: boolean;
  /** one-shot reasoning bursts after an error/critique/ramble/seeded-error (default ON).
   *  Off ⇒ never auto-think on those moments (only the explicit `thinking` toggle). */
  recoveryBursts?: boolean;
}

/** A file on disk in a project, as the backend reports it. */
export interface FileEntry {
  path: string;
  bytes: number;
}

/** Project listing entry (from the backend). */
export interface ProjectInfo {
  id: string;
  files: number;
  hasIndex: boolean;
  mtime: number;
}

/** Context handed to a tool executor for each call (the jail id, etc.). */
export interface ToolContext {
  project: string;
}

/** A richer tool result: the text the model reads, plus an optional image it SEES
 *  (e.g. a screenshot from check_app) — the loop appends the image as a user turn. */
export interface ToolResult {
  text: string;
  image?: Attachment;
}

/**
 * Executes a model-requested tool and returns the short string result the model
 * sees next turn (or a {text, image} result for tools that produce a screenshot).
 * The default implementation talks to the jailed /codelab backend over HTTP, but
 * the loop only depends on this interface, so tests (and future transports) can
 * swap it freely.
 */
export interface ToolExecutor {
  call(name: string, args: any, ctx: ToolContext): Promise<string | ToolResult>;
}

/**
 * The on-disk compaction checkpoint (written as `.codelab-state.json`, hidden
 * from the model by the backend's `.codelab` prefix filter). A DETERMINISTIC
 * dump of engine-tracked ground truth — never an LLM summary.
 */
export interface Checkpoint {
  version: number;
  project: string;
  goal: string;
  files: FileEntry[];
  styleChosen: string;
  lastCritique: string;
  outstandingErrors: string[];
  toolLog: string[];
  compactions: number;
  ts: number;
}
