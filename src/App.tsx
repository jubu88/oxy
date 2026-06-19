import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import type { AgentStep } from "../agent/types.ts";
import { Background } from "./Background.tsx";
import { Settings } from "./Settings.tsx";
import { exportUrl, getProjects, getStatus, previewUrl, runAsk, runBuild, type AskEvent, type Attachment, type BuildEvent, type OxyStatus, type ProjectInfo } from "./api.ts";

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

function tagsFor(s: AgentStep): Array<{ cls: string; label: string }> {
  const tags: Array<{ cls: string; label: string }> = [];
  if (s.burst) tags.push({ cls: "think", label: "thinking" });
  if (s.compacted) tags.push({ cls: "compact", label: "compacted" });
  if (s.truncated) tags.push({ cls: "trunc", label: "truncated" });
  if (s.done) tags.push({ cls: "done", label: "done" });
  return tags;
}

// Which processor the active engine will actually use here — shown so nobody is
// silently on CPU. Ollama only offloads to CUDA/Metal; llama-server uses the
// detected backend (incl. Vulkan on Intel/AMD).
function processorLabel(engine: string, status: OxyStatus | null): string {
  if (!status) return "";
  if (engine === "openai") return "remote";
  if (engine === "ollama") return status.ollamaUsesGpu ? (status.gpu ?? "gpu").toUpperCase() : "CPU";
  return (status.gpu ?? "cpu").toUpperCase();
}

// elapsed as M:SS for the live "generating…" indicator
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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

const projectLabel = (id: string) => id.replace(/-\d{8,}$/, "").replace(/-/g, " ").slice(0, 40) || id;

// Remember the user's engine/model choice across reloads, so a page refresh doesn't
// snap them back to the auto-recommended engine (the "I picked ollama but it used
// llama-server" surprise). Falls back to {} on any storage/parse error.
function loadPrefs(): { engine?: string; model?: string; baseUrl?: string; useStitch?: boolean } {
  try {
    return JSON.parse(localStorage.getItem("oxy.prefs") || "{}") || {};
  } catch {
    return {};
  }
}

// Read a file's bytes as base64 (no data: prefix).
function fileToBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}

// Downscale large images before sending. gemma4 tiles big images into many vision
// tokens ("pan-and-scan"), so a full-size screenshot can take minutes to encode on
// an iGPU before the first output token. Capping the longest edge slashes that with
// negligible quality loss for "look at this and build it". Small images and any
// decode failure fall through to the original bytes untouched.
async function imageToAttachmentData(f: File, maxEdge = 1024): Promise<{ data: string; mime: string }> {
  try {
    const bmp = await createImageBitmap(f);
    const big = Math.max(bmp.width, bmp.height);
    if (big <= maxEdge) {
      bmp.close?.();
      return { data: await fileToBase64(f), mime: f.type };
    }
    const scale = maxEdge / big;
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bmp.close?.();
      return { data: await fileToBase64(f), mime: f.type };
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    // PNG keeps UI/text screenshots crisp (JPEG ringing hurts "rebuild this UI").
    const data = canvas.toDataURL("image/png").split(",")[1] ?? "";
    return { data, mime: "image/png" };
  } catch {
    return { data: await fileToBase64(f), mime: f.type };
  }
}

// One row in the build-progress list: a phase ("loading model…", "generating…") or a
// completed step (a tool call), each with how long it took. The active row is tracked
// separately (activeLabel) and shows a live timer.
interface TimelineItem {
  kind: "phase" | "step";
  label: string;
  ms: number;
  tags?: Array<{ cls: string; label: string }>;
  done?: boolean;
  icon?: string;
}

