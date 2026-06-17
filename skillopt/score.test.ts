// Tests for the pure score-combination math. node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { combineScore, type ScoreBreakdown } from "./score.ts";

const base: ScoreBreakdown = { hasIndex: true, finished: true, noErrors: true, selectors: 1, text: 1, bytes: 100, errors: [], notes: [] };

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

test("partial selector/text coverage scales proportionally", () => {
  // hasIndex .2 + finished .1 + noErrors .3 + selectors .3*0.5 + text .1*0 = 0.75
  assert.equal(combineScore({ ...base, selectors: 0.5, text: 0 }), 0.75);
});

test("a bare page (renders, but missing everything) is well below a complete one", () => {
  const bare = combineScore({ ...base, finished: false, selectors: 0, text: 0 });
  assert.ok(bare < combineScore(base));
  assert.ok(bare >= 0.5); // still got hasIndex + noErrors
});
