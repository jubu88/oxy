// Unit tests for the gated auto-promote trigger decision (server/auto-promote.mjs).
// The real promote runs a slow benchmark, so the DECISION to fire is what we lock
// down here: it must fire exactly at the threshold, and every guard must block it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldAutoPromote } from "./auto-promote.mjs";

// idle, enabled, exactly at the default cadence
const ready = { fresh: 10, every: 10, promoteRunning: false, activeBuilds: 0, disabled: false };

test("fires when enough lessons have banked and nothing blocks it", () => {
  assert.equal(shouldAutoPromote(ready), true);
});

test("fires above the threshold too", () => {
  assert.equal(shouldAutoPromote({ ...ready, fresh: 37 }), true);
});

test("does NOT fire below the threshold (off-by-one guard)", () => {
  assert.equal(shouldAutoPromote({ ...ready, fresh: 9 }), false);
});

test("never fires while a build is in flight (no llama-server contention)", () => {
  assert.equal(shouldAutoPromote({ ...ready, activeBuilds: 1 }), false);
  assert.equal(shouldAutoPromote({ ...ready, activeBuilds: 3 }), false);
});

test("never fires while a promote is already running (no double-spawn)", () => {
  assert.equal(shouldAutoPromote({ ...ready, promoteRunning: true }), false);
});

test("respects the disable switch (OXY_AUTO_PROMOTE=0 / Settings auto-learn off)", () => {
  assert.equal(shouldAutoPromote({ ...ready, disabled: true }), false);
});

test("a custom cadence is honoured", () => {
  assert.equal(shouldAutoPromote({ ...ready, fresh: 10, every: 20 }), false);
  assert.equal(shouldAutoPromote({ ...ready, fresh: 20, every: 20 }), true);
});

test("a non-finite or non-positive input never fires", () => {
  assert.equal(shouldAutoPromote({ ...ready, fresh: NaN }), false);
  assert.equal(shouldAutoPromote({ ...ready, fresh: 10, every: 0 }), false);
  assert.equal(shouldAutoPromote({ ...ready, fresh: 10, every: NaN }), false);
});
