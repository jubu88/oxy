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

/** Split a reasoning model's <think>…</think> trace out of the visible content. */
export function splitReasoning(text: string): { content: string; thinking?: string } {
  const m = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (!m) return { content: text };
  const thinking = m[1].trim();
  const content = text.replace(/<think>[\s\S]*?<\/think>/i, "").trim();
  return { content, thinking: thinking || undefined };
}
