// Generates Oxy's interface design with Google Stitch (cloud). Produces two
// candidates (Stitch varies per run) so we can pick the strongest, then the
// chosen one becomes the design we implement faithfully. The Stitch API key is
// read by server.mjs from stitch.key.local (never committed).
// Run: node design/gen-stitch.mjs
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stitchGenerate } from "../server/server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PROMPT = `Design the desktop interface for "Oxy" — a local-first AI app builder where a model on your own machine builds web apps for you. Modern, sleek, a little futuristic — BUT legibility and contrast come FIRST.

CRITICAL — make every component obviously distinct and readable:
- Strong CONTRAST everywhere. All text must be easily readable against its background (aim for WCAG AA: ~4.5:1 for normal text, ~3:1 for large text and UI borders). No low-contrast grey-on-grey.
- Clearly SEPARATED surfaces at distinct elevation levels: the page background, raised cards/panels, and inputs must each be a VISIBLY different shade so you can instantly tell them apart. Do NOT make everything the same color or rely on faint translucency — use solid fills, clear 1px borders, and subtle shadows to delineate every component.
- A clear visual HIERARCHY: the prompt input and primary button are the focal point; secondary controls are visibly quieter but still readable.
- ONE vivid, high-contrast accent color used for the primary button and the active state, so it pops against everything else.

Use a clean dark theme (deep slate background, clearly lighter raised cards, crisp light text) OR a clean light theme — whichever gives the strongest contrast. A refined sans-serif for UI, a mono for code/labels.

Layout — a centered ~840px column, sections top to bottom:
1. Top bar: a bold "Oxy" wordmark + one-line subtitle on the left; a "New project" dropdown and a settings gear button on the right.
2. A large, clearly-bordered prompt input with placeholder "Describe the app you want to build…" and a prominent high-contrast primary "Build" button.
3. A status row: a clearly-bordered pill on the left showing the engine + model (e.g. "llama-server · gemma4"), and on the right a labelled "context" progress bar.
4. A "Build progress" panel: a vertical timeline of clearly-separated step cards (each a raised card with a 1px border), each showing a small icon, a monospace tool label (e.g. "write_file · index.html"), and small high-contrast pill tags ("thinking", "compacted"). Show 4 steps; the latest highlighted with the accent color and a clear glow/border so it stands out from the rest.
5. A preview panel as a browser-style frame (faux address bar) with a "Export .zip" button, containing a placeholder of the generated page.

Premium, crisp, high-contrast. Every element easy to see and tell apart.`;

async function gen(label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[stitch] generating candidate ${label} (attempt ${attempt})…`);
      const r = await stitchGenerate(PROMPT, { deviceType: "DESKTOP", title: `Oxy UI ${label}` });
      const out = path.join(HERE, `stitch-${label}.html`);
      writeFileSync(out, r.html, "utf8");
      console.log(`[stitch] wrote ${out} — ${r.html.length} bytes in ${r.seconds}s`);
      return;
    } catch (e) {
      console.log(`[stitch] candidate ${label} attempt ${attempt} failed: ${String(e?.message ?? e)}`);
      if (attempt === 3) throw e;
    }
  }
}

await gen("a");
await gen("b");
console.log("[stitch] done — review design/stitch-a.html and design/stitch-b.html");
