// Browser client for Oxy's server-side build endpoint and the jailed backend.
import type { AgentStep } from "../agent/types.ts";

export interface OxyStatus {
  engines: Record<string, boolean>;
  stitch: boolean;
  sd: boolean;
  models: string[];
}

export type BuildEvent =
  | { type: "status"; message: string }
  | { type: "project"; project: string }
  | { type: "step"; step: AgentStep }
  | { type: "progress"; iteration: number; tokens: number }
  | { type: "done"; project: string }
  | { type: "error"; message: string };

export async function getStatus(): Promise<OxyStatus> {
  const r = await fetch("/oxy/api/status");
  const j = await r.json();
  return { engines: j.engines ?? {}, stitch: !!j.stitch, sd: !!j.sd, models: j.models ?? [] };
}

export interface BuildRequest {
  task: string;
  engine: string;
  model?: string;
  useStitch?: boolean;
}

/** POST a build and stream NDJSON events back as they happen. */
export async function runBuild(body: BuildRequest, onEvent: (e: BuildEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch("/oxy/api/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`build request failed (HTTP ${res.status})`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as BuildEvent);
      } catch {
        /* skip malformed */
      }
    }
  }
  if (buf.trim()) {
    try {
      onEvent(JSON.parse(buf) as BuildEvent);
    } catch {
      /* ignore */
    }
  }
}

export const previewUrl = (project: string) => `/codelab/preview/${project}/`;
export const exportUrl = (project: string) => `/codelab/api/export?project=${encodeURIComponent(project)}`;
