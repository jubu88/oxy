// Tests for the SkillOpt loop control flow, using fake eval + optimizer (so the
// validation-gate / accept / deploy logic is verified without real builds). node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { optimizeSkill, type EvalResult } from "./loop.ts";
import type { Task } from "./score.ts";

const SCORES: Record<string, number> = { A: 0.5, B: 0.8, C: 0.4, D: 0.5, E: 0.9 };
const fakeEval = (skill: string): Promise<EvalResult> => Promise.resolve({ score: SCORES[skill] ?? 0, rollouts: [] });
const T: Task[] = [{ id: "t", prompt: "p" }];

test("accepts an improving candidate and deploys it", async () => {
  const deployed: string[] = [];
  const r = await optimizeSkill({
    seedSkill: "A",
    trainTasks: T,
    valTasks: T,
    evalSkill: fakeEval,
    proposeEdit: async () => "B",
    deploy: (s) => void deployed.push(s),
  });
  assert.equal(r.seedScore, 0.5);
  assert.equal(r.bestSkill, "B");
  assert.equal(r.bestScore, 0.8);
  assert.equal(r.accepted, 1);
  assert.deepEqual(deployed, ["B"]);
});

test("rejects a worse candidate; best + deploy unchanged", async () => {
  const deployed: string[] = [];
  const r = await optimizeSkill({
    seedSkill: "A",
    trainTasks: T,
    valTasks: T,
    evalSkill: fakeEval,
    proposeEdit: async () => "C", // 0.4 < 0.5
    deploy: (s) => void deployed.push(s),
  });
  assert.equal(r.bestSkill, "A");
  assert.equal(r.accepted, 0);
  assert.deepEqual(deployed, []);
});

test("validation gate is strict — an equal-scoring candidate is rejected", async () => {
  const r = await optimizeSkill({ seedSkill: "A", trainTasks: T, valTasks: T, evalSkill: fakeEval, proposeEdit: async () => "D" }); // 0.5 == 0.5
  assert.equal(r.bestSkill, "A");
  assert.equal(r.accepted, 0);
});

test("a no-op edit (same skill) is skipped without a validation eval", async () => {
  let evalCalls = 0;
  const r = await optimizeSkill({
    seedSkill: "A",
    trainTasks: T,
    valTasks: T,
    evalSkill: (s) => {
      evalCalls++;
      return fakeEval(s);
    },
    proposeEdit: async () => "A", // identical → skip
  });
  assert.equal(r.accepted, 0);
  assert.equal(evalCalls, 2); // seed val + one train rollout; NO candidate val
});

test("improves monotonically across batches (each accepted edit raises the bar)", async () => {
  const cands = ["B", "E"]; // 0.8 then 0.9
  let i = 0;
  const r = await optimizeSkill({
    seedSkill: "A",
    trainTasks: [{ id: "t1", prompt: "p" }, { id: "t2", prompt: "p" }],
    valTasks: T,
    batchSize: 1,
    evalSkill: fakeEval,
    proposeEdit: async () => cands[i++],
  });
  assert.equal(r.bestSkill, "E");
  assert.equal(r.bestScore, 0.9);
  assert.equal(r.accepted, 2);
});

test("acceptance margin rejects a candidate that improves by less than the noise band", async () => {
  // B (0.8) beats A (0.5) by 0.3, but the margin is 0.4 → not enough
  const r = await optimizeSkill({ seedSkill: "A", trainTasks: T, valTasks: T, acceptMargin: 0.4, evalSkill: fakeEval, proposeEdit: async () => "B" });
  assert.equal(r.bestSkill, "A");
  assert.equal(r.accepted, 0);
});

test("no-regression guard rejects a higher-mean candidate that regresses a single val task", async () => {
  // seed mean 0.5 (t1 .5, t2 .5); candidate mean 0.55 (t1 .9, t2 .2) — t2 regressed beyond margin 0
  const evalPerTask = (skill: string): Promise<EvalResult> =>
    skill === "SEED"
      ? Promise.resolve({ score: 0.5, rollouts: [], perTask: [{ id: "t1", score: 0.5 }, { id: "t2", score: 0.5 }] })
      : Promise.resolve({ score: 0.55, rollouts: [], perTask: [{ id: "t1", score: 0.9 }, { id: "t2", score: 0.2 }] });
  const deployed: string[] = [];
  const r = await optimizeSkill({
    seedSkill: "SEED",
    trainTasks: [{ id: "t1", prompt: "p" }, { id: "t2", prompt: "p" }],
    valTasks: [{ id: "t1", prompt: "p" }, { id: "t2", prompt: "p" }],
    evalSkill: evalPerTask,
    proposeEdit: async () => "CAND",
    deploy: (s) => void deployed.push(s),
  });
  assert.equal(r.bestSkill, "SEED");
  assert.equal(r.accepted, 0);
  assert.deepEqual(deployed, []);
});
