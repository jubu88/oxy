import { useEffect, useState } from "react";
import { checkModel, downloadModel, listDownloadableModels, saveFeatures, saveModels, saveStitchKey, saveToolSettings, type DownloadableModel, type OxyStatus } from "./api.ts";

const modelLabel = (ref: string) => ref.replace(/^hf:/, "");

const SAFE_TOOLS: Array<{ key: string; label: string; hint: string }> = [
  { key: "web_search", label: "Web search", hint: "let the model search the web (DuckDuckGo)" },
  { key: "web_fetch", label: "Web fetch", hint: "let the model fetch a URL's text (SSRF-guarded)" },
  { key: "generate_image", label: "Image generation", hint: "local Stable Diffusion image assets" },
];

// The toggleable "improvement" features — flip any off to A/B test it. `def` mirrors the
// server's DEFAULT_FEATURES so the toggle shows the right state before status loads.
const FEATURE_CATALOG: Array<{ key: string; def: boolean; label: string; hint: string }> = [
  { key: "autoLearn", def: true, label: "Auto-learn from builds", hint: "review every build in the background and, after enough have accumulated, auto-promote a skill improvement — but only if it beats the benchmark (gated, never degrades). Self-improving." },
  { key: "useSkill", def: true, label: "Use the learned skill", hint: "build with the tuned skill in skill/system.md. OFF = use the built-in default prompt (handy to A/B the learned skill against baseline)" },
  { key: "thinking", def: false, label: "Model thinking", hint: "reason each turn before acting — slower, can help hard logic. OFF = straight to building (recommended; gemma4 over-thinks)" },
  { key: "downscaleImages", def: true, label: "Downscale attached images", hint: "shrink big screenshots before sending — far faster vision prefill on an iGPU" },
  { key: "idleTimeout", def: true, label: "Idle generate timeout", hint: "abort only after 120s of silence, not a 600s total cap — lets a slow-but-working build finish instead of reboot-looping" },
  { key: "autoCompact", def: true, label: "Auto-compact context", hint: "checkpoint + reseed a fresh context when it fills, so long builds keep going past the window" },
  { key: "recoveryBursts", def: true, label: "Recovery reasoning bursts", hint: "think for one turn after an error, a design critique, or rambling — even when thinking is off" },
  { key: "modelAwareReuse", def: true, label: "Model-aware server reuse", hint: "restart llama-server when you pick a different model, instead of silently keeping the old one" },
];

