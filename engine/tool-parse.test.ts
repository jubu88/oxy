// Tests for the engine-agnostic tool-call/reasoning parsers. node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { codeBlocksToWrites, parseTextToolCalls, splitReasoning } from "./tool-parse.ts";

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

test("codeBlocksToWrites recovers a ```html block as write_file index.html (the coder-model case)", () => {
  const content = "Here's the page:\n```html\n<!DOCTYPE html><html><body><h1>Bank</h1></body></html>\n```";
  const r = codeBlocksToWrites(content, KNOWN);
  assert.equal(r.length, 1);
  assert.equal(r[0].name, "write_file");
  assert.equal(r[0].arguments.path, "index.html");
  assert.match(r[0].arguments.content, /<!DOCTYPE html>/);
});

test("codeBlocksToWrites recovers html + css + js as three writes", () => {
  const content = "```html\n<!DOCTYPE html><html><body>hello there friend</body></html>\n```\n```css\nbody { margin: 0; padding: 0; color: red; }\n```\n```js\nconsole.log('hello world from the app');\n```";
  const paths = codeBlocksToWrites(content, KNOWN).map((c) => c.arguments.path).sort();
  assert.deepEqual(paths, ["app.js", "index.html", "style.css"]);
});

test("codeBlocksToWrites takes the LONGEST block per language", () => {
  const content = "```html\n<a>short but over forty chars long here padding</a>\n```\n```html\n<b>this one is clearly the much much longer html block to keep</b>\n```";
  const r = codeBlocksToWrites(content, KNOWN);
  assert.equal(r.length, 1);
  assert.match(r[0].arguments.content, /much much longer/);
});

test("codeBlocksToWrites ignores tiny snippets and unknown languages", () => {
  assert.deepEqual(codeBlocksToWrites("```html\n<br>\n```", KNOWN), []); // too short
  assert.deepEqual(codeBlocksToWrites("```python\nprint('this is a long enough python snippet to pass')\n```", KNOWN), []); // unmapped lang
});

test("codeBlocksToWrites ignores comment-only placeholder blocks (no stub files)", () => {
  // the exact Qwen-3B failure: a ```js block that's just a placeholder comment
  assert.deepEqual(codeBlocksToWrites("```js\n// Add JavaScript logic for dashboard, payments, statements and settings here\n```", KNOWN), []);
  assert.deepEqual(codeBlocksToWrites("```css\n/* put the real styles here later, this is only a placeholder */\n```", KNOWN), []);
  assert.deepEqual(codeBlocksToWrites("```html\n<!-- the full page markup goes here once it is actually written -->\n```", KNOWN), []);
  // but a comment ALONGSIDE real code is still recovered (and a URL's // isn't mistaken for a comment)
  const r = codeBlocksToWrites("```js\n// init\nfetch('https://api.example.com/x').then((r) => r.json());\n```", KNOWN);
  assert.equal(r.length, 1);
  assert.equal(r[0].arguments.path, "app.js");
});

test("codeBlocksToWrites is a no-op when write_file isn't a known tool", () => {
  assert.deepEqual(codeBlocksToWrites("```html\n<!DOCTYPE html><html><body>plenty of content here</body></html>\n```", new Set(["done"])), []);
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
