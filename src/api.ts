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

export interface ProjectInfo {
  id: string;
  files: number;
  hasIndex: boolean;
  mtime: number;
}

export async function getProjects(): Promise<ProjectInfo[]> {
  try {
    const r = await fetch("/codelab/api/projects");
    const j = await r.json();
    return (j.projects ?? []).filter((p: ProjectInfo) => p.hasIndex);
  } catch {
    return [];
  }
}

/** Save the user's Stitch API key (server writes it to the gitignored key file). */
export async function saveStitchKey(key: string): Promise<boolean> {
  const r = await fetch("/oxy/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stitchApiKey: key }),
  });
  const j = await r.json();
  return !!j.ok;
}

export interface BuildRequest {
  task: string;
  engine: string;
  model?: string;
  useStitch?: boolean;
  /** continue/modify an existing project instead of building a new one */
  project?: string;
  /** for engine "openai": the OpenAI-compatible server base URL */
  baseUrl?: string;
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
