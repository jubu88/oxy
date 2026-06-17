import { useState } from "react";
import { saveStitchKey, saveToolSettings } from "./api.ts";

const SAFE_TOOLS: Array<{ key: string; label: string; hint: string }> = [
  { key: "web_search", label: "Web search", hint: "let the model search the web (DuckDuckGo)" },
  { key: "web_fetch", label: "Web fetch", hint: "let the model fetch a URL's text (SSRF-guarded)" },
  { key: "generate_image", label: "Image generation", hint: "local Stable Diffusion image assets" },
];

export function Settings({
  stitchAvailable,
  tools: initialTools,
  terminalMode: initialMode,
  onClose,
  onSaved,
}: {
  stitchAvailable: boolean;
  tools?: Record<string, boolean>;
  terminalMode?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [tools, setTools] = useState<Record<string, boolean>>(initialTools ?? { web_search: true, web_fetch: true, generate_image: true, run_command: false });
  const [mode, setMode] = useState(initialMode ?? "container");

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

  async function persist(nextTools: Record<string, boolean>, nextMode: string) {
    setTools(nextTools);
    setMode(nextMode);
    const r = await saveToolSettings(nextTools, nextMode);
    if (r) {
      if (r.tools) setTools(r.tools);
      if (r.terminalMode) setMode(r.terminalMode);
      onSaved();
    }
  }
  const toggleTool = (k: string) => persist({ ...tools, [k]: !tools[k] }, mode);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <p className="modal-sub">Bring your own keys, and choose which tools the model may use — everything stays on your machine.</p>

        <div className="field">
          <label>Google Stitch API key — optional, for cloud UI design</label>
          <div className="field-row">
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={stitchAvailable ? "•••••••  (a key is set — type to replace)" : "paste your Stitch API key"} spellCheck={false} />
            <button className="build-btn" onClick={saveKey} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          <span className={`field-status ${stitchAvailable ? "ok" : ""}`}>{msg || (stitchAvailable ? "✓ Stitch is configured" : "not configured — the cloud design tool stays hidden")}</span>
        </div>

        <div className="field">
          <label>Tools the model may use</label>
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
              <select value={mode} onChange={(e) => persist(tools, e.target.value)}>
                <option value="container">Sandboxed container (Docker, network-off) — recommended</option>
                <option value="host">Host (unsafe — only inside a VM/k8s)</option>
              </select>
              {mode === "container" && <span className="tool-hint">requires Docker; commands run in a throwaway, network-less container scoped to the project.</span>}
              {mode === "host" && <span className="tool-hint danger-text">commands run directly on this machine (cwd-jailed only). Use ONLY if Oxy itself is inside a VM/k8s.</span>}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
