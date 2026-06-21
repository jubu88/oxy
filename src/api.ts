// Browser client for Oxy's server-side build endpoint and the jailed backend.
import type { AgentStep } from "../agent/types.ts";

export interface OxyStatus {
  engines: Record<string, boolean>;
  stitch: boolean;
  sd: boolean;
  models: string[];
  /** detected best backend: "cuda" | "metal" | "vulkan" | "cpu" */
  gpu?: string;
  /** would Ollama offload to the GPU on this machine? (false ⇒ Ollama runs on CPU) */
  ollamaUsesGpu?: boolean;
  /** engine recommended for this machine ("ollama" or "llama-server") */
  recommended?: string;
  recommendReason?: string;
  /** which gateable tools are enabled (web_search/web_fetch/generate_image/run_command) */
  tools?: Record<string, boolean>;
  /** terminal sandbox mode: "container" | "host" | "disabled" */
  terminalMode?: string;
  /** toggleable "improvement" features (thinking/autoCompact/idleTimeout/…) for A/B testing */
  features?: Record<string, boolean>;
  /** saved llama-server model refs for the picker (HF refs / paths); first is the default */
  llamaModels?: string[];
  /** design systems offered in the picker (key + friendly label) */
  designSystems?: Array<{ key: string; label: string }>;
}

export type BuildEvent =
  | { type: "status"; message: string }
  | { type: "project"; project: string }
  | { type: "step"; step: AgentStep }
  | { type: "progress"; iteration: number; tokens: number }
  | { type: "summary"; iterate: boolean; wrote: string[]; edited: string[]; doneSummary: string; finished: boolean }
  | { type: "done"; project: string }
  | { type: "error"; message: string };

/** Live state of the continuous-improvement (auto-learn / gated promote) background process. */
export interface AutoLearnStatus {
  ok: boolean;
  running: boolean;
  startedAt: number | null;
  elapsedMs: number | null;
  every: number;
  disabled: boolean;
  autoLearn: boolean;
  status: {
    found: boolean;
    phase: string;
    model: string | null;
    finished: boolean;
    deployed: boolean | null;
    outcome: string | null;
    valTotal: number | null;
    reviewed: number | null;
    finishRate: number | null;
    base: { score: number | null; perTask: Array<{ id: string; score: number }> };
    candidate: { score: number | null; perTask: Array<{ id: string; score: number }>; proposed: boolean | null };
  };
  progress: { done: number; total: number; perPass: number } | null;
  journal: { total: number; unconsumed: number; finishRate: number | null; topMistakes: Array<{ text: string; count: number }> };
  logTail: string;
}

export async function getAutoLearn(): Promise<AutoLearnStatus | null> {
  try {
    const r = await fetch("/codelab/api/autolearn");
    const j = await r.json();
    return j?.ok ? j : null;
  } catch {
    return null;
  }
}

