// Public surface of the Oxy engine-agnostic agent core.
export { runAgent } from "./loop.ts";
export type { RunAgentDeps } from "./loop.ts";
export { TOOLS, SYSTEM, STITCH_RULE, buildSystem, buildTools } from "./tools.ts";
export { DESIGN_SYSTEMS } from "./design-systems.ts";
export { HttpToolExecutor, createProject, listProjects } from "./executor.ts";
export type { HttpToolExecutorOptions } from "./executor.ts";
export { COMPACT_TRIGGER, SEED_CEILING, MAX_COMPACTIONS, CHECKPOINT_FILE, estTokens, resumePrompt } from "./compaction.ts";
export type {
  AgentConfig,
  AgentStep,
  AgentProgress,
  ToolCallRecord,
  ToolExecutor,
  ToolContext,
  ProjectInfo,
  FileEntry,
  Checkpoint,
} from "./types.ts";
