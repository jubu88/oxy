import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentStep } from "../agent/types.ts";
import { Settings } from "./Settings.tsx";
import { exportUrl, getProjects, getStatus, previewUrl, runBuild, type BuildEvent, type OxyStatus, type ProjectInfo } from "./api.ts";

const NUM_CTX = 16384;

function stepLabel(s: AgentStep): string {
  if (!s.toolCalls.length) return "model";
  return s.toolCalls
    .map((t) => {
      const arg = t.args?.path || t.args?.style || t.args?.name || t.args?.query || "";
      return arg ? `${t.name} · ${arg}` : t.name;
    })
    .join(", ");
}

function describe(s: AgentStep): string {
  const t = s.toolCalls[0];
  if (!t) return s.message?.trim() ? "Thinking…" : "Working…";
  const a = t.args ?? {};
  switch (t.name) {
    case "get_design_system": return `Applying the “${a.style}” design system.`;
    case "write_file": return `Writing ${a.path}.`;
    case "edit_file": return `Editing ${a.path}.`;
    case "read_file": return `Reading ${a.path}.`;
    case "list_files": return "Listing the project files.";
    case "get_icon": return `Fetching the ${a.name} icon.`;
    case "web_search": return `Searching the web: ${a.query}.`;
    case "web_fetch": return `Fetching ${a.url}.`;
    case "generate_image": return `Generating image ${a.path}.`;
    case "design_with_stitch": return `Designing ${a.path || "index.html"} with Stitch.`;
    case "review_design": return "Reviewing how the page actually looks.";
    case "done": return `Finished${a.summary ? ` — ${a.summary}` : "."}`;
    default: return t.name;
  }
}

function tagsFor(s: AgentStep): Array<{ cls: string; label: string }> {
  const tags: Array<{ cls: string; label: string }> = [];
  if (s.burst) tags.push({ cls: "text-primary border-primary/40 bg-primary/10", label: "thinking" });
  if (s.compacted) tags.push({ cls: "text-tertiary border-tertiary/40 bg-tertiary/10", label: "compacted" });
  if (s.truncated) tags.push({ cls: "text-error border-error/40 bg-error/10", label: "truncated" });
  return tags;
}

function pickDefaultModel(models: string[]): string {
  const isAux = (m: string) => /vl|vision|moondream|embed|clip/i.test(m);
  return (
    models.find((m) => /coder/i.test(m) && !isAux(m)) ??
    models.find((m) => /gemma4?:e4b/i.test(m)) ??
    models.find((m) => /gemma|qwen|llama|mistral|deepseek/i.test(m) && !isAux(m)) ??
    models.find((m) => !isAux(m)) ??
    models[0] ??
    ""
  );
}

const projectLabel = (id: string) => id.replace(/-\d{8,}$/, "").replace(/-/g, " ").slice(0, 40) || id;

