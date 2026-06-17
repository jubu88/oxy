// Tests for the OpenAI-compatible mapping helpers. No network: node --test.
import { test } from "node:test";
import assert from "node:assert/strict";

import { finalizeToolCalls, toOpenAIMessages, toOpenAITools } from "./openai-map.ts";
import type { ChatMessage } from "./engine.ts";

test("toOpenAITools maps ToolDefs and returns undefined for empty", () => {
  assert.equal(toOpenAITools([]), undefined);
  const t = toOpenAITools([{ name: "write_file", description: "w", parameters: { type: "object", properties: {} } }])!;
  assert.equal(t[0].type, "function");
  assert.equal(t[0].function.name, "write_file");
});

test("toOpenAIMessages pairs each tool result with its assistant tool_call id", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    { role: "assistant", content: "", tool_calls: [{ name: "list_files", arguments: {} }, { name: "read_file", arguments: { path: "a.html" } }] },
    { role: "tool", tool_name: "list_files", content: "[]" },
    { role: "tool", tool_name: "read_file", content: "<html></html>" },
  ];
  const out = toOpenAIMessages(messages);
  // [system, user, assistant(tool_calls), tool, tool]
  assert.equal(out.length, 5);
  const asst = out[2];
  assert.equal(asst.role, "assistant");
  assert.equal(asst.content, null); // null content alongside tool_calls
  assert.equal(asst.tool_calls.length, 2);
  const id0 = asst.tool_calls[0].id;
  const id1 = asst.tool_calls[1].id;
  assert.ok(id0 && id1 && id0 !== id1);
  // arguments serialized to a JSON string
  assert.equal(asst.tool_calls[1].function.arguments, JSON.stringify({ path: "a.html" }));
  // tool messages reference the right ids, in order
  assert.equal(out[3].role, "tool");
  assert.equal(out[3].tool_call_id, id0);
  assert.equal(out[4].tool_call_id, id1);
});

test("toOpenAIMessages passes through string assistant arguments and plain turns", () => {
  const out = toOpenAIMessages([
    { role: "assistant", content: "hi" },
    { role: "user", content: "next" },
  ]);
  assert.equal(out[0].content, "hi");
  assert.equal(out[0].tool_calls, undefined);
  assert.equal(out[1].role, "user");
});

test("toOpenAIMessages maps a multimodal user turn to content parts (image + audio)", () => {
  const out = toOpenAIMessages([
    {
      role: "user",
      content: "build from this",
      attachments: [
        { kind: "image", mime: "image/png", data: "AAAA" },
        { kind: "audio", mime: "audio/wav", data: "BBBB" },
      ],
    },
  ]);
  assert.equal(out.length, 1);
  const parts = out[0].content;
  assert.ok(Array.isArray(parts));
  assert.deepEqual(parts[0], { type: "text", text: "build from this" });
  assert.equal(parts[1].type, "image_url");
  assert.equal(parts[1].image_url.url, "data:image/png;base64,AAAA");
  assert.equal(parts[2].type, "input_audio");
  assert.deepEqual(parts[2].input_audio, { data: "BBBB", format: "wav" });
});

test("toOpenAIMessages leaves a plain user turn (no attachments) as a string", () => {
  const out = toOpenAIMessages([{ role: "user", content: "plain" }]);
  assert.equal(out[0].content, "plain");
});

test("finalizeToolCalls assembles streamed fragments and parses arguments", () => {
  const frags = new Map<number, { name: string; args: string }>();
  frags.set(0, { name: "write_file", args: '{"path":"index.html","content":"<h1>hi</h1>"}' });
  frags.set(1, { name: "", args: "" }); // nameless → dropped
  assert.deepEqual(finalizeToolCalls(frags), [{ name: "write_file", arguments: { path: "index.html", content: "<h1>hi</h1>" } }]);
});

test("finalizeToolCalls tolerates fragmented arguments and bad JSON", () => {
  const frags = new Map<number, { name: string; args: string }>();
  frags.set(0, { name: "done", args: '{"summ' + 'ary":"x"}' });
  frags.set(1, { name: "get_icon", args: "not json" });
  assert.deepEqual(finalizeToolCalls(frags), [
    { name: "done", arguments: { summary: "x" } },
    { name: "get_icon", arguments: {} },
  ]);
});
