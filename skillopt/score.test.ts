// Tests for the pure score-combination math. node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { combineScore, type ScoreBreakdown } from "./score.ts";

// a perfect interactive build: all dimensions declared and fully met
const base: ScoreBreakdown = {
  hasIndex: true,
  finished: true,
  noErrors: true,
  selectors: 1,
  text: 1,
  functional: 1,
  active: { selectors: true, text: true, functional: true },
  bytes: 100,
  errors: [],
  notes: [],
};

test("a perfect build scores 1", () => {
  assert.equal(combineScore(base), 1);
});

test("no index.html scores 0 regardless of other fields", () => {
  assert.equal(combineScore({ ...base, hasIndex: false }), 0);
});

test("runtime errors drop the score by the noErrors weight (0.3)", () => {
  assert.equal(combineScore({ ...base, noErrors: false }), 0.7);
});

test("not calling done drops the score by the finished weight (0.1)", () => {
  assert.equal(combineScore({ ...base, finished: false }), 0.9);
});

test("a dead mockup (all elements/text present but nothing works) scores well below a working app", () => {
  const working = combineScore(base); // functional 1
  const mockup = combineScore({ ...base, functional: 0 }); // looks right, does nothing
  assert.equal(working, 1);
  assert.equal(mockup, 0.7); // loses exactly the functional weight (0.3)
  assert.ok(working - mockup >= 0.3, "the functional dimension must separate working from mockup");
});

test("partial functional coverage scales proportionally", () => {
  // 0.1 finished + 0.3 noErrors + 0.2 selectors + 0.1 text + 0.3*0.5 functional = 0.85
  assert.equal(combineScore({ ...base, functional: 0.5 }), 0.85);
});

test("weights renormalize per task — a fully-correct STATIC task (no functional check) still scores 1", () => {
  const staticPerfect = combineScore({
    ...base,
    functional: 0, // no interaction was run...
    active: { selectors: true, text: true, functional: false }, // ...because the task declared none
  });
  assert.equal(staticPerfect, 1); // the functional weight is redistributed, not lost as a 0
});

test("a static task with errors is penalized on the renormalized scale (not the raw one)", () => {
  // active dims: finished .1 + noErrors .3 + selectors .2 + text .1 = 0.7 total
  // noErrors=false ⇒ (0.1 + 0 + 0.2 + 0.1) / 0.7 = 0.571
  const v = combineScore({ ...base, noErrors: false, functional: 0, active: { selectors: true, text: true, functional: false } });
  assert.equal(v, 0.571);
});

test("a bare page (renders, but missing everything) is now well BELOW 0.5 (de-inflated)", () => {
  const bare = combineScore({ ...base, finished: false, selectors: 0, text: 0, functional: 0 });
  // 0 finished + 0.3 noErrors + 0 + 0 + 0 = 0.3 — no free hasIndex credit anymore
  assert.equal(bare, 0.3);
  assert.ok(bare < combineScore(base));
});