export function Settings({
  status,
  stitchAvailable,
  engine,
  onEngineChange,
  model,
  setModel,
  baseUrl,
  setBaseUrl,
  useStitch,
  setUseStitch,
  tools: initialTools,
  terminalMode: initialMode,
  features: initialFeatures,
  onClose,
  onSaved,
}: {
  status: OxyStatus | null;
  stitchAvailable: boolean;
  engine: string;
  onEngineChange: (e: string) => void;
  model: string;
  setModel: (m: string) => void;
  baseUrl: string;
  setBaseUrl: (u: string) => void;
  useStitch: boolean;
  setUseStitch: (b: boolean) => void;
  tools?: Record<string, boolean>;
  terminalMode?: string;
  features?: Record<string, boolean>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [tools, setTools] = useState<Record<string, boolean>>(initialTools ?? { web_search: true, web_fetch: true, generate_image: true, run_command: false });
  const [mode, setMode] = useState(initialMode ?? "container");
  const [features, setFeatures] = useState<Record<string, boolean>>(initialFeatures ?? {});
  const [llamaModels, setLlamaModels] = useState<string[]>(status?.llamaModels ?? []);
  const [hfInput, setHfInput] = useState("");
  const [hfMsg, setHfMsg] = useState("");
  const [adding, setAdding] = useState(false);
  const [catalog, setCatalog] = useState<DownloadableModel[]>([]);
  const [browseRef, setBrowseRef] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [dl, setDl] = useState<{ active: boolean; pct: number | null; msg: string }>({ active: false, pct: null, msg: "" });

  const ollamaModels = engine === "ollama" ? status?.models ?? [] : [];

  // load the downloadable-model catalog once (server caches it; Refresh re-pulls)
  useEffect(() => {
    listDownloadableModels(false)
      .then((r) => setCatalog(r.models))
      .catch(() => {});
  }, []);

  async function refreshCatalog() {
    setRefreshing(true);
    const r = await listDownloadableModels(true);
    setRefreshing(false);
    if (r.models.length) setCatalog(r.models);
  }

  // Download a browsed model NOW (prewarm + load), streaming progress, then select it.
  async function downloadNow() {
    if (!browseRef) return;
    setDl({ active: true, pct: null, msg: "starting…" });
    try {
      await downloadModel(browseRef, (e) => {
        if (e.type === "status") setDl((d) => ({ ...d, msg: e.message }));
        else if (e.type === "progress") setDl({ active: true, pct: e.pct, msg: e.pct != null ? `${e.pct}% · ${e.mb}/${e.totalMb} MB · ${e.secs}s` : `${e.mb} MB · ${e.secs}s` });
        else if (e.type === "done") setDl({ active: false, pct: 100, msg: "✓ downloaded & ready" });
        else if (e.type === "error") setDl({ active: false, pct: null, msg: "✗ " + e.message });
      });
      const saved = await saveModels([...new Set([...llamaModels, browseRef])]);
      if (saved) {
        setLlamaModels(saved);
        setModel(browseRef);
        onSaved();
      }
    } catch (e: any) {
      setDl({ active: false, pct: null, msg: "✗ " + String(e?.message ?? e) });
    }
  }

  // Add a Hugging Face model: validate it exists (+ has the quant) then save it to the picker.
  async function addHfModel() {
    const raw = hfInput.trim();
    if (!raw) return;
    const ref = raw.startsWith("hf:") || /^https?:\/\//i.test(raw) || raw.includes("\\") ? raw : `hf:${raw}`;
    setAdding(true);
    setHfMsg("checking Hugging Face…");
    const res = await checkModel(ref);
    setAdding(false);
    if (!res.ok) {
      setHfMsg("✗ " + (res.error || "not found"));
      return;
    }
    const saved = await saveModels([...new Set([...llamaModels, ref])]);
    if (saved) {
      setLlamaModels(saved);
      setModel(ref);
      setHfInput("");
      setHfMsg(`✓ added — downloads automatically on first build${res.note ? ` (${res.note})` : ""}`);
      onSaved();
    } else setHfMsg("✗ could not save");
  }

  async function saveKey() {
    setSaving(true);
    setMsg("");
    const ok = await saveStitchKey(key);
    setSaving(false);
    if (ok) {
      setMsg(key.trim() ? "✓ saved" : "✓ cleared");
      onSaved();
    } else setMsg("could not save");
  }

  async function persistTools(nextTools: Record<string, boolean>, nextMode: string) {
    setTools(nextTools);
    setMode(nextMode);
    const r = await saveToolSettings(nextTools, nextMode);
    if (r) {
      if (r.tools) setTools(r.tools);
      if (r.terminalMode) setMode(r.terminalMode);
      onSaved();
    }
  }
  const toggleTool = (k: string) => persistTools({ ...tools, [k]: !tools[k] }, mode);

  async function toggleFeature(f: { key: string; def: boolean }) {
    const cur = features[f.key] ?? f.def;
    const next = { ...features, [f.key]: !cur };
    setFeatures(next);
    const saved = await saveFeatures(next);
    if (saved) {
      setFeatures(saved);
      onSaved();
    }
  }

  return (
    <div className="settings-page">
      <div className="settings-inner">
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="btn-ghost" onClick={onClose}>
            ← Back
          </button>
        </div>
        <p className="modal-sub">Engine, model, and every feature flag live here. The main screen just shows status. Everything stays on your machine.</p>

        {/* ---- Engine & model ---- */}
        <div className="settings-section">
          <h3>Engine &amp; model</h3>
          <div className="field">
            <label>Engine — where inference runs</label>
            <select className="settings-select" value={engine} onChange={(e) => onEngineChange(e.target.value)}>
              {status?.engines.ollama && <option value="ollama">ollama</option>}
              <option value="llama-server">llama-server (managed, GPU via Vulkan)</option>
              <option value="openai">openai-compatible</option>
            </select>
            {status?.recommendReason && <span className="tool-hint">{status.recommendReason}</span>}
          </div>

          <div className="field">
            <label>Model{engine === "llama-server" ? " — name, or download from Hugging Face" : ""}</label>
            {engine === "ollama" ? (
              ollamaModels.length ? (
                <select className="settings-select" value={model} onChange={(e) => setModel(e.target.value)}>
                  {ollamaModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="tool-hint">no Ollama models found — pull one with `ollama pull gemma4:e4b`</span>
              )
            ) : engine === "openai" ? (
              <div className="field-row">
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:8080/v1" spellCheck={false} />
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model id (optional)" spellCheck={false} />
              </div>
            ) : (
              <>
                {/* active model (saved + downloaded) */}
                <select className="settings-select" value={model || llamaModels[0] || ""} onChange={(e) => setModel(e.target.value)}>
                  {llamaModels.map((m, i) => (
                    <option key={m} value={m}>
                      {modelLabel(m)}
                      {i === 0 ? "  (default)" : ""}
                    </option>
                  ))}
                </select>

                {/* browse + download from Hugging Face */}
                <label style={{ marginTop: 14 }}>Download a model from Hugging Face</label>
                <div className="field-row">
                  <select className="settings-select" style={{ flex: 1 }} value={browseRef} onChange={(e) => setBrowseRef(e.target.value)}>
                    <option value="">{catalog.length ? "— pick a model to download —" : "— loading list… —"}</option>
                    {catalog.map((m) => (
                      <option key={m.ref} value={m.ref}>
                        {m.repo}:{m.quant}
                        {m.downloads ? `  (${m.downloads.toLocaleString()}↓)` : ""}
                      </option>
                    ))}
                  </select>
                  <button className="btn-ghost" onClick={refreshCatalog} disabled={refreshing} title="re-pull the list from Hugging Face (in case newer models appeared)">
                    {refreshing ? "…" : "↻ Refresh"}
                  </button>
                </div>
                <div className="field-row">
                  <button className="build-btn" onClick={downloadNow} disabled={!browseRef || dl.active}>
                    {dl.active ? "Downloading…" : "Download now"}
                  </button>
                  {dl.msg && <span className={`tool-hint ${dl.msg.startsWith("✗") ? "danger-text" : ""}`} style={{ alignSelf: "center" }}>{dl.msg}</span>}
                </div>
                {dl.active && dl.pct != null && (
                  <div className="dl-bar">
                    <div className="dl-fill" style={{ width: `${dl.pct}%` }} />
                  </div>
                )}

                {/* add any custom ref (downloads on first build) */}
                <label style={{ marginTop: 14 }}>…or add a custom ref</label>
                <div className="field-row">
                  <input
                    value={hfInput}
                    onChange={(e) => setHfInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addHfModel();
                    }}
                    placeholder="org/repo:Quant — e.g. unsloth/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M"
                    spellCheck={false}
                  />
                  <button className="build-btn" onClick={addHfModel} disabled={adding || !hfInput.trim()}>
                    {adding ? "Checking…" : "Add"}
                  </button>
                </div>
                <span className={`tool-hint ${hfMsg.startsWith("✗") ? "danger-text" : ""}`}>
                  {hfMsg || "“Download now” fetches the model immediately; “Add” saves a ref that downloads on first build. The list is cached — Refresh re-pulls it."}
                </span>
              </>
            )}
          </div>
        </div>

        {/* ---- Feature flags ---- */}
        <div className="settings-section">
          <h3>Improvement features</h3>
          <p className="section-note">Each is an improvement we added; flip one OFF to compare builds with and without it. Defaults are the recommended setting.</p>
          {FEATURE_CATALOG.map((f) => {
            const on = features[f.key] ?? f.def;
            return (
              <label key={f.key} className="tool-row">
                <input type="checkbox" checked={on} onChange={() => toggleFeature(f)} />
                <span className="tool-label">{f.label}</span>
                <span className="tool-hint">{f.hint}</span>
              </label>
            );
          })}
        </div>

        {/* ---- Tools ---- */}
        <div className="settings-section">
          <h3>Tools the model may use</h3>
          {SAFE_TOOLS.map((t) => (
            <label key={t.key} className="tool-row">
              <input type="checkbox" checked={!!tools[t.key]} onChange={() => toggleTool(t.key)} />
              <span className="tool-label">{t.label}</span>
              <span className="tool-hint">{t.hint}</span>
            </label>
          ))}

          <label className="tool-row danger">
            <input type="checkbox" checked={!!tools.run_command} onChange={() => toggleTool("run_command")} />
            <span className="tool-label">Terminal — run commands</span>
            <span className="tool-hint">let the model run shell commands</span>
          </label>

          {tools.run_command && (
            <div className="tool-warning">
              ⚠ A local model running shell commands is dangerous. Only enable this inside a <b>disposable VM or container</b> (e.g. Kubernetes). Choose how commands run:
              <select value={mode} onChange={(e) => persistTools(tools, e.target.value)}>
                <option value="container">Sandboxed container (Docker, network-off) — recommended</option>
                <option value="host">Host (unsafe — only inside a VM/k8s)</option>
              </select>
              {mode === "container" && <span className="tool-hint">requires Docker; commands run in a throwaway, network-less container scoped to the project.</span>}
              {mode === "host" && <span className="tool-hint danger-text">commands run directly on this machine (cwd-jailed only). Use ONLY if Oxy itself is inside a VM/k8s.</span>}
            </div>
          )}
        </div>

        {/* ---- Cloud design (Stitch) ---- */}
        <div className="settings-section">
          <h3>Cloud design (Google Stitch)</h3>
          <div className="field">
            <label>Stitch API key — optional, for cloud UI design</label>
            <div className="field-row">
              <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={stitchAvailable ? "•••••••  (a key is set — type to replace)" : "paste your Stitch API key"} spellCheck={false} />
              <button className="build-btn" onClick={saveKey} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
            <span className={`field-status ${stitchAvailable ? "ok" : ""}`}>{msg || (stitchAvailable ? "✓ Stitch is configured" : "not configured — the cloud design tool stays hidden")}</span>
          </div>
          {stitchAvailable && (
            <label className="tool-row">
              <input type="checkbox" checked={useStitch} onChange={(e) => setUseStitch(e.target.checked)} />
              <span className="tool-label">Design with Stitch</span>
              <span className="tool-hint">use Google Stitch (cloud) to design the page — the prompt is sent to Google</span>
            </label>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
