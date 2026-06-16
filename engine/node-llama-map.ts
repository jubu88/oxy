// Pure mapping helpers for the node-llama-cpp adapter. Kept in their own module
// (NO `node-llama-cpp` import) so they unit-test with zero install. The adapter
// (node-llama.ts) imports both these and the native binding.
//
// The interesting part is history conversion: Oxy holds history as a flat
// ChatMessage[] (assistant message, then separate tool messages), but
// node-llama-cpp represents a model turn as ONE item whose `response` array
// interleaves text and { type:"functionCall", name, params, result } entries —
// the call and its result live together. So we pair each assistant tool_call
// with the tool message(s) that follow it.
import type { ChatMessage, ToolCall, ToolDef } from "./engine.ts";

/** node-llama-cpp ChatHistoryItem (typed loosely — the package types aren't imported here). */
export type LlamaHistoryItem =
  | { type: "system"; text: string }
  | { type: "user"; text: string }
  | { type: "model"; response: Array<string | LlamaFunctionCall> };

export interface LlamaFunctionCall {
  type: "functionCall";
  name: string;
  params: any;
  result: any;
}

function tryParse(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Convert Oxy ChatMessage[] into node-llama-cpp ChatHistoryItem[]. */
export function toLlamaHistory(messages: ChatMessage[]): LlamaHistoryItem[] {
  const out: LlamaHistoryItem[] = [];
  let pending: LlamaFunctionCall[] = []; // function calls in the current model item awaiting results

  for (const m of messages) {
    if (m.role === "system") {
      out.push({ type: "system", text: m.content });
      pending = [];
    } else if (m.role === "user") {
      out.push({ type: "user", text: m.content });
      pending = [];
    } else if (m.role === "assistant") {
      const response: Array<string | LlamaFunctionCall> = [];
      if (m.content) response.push(m.content);
      pending = [];
      for (const tc of m.tool_calls ?? []) {
        const call: LlamaFunctionCall = { type: "functionCall", name: tc.name, params: tc.arguments ?? {}, result: "" };
        response.push(call);
        pending.push(call);
      }
      out.push({ type: "model", response });
    } else if (m.role === "tool") {
      // attach this result to the next assistant tool_call awaiting one (in order)
      const call = pending.shift();
      if (call) call.result = tryParse(m.content);
      else out.push({ type: "user", text: `[tool result${m.tool_name ? ` ${m.tool_name}` : ""}] ${m.content}` });
    }
  }
  return out;
}

/** Convert Oxy ToolDef[] into node-llama-cpp ChatModelFunctions ({ name: {description, params} }). */
export function toLlamaFunctions(tools: ToolDef[]): Record<string, { description: string; params: any }> | undefined {
  if (!tools.length) return undefined;
  const out: Record<string, { description: string; params: any }> = {};
  for (const t of tools) out[t.name] = { description: t.description, params: t.parameters };
  return out;
}

/** Normalize node-llama-cpp functionCalls ({functionName, params}) to Oxy ToolCall[]. */
export function normalizeToolCalls(functionCalls: Array<{ functionName?: string; name?: string; params?: any }> | undefined): ToolCall[] {
  return (functionCalls ?? [])
    .map((fc) => ({ name: fc.functionName ?? fc.name ?? "", arguments: fc.params ?? {} }))
    .filter((tc): tc is ToolCall => tc.name.length > 0);
}

/**
 * Split a reasoning model's <think>…</think> trace out of the visible content.
 * node-llama-cpp's chat wrapper often already segments thoughts, in which case
 * there's no tag and `thinking` stays undefined.
 */
export function splitReasoning(text: string): { content: string; thinking?: string } {
  const m = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (!m) return { content: text };
  const thinking = m[1].trim();
  const content = text.replace(/<think>[\s\S]*?<\/think>/i, "").trim();
  return { content, thinking: thinking || undefined };
}