export function App() {
  const [status, setStatus] = useState<OxyStatus | null>(null);
  const [engine, setEngine] = useState(() => loadPrefs().engine || "ollama");
  const [model, setModel] = useState(() => loadPrefs().model || "");
  const [baseUrl, setBaseUrl] = useState(() => loadPrefs().baseUrl || "http://localhost:8080/v1");
  const [task, setTask] = useState("");
  const [useStitch, setUseStitch] = useState(() => !!loadPrefs().useStitch);
  const [mode, setMode] = useState<"build" | "ask">("build"); // build an app vs. one-shot Q&A
  const [answer, setAnswer] = useState(""); // ask-mode response

  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [selProject, setSelProject] = useState("");
  const [showSettings, setShowSettings] = useState(false);

  const [building, setBuilding] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [project, setProject] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [previewKey, setPreviewKey] = useState(0);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [liveTokens, setLiveTokens] = useState(0); // tokens streamed in the current turn
  const [, setNowTick] = useState(0); // 1s heartbeat so the elapsed timer re-renders
  const [items, setItems] = useState<TimelineItem[]>([]); // completed phase/step rows, each with its duration
  const [activeLabel, setActiveLabel] = useState(""); // the in-progress row's label (live timer)
  const [lastBuildMs, setLastBuildMs] = useState(0); // total wall-clock of the last finished build
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const activeLabelRef = useRef(""); // current active label, read inside the streaming callback (avoids stale closure)
  const genStartRef = useRef<number>(0); // when the current row started (resets each phase/step)
  const buildStartRef = useRef<number>(0); // when the whole build started (never resets) — overall timer

  useEffect(() => {
    const hadSavedEngine = !!loadPrefs().engine;
    getStatus()
      .then((s) => {
        setStatus(s);
        // smart routing applies only on first run; once the user has explicitly
        // chosen an engine we keep it (don't override their pick with the default).
        if (!hadSavedEngine) {
          const eng = s.recommended ?? (s.engines.ollama ? "ollama" : "llama-server");
          setEngine(eng);
          setModel(eng === "ollama" ? pickDefaultModel(s.models) : "");
        }
      })
      .catch(() => setStatus({ engines: { ollama: false, "llama-server": true }, stitch: false, sd: false, models: [] }));
    getProjects().then(setProjects);
  }, []);

  // persist the engine/model choice so a reload keeps it (no snap-back to the default)
  useEffect(() => {
    try {
      localStorage.setItem("oxy.prefs", JSON.stringify({ engine, model, baseUrl, useStitch }));
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [engine, model, baseUrl, useStitch]);

  // 1-second heartbeat so the live "generating…" elapsed timer ticks while building
  useEffect(() => {
    if (!building) return;
    const t = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [building]);

  const ctxPct = useMemo(() => {
    const last = [...steps].reverse().find((s) => typeof s.ctxTokens === "number");
    if (!last?.ctxTokens) return 0;
    return Math.max(0, Math.min(100, Math.round((last.ctxTokens / NUM_CTX) * 100)));
  }, [steps]);

  const hasWritten = steps.some((s) => s.toolCalls.some((t) => ["write_file", "edit_file", "design_with_stitch"].includes(t.name)));
  const selHasIndex = !!projects.find((p) => p.id === project)?.hasIndex;
  const canPreview = !!project && (hasWritten || selHasIndex);
  const iterating = !!selProject;
  const features = status?.features ?? {};
  const proc = processorLabel(engine, status);
  // live "generating…" indicator: elapsed since the current turn began + streamed tokens/rate
  const genElapsed = building ? Date.now() - genStartRef.current : 0;
  const liveLabel = building ? `${fmtElapsed(genElapsed)}${liveTokens > 0 ? ` · ${liveTokens} tok · ${Math.round(liveTokens / Math.max(1, genElapsed / 1000))}/s` : ""}` : "";
  // once tokens stream, the model is past loading/prefill — say so, don't linger on "reading images…"
  const displayStatus = building && liveTokens > 0 ? "generating…" : statusMsg;
  // overall build time — keeps running across steps (unlike the per-turn live timer) and
  // freezes at the final total when the build ends.
  const overallElapsed = building ? Date.now() - buildStartRef.current : lastBuildMs;

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

  // close the current row, recording its label + how long it took, into the list
  function closeRow(kind: "phase" | "step", label: string, extra?: Partial<TimelineItem>) {
    const ms = Date.now() - genStartRef.current;
    setItems((prev) => [...prev, { kind, label, ms, ...extra }]);
    genStartRef.current = Date.now();
    setLiveTokens(0);
  }

  async function build() {
    if (building || !task.trim()) return;
    setBuilding(true);
    setError("");
    setSteps([]);
    setItems([]);
    setLastBuildMs(0);
    activeLabelRef.current = "starting…";
    setActiveLabel("starting…");
    setLiveTokens(0);
    genStartRef.current = Date.now();
    buildStartRef.current = Date.now();
    if (!selProject) setProject(null);
    const ac = new AbortController();
    abortRef.current = ac;
    let builtId = selProject || "";
    try {
      await runBuild(
        { task: task.trim(), engine, model: model || undefined, useStitch, project: selProject || undefined, baseUrl: engine === "openai" ? baseUrl : undefined, attachments: attachments.length ? attachments : undefined },
        (e: BuildEvent) => {
          if (e.type === "status") {
            // a new phase begins — record the previous active row as a phase, then switch
            if (activeLabelRef.current) closeRow("phase", activeLabelRef.current);
            activeLabelRef.current = e.message;
            setActiveLabel(e.message);
          } else if (e.type === "project") {
            builtId = e.project;
            setProject(e.project);
          } else if (e.type === "step") {
            // the active turn produced a tool call — record it AS that step (with its timer)
            closeRow("step", stepLabel(e.step), { tags: tagsFor(e.step), done: e.step.done, icon: iconFor(e.step) });
            setSteps((prev) => [...prev, e.step]);
            activeLabelRef.current = e.step.done ? "" : "generating…";
            setActiveLabel(activeLabelRef.current);
            if (e.step.toolCalls.some((t) => ["write_file", "edit_file", "design_with_stitch"].includes(t.name))) setPreviewKey((k) => k + 1);
          } else if (e.type === "progress") {
            setLiveTokens(e.tokens);
          } else if (e.type === "done") {
            if (activeLabelRef.current) closeRow("phase", activeLabelRef.current, { done: true });
            activeLabelRef.current = "";
            setActiveLabel("");
            setPreviewKey((k) => k + 1);
          } else if (e.type === "error") setError(e.message);
        },
        ac.signal,
      );
      const fresh = await getProjects();
      setProjects(fresh);
      if (builtId) setSelProject(builtId);
    } catch (err: any) {
      if (!ac.signal.aborted) setError(String(err?.message ?? err));
    } finally {
      setLastBuildMs(Date.now() - buildStartRef.current); // freeze the total
      setBuilding(false);
      activeLabelRef.current = "";
      setActiveLabel("");
      abortRef.current = null;
    }
  }

  // Ask mode: one-shot Q&A (no build/tools/project) — attach/paste an image + a question
  async function ask() {
    if (building || !task.trim()) return;
    setBuilding(true);
    setError("");
    setAnswer("");
    setLastBuildMs(0);
    setStatusMsg("thinking…");
    setLiveTokens(0);
    genStartRef.current = Date.now();
    buildStartRef.current = Date.now();
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await runAsk(
        { task: task.trim(), engine, model: model || undefined, baseUrl: engine === "openai" ? baseUrl : undefined, attachments: attachments.length ? attachments : undefined },
        (e: AskEvent) => {
          if (e.type === "status") setStatusMsg(e.message);
          else if (e.type === "delta") {
            setStatusMsg("");
            setAnswer((a) => a + e.text);
          } else if (e.type === "progress") setLiveTokens(e.tokens);
          else if (e.type === "answer") {
            setStatusMsg("");
            setAnswer(e.text);
          } else if (e.type === "error") setError(e.message);
        },
        ac.signal,
      );
    } catch (err: any) {
      if (!ac.signal.aborted) setError(String(err?.message ?? err));
    } finally {
      setLastBuildMs(Date.now() - buildStartRef.current);
      setBuilding(false);
      setStatusMsg("");
      abortRef.current = null;
    }
  }

  const submit = () => (mode === "ask" ? ask() : build());

  const stop = () => {
    abortRef.current?.abort();
    setBuilding(false);
  };

  // paste an image straight into the prompt (clipboard screenshots / copied images)
  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const imgs = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (imgs.length) {
      e.preventDefault(); // don't also dump the image as junk text
      void onFiles(imgs);
    }
  }

  // read attached image/audio files as base64 (gemma4 is multimodal)
  async function onFiles(files: FileList | File[] | null) {
    if (!files) return;
    const next: Attachment[] = [];
    for (const f of Array.from(files)) {
      const kind = f.type.startsWith("image/") ? "image" : f.type.startsWith("audio/") ? "audio" : null;
      if (!kind) {
        setError(`${f.name}: only image or audio files can be attached`);
        continue;
      }
      if (f.size > 12 * 1024 * 1024) {
        setError(`${f.name} is too large (max 12 MB)`);
        continue;
      }
      // images get downscaled (huge screenshots = slow vision prefill on an iGPU) unless
      // the feature is toggled off in Settings; audio passes through as raw base64.
      const downscale = status?.features?.downscaleImages !== false;
      const { data, mime } =
        kind === "image" && downscale ? await imageToAttachmentData(f) : { data: await fileToBase64(f), mime: f.type };
      next.push({ kind, mime, data, name: f.name || `pasted.${mime.split("/")[1] || "png"}` });
    }
    if (next.length) setAttachments((prev) => [...prev, ...next].slice(0, 6));
    if (fileRef.current) fileRef.current.value = ""; // allow re-picking the same file
  }
  const removeAttachment = (i: number) => setAttachments((prev) => prev.filter((_, j) => j !== i));

  return (
    <>
      <Background />
      <div className="app">
        <div className="topbar">
          <select className="project-select" value={selProject} onChange={(e) => selectProject(e.target.value)} title="new project, or pick one to keep iterating">
            <option value="">+ New project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {projectLabel(p.id)}
              </option>
            ))}
          </select>
          <button className="gear" title="Settings" onClick={() => setShowSettings(true)}>
            <span className="material-symbols-outlined">settings</span>
          </button>
        </div>

        <header className="header">
          <h1>Oxy</h1>
          <p>build apps with a local model</p>
        </header>

        <section className="prompt">
          <div className="prompt-main">
          <div className="mode-toggle">
            <button type="button" className={mode === "build" ? "on" : ""} onClick={() => setMode("build")}>Build</button>
            <button type="button" className={mode === "ask" ? "on" : ""} onClick={() => setMode("ask")}>Ask</button>
          </div>
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder={mode === "ask" ? "Ask about an attached image, or anything…" : iterating ? "Describe a change or addition…" : "Describe the app you want to build…"}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
            }}
            onPaste={onPaste}
          />
          <div className="attach-row">
            <button className="attach-btn" type="button" onClick={() => fileRef.current?.click()} title="attach an image or audio file (gemma4 is multimodal)">
              <span className="material-symbols-outlined">attach_file</span>
            </button>
            <input ref={fileRef} type="file" accept="image/*,audio/*" multiple hidden onChange={(e) => onFiles(e.target.files)} />
            {attachments.map((a, i) => (
              <span key={i} className="attach-chip" title={a.name}>
                <span className="material-symbols-outlined">{a.kind === "image" ? "image" : "graphic_eq"}</span>
                <span className="attach-name">{a.name || a.kind}</span>
                <button className="attach-x" type="button" onClick={() => removeAttachment(i)} title="remove">
                  ×
                </button>
              </span>
            ))}
          </div>
          </div>
          {building ? (
            <button className="build-btn stop" onClick={stop}>
              Stop
            </button>
          ) : (
            <button className="build-btn" onClick={submit} disabled={!task.trim()}>
              {mode === "ask" ? "Ask" : iterating ? "Update" : "Build"}
            </button>
          )}
        </section>
        <p className="helper">{mode === "ask" ? "⌘/Ctrl + Enter to ask — attach or paste an image" : iterating ? "iterating — Oxy reads the current files and edits in place" : "⌘/Ctrl + Enter to build"}</p>

        <section className="status-row">
          <button className="pill info-pill" title="active engine and model — click to change in Settings" onClick={() => setShowSettings(true)}>
            <span className="material-symbols-outlined">memory</span>
            <span className="info-engine">{engine}</span>
            <span className="info-sep">·</span>
            <span className="info-model">{engine === "ollama" ? model || "default" : engine === "openai" ? model || "default" : model || "gemma4"}</span>
            {features.thinking && <span className="info-flag">thinking</span>}
            {useStitch && status?.stitch && <span className="info-flag">Stitch</span>}
            {proc && (
              <span className={"proc" + (proc === "CPU" ? " cpu" : "")} title={status?.recommendReason || "where this engine runs"}>
                {proc}
              </span>
            )}
            <span className="material-symbols-outlined info-gear">settings</span>
          </button>

          <div className="context" title="how full the model's context window is">
            <span className="num">{ctxPct}%</span>
            <div className="track">
              <div className="fill" style={{ width: `${ctxPct}%` }} />
            </div>
            <span className="tag">context</span>
          </div>
        </section>

        {error && <div className="banner error">{error}</div>}

        {mode === "build" && (items.length > 0 || building) && (
          <section>
            <p className="section-title">
              Build progress
              {overallElapsed > 0 && <span className="section-timer">{fmtElapsed(overallElapsed)}</span>}
            </p>
            <div className="timeline">
              {items.map((it, i) => (
                <div key={i} className="step">
                  <div className="node">
                    <span className="material-symbols-outlined">{it.icon ?? (it.kind === "phase" ? "hourglass_top" : "check")}</span>
                  </div>
                  <div className="card">
                    <div className="left">
                      <code>{it.label}</code>
                    </div>
                    <div className="tags">
                      <span className="tag-pill time">{fmtElapsed(it.ms)}</span>
                      {it.tags?.map((t) => (
                        <span key={t.label} className={`tag-pill ${t.cls}`}>
                          {t.label}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
              {building && activeLabel && (
                <div className="step active">
                  <div className="node">
                    <span className="dot" />
                  </div>
                  <div className="card">
                    <div className="left">
                      <code>{activeLabel}</code>
                    </div>
                    <div className="tags">{liveLabel && <span className="tag-pill live">{liveLabel}</span>}</div>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {mode === "ask" && (answer || building) && (
          <section>
            <p className="section-title">
              Answer
              {overallElapsed > 0 && <span className="section-timer">{fmtElapsed(overallElapsed)}</span>}
            </p>
            <div className="answer-card">
              {answer ? <div className="answer-text">{answer}</div> : <div className="answer-text muted">{displayStatus || "…"}</div>}
              {building && liveLabel && <div className="answer-live">{liveLabel}</div>}
            </div>
          </section>
        )}

        {mode === "build" && (
        <section className="preview">
          <div className="browser-bar">
            <div className="dots">
              <span />
              <span />
              <span />
            </div>
            <div className="addr">
              <span className="material-symbols-outlined">lock</span>
              {project ? `oxy / ${projectLabel(project)}` : "preview"}
            </div>
            <div className="export">
              <button disabled={!canPreview} onClick={() => project && window.open(exportUrl(project), "_blank")}>
                <span className="material-symbols-outlined">download</span>
                Export .zip
              </button>
            </div>
          </div>
          <div className="preview-view">
            {canPreview && project ? (
              <iframe key={previewKey} src={previewUrl(project)} title="preview" sandbox="allow-scripts" />
            ) : (
              <div className="preview-empty">
                <span className="material-symbols-outlined">web</span>
                <p>{building ? "building your app — the preview will appear as soon as a page is written." : "Describe an app above and press Build. The live preview will appear here."}</p>
              </div>
            )}
          </div>
        </section>
        )}
      </div>

      {showSettings && (
        <Settings
          status={status}
          stitchAvailable={!!status?.stitch}
          engine={engine}
          onEngineChange={changeEngine}
          model={model}
          setModel={setModel}
          baseUrl={baseUrl}
          setBaseUrl={setBaseUrl}
          useStitch={useStitch}
          setUseStitch={setUseStitch}
          tools={status?.tools}
          terminalMode={status?.terminalMode}
          features={status?.features}
          onClose={() => setShowSettings(false)}
          onSaved={() => getStatus().then(setStatus).catch(() => {})}
        />
      )}
    </>
  );
}