export function App() {
  const [status, setStatus] = useState<OxyStatus | null>(null);
  const [engine, setEngine] = useState("ollama");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:8080/v1");
  const [task, setTask] = useState("");
  const [useStitch, setUseStitch] = useState(false);

  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selProject, setSelProject] = useState("");
  const [showSettings, setShowSettings] = useState(false);

  const [building, setBuilding] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [project, setProject] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [previewKey, setPreviewKey] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    getStatus()
      .then((s) => {
        setStatus(s);
        if (!s.engines.ollama) {
          setEngine("llama-server");
          setModel("");
        } else {
          setModel(pickDefaultModel(s.models));
        }
      })
      .catch(() => setStatus({ engines: { ollama: false, "llama-server": true }, stitch: false, sd: false, models: [] }));
    getProjects().then(setProjects);
  }, []);

  const ctxPct = useMemo(() => {
    const last = [...steps].reverse().find((s) => typeof s.ctxTokens === "number");
    if (!last?.ctxTokens) return 0;
    return Math.max(0, Math.min(100, Math.round((last.ctxTokens / NUM_CTX) * 100)));
  }, [steps]);

  const hasWritten = steps.some((s) => s.toolCalls.some((t) => ["write_file", "edit_file", "design_with_stitch"].includes(t.name)));
  const selHasIndex = !!projects.find((p) => p.id === project)?.hasIndex;
  const canPreview = !!project && (hasWritten || selHasIndex);
  const iterating = !!selProject;
  const modelOptions = engine === "ollama" ? status?.models ?? [] : [];

  function changeEngine(next: string) {
    setEngine(next);
    setModel(next === "ollama" ? pickDefaultModel(status?.models ?? []) : "");
  }

  function selectProject(id: string) {
    setSelProject(id);
    setSteps([]);
    setError("");
    if (id) {
      setProject(id);
      setPreviewKey((k) => k + 1);
    } else {
      setProject(null);
    }
  }

  async function build() {
    if (building || !task.trim()) return;
    setBuilding(true);
    setError("");
    setSteps([]);
    setStatusMsg("starting…");
    if (!selProject) setProject(null);
    const ac = new AbortController();
    abortRef.current = ac;
    let builtId = selProject || "";
    try {
      await runBuild(
        { task: task.trim(), engine, model: model || undefined, useStitch, project: selProject || undefined, baseUrl: engine === "openai" ? baseUrl : undefined },
        (e: BuildEvent) => {
          if (e.type === "status") setStatusMsg(e.message);
          else if (e.type === "project") {
            builtId = e.project;
            setProject(e.project);
          } else if (e.type === "step") {
            setStatusMsg("");
            setSteps((prev) => [...prev, e.step]);
            if (e.step.toolCalls.some((t) => ["write_file", "edit_file", "design_with_stitch"].includes(t.name))) setPreviewKey((k) => k + 1);
          } else if (e.type === "done") setPreviewKey((k) => k + 1);
          else if (e.type === "error") setError(e.message);
        },
        ac.signal,
      );
      const fresh = await getProjects();
      setProjects(fresh);
      if (builtId) setSelProject(builtId);
    } catch (err: any) {
      if (!ac.signal.aborted) setError(String(err?.message ?? err));
    } finally {
      setBuilding(false);
      setStatusMsg("");
      abortRef.current = null;
    }
  }

  const stop = () => {
    abortRef.current?.abort();
    setBuilding(false);
  };

  return (
    <>
      <header className="bg-background border-b border-outline-variant fixed top-0 w-full z-50">
        <div className="flex justify-between items-center max-w-[840px] mx-auto px-lg py-md w-full">
          <div className="flex items-baseline gap-sm">
            <h1 className="text-headline-md font-headline-md font-bold text-on-background tracking-tight">Oxy</h1>
            <span className="font-body-sm text-body-sm text-on-surface-variant opacity-70">Local-first AI Builder</span>
          </div>
          <div className="flex items-center gap-sm">
            <select
              className="oxy-field bg-brand-panel border border-brand-border text-on-surface px-md py-sm rounded-lg font-body-sm text-body-sm hover:border-brand-indigo/60 transition-colors max-w-[220px]"
              value={selProject}
              onChange={(e) => selectProject(e.target.value)}
              title="new project, or pick one to keep iterating"
            >
              <option value="">+ New project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {projectLabel(p.id)}
                </option>
              ))}
            </select>
            <button className="text-on-surface-variant hover:text-primary p-xs transition-colors" title="Settings" onClick={() => setShowSettings(true)}>
              <span className="material-symbols-outlined">settings</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-[840px] mx-auto px-lg pt-[100px] pb-xl min-h-screen">
        {/* Prompt */}
        <section className="mb-lg">
          <div className="bg-brand-panel border border-brand-border rounded-xl p-md shadow-lg transition-all focus-within:border-brand-indigo/50">
            <textarea
              className="w-full bg-transparent border-none focus:ring-0 outline-none text-body-lg font-body-lg text-on-surface placeholder:text-on-surface-variant/40 min-h-[120px] resize-none custom-scrollbar"
              placeholder={iterating ? "Describe a change or addition…" : "Describe the app you want to build…"}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") build();
              }}
            />
            <div className="flex justify-between items-center mt-sm">
              <span className="font-body-sm text-body-sm text-on-surface-variant/50">
                {iterating ? "iterating — reads the current files and edits in place" : "⌘/Ctrl + Enter to build"}
              </span>
              {building ? (
                <button
                  className="bg-error/90 hover:bg-error text-on-error px-xl py-sm rounded-lg font-bold text-body-md transition-all active:scale-95"
                  onClick={stop}
                >
                  Stop
                </button>
              ) : (
                <button
                  className="bg-brand-indigo hover:bg-brand-indigo/90 text-white px-xl py-sm rounded-lg font-bold text-body-md transition-all active:scale-95 shadow-[0_0_20px_rgba(99,102,241,0.2)] disabled:opacity-40 disabled:cursor-default"
                  onClick={build}
                  disabled={!task.trim()}
                >
                  {iterating ? "Update" : "Build"}
                </button>
              )}
            </div>
          </div>
        </section>

        {/* Status bar */}
        <section className="flex flex-col md:flex-row justify-between items-center gap-md mb-xl px-xs">
          <div className="flex items-center gap-sm flex-wrap">
            <div className="border border-brand-border bg-brand-panel/50 px-md py-xs rounded-full flex items-center gap-xs">
              <span className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]" />
              <select className="oxy-field text-primary font-code-md text-code-md" value={engine} onChange={(e) => changeEngine(e.target.value)}>
                {status?.engines.ollama && <option value="ollama">ollama</option>}
                <option value="llama-server">llama-server</option>
                <option value="openai">openai</option>
              </select>
              <span className="text-on-surface-variant/40">·</span>
              {engine === "ollama" ? (
                <select className="oxy-field text-on-surface-variant font-code-md text-code-md max-w-[160px]" value={model} onChange={(e) => setModel(e.target.value)}>
                  {modelOptions.length ? modelOptions.map((m) => <option key={m} value={m}>{m}</option>) : <option value="">no models</option>}
                </select>
              ) : engine === "openai" ? (
                <input className="oxy-field text-on-surface-variant font-code-md text-code-md w-[180px]" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:8080/v1" spellCheck={false} />
              ) : (
                <input
                  className="oxy-field text-on-surface-variant font-code-md text-code-md w-[200px]"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="gemma4 default · or hf:org/repo:quant"
                  spellCheck={false}
                />
              )}
            </div>
            {status?.stitch && (
              <label className="flex items-center gap-xs font-body-sm text-body-sm text-on-surface-variant/70 cursor-pointer select-none" title="use Google Stitch (cloud) for the page design">
                <input type="checkbox" className="accent-brand-indigo" checked={useStitch} onChange={(e) => setUseStitch(e.target.checked)} /> Stitch
              </label>
            )}
          </div>
          <div className="flex items-center gap-md w-full md:w-auto">
            <span className="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest">Context</span>
            <div className="flex items-center gap-sm flex-1 md:w-48">
              <div className="h-1.5 w-full bg-brand-border rounded-full overflow-hidden">
                <div className="h-full bg-brand-indigo rounded-full shadow-[0_0_8px_rgba(99,102,241,0.4)] transition-[width] duration-500" style={{ width: `${ctxPct}%` }} />
              </div>
              <span className="font-code-md text-code-md text-on-surface-variant min-w-[32px]">{ctxPct}%</span>
            </div>
          </div>
        </section>

        {error && (
          <div className="bg-error/10 border border-error/40 text-error rounded-lg p-md mb-xl font-code-md text-code-md">{error}</div>
        )}

        {/* Build process */}
        {(steps.length > 0 || building) && (
          <section className="space-y-md mb-xl">
            <h3 className="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest mb-sm ml-xs">Build Process</h3>
            {statusMsg && steps.length === 0 && (
              <div className="bg-brand-panel border border-brand-border rounded-lg p-md flex gap-md items-center">
                <span className="material-symbols-outlined text-brand-indigo animate-spin-slow">progress_activity</span>
                <span className="font-code-md text-code-md text-on-surface-variant">{statusMsg}</span>
              </div>
            )}
            {steps.map((s, i) => {
              const active = building && i === steps.length - 1;
              return (
                <div
                  key={i}
                  className={`bg-brand-panel border border-brand-border rounded-lg p-md flex gap-md items-start ${
                    active ? "step-active-border shadow-xl animate-pulse-subtle" : "shadow-sm opacity-90 hover:opacity-100 transition-opacity"
                  }`}
                >
                  <div className="mt-1">
                    {active ? (
                      <span className="material-symbols-outlined text-brand-indigo animate-spin-slow">progress_activity</span>
                    ) : (
                      <span className="material-symbols-outlined text-green-500" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                    )}
                  </div>
                  <div className="flex-1 space-y-xs min-w-0">
                    <div className="flex justify-between items-center gap-sm">
                      <span className={`font-code-md text-code-md text-brand-indigo ${active ? "bg-brand-indigo/20" : "bg-brand-indigo/10"} px-sm py-[2px] rounded truncate`}>
                        {stepLabel(s)}
                      </span>
                      <div className="flex items-center gap-xs flex-shrink-0">
                        {tagsFor(s).map((t) => (
                          <span key={t.label} className={`font-code-md text-[10px] uppercase tracking-wide px-xs py-[1px] rounded border ${t.cls}`}>
                            {t.label}
                          </span>
                        ))}
                        <span className="font-code-md text-[12px] text-on-surface-variant opacity-50 min-w-[44px] text-right">
                          {active ? "Running…" : s.done ? "done" : `${s.tokens ?? 0}t`}
                        </span>
                      </div>
                    </div>
                    <p className="text-on-surface font-body-md">{describe(s)}</p>
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {/* Preview (same visual language as the design) */}
        <section>
          <h3 className="font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest mb-sm ml-xs">Preview</h3>
          <div className="bg-brand-panel border border-brand-border rounded-xl overflow-hidden shadow-lg">
            <div className="flex items-center justify-between gap-md px-md py-sm border-b border-brand-border bg-background/40">
              <div className="flex gap-xs w-1/4">
                <span className="w-2.5 h-2.5 rounded-full bg-error/60" />
                <span className="w-2.5 h-2.5 rounded-full bg-tertiary/60" />
                <span className="w-2.5 h-2.5 rounded-full bg-green-500/60" />
              </div>
              <div className="flex-1 max-w-[420px] flex items-center justify-center gap-xs bg-background border border-brand-border rounded px-md py-[3px]">
                <span className="material-symbols-outlined text-[14px] text-on-surface-variant/60">lock</span>
                <span className="font-code-md text-[12px] text-on-surface-variant/70">{project ? `oxy / ${projectLabel(project)}` : "preview"}</span>
              </div>
              <div className="w-1/4 flex justify-end">
                <button
                  className="flex items-center gap-xs font-code-md text-[12px] text-on-surface-variant hover:text-primary px-sm py-[3px] rounded transition-colors disabled:opacity-30 disabled:cursor-default"
                  disabled={!canPreview}
                  onClick={() => project && window.open(exportUrl(project), "_blank")}
                >
                  <span className="material-symbols-outlined text-[16px]">download</span>
                  Export
                </button>
              </div>
            </div>
            <div className="aspect-video bg-background relative">
              {canPreview && project ? (
                <iframe key={previewKey} src={previewUrl(project)} title="preview" sandbox="allow-scripts" className="w-full h-full border-none bg-white" />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-sm text-center px-lg">
                  <span className="material-symbols-outlined text-[40px] text-on-surface-variant/30">web</span>
                  <p className="font-body-sm text-body-sm text-on-surface-variant/60 max-w-[360px]">
                    {building ? "Building — the preview appears as soon as a page is written." : "Describe an app above and press Build. The live preview shows here."}
                  </p>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      {showSettings && (
        <Settings stitchAvailable={!!status?.stitch} onClose={() => setShowSettings(false)} onSaved={() => getStatus().then(setStatus).catch(() => {})} />
      )}
    </>
  );
}
