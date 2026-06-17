// Tests for the engine-agnostic tool-call/reasoning parsers. node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTextToolCalls, splitReasoning } from "./tool-parse.ts";

const KNOWN = new Set(["get_design_system", "write_file", "done", "get_icon"]);

test("parseTextToolCalls extracts a fenced ```json tool call (the small-model case)", () => {
  const content = '```json\n{\n  "name": "get_design_system",\n  "arguments": { "style": "modern-saas" }\n}\n```';
  const r = parseTextToolCalls(content, KNOWN);
  assert.deepEqual(r.toolCalls, [{ name: "get_design_system", arguments: { style: "modern-saas" } }]);
  assert.equal(r.content, "");
});

test("parseTextToolCalls handles a bare JSON object and tolerant shapes", () => {
  assert.deepEqual(parseTextToolCalls('{"tool":"done","args":{"summary":"x"}}', KNOWN).toolCalls, [{ name: "done", arguments: { summary: "x" } }]);
  assert.deepEqual(parseTextToolCalls('{"function":{"name":"write_file","arguments":{"path":"a.html"}}}', KNOWN).toolCalls, [
    { name: "write_file", arguments: { path: "a.html" } },
  ]);
});

test("parseTextToolCalls keeps prose and strips only the call block", () => {
  const r = parseTextToolCalls('Sure, here goes:\n```json\n{"name":"write_file","arguments":{"path":"index.html","content":"<h1>hi</h1>"}}\n```', KNOWN);
  assert.equal(r.toolCalls[0].name, "write_file");
  assert.equal(r.content, "Sure, here goes:");
});

test("parseTextToolCalls ignores JSON that isn't a known tool (no false positives)", () => {
  assert.deepEqual(parseTextToolCalls('```json\n{"name":"Stillness","theme":"dark"}\n```', KNOWN).toolCalls, []);
  assert.deepEqual(parseTextToolCalls('{"title":"my app","version":1}', KNOWN).toolCalls, []);
});

test("splitReasoning extracts <think> into a separate channel", () => {
  const r = splitReasoning("<think>let me plan</think>Here is the page.");
  assert.equal(r.thinking, "let me plan");
  assert.equal(r.content, "Here is the page.");
});

test("splitReasoning leaves plain text untouched", () => {
  const r = splitReasoning("just content");
  assert.equal(r.content, "just content");
  assert.equal(r.thinking, undefined);
});
