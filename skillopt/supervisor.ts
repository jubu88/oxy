// Continuous skill improvement from REAL builds. After each chat build a supervisor
// (a strong model) reviews what the small model did — its tool sequence, whether it
// finished, errors — and journals general, procedural lessons. A separate GATED
// promote (promote.ts) turns accumulated lessons into a validated skill edit.
//
// Split of responsibilities (the user's "watch always, deploy gated"):
//   watch   = continuous + cheap (cloud review per build) → journal.jsonl
//   deploy  = gated (a journal-seeded edit must pass the benchmark before it lands)
// so the skill file improves over time but can never silently degrade.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Engine } from "../engine/engine.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const JOURNAL_PATH = path.join(HERE, "journal.jsonl");

export interface BuildSummary {
  task: string;
  project: string;
  toolLog: string[]; // the tool-call sequence the agent ran
  finished: boolean; // did it call done()
  errors: string[]; // runtime errors if known
  fileCount: number;
  iterate: boolean;
}

export interface ReviewEntry {
  ts: number;
  task: string;
  project: string;
  finished: boolean;
  wins: string[];
  mistakes: string[];
  /** ONE general, procedural lesson for the skill (not task-specific); "" if none */
  lesson: string;
  /** already folded into a skill-edit proposal by promote.ts */
  consumed?: boolean;
}

/** Pull the first balanced {...} object out of a model reply (tolerates fences/prose). */
export function extractJson(text: string): any | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

const asStrings = (v: any): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()).slice(0, 6) : []);

/** Shape a raw supervisor reply into a ReviewEntry (pure — unit-tested). */
export function toReviewEntry(b: BuildSummary, raw: string, now: number): ReviewEntry | null {
  const j = extractJson(raw);
  if (!j) return null;
  return {
    ts: now,
    task: b.task.slice(0, 200),
    project: b.project,
    finished: b.finished,
    wins: asStrings(j.wins),
    mistakes: asStrings(j.mistakes),
    lesson: typeof j.lesson === "string" ? j.lesson.trim() : "",
  };
}

function reviewPrompt(b: BuildSummary, skill: string): string {
  return `You supervise a SMALL local model that builds web apps by calling tools (write_file, edit_file, get_design_system, get_icon, generate_image, review_design, done). Review ONE build and extract lessons to improve its SYSTEM instructions (the "skill").

CURRENT SKILL (for context — do not repeat it back):
"""
${skill.slice(0, 1500)}
"""

BUILD:
- task: ${b.task}
- iterate (editing an existing project): ${b.iterate}
- finished (called done): ${b.finished}
- tool sequence: ${b.toolLog.join(" → ") || "(no tool calls)"}
- files produced: ${b.fileCount}
- runtime errors: ${b.errors.slice(0, 5).join("; ") || "none"}

What did the agent do WELL and WRONG, and ONE general, procedural lesson that would make the skill produce better builds in FUTURE (must generalize — do NOT mention this specific task; "" if nothing actionable).
Output ONLY JSON: {"wins":[..],"mistakes":[..],"lesson":".."}`;
}

/** Review one build with the supervisor model and append the lesson to the journal.
 *  Best-effort: returns null (and writes nothing) on any failure — never breaks a build. */
export async function reviewBuild(b: BuildSummary, supervisor: Engine, skill: string, now: number = Date.now()): Promise<ReviewEntry | null> {
  let raw: string;
  try {
    const res = await supervisor.generate([{ role: "user", content: reviewPrompt(b, skill) }], [], { temperature: 0.3, numCtx: 8192, numPredict: 600 });
    raw = res.content || "";
  } catch {
    return null;
  }
  const entry = toReviewEntry(b, raw, now);
  if (entry) appendJournal(entry);
  return entry;
}

export function appendJournal(e: ReviewEntry): void {
  try {
    fs.appendFileSync(JOURNAL_PATH, JSON.stringify(e) + "\n", "utf8");
  } catch {
    /* best-effort */
  }
}

export function readJournal(): ReviewEntry[] {
  try {
    return fs
      .readFileSync(JOURNAL_PATH, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ReviewEntry);
  } catch {
    return [];
  }
}

export function unconsumedCount(): number {
  return readJournal().filter((e) => !e.consumed).length;
}

/** Mark all current entries consumed (after a promote folds their lessons into an edit). */
export function markAllConsumed(): void {
  const all = readJournal().map((e) => ({ ...e, consumed: true }));
  try {
    fs.writeFileSync(JOURNAL_PATH, all.map((e) => JSON.stringify(e)).join("\n") + (all.length ? "\n" : ""), "utf8");
  } catch {
    /* best-effort */
  }
}

/** Digest the unconsumed lessons/mistakes for the optimizer's promote prompt. */
export function journalDigest(limit = 40): string {
  const fresh = readJournal().filter((e) => !e.consumed).slice(-limit);
  if (!fresh.length) return "";
  const lessons = fresh.map((e) => e.lesson).filter(Boolean);
  const mistakes = fresh.flatMap((e) => e.mistakes);
  const finishRate = fresh.filter((e) => e.finished).length / fresh.length;
  const tally = (xs: string[]) => {
    const m = new Map<string, number>();
    for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, n]) => `- (${n}×) ${t}`);
  };
  return [`Real builds reviewed: ${fresh.length} · finished rate ${(finishRate * 100).toFixed(0)}%`, `Recurring mistakes:\n${tally(mistakes).join("\n") || "- none"}`, `Proposed lessons:\n${tally(lessons).join("\n") || "- none"}`].join("\n\n");
}
