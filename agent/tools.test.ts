// Tests for tool gating — the model is only offered tools that are enabled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTools } from "./tools.ts";

const names = (opts?: Parameters<typeof buildTools>[0]) => new Set(buildTools(opts).map((t) => t.name));

test("safe tools are always offered; run_command and stitch are not, by default", () => {
  const n = names();
  for (const t of ["write_file", "edit_file", "read_file", "list_files", "get_design_system", "get_icon", "review_design", "done"]) assert.ok(n.has(t), `missing ${t}`);
  assert.ok(n.has("web_search"), "web_search defaults on");
  assert.ok(!n.has("run_command"), "run_command must be OFF by default");
  assert.ok(!n.has("design_with_stitch"), "stitch off unless opted in");
});

test("run_command is offered only when explicitly enabled", () => {
  assert.ok(!names({ enabled: { run_command: false } }).has("run_command"));
  assert.ok(names({ enabled: { run_command: true } }).has("run_command"));
});

test("disabling a default-on tool removes it", () => {
  assert.ok(!names({ enabled: { web_search: false } }).has("web_search"));
});

test("stitch is gated by its own flag", () => {
  assert.ok(names({ useStitch: true }).has("design_with_stitch"));
  assert.ok(!names({ useStitch: false }).has("design_with_stitch"));
});
