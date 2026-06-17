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
