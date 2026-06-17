// Generates Oxy's interface design with Google Stitch (cloud) and saves the raw
// HTML to design/stitch-ui.html as the design reference the React UI is built
// from. The Stitch API key is read by server.mjs from stitch.key.local (never
// committed). Run: node design/gen-stitch.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stitchGenerate } from "../server/server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PROMPT = `Design the interface for "Oxy" — a local-first AI web-app builder where a small language model running entirely on your own machine builds web apps for you. The whole feeling should be calm, focused, minimal and genuinely beautiful — lots of whitespace, soft shadows, rounded corners, one tasteful accent color (a calm indigo), a refined modern sans-serif, light theme.

Single centered column on a soft off-white background. Sections, top to bottom:
1. A small wordmark "Oxy" with a one-line subtitle "build web apps with a local model".
2. A large, inviting rounded multi-line prompt input with placeholder "Describe the app you want to build…" and a prominent primary "Build" button to its right.
3. A subtle status row directly under the input: a small rounded pill on the left showing the active engine and model (e.g. "node-llama-cpp · qwen2.5-coder"), and on the right a thin "context" progress bar with a tiny percentage label (this shows how full the model's context window is).
4. A "Build progress" panel: a clean vertical timeline of step cards. Each card has a small circular icon, a monospace label for the tool that ran (e.g. "write_file · index.html", "get_design_system · modern-saas", "review_design"), and occasional tiny pill tags like "thinking" and "compacted". Show 4-5 example steps, the latest one highlighted.
5. A preview panel shown as a browser-like frame (with a faux address bar) containing a placeholder of the generated web page, and a small ghost "Export .zip" button in its top-right corner.

No clutter, no navigation bars, no ads. Elegant, quiet, confident. Desktop layout.`;

console.log("[stitch] generating Oxy UI design (cloud, ~1-3 min)…");
const r = await stitchGenerate(PROMPT, { deviceType: "DESKTOP", title: "Oxy UI" });
const out = path.join(HERE, "stitch-ui.html");
writeFileSync(out, r.html, "utf8");
console.log(`[stitch] wrote ${out} — ${r.html.length} bytes in ${r.seconds}s (stitch project ${r.stitchProjectId})`);
