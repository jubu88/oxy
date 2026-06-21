// Tests for the auto-promote log parser. node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAutoPromoteLog, autoLearnProgress } from "./autolearn.mjs";

const HEAD = "=== Oxy SkillOpt · gated promote ===";

// a real-shaped mid-run log: base fully scored, candidate partway, not finished
const MID = `
${HEAD}
target: llama-server (hf:unsloth/gemma-4-E2B-it-GGUF:Q4_K_M) · optimizer: ollama (gpt-oss:120b-cloud)
journal: 10 fresh review(s) · val: 10 · repeats: 1 · margin: 0.03
Real builds reviewed: 10 · finished rate 50%
[promote] scoring current skill on the held-out benchmark…
      calculator: 1.00 (1.00)
      clock: 1.00 (1.00)
      calc-precedence: 0.56 (0.56)
      todomvc: 0.70 (0.70)
[promote] current skill val: 0.916
[promote] asking optimizer for a journal-informed edit…
[promote] scoring the candidate skill…
      calculator: 0.89 (0.89)
      clock: 0.50 (0.50)
`;

test("parses a mid-run log: phase, base score, per-task buckets, not finished", () => {
  const st = parseAutoPromoteLog(MID);
  assert.equal(st.found, true);
  assert.equal(st.phase, "scoring-candidate");
  assert.equal(st.finished, false);
  assert.equal(st.valTotal, 10);
  assert.equal(st.repeats, 1);
  assert.equal(st.finishRate, 50);
  assert.equal(st.base.score, 0.916);
  assert.equal(st.base.perTask.length, 4); // task lines under "scoring current skill"
  assert.equal(st.candidate.perTask.length, 2); // task lines under "scoring the candidate"
  assert.deepEqual(st.candidate.perTask[1], { id: "clock", score: 0.5 });
  assert.equal(st.candidate.proposed, true);
  assert.equal(st.deployed, null); // undecided mid-run
});

test("progress counts builds across base + candidate passes", () => {
  const p = autoLearnProgress(parseAutoPromoteLog(MID));
  assert.equal(p.perPass, 10);
  assert.equal(p.total, 20); // base pass + candidate pass, 10 tasks each
  assert.equal(p.done, 6); // 4 base + 2 candidate so far
});

test("parses a finished + rejected run", () => {
  const st = parseAutoPromoteLog(`${MID}
[promote] candidate val 0.812 vs current 0.916 (margin 0.03) · regression-free: false
[promote] rejected — skill/system.md unchanged

=== promote done — no change ===
`);
  assert.equal(st.finished, true);
  assert.equal(st.deployed, false);
  assert.equal(st.outcome, "no change");
  assert.equal(st.candidate.score, 0.812);
  assert.equal(st.base.score, 0.916);
});

test("parses a finished + accepted run", () => {
  const st = parseAutoPromoteLog(`${HEAD}
journal: 12 fresh review(s) · val: 10 · repeats: 1 · margin: 0.03
[promote] scoring current skill on the held-out benchmark…
      calculator: 0.80 (0.80)
[promote] current skill val: 0.800
[promote] scoring the candidate skill…
      calculator: 0.95 (0.95)
[promote] candidate val 0.950 vs current 0.800 (margin 0.03) · regression-free: true
[promote] ACCEPTED ✅ — deployed to skill/system.md

=== promote done — skill improved ===
`);
  assert.equal(st.finished, true);
  assert.equal(st.deployed, true);
  assert.equal(st.outcome, "skill improved");
});

test("optimizer proposed no change → candidate not proposed, no candidate pass expected", () => {
  const st = parseAutoPromoteLog(`${HEAD}
journal: 11 fresh review(s) · val: 10 · repeats: 1 · margin: 0.03
[promote] scoring current skill on the held-out benchmark…
      calculator: 1.00 (1.00)
[promote] current skill val: 1.000
[promote] optimizer proposed no change.

=== promote done — no change ===
`);
  assert.equal(st.candidate.proposed, false);
  assert.equal(st.deployed, false);
  const p = autoLearnProgress(st);
  assert.equal(p.total, 10); // only the base pass counts
});

test("empty / no run logged → found:false", () => {
  assert.equal(parseAutoPromoteLog("").found, false);
  assert.equal(parseAutoPromoteLog("some unrelated text\n").found, false);
  assert.equal(autoLearnProgress(parseAutoPromoteLog("")), null);
});

test("parses only the most recent run when the log has several", () => {
  const st = parseAutoPromoteLog(`${HEAD}
journal: 5 fresh review(s) · val: 10 · repeats: 1 · margin: 0.03
[promote] current skill val: 0.500

=== promote done — no change ===
${HEAD}
journal: 10 fresh review(s) · val: 10 · repeats: 1 · margin: 0.03
[promote] current skill val: 0.916
`);
  assert.equal(st.reviewed, 10); // from the SECOND run, not the first
  assert.equal(st.base.score, 0.916);
  assert.equal(st.finished, false);
});
