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
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm p-md" onClick={onClose}>
      <div className="w-[min(480px,92vw)] bg-brand-panel border border-brand-border rounded-xl p-lg shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-headline-md font-headline-md font-bold text-on-surface mb-xs">Settings</h2>
        <p className="font-body-sm text-body-sm text-on-surface-variant mb-lg">Bring your own keys — everything stays on your machine, written to a git-ignored file.</p>

        <div className="space-y-sm mb-lg">
          <label className="block font-label-caps text-label-caps text-on-surface-variant uppercase tracking-widest">Google Stitch API key — optional, for cloud UI design</label>
          <div className="flex gap-sm">
            <input
              type="password"
              className="flex-1 bg-background border border-brand-border rounded-lg px-md py-sm font-code-md text-code-md text-on-surface outline-none focus:border-brand-indigo/60 transition-colors"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={stitchAvailable ? "•••••••  (a key is set — type to replace)" : "paste your Stitch API key"}
              spellCheck={false}
            />
            <button
              className="bg-brand-indigo hover:bg-brand-indigo/90 text-white px-lg py-sm rounded-lg font-bold text-body-sm transition-all active:scale-95 disabled:opacity-50"
              onClick={save}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
          <span className={`font-code-md text-code-md ${stitchAvailable ? "text-green-500" : "text-on-surface-variant/50"}`}>
            {msg || (stitchAvailable ? "✓ Stitch is configured" : "not configured — the cloud design tool stays hidden")}
          </span>
        </div>

        <div className="flex justify-end">
          <button className="border border-brand-border hover:border-brand-indigo/60 text-on-surface px-lg py-sm rounded-lg font-body-sm text-body-sm transition-colors" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
