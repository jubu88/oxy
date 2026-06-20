// Engine-agnostic tool-call/reasoning parsing helpers (pure, no native deps).
//
// Many local models emit tool calls as TEXT (a ```json fenced block or a bare
// JSON object) instead of via structured function calling. parseTextToolCalls
// extracts them, GATED to known tool names so legitimate JSON a model writes into
// a file is never mistaken for a tool call. Used by every server-backed engine.
import type { ToolCall } from "./engine.ts";

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// Tolerate the many shapes small models emit: {name,arguments}, {tool,args},
// {function:{...}}, {tool_call:{...}}. Only accepted if the name is a KNOWN tool.
function asCall(o: any, names: Set<string>): ToolCall | null {
  if (!o || typeof o !== "object") return null;
  const inner = o.tool_call ?? (typeof o.function === "object" ? o.function : null);
  if (inner) return asCall(inner, names);
  const name = o.name ?? o.tool ?? o.tool_name ?? (typeof o.function === "string" ? o.function : undefined);
  let args = o.arguments ?? o.args ?? o.parameters ?? o.params ?? {};
  if (typeof args === "string") args = safeJson(args) ?? {};
  if (typeof name === "string" && names.has(name)) return { name, arguments: args };
  return null;
}

/** Extract text-emitted tool call(s) from content, gated to known tool names. */
export function parseTextToolCalls(content: string, names: Set<string>): { toolCalls: ToolCall[]; content: string } {
  const calls: ToolCall[] = [];
  let cleaned = content;
  const fence = /```(?:json|tool_call|tool|xml|js)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  let matchedAny = false;
  while ((m = fence.exec(content))) {
    const c = asCall(safeJson((m[1] ?? "").trim()), names);
    if (c) {
      calls.push(c);
      cleaned = cleaned.replace(m[0], "");
      matchedAny = true;
    }
  }
  if (!matchedAny) {
    const whole = asCall(safeJson(content.trim()), names);
    if (whole) {
      calls.push(whole);
      cleaned = "";
    }
  }
  return { toolCalls: calls, content: cleaned.trim() };
}

const FILE_FOR_LANG: Record<string, string> = {
  html: "index.html",
  htm: "index.html",
  css: "style.css",
  js: "app.js",
  javascript: "app.js",
  mjs: "app.js",
};

/**
 * Recover a CODER model's output as file writes. Code-completion models (e.g.
 * Qwen2.5-Coder) often emit the app as fenced ```html/```css/```js blocks instead of
 * calling write_file — so the build loop sees "no tool call" and writes nothing. This
 * turns the LONGEST block per language into a write_file call (html→index.html,
 * css→style.css, js→app.js). Gated to when write_file is a known tool, and intended as
 * a FALLBACK only when no real tool call was made (models that tool-call never hit it).
 */
export function codeBlocksToWrites(content: string, names: Set<string>): ToolCall[] {
  if (!content || !names.has("write_file")) return [];
  const re = /```([a-zA-Z]+)?[ \t]*\r?\n?([\s\S]*?)```/g;
  const best = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const file = FILE_FOR_LANG[(m[1] ?? "").toLowerCase()];
    if (!file) continue;
    const body = (m[2] ?? "").trim();
    if (body.length < 40) continue; // skip tiny snippets / inline examples
    if (!best.has(file) || body.length > (best.get(file) as string).length) best.set(file, body);
  }
  return [...best.entries()].map(([path, body]) => ({ name: "write_file", arguments: { path, content: body } }));
}

/** Split a reasoning model's <think>…</think> trace out of the visible content. */
export function splitReasoning(text: string): { content: string; thinking?: string } {
  const m = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (!m) return { content: text };
  const thinking = m[1].trim();
  const content = text.replace(/<think>[\s\S]*?<\/think>/i, "").trim();
  return { content, thinking: thinking || undefined };
}
