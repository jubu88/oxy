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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>
        <p className="modal-sub">Bring your own keys — everything stays on your machine, written to a git-ignored file.</p>

        <div className="field">
          <label>Google Stitch API key — optional, for cloud UI design</label>
          <div className="field-row">
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={stitchAvailable ? "•••••••  (a key is set — type to replace)" : "paste your Stitch API key"}
              spellCheck={false}
            />
            <button className="build-btn" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          <span className={`field-status ${stitchAvailable ? "ok" : ""}`}>
            {msg || (stitchAvailable ? "✓ Stitch is configured" : "not configured — the cloud design tool stays hidden")}
          </span>
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
