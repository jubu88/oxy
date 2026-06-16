import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentStep } from "../agent/types.ts";
import { exportUrl, getStatus, previewUrl, runBuild, type BuildEvent, type OxyStatus } from "./api.ts";

const NUM_CTX = 16384; // matches the loop's context budget

const TOOL_ICON: Record<string, string> = {
  get_design_system: "palette",
  write_file: "draft",
  edit_file: "edit",
  read_file: "description",
  list_files: "folder_open",
  get_icon: "star",
  web_search: "search",
  web_fetch: "public",
  generate_image: "image",
  design_with_stitch: "auto_awesome",
  review_design: "visibility",
  done: "check_circle",
};

function iconFor(s: AgentStep): string {
  const t = s.toolCalls[0]?.name;
  if (t && TOOL_ICON[t]) return TOOL_ICON[t];
  return s.done ? "check_circle" : "bolt";
}

function stepLabel(s: AgentStep): string {
  if (!s.toolCalls.length) return s.message?.trim() ? "thinking…" : "no action";
  return s.toolCalls
    .map((t) => {
      const arg = t.args?.path || t.args?.style || t.args?.name || t.args?.query || "";
      return arg ? `${t.name} · ${arg}` : t.name;
    })
    .join(", ");
}

// Prefer a coder/instruct model; never auto-pick a vision/embedding model.
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

function tagsFor(s: AgentStep): Array<{ cls: string; label: string }> {
  const tags: Array<{ cls: string; label: string }> = [];
  if (s.burst) tags.push({ cls: "think", label: "thinking" });
  if (s.compacted) tags.push({ cls: "compact", label: "compacted" });
  if (s.truncated) tags.push({ cls: "trunc", label: "truncated" });
  if (s.done) tags.push({ cls: "done", label: "done" });
  return tags;
}

