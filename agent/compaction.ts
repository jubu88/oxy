// Auto-compact constants + the deterministic resume seed.
//
// When context pressure crosses COMPACT_TRIGGER, the loop writes a checkpoint
// (a deterministic dump of ground-truth state — NOT an LLM summary) and replaces
// the whole history with a tiny seed: the system prompt + a resume prompt built
// from the checkpoint. This lets a small model build things larger than its
// context window, and makes a build resumable after a crash/sleep. The actual
// reseed lives in the loop (it owns the message history); the reusable pieces are
// here.
import type { ChatMessage } from "../engine/engine.ts";
import type { Checkpoint } from "./types.ts";

/** tokens (~67% of num_ctx 16384) — leaves room for one read_file(16000≈4-5k)+write */
export const COMPACT_TRIGGER = 11000;
/** if the fresh seed still estimates above this, don't reseed (anti-thrash) */
export const SEED_CEILING = 5500;
export const MAX_COMPACTIONS = 8;
/** checkpoint filename — the `.codelab` prefix hides it from the model & exports */
export const CHECKPOINT_FILE = ".codelab-state.json";

/** Cheap char-based token estimate (fallback when the engine reports no counts). */
export const estTokens = (msgs: ChatMessage[]): number => Math.ceil(JSON.stringify(msgs).length / 3.5);

// Deterministic resume prompt built from a compaction checkpoint. Seeds the file
// LIST (never contents — forces read_file on demand) plus verbatim outstanding
// issues, and explicitly tells the model to continue (not restart) so it edits
// rather than clobbers verified work.
export function resumePrompt(cp: Checkpoint): string {
  const files = cp.files ?? [];
  return (
    `You are CONTINUING an in-progress build — the conversation was compacted to stay small, so earlier turns are gone. Do NOT start over and do NOT recreate files from scratch.\n\n` +
    `GOAL:\n${cp.goal}\n\n` +
    `FILES ALREADY ON DISK (the real current state — read_file before you edit, and prefer edit_file over rewriting):\n${files.map((f) => `- ${f.path} (${f.bytes} bytes)`).join("\n") || "(none yet)"}\n\n` +
    (cp.styleChosen
      ? `DESIGN SYSTEM ALREADY CHOSEN: ${cp.styleChosen} — its CSS variables are already in the files; do NOT call get_design_system again, read_file the stylesheet if you need the tokens.\n\n`
      : "") +
    (cp.outstandingErrors?.length ? `RUNTIME ERRORS REPORTED AT THE START (verify each is still present before changing code — some may already be fixed):\n${cp.outstandingErrors.join("\n")}\n\n` : "") +
    (cp.lastCritique ? `LATEST DESIGN CRITIQUE STILL TO ADDRESS (verbatim — fix these specifically):\n${cp.lastCritique}\n\n` : "") +
    `WORK DONE SO FAR:\n${(cp.toolLog ?? []).join("\n") || "(nothing yet)"}\n\n` +
    `NEXT STEPS: call list_files to orient, then continue the remaining work. If you have not reviewed the page yet, call review_design, then fix issues with edit_file. Call done when finished.\n\n` +
    `Continue now with tool calls. The entry file must be index.html.`
  );
}
