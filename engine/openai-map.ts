// Pure mapping helpers for the OpenAI-compatible adapter (no network, unit-tested).
//
// The OpenAI chat protocol correlates each tool result to the assistant tool call
// it answers via a `tool_call_id`. Oxy's internal history doesn't carry ids
// ({role:"tool", tool_name, content}), so we synthesize ids and pair each
// assistant tool_call with the tool message(s) that follow it — same idea as the
// node-llama history mapper.
import type { ChatMessage, ToolCall, ToolDef } from "./engine.ts";

export function toOpenAITools(tools: ToolDef[]): any[] | undefined {
  if (!tools.length) return undefined;
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

export function toOpenAIMessages(messages: ChatMessage[]): any[] {
  const out: any[] = [];
  let counter = 0;
  let pendingIds: string[] = []; // ids of the current assistant's tool_calls awaiting results

  for (const m of messages) {
    if (m.role === "user" && m.attachments?.length) {
      // multimodal user turn → OpenAI content-parts (image_url / input_audio).
      // Needs a vision/audio server (llama-server with --mmproj, or Ollama's /v1).
      const parts: any[] = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const a of m.attachments) {
        if (a.kind === "image") parts.push({ type: "image_url", image_url: { url: `data:${a.mime};base64,${a.data}` } });
        else if (a.kind === "audio") parts.push({ type: "input_audio", input_audio: { data: a.data, format: a.mime.split("/")[1] || "wav" } });
      }
      out.push({ role: "user", content: parts });
      pendingIds = [];
    } else if (m.role === "system" || m.role === "user") {
      out.push({ role: m.role, content: m.content });
      pendingIds = [];
    } else if (m.role === "assistant") {
      const msg: any = { role: "assistant", content: m.content || "" };
      pendingIds = [];
      if (m.tool_calls?.length) {
        msg.content = m.content || null; // OpenAI allows null content alongside tool_calls
        msg.tool_calls = m.tool_calls.map((tc) => {
          const id = `call_${counter++}`;
          pendingIds.push(id);
          return {
            id,
            type: "function",
            function: { name: tc.name, arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}) },
          };
        });
      }
      out.push(msg);
    } else if (m.role === "tool") {
      const id = pendingIds.shift() ?? `call_orphan_${counter++}`;
      out.push({ role: "tool", tool_call_id: id, content: m.content });
    }
  }
  return out;
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * Assemble streamed OpenAI tool-call deltas (keyed by their `index`) into Oxy
 * ToolCall[]. Each delta fragment may carry the name once and the arguments in
 * pieces, which we concatenate then JSON-parse.
 */
export function finalizeToolCalls(assembled: Map<number, { name: string; args: string }>): ToolCall[] {
  return [...assembled.values()]
    .filter((c) => c.name)
    .map((c) => ({ name: c.name, arguments: c.args ? safeJson(c.args) : {} }));
}
