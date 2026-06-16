import { useState } from "react";
import { saveStitchKey } from "./api.ts";

export function Settings({ stitchAvailable, onClose, onSaved }: { stitchAvailable: boolean; onClose: () => void; onSaved: () => void }) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  async function save() {
    setSaving(true);
    setMsg("");
    const ok = await saveStitchKey(key);
    setSaving(false);
    if (ok) {
      setMsg(key.trim() ? "✓ saved" : "✓ cleared");
      onSaved();
    } else {
      setMsg("could not save");
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal glass" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <p className="sub">Bring your own keys — everything stays on your machine, written to a git-ignored file.</p>
        <div className="field">
          <label>Google Stitch API key — optional, for cloud UI design</label>
          <div className="row">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={stitchAvailable ? "•••••••  (a key is already set — type to replace)" : "paste your Stitch API key"}
              spellCheck={false}
            />
            <button className="btn primary" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          <span className={`status ${stitchAvailable ? "ok" : "no"}`}>
            {msg || (stitchAvailable ? "✓ Stitch is configured" : "not configured — the cloud design tool stays hidden")}
          </span>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
