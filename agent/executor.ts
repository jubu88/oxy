// Default tool executor: runs each model-requested tool against the jailed
// /codelab backend (server.mjs) over HTTP, and returns the short string the
// model sees next turn. The backend is the trust boundary — it enforces the
// workspace jail (safePath), the write extension allow-list (checkExt), file
// size/count caps, the SSRF guard, and hides `.codelab*` checkpoints. This
// executor only translates tool calls into requests; it adds no privileges.
//
// `get_design_system` and `done` are pure-local (no backend round-trip). The
// loop depends only on the ToolExecutor interface (types.ts), so tests inject a
// fake and the real engine never has to be running.
import type { ProjectInfo, ToolContext, ToolExecutor } from "./types.ts";
import { DESIGN_SYSTEMS } from "./design-systems.ts";

const DEFAULT_BASE = "http://localhost:5173";

export interface HttpToolExecutorOptions {
  /** Origin where the Vite dev server (with codeLabPlugin) is mounted. */
  baseUrl?: string;
}

function apiBase(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/codelab/api`;
}

function post(body: any): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export class HttpToolExecutor implements ToolExecutor {
  private readonly api: string;

  constructor(opts: HttpToolExecutorOptions = {}) {
    this.api = apiBase(opts.baseUrl ?? DEFAULT_BASE);
  }

  async call(name: string, args: any, ctx: ToolContext): Promise<string> {
    const api = this.api;
    const project = ctx.project;
    try {
      if (name === "get_design_system") {
        const key = String(args.style || "").toLowerCase();
        return DESIGN_SYSTEMS[key] ?? `Unknown style "${args.style}". Available: ${Object.keys(DESIGN_SYSTEMS).join(", ")}. ${DESIGN_SYSTEMS["modern-saas"]}`;
      }
      if (name === "get_icon") {
        const r = await (await fetch(`${api}/icon?name=${encodeURIComponent(args.name)}`)).json();
        return r.ok ? r.svg : `error: ${r.error}`;
      }
      if (name === "list_files") {
        const r = await (await fetch(`${api}/list?project=${encodeURIComponent(project)}`)).json();
        return JSON.stringify(r.files ?? []);
      }
      if (name === "write_file") {
        const r = await (await fetch(`${api}/write`, post({ project, path: args.path, content: args.content }))).json();
        return r.ok ? `wrote ${r.path} (${r.bytes} bytes)` : `error: ${r.error}`;
      }
      if (name === "edit_file") {
        const r = await (
          await fetch(`${api}/edit`, post({ project, path: args.path, old_string: args.old_string, new_string: args.new_string }))
        ).json();
        return r.ok
          ? `edited ${r.path} (now ${r.bytes} bytes)` +
              (r.replacedFirstOf > 1 ? ` — note: matched ${r.replacedFirstOf} places, changed the first; add more context if that was wrong` : "")
          : `error: ${r.error}`;
      }
      if (name === "read_file") {
        const r = await (await fetch(`${api}/read`, post({ project, path: args.path }))).json();
        return r.ok ? r.content : `error: ${r.error}`;
      }
      if (name === "web_search") {
        const r = await (await fetch(`${api}/web-search`, post({ query: args.query }))).json();
        return r.ok ? JSON.stringify(r.results) : `error: ${r.error}`;
      }
      if (name === "web_fetch") {
        const r = await (await fetch(`${api}/web-fetch`, post({ url: args.url }))).json();
        return r.ok ? `[${r.status}] ${r.text}` : `error: ${r.error}`;
      }
      if (name === "review_design") {
        const r = await (await fetch(`${api}/review`, post({ project }))).json();
        return r.ok ? `DESIGN CRITIQUE:\n${r.critique}` : `error: ${r.error}`;
      }
      if (name === "design_with_stitch") {
        const r = await (
          await fetch(`${api}/design-stitch`, post({ project, path: args.path, prompt: args.prompt, deviceType: args.deviceType }))
        ).json();
        return r.ok
          ? `Stitch designed and saved ${r.path} (${r.bytes} bytes, ${r.seconds}s). Preview of the start of the page:\n${r.preview}\n…\nThe page is written. Do NOT write_file ${r.path} again — instead call review_design, then refine with edit_file if needed, then done.`
          : `error: ${r.error}`;
      }
      if (name === "generate_image") {
        const r = await (
          await fetch(`${api}/generate-image`, post({ project, path: args.path, prompt: args.prompt, width: args.width, height: args.height }))
        ).json();
        return r.ok ? `generated ${r.path} (${r.width}x${r.height}, ${r.seconds}s) — reference it with <img src="${r.path}">` : `error: ${r.error}`;
      }
      if (name === "run_command") {
        const r = await (await fetch(`${api}/run-command`, post({ project, command: args.command }))).json();
        return r.ok ? r.output : `error: ${r.error || r.output}`;
      }
      if (name === "done") return "done";
      return `error: unknown tool ${name}`;
    } catch (e: any) {
      return `error: ${String(e?.message ?? e)}`;
    }
  }
}

/** Create a new jailed project on the backend and return its id. */
export async function createProject(name: string, baseUrl: string = DEFAULT_BASE): Promise<string> {
  const api = apiBase(baseUrl);
  const r = await (await fetch(`${api}/project/new`, post({ name }))).json();
  if (!r.ok) throw new Error(r.error || "could not create project");
  return r.id as string;
}

/** List existing projects on the backend. */
export async function listProjects(baseUrl: string = DEFAULT_BASE): Promise<ProjectInfo[]> {
  const api = apiBase(baseUrl);
  const r = await (await fetch(`${api}/projects`)).json();
  return r.projects ?? [];
}
