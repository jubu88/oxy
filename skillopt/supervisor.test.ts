// Tests for the supervisor's pure parsing/shaping logic (no engine, no fs writes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, toReviewEntry, type BuildSummary } from "./supervisor.ts";

test("extractJson pulls a balanced object out of fences/prose/nesting", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson("```json\n{\"x\":2}\n```"), { x: 2 });
  assert.deepEqual(extractJson('sure, here: {"wins":["a"],"lesson":"y"} — done'), { wins: ["a"], lesson: "y" });
  assert.deepEqual(extractJson('{"a":{"b":1},"c":2}'), { a: { b: 1 }, c: 2 });
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson('{"broken": '), null);
});

const build: BuildSummary = { task: "build a thing", project: "p1", toolLog: ["write_file", "done"], finished: true, errors: [], fileCount: 1, iterate: false };

test("toReviewEntry shapes a valid reply (arrays, lesson, ts, task)", () => {
  const e = toReviewEntry(build, '{"wins":["called done"],"mistakes":["no design system"],"lesson":"always call get_design_system first"}', 123)!;
  assert.equal(e.ts, 123);
  assert.equal(e.project, "p1");
  assert.equal(e.finished, true);
  assert.deepEqual(e.wins, ["called done"]);
  assert.deepEqual(e.mistakes, ["no design system"]);
  assert.equal(e.lesson, "always call get_design_system first");
});

test("toReviewEntry coerces missing/wrong-typed fields safely", () => {
  const e = toReviewEntry(build, '{"mistakes":"oops not an array","lesson":42}', 1)!;
  assert.deepEqual(e.wins, []); // missing → []
  assert.deepEqual(e.mistakes, []); // non-array → []
  assert.equal(e.lesson, ""); // non-string → ""
});

test("toReviewEntry returns null when there is no JSON", () => {
  assert.equal(toReviewEntry(build, "the model rambled with no json", 1), null);
});

test("toReviewEntry truncates an overlong task", () => {
  const long = { ...build, task: "x".repeat(500) };
  const e = toReviewEntry(long, '{"lesson":"keep files small"}', 1)!;
  assert.equal(e.task.length, 200);
});
