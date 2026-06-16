// Tests for the node-llama-cpp mapping helpers. No native binding required, so
// these run with zero install: node --test engine/node-llama-map.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeToolCalls, parseTextToolCalls, splitReasoning, toLlamaFunctions, toLlamaHistory } from "./node-llama-map.ts";
import type { ChatMessage } from "./engine.ts";

const KNOWN = new Set(["get_design_system", "write_file", "done"]);

test("toLlamaHistory maps system/user to plain items", () => {
  const h = toLlamaHistory([
    { role: "system", content: "sys" },
    { role: "user", content: "build it" },
  ]);
  assert.deepEqual(h, [
    { type: "system", text: "sys" },
    { type: "user", text: "build it" },
  ]);
});

test("toLlamaHistory merges an assistant tool_call with its following tool result", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    { role: "assistant", content: "", tool_calls: [{ name: "write_file", arguments: { path: "index.html", content: "<h1>hi</h1>" } }] },
    { role: "tool", tool_name: "write_file", content: "wrote index.html (10 bytes)" },
  ];
  const h = toLlamaHistory(messages);
  assert.equal(h.length, 3); // system, user, model
  const model = h[2] as any;
  assert.equal(model.type, "model");
  assert.equal(model.response.length, 1); // just the functionCall (assistant content was "")
  const call = model.response[0];
  assert.equal(call.type, "functionCall");
  assert.equal(call.name, "write_file");
  assert.deepEqual(call.params, { path: "index.html", content: "<h1>hi</h1>" });
  assert.equal(call.result, "wrote index.html (10 bytes)"); // non-JSON stays a string
});

test("toLlamaHistory pairs multiple calls with multiple results in order", () => {
  const messages: ChatMessage[] = [
    { role: "assistant", content: "doing two things", tool_calls: [{ name: "list_files", arguments: {} }, { name: "read_file", arguments: { path: "a.html" } }] },
    { role: "tool", tool_name: "list_files", content: '[{"path":"a.html","bytes":5}]' },
    { role: "tool", tool_name: "read_file", content: "<html></html>" },
  ];
  const model = toLlamaHistory(messages)[0] as any;
  assert.equal(model.response.length, 3); // "doing two things" + 2 calls
  assert.equal(model.response[0], "doing two things");
  assert.equal(model.response[1].name, "list_files");
  assert.deepEqual(model.response[1].result, [{ path: "a.html", bytes: 5 }]); // JSON result parsed
  assert.equal(model.response[2].name, "read_file");
  assert.equal(model.response[2].result, "<html></html>");
});

test("toLlamaFunctions converts ToolDefs and returns undefined for empty", () => {
  assert.equal(toLlamaFunctions([]), undefined);
  const fns = toLlamaFunctions([{ name: "write_file", description: "writes", parameters: { type: "object", properties: {} } }])!;
  assert.deepEqual(Object.keys(fns), ["write_file"]);
  assert.equal(fns.write_file.description, "writes");
  assert.deepEqual(fns.write_file.params, { type: "object", properties: {} });
});

test("normalizeToolCalls maps functionName/params and drops nameless calls", () => {
  const tcs = normalizeToolCalls([
    { functionName: "done", params: { summary: "x" } },
    { params: { junk: 1 } } as any,
  ]);
  assert.deepEqual(tcs, [{ name: "done", arguments: { summary: "x" } }]);
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

test("parseTextToolCalls extracts a fenced ```json tool call (the Qwen-coder case)", () => {
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
