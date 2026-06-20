// Deterministic post-generation repair for files small models commonly mangle.
//
// The #1 fatal failure we measured: the model wraps a .js file in <script>...</script>
// (HTML habit) or fences it in ``` — loaded as JavaScript that's "Uncaught SyntaxError:
// Unexpected token '<'", which kills the WHOLE app. The same happens with <style> in .css.
// Stripping these is ALWAYS safe (a real .js/.css never legitimately starts with a tag),
// so the harness fixes it deterministically instead of hoping the model can self-correct
// (it can't — we watched an 18-minute edit-loop fail to fix exactly this).
//
// What it WON'T do: change real logic. Things it can't safely auto-fix (a stray brace,
// a missing file) are surfaced by verifyProject() so the next iteration/turn can address
// them — repair what's unambiguous, report the rest.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const CODE_EXT = /\.(js|mjs|cjs|jsx|ts|tsx)$/i;

const stripFence = (s) =>
  s.replace(/^﻿?\s*```[a-z0-9]*[ \t]*\r?\n/i, "").replace(/\r?\n```\s*$/i, "");

/**
 * Repair one file's content based on its extension. PURE (no I/O) so it's unit-tested
 * and can run inline on every write. Returns { content, fixes: string[] }.
 */
export function sanitizeFileContent(relPath, content) {
  if (typeof content !== "string" || !content) return { content, fixes: [] };
  const ext = (String(relPath).match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  const fixes = [];
  let out = content;

  if (CODE_EXT.test("." + ext)) {
    const before = out;
    out = stripFence(out);
    // a wrapping <script ...> … </script> around a JS file — the fatal "Unexpected token '<'"
    out = out.replace(/^\s*<script\b[^>]*>\s*\r?\n?/i, "").replace(/\r?\n?\s*<\/script>\s*$/i, "");
    if (out !== before) fixes.push(`${relPath}: stripped an HTML/markdown wrapper around the JavaScript (would crash with "Unexpected token '<'")`);
  } else if (ext === "css") {
    const before = out;
    out = stripFence(out);
    out = out.replace(/^\s*<style\b[^>]*>\s*\r?\n?/i, "").replace(/\r?\n?\s*<\/style>\s*$/i, "");
    if (out !== before) fixes.push(`${relPath}: stripped a <style>/markdown wrapper around the CSS`);
  } else if (ext === "html" || ext === "htm") {
    const before = out;
    out = stripFence(out); // models sometimes fence the whole page in ```html — but NEVER touch inner <script> tags here
    if (out !== before) fixes.push(`${relPath}: stripped a markdown code fence around the HTML`);
  }
  return { content: out, fixes };
}

/** Sanitize every text file in a project dir IN PLACE. Returns the fixes applied. */
export function sanitizeProject(projectDir) {
  const fixes = [];
  let files = [];
  try {
    files = fs.readdirSync(projectDir);
  } catch {
    return fixes;
  }
  for (const f of files) {
    if (f.startsWith(".codelab")) continue;
    const p = path.join(projectDir, f);
    let content;
    try {
      if (!fs.statSync(p).isFile()) continue;
      content = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const r = sanitizeFileContent(f, content);
    if (r.content !== content) {
      try {
        fs.writeFileSync(p, r.content, "utf8");
        fixes.push(...r.fixes);
      } catch {
        /* best-effort */
      }
    }
  }
  return fixes;
}

/** Parse-check a classic browser script (how a <script src> actually loads it). */
function jsSyntaxError(code) {
  try {
    new vm.Script(code);
    return null;
  } catch (e) {
    return String(e?.message ?? e).slice(0, 140);
  }
}

/**
 * Static checks that CAN'T be auto-fixed safely — surfaced so the next turn can act:
 *  - JavaScript files that don't parse (e.g. a stray brace),
 *  - assets index.html links (<link href>, <script src>) that were never created.
 * Returns a list of human-readable issues (empty = clean).
 */
export function verifyProject(projectDir) {
  const issues = [];
  let files = [];
  try {
    files = fs.readdirSync(projectDir).filter((f) => !f.startsWith(".codelab"));
  } catch {
    return issues;
  }
  const present = new Set(files.map((f) => f.toLowerCase()));

  for (const f of files) {
    if (!/\.(js|mjs|cjs)$/i.test(f)) continue;
    let code = "";
    try {
      code = fs.readFileSync(path.join(projectDir, f), "utf8");
    } catch {
      continue;
    }
    // skip ES modules — vm.Script can't parse import/export and that's legitimate
    if (/^\s*(import|export)\b/m.test(code)) continue;
    const err = jsSyntaxError(code);
    if (err) issues.push(`${f} has a JavaScript syntax error: ${err}`);
  }

  const idx = files.find((f) => f.toLowerCase() === "index.html");
  if (idx) {
    let html = "";
    try {
      html = fs.readFileSync(path.join(projectDir, idx), "utf8");
    } catch {}
    const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    for (const ref of refs) {
      if (/^(https?:|data:|blob:|#|mailto:|tel:|\/\/)/i.test(ref)) continue; // external/anchor
      const clean = ref.split(/[?#]/)[0].replace(/^\.?\//, "");
      if (clean && /\.(css|js|mjs)$/i.test(clean) && !present.has(clean.toLowerCase())) {
        issues.push(`index.html references "${ref}" but that file was never created`);
      }
    }
  }
  return issues;
}
