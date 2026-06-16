// The Oxy agent loop — ENGINE-AGNOSTIC.
//
// It drives ONE assistant turn at a time via `Engine.generate` and owns the
// message history itself (ChatMessage[]). Tool execution goes through a pluggable
// `ToolExecutor`. Everything that makes a weak local model punch above its weight
// lives here and depends on nothing backend-specific:
//   • auto-compact   — checkpoint ground-truth state to disk, reseed a fresh
//                       small context, so a build can exceed the context window
//                       and survive a crash/sleep.
//   • thinking-burst — reason hard for exactly ONE turn after a critique/error/
//                       truncation; the trace is shown but never persisted, so it
//                       contributes zero tokens to any later prefill.
//   • token accounting — use the engine's exact prompt/eval counts to drive the
//                       compaction trigger and a context-pressure meter.
//
// Ported from reasoning-lab's codeagent.ts: the only structural change is that the
// inline Ollama fetch + NDJSON stream collapsed into one engine.generate() call,
// and native tool calls now arrive as GenerateResult.toolCalls (already {name,
// arguments}) instead of Ollama's {function:{…}} shape.
import type { Engine, ChatMessage, GenerateResult } from "../engine/engine.ts";
import type { AgentConfig, AgentProgress, AgentStep, Checkpoint, FileEntry, ToolCallRecord, ToolExecutor } from "./types.ts";
import { buildSystem, buildTools } from "./tools.ts";
import { CHECKPOINT_FILE, COMPACT_TRIGGER, estTokens, MAX_COMPACTIONS, resumePrompt, SEED_CEILING } from "./compaction.ts";

// Generous generation budget: a full inline page can exceed 4096 tokens and
// truncating mid-tool-call corrupts the write. 8192 fits within the 16384 ctx.
const NUM_CTX = 16384;
const NUM_PREDICT = 8192;

export interface RunAgentDeps {
  /** produces one assistant turn at a time; owns the active model */
  engine: Engine;
  /** executes model-requested tools (default: HttpToolExecutor → /codelab) */
  executor: ToolExecutor;
  /** one per assistant turn */
  onStep: (step: AgentStep) => void;
  /** live token-by-token progress within a turn */
  onProgress?: (progress: AgentProgress) => void;
  signal?: AbortSignal;
}

