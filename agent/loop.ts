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
import { codeBlocksToWrites } from "../engine/tool-parse.ts";
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
  /** out-of-band status (e.g. a managed-engine reboot mid-generate) for the UI */
  onNotice?: (message: string) => void;
  signal?: AbortSignal;
}

export async function runAgent(config: AgentConfig, deps: RunAgentDeps): Promise<void> {
  const { engine, executor, onStep, onProgress, onNotice, signal } = deps;
  const ctx = { project: config.project };

  const tools = buildTools({ useStitch: config.useStitch, enabled: config.enabledTools });
  const toolNames = new Set(tools.map((t) => t.name)); // for recovering coder-style code blocks as writes
  const system = buildSystem(config.useStitch, config.systemOverride);

  // Files known to exist on disk (lowercased, top-level-normalized). Drives the
  // done-guard below: the build can't FINISH without a renderable entry page
  // (index.html), regardless of the order files were written in. Seeded from disk
  // on iterate, unioned on compaction, and updated on every successful write_file.
  const filesPresent = new Set<string>();
  const normPath = (p: unknown) =>
    String(p ?? "").trim().replace(/\\/g, "/").replace(/^\.?\/+/, "").toLowerCase();

  // The user pre-picked a design system? Fetch its tokens now and inject them so the
  // model uses them directly — skipping the get_design_system turn. Fresh builds only.
  let designSeed = "";
  if (!config.iterate && config.designStyle) {
    try {
      const ds = await executor.call("get_design_system", { style: config.designStyle }, ctx);
      const dsText = typeof ds === "string" ? ds : ds.text;
      if (dsText && !dsText.startsWith("Unknown")) {
        designSeed = `\n\nThe user picked this design system — USE these CSS variables directly and do NOT call get_design_system:\n${dsText}\n`;
      }
    } catch {
      /* fall back to a model-chosen style */
    }
  }

  // Iterate mode seeds the model with the existing files and frames the task as a
  // change to make; a fresh build seeds the task as something to create.
  let initialUser: string;
  if (config.iterate) {
    let files: FileEntry[] = [];
    try {
      const listed = await executor.call("list_files", {}, ctx);
      files = (JSON.parse(typeof listed === "string" ? listed : listed.text) as FileEntry[]).filter((f) => !String(f.path).startsWith(".codelab"));
    } catch {
      /* none yet */
    }
    for (const f of files) filesPresent.add(normPath(f.path)); // seed the done-guard from what's already on disk
    initialUser = iteratePrompt(config.task, files, config.projectGoal);
  } else {
    initialUser =
      `Build this app:\n\n${config.task}\n${designSeed}\n` +
      (config.consoleErrors?.length
        ? `The current version produced these runtime errors in the browser — fix them:\n${config.consoleErrors.join("\n")}\n\n`
        : "") +
      `Start now. Remember: the entry file must be index.html, and call done when finished.`;
  }
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    // attachments (images/audio) ride on the first user turn; after a compaction
    // the resume seed is text-only (the built files carry the result forward)
    { role: "user", content: initialUser, attachments: config.attachments?.length ? config.attachments : undefined },
  ];

  // ---- auto-compact + thinking-burst (engine-owned state; never round-tripped through the model) ----
  let compactions = 0;
  let lastCompactIter = -1;
  const toolLog: string[] = []; // deterministic per-call digest — ground truth of work done
  let lastCritique = ""; // verbatim latest review_design critique (never summarized away)
  let styleChosen = designSeed ? (config.designStyle || "").toLowerCase() : ""; // pre-picked, or set once get_design_system succeeds
  const outstandingErrors: string[] = config.consoleErrors?.length ? [...config.consoleErrors] : [];
  // Thinking defaults OFF for speed (gemma4 otherwise spends its whole budget on a
  // reasoning trace before acting — the "5 min, no output" cause). The user toggle
  // forces it ON every turn; OFF still arms sparing one-shot bursts only when a turn
  // needs it (critique/error/truncation/ramble). This requires the engine to actually
  // honor `think` — openai-compat now sends enable_thinking so llama-server's gemma4
  // stops thinking when told (it ignored it before, so it always thought = slow).
  const thinkingOn = !!config.thinking;
  const recoveryBursts = config.recoveryBursts !== false; // default ON (A/B toggle)
  // think on turn 0 if the user enabled thinking OR (recovery on AND) we were seeded
  // with runtime errors to fix (a one-shot burst helps reason about the fix).
  let thinkNext = thinkingOn || (recoveryBursts && outstandingErrors.length > 0);

  // Compact at a consistent loop boundary: re-fetch the authoritative file list,
  // persist a checkpoint (survives crash/sleep), then replace the growing history
  // with a small deterministic seed. config.project (the jail) is NEVER derived
  // from model text. Returns true if the context was actually reset.
  async function compactContext(): Promise<boolean> {
    let files: FileEntry[] = [];
    try {
      const listed = await executor.call("list_files", {}, ctx);
      files = (JSON.parse(typeof listed === "string" ? listed : listed.text) as FileEntry[]).filter((f) => !String(f.path).startsWith(".codelab"));
    } catch {
      /* seed still carries goal + toolLog */
    }
    for (const f of files) filesPresent.add(normPath(f.path)); // keep the done-guard's view current after a reseed
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

  let consecutiveNoAction = 0; // give up if a weak model can't emit tool calls turn after turn
  let doneBlocked = 0; // times we refused `done` for a missing index.html (bounded so a build is never trapped)
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
        onNotice,
        onToken: (chunk) => {
          liveText += chunk; // content only (used for the downstream-dropped progress text)
        },
        onProgressTick: () => {
          // count EVERY generated token — content, reasoning, OR tool-call arg — so the
          // meter reflects real work instead of sitting at 0 while the model thinks or
          // streams a write_file body.
          liveTokens++;
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
    let rawToolCalls = result.toolCalls ?? [];
    // Coder models (e.g. Qwen2.5-Coder) often emit the app as ```html/```css/```js blocks
    // instead of calling write_file, so the loop would see "no action" and write nothing.
    // Recover those blocks as write_file calls. No-op for models that tool-call correctly
    // (they don't reach here with an empty toolCalls list).
    if (!rawToolCalls.length) {
      const recovered = codeBlocksToWrites(content, toolNames);
      if (recovered.length) rawToolCalls = recovered;
    }
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
      const raw = await executor.call(name, args, ctx);
      const result = typeof raw === "string" ? raw : raw.text; // a tool may return {text, image}
      const image = typeof raw === "string" ? undefined : raw.image;
      toolCalls.push({ name, args, result });
      // accumulate deterministic state for a possible compaction (ground truth, no extra model call)
      toolLog.push(`${name} ${args.path || args.style || args.name || ""}`.trim());
      if (name === "write_file" && !result.startsWith("error:")) filesPresent.add(normPath(args.path));
      if (name === "get_design_system" && !result.startsWith("Unknown")) styleChosen = String(args.style || "").toLowerCase();
      if (name === "review_design" && result.startsWith("DESIGN CRITIQUE:")) lastCritique = result.slice(0, 700);
      // read_file gets a larger budget so the model sees enough of a big file
      // (e.g. a Stitch-generated ~20KB page) to craft exact edit_file snippets.
      const limit = name === "read_file" ? 16000 : 4000;
      turnToolChars += Math.min(result.length, limit);
      messages.push({ role: "tool", tool_name: name, content: result.slice(0, limit) });
      // a tool that produced an image (check_app's screenshot) — surface it to the model
      // as a USER turn so it can actually SEE its app (tool messages can't carry images in
      // the OpenAI/Ollama shape). Dropped on the next compaction; that's fine.
      if (image) {
        messages.push({
          role: "user",
          content: "Screenshot of your app's current state — confirm it looks right and the interaction worked; then fix with edit_file or call done.",
          attachments: [image],
        });
        turnToolChars += 900; // rough image prefill budget
      }
    }

    let isDone = toolCalls.some((t) => t.name === "done");
    // Refuse to FINISH without a renderable entry page. A weak/coder model sometimes
    // writes only app.js/style.css (or a placeholder) and calls done — leaving a project
    // that can't render ("not found"). The order files are written in doesn't matter, only
    // that index.html exists by the time the model finishes. We track writes in-loop (fast
    // path) and, only when that view lacks index.html, do ONE authoritative disk check
    // before refusing (covers resume / tracking gaps). Bounded so a model that truly can't
    // produce it isn't trapped — the post-build check then flags the missing page.
    if (isDone && doneBlocked < 3 && !filesPresent.has("index.html")) {
      let hasIndex = false;
      try {
        const listed = await executor.call("list_files", {}, ctx);
        const onDisk = JSON.parse(typeof listed === "string" ? listed : listed.text) as FileEntry[];
        hasIndex = onDisk.some((f) => normPath(f.path) === "index.html");
      } catch {
        hasIndex = true; // can't verify (infra error) — don't trap the build on it
      }
      if (hasIndex) {
        filesPresent.add("index.html");
      } else {
        isDone = false;
        doneBlocked++;
        messages.push({
          role: "user",
          content:
            "You called done, but no index.html exists yet — the app has no entry page and will not render. Before finishing you MUST create index.html with write_file: a COMPLETE HTML document — <!DOCTYPE html>, a <head> that links any style.css/app.js you wrote, and a <body> with the real UI. Write index.html now, then call done.",
        });
      }
    }
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

    // thinking for the NEXT turn: the user toggle forces it ON for EVERY turn; with
    // the toggle off (default) we still arm a one-shot burst only when THIS turn
    // surfaced something worth reasoning about — a design critique to act on, a tool
    // error, or a truncated write. Recomputed each turn ⇒ auto-resets, never stale.
    thinkNext =
      thinkingOn ||
      (recoveryBursts &&
        (toolCalls.some((t) => t.name === "review_design" && t.result.startsWith("DESIGN CRITIQUE:")) ||
          toolCalls.some((t) => t.result.startsWith("error:")) ||
          truncated));

    // auto-compact at this consistent boundary (messages[] is balanced here)
    let compacted = false;
    if (config.autoCompact !== false && ctxTokens >= COMPACT_TRIGGER && rawToolCalls.length > 0 && i - lastCompactIter >= 2 && compactions < MAX_COMPACTIONS) {
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
    if (rawToolCalls.length) {
      consecutiveNoAction = 0;
    } else if (!compacted) {
      // give up if the model produces no tool call several turns running (a weak model
      // that can't drive the loop) instead of burning the whole step budget on dead turns.
      if (++consecutiveNoAction >= 3) {
        onNotice?.("stopped: the model produced no tool calls for 3 turns running — it can't drive this build. Try a different model.");
        return;
      }
      const rambled = content.trim().length > 40;
      messages.push({
        role: "user",
        content: rambled
          ? "You replied with text but called no tool. Do NOT write code or prose in chat — the ONLY way to create the page is to CALL the write_file tool with { path, content }. Respond now with a single tool call."
          : "Continue building with tool calls, or call done if index.html is complete.",
      });
      if (rambled && recoveryBursts) thinkNext = true; // one-shot recovery burst (gated by the feature) — a model that rambled needs the nudge to emit a real tool call
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
function iteratePrompt(task: string, files: FileEntry[], goal?: string): string {
  return (
    `You are MODIFYING an existing project — do NOT start over or recreate files from scratch. read_file before you edit, and prefer edit_file over rewriting whole files.\n\n` +
    (goal?.trim() ? `WHAT THIS PROJECT IS (the original request — preserve its intent while making the change):\n${goal.trim()}\n\n` : "") +
    `FILES ALREADY ON DISK:\n${files.map((f) => `- ${f.path} (${f.bytes} bytes)`).join("\n") || "(none yet)"}\n\n` +
    `THE CHANGE TO MAKE:\n${task}\n\n` +
    `Read the relevant files first, make the change, and keep everything else working. The entry file must remain index.html. Call done when finished.`
  );
}
