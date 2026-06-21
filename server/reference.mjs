// Lightweight RAG: surgical, curated reference snippets the model can pull on demand so a
// tiny local model writes CORRECT library code (Supabase / Web Components / React SPA)
// instead of guessing. NOT embeddings — a hand-curated corpus (reference/<library>.md, one
// "## topic" section each) + keyword retrieval. Surgical by design: returns the few matching
// sections, never the whole doc (a ~2B model degrades with a long prompt). Pure matcher is
// unit-tested; getReference reads the files.
import fs from "node:fs";
import path from "node:path";

// library key -> the runtime note prepended so the model targets Oxy's no-build static
// iframe (CDN deps, no bundler) rather than a toolchain it can't run here.
export const REFERENCE_LIBRARIES = {
  supabase: "Supabase from the browser via the CDN client (no backend server needed for the frontend).",
  "web-components": "Native Web Components — no build step, runs as-is.",
  react: "React as a no-build SPA: React + ReactDOM + Babel from a CDN, JSX in <script type=\"text/babel\">. Oxy has no bundler, so do NOT use import/JSX files or a Vite/npm setup.",
};

/** Split a reference doc into {heading, body} sections on "## " headings. */
export function parseSections(md) {
  const out = [];
  const re = /^##[ \t]+(.+)$/gm;
  let m;
  let last = null;
  while ((m = re.exec(md))) {
    if (last) out.push({ heading: last.h, body: md.slice(last.start, m.index).trim() });
    last = { h: m[1].trim(), start: m.index };
  }
  if (last) out.push({ heading: last.h, body: md.slice(last.start).trim() });
  return out;
}

/** Pick the section(s) best matching the query topic (word overlap: heading weighted over body). */
export function pickReference(md, topic) {
  const sections = parseSections(md);
  const topics = sections.map((s) => s.heading);
  if (!sections.length) return { match: null, topics };
  const words = String(topic || "")
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2);
  const scored = sections.map((s) => {
    const h = s.heading.toLowerCase();
    const b = s.body.toLowerCase();
    const score = words.reduce((n, w) => n + (h.includes(w) ? 3 : 0) + (b.includes(w) ? 1 : 0), 0);
    return { s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  if (!scored[0].score) return { match: null, topics };
  // the top section, plus a clearly-relevant runner-up — but stay surgical (<=2)
  const cutoff = Math.max(1, scored[0].score * 0.6);
  const match = scored.filter((x) => x.score >= cutoff).slice(0, 2).map((x) => x.s);
  return { match, topics };
}

const MAX_REF_BYTES = 6000; // cap what we feed back (brevity matters for a small model)

/** Read reference/<library>.md and return the snippet(s) matching topic (+ available topics). */
export function getReference(refDir, library, topic) {
  const key = String(library || "").toLowerCase().trim();
  if (!Object.prototype.hasOwnProperty.call(REFERENCE_LIBRARIES, key)) {
    return { ok: false, error: `unknown library "${library}". Available: ${Object.keys(REFERENCE_LIBRARIES).join(", ")}` };
  }
  let md = "";
  try {
    md = fs.readFileSync(path.join(refDir, `${key}.md`), "utf8");
  } catch {
    return { ok: false, error: `no reference doc for ${key}` };
  }
  const note = REFERENCE_LIBRARIES[key];
  const { match, topics } = pickReference(md, topic);
  if (!match) {
    return { ok: true, text: `${note}\n\nNo section matched "${topic}". Available topics: ${topics.join(", ")}. Call get_reference again with one of these.`, topics };
  }
  const body = match.map((s) => `## ${s.heading}\n${s.body.replace(/^##[ \t]+.+\n?/, "")}`).join("\n\n");
  return { ok: true, text: `${note}\n\n${body}`.slice(0, MAX_REF_BYTES), topics };
}