export async function runAgent(config: AgentConfig, deps: RunAgentDeps): Promise<void> {
  const { engine, executor, onStep, onProgress, signal } = deps;
  const ctx = { project: config.project };

  const tools = buildTools(config.useStitch);
  const system = buildSystem(config.useStitch);

  // Iterate mode seeds the model with the existing files and frames the task as a
  // change to make; a fresh build seeds the task as something to create.
  let initialUser: string;
  if (config.iterate) {
    let files: FileEntry[] = [];
    try {
      files = (JSON.parse(await executor.call("list_files", {}, ctx)) as FileEntry[]).filter((f) => !String(f.path).startsWith(".codelab"));
    } catch {
      /* none yet */
    }
    initialUser = iteratePrompt(config.task, files);
  } else {
    initialUser =
      `Build this app:\n\n${config.task}\n\n` +
      (config.consoleErrors?.length
        ? `The current version produced these runtime errors in the browser — fix them:\n${config.consoleErrors.join("\n")}\n\n`
        : "") +
      `Start now. Remember: the entry file must be index.html, and call done when finished.`;
  }
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: initialUser },
  ];

  // ---- auto-compact + thinking-burst (engine-owned state; never round-tripped through the model) ----
  let compactions = 0;
  let lastCompactIter = -1;
  const toolLog: string[] = []; // deterministic per-call digest — ground truth of work done
  let lastCritique = ""; // verbatim latest review_design critique (never summarized away)
  let styleChosen = ""; // design system name once get_design_system succeeds
  const outstandingErrors: string[] = config.consoleErrors?.length ? [...config.consoleErrors] : [];
  let thinkNext = outstandingErrors.length > 0; // arm a one-shot burst for iter 0 only if seeded with errors

  // Compact at a consistent loop boundary: re-fetch the authoritative file list,
  // persist a checkpoint (survives crash/sleep), then replace the growing history
  // with a small deterministic seed. config.project (the jail) is NEVER derived
  // from model text. Returns true if the context was actually reset.
  async function compactContext(): Promise<boolean> {
    let files: FileEntry[] = [];
    try {
      const listed = await executor.call("list_files", {}, ctx);
      files = (JSON.parse(listed) as FileEntry[]).filter((f) => !String(f.path).startsWith(".codelab"));
    } catch {
      /* seed still carries goal + toolLog */
    }
    const checkpoint: Checkpoint = {
      version: 1,
      project: config.project,
      goal: config.task,
      files,
      styleChosen,
      lastCritique,
      outstandingErrors,
      toolLog: toolLog.slice(-30),
      compactions: compactions + 1,
      ts: Date.now(),
    };
    try {
      await executor.call("write_file", { path: CHECKPOINT_FILE, content: JSON.stringify(checkpoint) }, ctx);
    } catch {
      /* checkpoint is best-effort; non-fatal */
    }
    const seed: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: resumePrompt(checkpoint) },
    ];
    if (estTokens(seed) >= SEED_CEILING) return false; // can't shrink enough — let truncation surface instead of thrashing
    messages.length = 0;
    messages.push(...seed);
    return true;
  }

  for (let i = 0; i < config.maxIterations; i++) {
    if (signal?.aborted) return;
    const ranWithThink = thinkNext; // freeze the one-shot burst flag for this turn

    // One assistant turn. The engine streams tokens (for live progress), does NOT
    // execute tools, and does NOT mutate history — it just returns the turn.
    let liveTokens = 0;
    let liveText = "";
    let result: GenerateResult;
    try {
      result = await engine.generate(messages, tools, {
        temperature: config.temperature,
        numCtx: NUM_CTX,
        numPredict: NUM_PREDICT,
        think: ranWithThink,
        signal,
        onToken: (chunk) => {
          liveTokens++;
          liveText += chunk;
          onProgress?.({ iteration: i, text: liveText || "thinking / building…", tokens: liveTokens });
        },
      });
    } catch (e) {
      if (signal?.aborted) return; // abort surfaces as a throw in some engines — swallow it
      throw e;
    }
    if (signal?.aborted) return;

    const content = result.content ?? "";
    const thinking = result.thinking ?? "";
    const rawToolCalls = result.toolCalls ?? [];
    const evalCount = result.evalTokens;
    const promptEvalCount = result.promptTokens; // exact prefill the engine processed this turn
    const truncated = !!result.truncated;

    // NOTE: the thinking trace is deliberately NOT persisted into messages[] — a
    // burst must shape only the turn that produced it, contributing zero tokens to
    // any later prefill (so it can neither accumulate nor anchor). It still reaches
    // the UI via onStep({ thinking }) below for display.
    const assistantMsg: ChatMessage = { role: "assistant", content };
    if (rawToolCalls.length) assistantMsg.tool_calls = rawToolCalls;
    messages.push(assistantMsg);

    const toolCalls: ToolCallRecord[] = [];
    let turnToolChars = 0; // chars of tool results appended this turn (not yet in promptEvalCount)
    for (const tc of rawToolCalls) {
      const name = tc.name;
      const args = typeof tc.arguments === "string" ? safeParse(tc.arguments) : tc.arguments ?? {};
      const result = await executor.call(name, args, ctx);
      toolCalls.push({ name, args, result });
      // accumulate deterministic state for a possible compaction (ground truth, no extra model call)
      toolLog.push(`${name} ${args.path || args.style || args.name || ""}`.trim());
      if (name === "get_design_system" && !result.startsWith("Unknown")) styleChosen = String(args.style || "").toLowerCase();
      if (name === "review_design" && result.startsWith("DESIGN CRITIQUE:")) lastCritique = result.slice(0, 700);
      // read_file gets a larger budget so the model sees enough of a big file
      // (e.g. a Stitch-generated ~20KB page) to craft exact edit_file snippets.
      const limit = name === "read_file" ? 16000 : 4000;
      turnToolChars += Math.min(result.length, limit);
      messages.push({ role: "tool", tool_name: name, content: result.slice(0, limit) });
    }

    const isDone = toolCalls.some((t) => t.name === "done");
    // estimate the prefill the NEXT turn will carry: what the engine just counted +
    // what it generated + the tool results we just appended. Fall back to a
    // (deliberately high) char estimate if promptEvalCount is unavailable.
    const ctxTokens =
      typeof promptEvalCount === "number" ? promptEvalCount + (evalCount ?? 0) + Math.ceil(turnToolChars / 4) : estTokens(messages);

    const emit = (compacted: boolean) =>
      onStep({
        iteration: i,
        thinking: thinking || undefined,
        message: content,
        toolCalls,
        done: isDone,
        tokens: evalCount ?? liveTokens,
        truncated,
        ctxTokens,
        burst: ranWithThink,
        compacted,
      });

    if (isDone) {
      emit(false);
      return;
    }

    // arm a one-shot thinking burst for the NEXT turn iff THIS turn surfaced something
    // worth reasoning about (a critique to act on, a tool error, or a truncated write).
    // Recomputed every turn from only this turn's results => auto-resets, can't re-fire stale.
    thinkNext =
      toolCalls.some((t) => t.name === "review_design" && t.result.startsWith("DESIGN CRITIQUE:")) ||
      toolCalls.some((t) => t.result.startsWith("error:")) ||
      truncated;

    // auto-compact at this consistent boundary (messages[] is balanced here)
    let compacted = false;
    if (ctxTokens >= COMPACT_TRIGGER && rawToolCalls.length > 0 && i - lastCompactIter >= 2 && compactions < MAX_COMPACTIONS) {
      compacted = await compactContext();
      if (compacted) {
        lastCompactIter = i;
        compactions++;
        thinkNext = false; // a fresh small context needs no burst
      }
    }

    emit(compacted);

    // a turn with no tool calls and no done — nudge once (but not right after a reseed,
    // whose seed already directs the next steps). If the model rambled in prose
    // instead of calling a tool (common with weak local models), push back hard and
    // arm a reasoning burst to help it produce a real call.
    if (!rawToolCalls.length && !compacted) {
      const rambled = content.trim().length > 40;
      messages.push({
        role: "user",
        content: rambled
          ? "You replied with text but called no tool. Do NOT write code or prose in chat — the ONLY way to create the page is to CALL the write_file tool with { path, content }. Respond now with a single tool call."
          : "Continue building with tool calls, or call done if index.html is complete.",
      });
      if (rambled) thinkNext = true;
    }
  }
}

function safeParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// Seed for iterating on an existing project: give the model the current files and
// frame the task as a change, so it edits in place instead of rebuilding.
function iteratePrompt(task: string, files: FileEntry[]): string {
  return (
    `You are MODIFYING an existing project — do NOT start over or recreate files from scratch. read_file before you edit, and prefer edit_file over rewriting whole files.\n\n` +
    `FILES ALREADY ON DISK:\n${files.map((f) => `- ${f.path} (${f.bytes} bytes)`).join("\n") || "(none yet)"}\n\n` +
    `THE CHANGE TO MAKE:\n${task}\n\n` +
    `Read the relevant files first, make the change, and keep everything else working. The entry file must remain index.html. Call done when finished.`
  );
}