/** Events from the one-shot /ask (no build) endpoint. */
export type AskEvent =
  | { type: "status"; message: string }
  | { type: "delta"; text: string }
  | { type: "progress"; iteration: number; tokens: number }
  | { type: "answer"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export async function getStatus(): Promise<OxyStatus> {
  const r = await fetch("/oxy/api/status");
  const j = await r.json();
  return { engines: j.engines ?? {}, stitch: !!j.stitch, sd: !!j.sd, models: j.models ?? [], gpu: j.gpu, ollamaUsesGpu: j.ollamaUsesGpu, recommended: j.recommended, recommendReason: j.recommendReason, tools: j.tools, terminalMode: j.terminalMode, features: j.features, llamaModels: j.llamaModels, designSystems: j.designSystems };
}

/** Toggle the "improvement" feature flags (server persists them; A/B testing). */
export async function saveFeatures(features: Record<string, boolean>): Promise<Record<string, boolean> | null> {
  const r = await fetch("/oxy/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ features }) });
  const j = await r.json();
  return j.ok ? j.features : null;
}

/** Save the list of llama-server model refs shown in the picker (server persists). */
export async function saveModels(llamaModels: string[]): Promise<string[] | null> {
  const r = await fetch("/oxy/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ llamaModels }) });
  const j = await r.json();
  return j.ok ? (j.llamaModels ?? null) : null;
}

export interface DownloadableModel {
  ref: string;
  repo: string;
  quant: string;
  downloads: number;
}

/** Browse downloadable GGUF models (curated HF search, cached server-side). refresh re-pulls. */
export async function listDownloadableModels(refresh = false): Promise<{ models: DownloadableModel[]; cachedAt: number }> {
  try {
    const r = await fetch(`/oxy/api/model/list${refresh ? "?refresh=1" : ""}`);
    const j = await r.json();
    return { models: j.models ?? [], cachedAt: j.cachedAt ?? 0 };
  } catch {
    return { models: [], cachedAt: 0 };
  }
}

/** Download a model NOW (prewarm the cache + load it), streaming progress events. */
export type DownloadEvent =
  | { type: "status"; message: string }
  | { type: "progress"; pct: number | null; mb: number; totalMb: number; secs: number }
  | { type: "done"; ref: string }
  | { type: "error"; message: string };
export function downloadModel(ref: string, onEvent: (e: DownloadEvent) => void, signal?: AbortSignal): Promise<void> {
  return streamNdjson("/oxy/api/model/download", { ref }, onEvent as (e: unknown) => void, signal);
}

/** Validate a Hugging Face model ref (repo exists + has a GGUF of that quant) before adding. */
export async function checkModel(ref: string): Promise<{ ok: boolean; error?: string; note?: string }> {
  try {
    const r = await fetch("/oxy/api/model/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref }) });
    return await r.json();
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** Toggle gateable tools / set the terminal sandbox mode (server persists them). */
export async function saveToolSettings(tools: Record<string, boolean>, terminalMode?: string): Promise<{ tools?: Record<string, boolean>; terminalMode?: string } | null> {
  const r = await fetch("/oxy/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tools, terminalMode }) });
  const j = await r.json();
  return j.ok ? { tools: j.tools, terminalMode: j.terminalMode } : null;
}

export interface ProjectInfo {
  id: string;
  files: number;
  hasIndex: boolean;
  mtime: number;
  /** the Stitch project this app's design is linked to ("" if none) */
  stitchProjectId?: string;
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

/** Set (or clear) a project's linked Stitch project id. Accepts a bare id or a full URL. */
export async function saveStitchProjectId(project: string, stitchProjectId: string): Promise<string | null> {
  try {
    const r = await fetch("/codelab/api/project-stitch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project, stitchProjectId }) });
    const j = await r.json();
    return j.ok ? (j.stitchProjectId ?? "") : null;
  } catch {
    return null;
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

export interface Attachment {
  kind: "image" | "audio";
  mime: string;
  /** base64 (no data: prefix) */
  data: string;
  /** display-only file name */
  name?: string;
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
  /** images/audio attached to the prompt (for a multimodal model like gemma4) */
  attachments?: Attachment[];
  /** allow the model's reasoning trace (default off — faster; gemma4 over-thinks) */
  think?: boolean;
  /** a design system key the user pre-picked (empty ⇒ the model chooses) */
  design?: string;
}

// POST a body and stream NDJSON events back as they happen (shared by build + ask).
async function streamNdjson(url: string, body: unknown, onEvent: (e: any) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) throw new Error(`request failed (HTTP ${res.status})`);
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
        onEvent(JSON.parse(line));
      } catch {
        /* skip malformed */
      }
    }
  }
  if (buf.trim()) {
    try {
      onEvent(JSON.parse(buf));
    } catch {
      /* ignore */
    }
  }
}

/** POST a build and stream NDJSON events back as they happen. */
export function runBuild(body: BuildRequest, onEvent: (e: BuildEvent) => void, signal?: AbortSignal): Promise<void> {
  return streamNdjson("/oxy/api/build", body, onEvent as (e: unknown) => void, signal);
}

/** One-shot Q&A (no build): attach/paste an image + a question → the model's answer, streamed. */
export function runAsk(body: BuildRequest, onEvent: (e: AskEvent) => void, signal?: AbortSignal): Promise<void> {
  return streamNdjson("/oxy/api/ask", body, onEvent as (e: unknown) => void, signal);
}

export const previewUrl = (project: string) => `/codelab/preview/${project}/`;
export const exportUrl = (project: string) => `/codelab/api/export?project=${encodeURIComponent(project)}`;