export function App() {
  const [status, setStatus] = useState<OxyStatus | null>(null);
  const [engine, setEngine] = useState("ollama");
  const [model, setModel] = useState("");
  const [task, setTask] = useState("");
  const [useStitch, setUseStitch] = useState(false);

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
        if (!s.engines.ollama && s.engines["node-llama"]) setEngine("node-llama");
        setModel(pickDefaultModel(s.models));
      })
      .catch(() => setStatus({ engines: { ollama: false, "node-llama": true }, stitch: false, sd: false, models: [] }));
  }, []);

  const ctxPct = useMemo(() => {
    const last = [...steps].reverse().find((s) => typeof s.ctxTokens === "number");
    if (!last?.ctxTokens) return 0;
    return Math.max(0, Math.min(100, Math.round((last.ctxTokens / NUM_CTX) * 100)));
  }, [steps]);

  const hasWritten = steps.some((s) => s.toolCalls.some((t) => ["write_file", "edit_file", "design_with_stitch"].includes(t.name)));

  async function build() {
    if (building || !task.trim()) return;
    setBuilding(true);
    setError("");
    setSteps([]);
    setProject(null);
    setStatusMsg("starting…");
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await runBuild({ task: task.trim(), engine, model: model || undefined, useStitch }, (e: BuildEvent) => {
        if (e.type === "status") setStatusMsg(e.message);
        else if (e.type === "project") setProject(e.project);
        else if (e.type === "step") {
          setStatusMsg("");
          setSteps((prev) => [...prev, e.step]);
          if (e.step.toolCalls.some((t) => ["write_file", "edit_file", "design_with_stitch"].includes(t.name))) {
            setPreviewKey((k) => k + 1);
          }
        } else if (e.type === "done") {
          setPreviewKey((k) => k + 1);
        } else if (e.type === "error") {
          setError(e.message);
        }
      }, ac.signal);
    } catch (err: any) {
      if (!ac.signal.aborted) setError(String(err?.message ?? err));
    } finally {
      setBuilding(false);
      setStatusMsg("");
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
    setBuilding(false);
  }

  function changeEngine(next: string) {
    setEngine(next);
    if (next === "ollama") {
      setModel(pickDefaultModel(status?.models ?? []));
    } else {
      setModel(""); // node-llama uses its bundled default GGUF unless a HF ref is given
    }
  }

  const modelOptions = engine === "ollama" ? status?.models ?? [] : [];

  return (
    <div className="app">
      <header className="header">
        <h1>Oxy</h1>
        <p>build web apps with a local model</p>
      </header>

      <section className="prompt">
        <textarea
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Describe the app you want to build…"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") build();
          }}
        />
        {building ? (
          <button className="build-btn" onClick={stop}>
            Stop
          </button>
        ) : (
          <button className="build-btn" onClick={build} disabled={!task.trim()}>
            Build
          </button>
        )}
      </section>

      <section className="status-row">
        <div className="pill" title="active engine and model">
          <span className="material-symbols-outlined">memory</span>
          <select className="engine" value={engine} onChange={(e) => changeEngine(e.target.value)}>
            {status?.engines.ollama && <option value="ollama">ollama</option>}
            <option value="node-llama">node-llama</option>
          </select>
          {engine === "ollama" ? (
            modelOptions.length ? (
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            ) : (
              <span className="label">no models</span>
            )
          ) : (
            <input
              className="model-input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="hf:Qwen/Qwen2.5-Coder-3B-Instruct-GGUF:Q4_K_M"
              spellCheck={false}
            />
          )}
        </div>

        <div className="context" title="how full the model's context window is">
          <span className="num">{ctxPct}%</span>
          <div className="track">
            <div className="fill" style={{ width: `${ctxPct}%` }} />
          </div>
          <span className="tag">context</span>
        </div>

        {status?.stitch && (
          <label className="stitch-toggle" title="let the model use Google Stitch (cloud) for the page design">
            <input type="checkbox" checked={useStitch} onChange={(e) => setUseStitch(e.target.checked)} /> design with Stitch
          </label>
        )}
      </section>

      {error && <div className="banner error">{error}</div>}

      {(steps.length > 0 || building) && (
        <section>
          <p className="section-title">Build progress</p>
          {statusMsg && steps.length === 0 && (
            <div className="timeline empty">
              <div className="card">
                <div className="left">
                  <span className="material-symbols-outlined">hourglass_top</span>
                  <code>{statusMsg}</code>
                </div>
              </div>
            </div>
          )}
          <div className={`timeline${steps.length === 0 ? " empty" : ""}`}>
            {steps.map((s, i) => {
              const active = building && i === steps.length - 1;
              const done = s.done || (!active && !building);
              return (
                <div key={i} className={`step${active ? " active" : ""}`}>
                  <div className="node">
                    {active ? <span className="dot" /> : <span className="material-symbols-outlined">{done ? "check" : iconFor(s)}</span>}
                  </div>
                  <div className="card">
                    <div className="left">
                      <span className="material-symbols-outlined">{iconFor(s)}</span>
                      <code>{stepLabel(s)}</code>
                    </div>
                    <div className="tags">
                      {tagsFor(s).map((t) => (
                        <span key={t.label} className={`tag-pill ${t.cls}`}>
                          {t.label}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="preview">
        <div className="browser-bar">
          <div className="dots">
            <span />
            <span />
            <span />
          </div>
          <div className="addr">
            <span className="material-symbols-outlined">lock</span>
            {project ? `localhost / ${project}` : "preview"}
          </div>
          <div className="export">
            <button disabled={!project || !hasWritten} onClick={() => project && window.open(exportUrl(project), "_blank")}>
              <span className="material-symbols-outlined">download</span>
              Export .zip
            </button>
          </div>
        </div>
        <div className="preview-view">
          {project && hasWritten ? (
            <iframe key={previewKey} src={previewUrl(project)} title="preview" sandbox="allow-scripts" />
          ) : (
            <div className="preview-empty">
              <span className="material-symbols-outlined">web</span>
              <p>{building ? "building your app — the preview will appear as soon as a page is written." : "Describe an app above and press Build. The live preview will appear here."}</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
