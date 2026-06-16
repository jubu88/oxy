// Generates Oxy's interface design with Google Stitch (cloud) and saves the raw
// HTML to design/stitch-ui.html as the design reference the React UI is built
// from. The Stitch API key is read by server.mjs from stitch.key.local (never
// committed). Run: node design/gen-stitch.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stitchGenerate } from "../server/server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PROMPT = `Design the interface for "Oxy" — a local-first AI app builder where a language model running entirely on the user's own machine builds web (and soon mobile) apps for them. Make it FUTURISTIC and alive — a high-tech command deck, not a plain form.

Aesthetic: deep-space DARK theme. A subtle ANIMATED background — a slow-drifting aurora/nebula gradient in the far background with a faint glowing grid or drifting particles over it, very low contrast so it never fights the content. Glassmorphism panels: frosted, translucent, with thin luminous 1px borders and soft inner glow. Neon accents — electric cyan and violet — used sparingly for focus, active states and glows. Smooth micro-animations: gentle hover glows, a pulsing "live" indicator on the active build step, subtle entrance fades. A refined geometric sans-serif for UI, a crisp monospace for code/labels. Confident, cinematic, but clean and uncluttered — generous spacing.

Layout: a centered column (~840px) over the animated background. Sections, top to bottom:
1. A top bar: the glowing "Oxy" wordmark on the left with a one-line subtitle "build apps with a local model"; on the right a small projects dropdown ("New project ▾") and a settings gear icon button.
2. A large frosted-glass prompt input with placeholder "Describe the app you want to build…" and a glowing primary "Build" button; below it small ghost helper text "or pick a project above to keep iterating".
3. A status row: a glass pill on the left with a tiny pulsing dot showing the active engine + model (e.g. "node-llama-cpp · qwen2.5-coder"), and on the right a thin neon "context" progress bar with a % label (how full the model's context window is).
4. A "Build progress" panel: a vertical timeline of glass step cards connected by a glowing line. Each card: a small circular node icon, a monospace label for the tool (e.g. "write_file · index.html", "get_design_system · modern-saas", "review_design"), and tiny glowing pill tags like "thinking" and "compacted". Show 4-5 steps; the latest one highlighted with a cyan glow and a pulsing node.
5. A preview panel as a sleek browser-like frame with a faux address bar and a ghost "Export .zip" button; inside, a placeholder of the generated app.

No ads, no clutter. Futuristic, animated, premium. Desktop layout.`;

console.log("[stitch] generating Oxy UI design (cloud, ~1-3 min)…");
const r = await stitchGenerate(PROMPT, { deviceType: "DESKTOP", title: "Oxy UI" });
const out = path.join(HERE, "stitch-ui.html");
writeFileSync(out, r.html, "utf8");
console.log(`[stitch] wrote ${out} — ${r.html.length} bytes in ${r.seconds}s (stitch project ${r.stitchProjectId})`);
