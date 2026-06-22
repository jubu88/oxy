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

/** Does this JS REQUIRE an ES module to run? (static import, top-level export, or top-level
 *  await — all of which a classic <script> can't execute.) */
function needsModule(js) {
  if (/^[ \t]*import\b[^\n]*['"]/m.test(js)) return true; // import … from "…" / import "…"
  if (/^[ \t]*export\b/m.test(js)) return true; // top-level export
  const err = jsSyntaxError(js);
  return !!err && /await is only valid/i.test(err); // top-level await
}

/**
 * Deterministic repair: a linked classic `<script src="x.js">` whose x.js uses `import` or a
 * top-level `await` will THROW on load and kill the whole app's JS (we watched a live build
 * ship exactly this with the Supabase ESM client). Adding `type="module"` to that script is
 * always safe — the file was non-functional as a classic script — so fix it instead of hoping
 * the model gets it right. Mutates *.html in place; returns the fixes applied.
 */
export function repairModuleScripts(projectDir) {
  const fixes = [];
  let files = [];
  try {
    files = fs.readdirSync(projectDir).filter((f) => /\.html?$/i.test(f) && !f.startsWith(".codelab"));
  } catch {
    return fixes;
  }
  for (const f of files) {
    const p = path.join(projectDir, f);
    let html = "";
    try {
      html = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    let changed = false;
    const out = html.replace(/<script\b([^>]*?)\bsrc\s*=\s*("|')([^"']+)\2([^>]*)>/gi, (full, pre, q, src, post) => {
      if (/\btype\s*=/i.test(pre + " " + post)) return full; // already typed (module/babel/…) — leave it
      if (/^[a-z]+:\/\//i.test(src) || src.startsWith("//")) return full; // remote — leave it
      let js = "";
      try {
        js = fs.readFileSync(path.join(projectDir, src.split(/[?#]/)[0].replace(/^\.?\//, "")), "utf8");
      } catch {
        return full;
      }
      if (!needsModule(js)) return full;
      changed = true;
      return `<script${pre} type="module" src=${q}${src}${q}${post}>`;
    });
    if (changed) {
      try {
        fs.writeFileSync(p, out, "utf8");
        fixes.push(`${f}: loaded a script as type="module" (it uses import / top-level await, which a classic <script> can't run)`);
      } catch {
        /* best-effort */
      }
    }
  }
  return fixes;
}

// ---- duplicate top-level class merge -------------------------------------------------
// The #2 fatal failure we measured: a small model writes ONE component as TWO same-name
// top-level `class X {…}` blocks (e.g. constructor/markup in one, methods in the other) →
// "SyntaxError: Identifier 'X' has already been declared", which kills the whole file. The
// model can't fix it (we watched 3 iterations across E2B + E4B fail). Two same-name classes
// at the top level are ALWAYS invalid JS, and the model meant them as one — so merge the
// bodies into a single class. Guarded both ways: we only act on a file that doesn't parse,
// and only keep the merge if the result DOES parse — so a bad scan can never ship.

const isWordChar = (ch) => !!ch && /[A-Za-z0-9_$]/.test(ch);

// Strip ES-module syntax for a parse PROBE only (vm.Script can't handle import/export), so the
// merge's safety-net parse-check works on module files (e.g. the Supabase ESM client) too.
const neutralizeModule = (s) =>
  s
    .replace(/^[ \t]*import\b.*$/gm, "")
    .replace(/^[ \t]*export\s+default\s+/gm, "")
    .replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*$/gm, "")
    .replace(/^[ \t]*export\s+/gm, "");

// From an index pointing AT a string/template quote, return the index of its closing quote,
// honoring escapes and (for templates) nested ${…} interpolation. Mutually recursive with
// matchDelim so braces inside strings/templates never confuse brace matching.
function skipString(code, i) {
  const q = code[i];
  if (q === "`") {
    for (let j = i + 1; j < code.length; j++) {
      const ch = code[j];
      if (ch === "\\") { j++; continue; }
      if (ch === "`") return j;
      if (ch === "$" && code[j + 1] === "{") {
        const close = matchDelim(code, j + 1);
        if (close < 0) return code.length - 1;
        j = close;
      }
    }
    return code.length - 1;
  }
  for (let j = i + 1; j < code.length; j++) {
    const ch = code[j];
    if (ch === "\\") { j++; continue; }
    if (ch === q) return j;
    if (ch === "\n") return j - 1; // unterminated quote — stop before the newline (best-effort)
  }
  return code.length - 1;
}

// From an index pointing AT an opening {, ( or [, return the index of the matching close,
// skipping strings, templates and comments. -1 if unbalanced.
function matchDelim(code, open) {
  const openCh = code[open];
  const closeCh = openCh === "{" ? "}" : openCh === "(" ? ")" : openCh === "[" ? "]" : null;
  if (!closeCh) return -1;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(code, i); continue; }
    if (c === "/" && code[i + 1] === "/") { const e = code.indexOf("\n", i); if (e < 0) return -1; i = e; continue; }
    if (c === "/" && code[i + 1] === "*") { const e = code.indexOf("*/", i + 2); if (e < 0) return -1; i = e + 1; continue; }
    if (c === openCh) depth++;
    else if (c === closeCh) { if (--depth === 0) return i; }
  }
  return -1;
}

// Locate every TOP-LEVEL (depth-0) `class Name [extends …] { … }` declaration.
function findTopLevelClasses(code) {
  const classes = [];
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(code, i); continue; }
    if (c === "/" && code[i + 1] === "/") { const e = code.indexOf("\n", i); if (e < 0) break; i = e; continue; }
    if (c === "/" && code[i + 1] === "*") { const e = code.indexOf("*/", i + 2); if (e < 0) break; i = e + 1; continue; }
    if (c === "(" || c === "[") { const e = matchDelim(code, i); if (e < 0) break; i = e; continue; } // skip grouped exprs (and any anon class inside a call)
    if (c === "{") { depth++; continue; }
    if (c === "}") { depth--; continue; }
    if (depth === 0 && code.startsWith("class", i) && !isWordChar(code[i - 1]) && !isWordChar(code[i + 5])) {
      const m = /^class\s+([A-Za-z_$][\w$]*)\s*(extends\s+[^{]+?)?\s*\{/.exec(code.slice(i));
      if (m) {
        const braceIdx = i + m[0].length - 1;
        const end = matchDelim(code, braceIdx);
        if (end > 0) {
          classes.push({ name: m[1], extendsClause: (m[2] || "").trim(), start: i, bodyStart: braceIdx + 1, bodyEnd: end, end: end + 1 });
          i = end; // skip the whole class body
          continue;
        }
      }
    }
  }
  return classes;
}

// Find a class body's first depth-0 `constructor(…) { … }`; null if none.
function findTopLevelCtor(body) {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") { i = skipString(body, i); continue; }
    if (c === "/" && body[i + 1] === "/") { const e = body.indexOf("\n", i); i = e < 0 ? body.length : e; continue; }
    if (c === "/" && body[i + 1] === "*") { const e = body.indexOf("*/", i + 2); i = e < 0 ? body.length : e + 1; continue; }
    if (c === "{") { depth++; continue; }
    if (c === "}") { depth--; continue; }
    if (depth === 0 && body.startsWith("constructor", i) && !isWordChar(body[i - 1]) && /[\s(]/.test(body[i + 11] || "")) {
      const parenOpen = body.indexOf("(", i);
      if (parenOpen < 0) return null;
      const parenClose = matchDelim(body, parenOpen);
      if (parenClose < 0) return null;
      const bm = /^\s*\{/.exec(body.slice(parenClose + 1));
      if (!bm) return null; // not a method (e.g. a `this.constructor()` field) — ignore
      const braceOpen = parenClose + bm[0].length;
      const braceClose = matchDelim(body, braceOpen);
      if (braceClose < 0) return null;
      return { start: i, end: braceClose + 1 };
    }
  }
  return null;
}

/**
 * Merge same-name top-level class declarations into one. PURE (unit-tested). Returns
 * { code, fixes }. No-op unless the file genuinely fails to parse AND the merge makes it
 * parse — so it never touches a working file and never ships a broken one.
 */
export function dedupeClasses(code) {
  if (typeof code !== "string" || !code) return { code, fixes: [] };
  if (!jsSyntaxError(neutralizeModule(code))) return { code, fixes: [] }; // already valid — never touch

  const classes = findTopLevelClasses(code);
  if (classes.length < 2) return { code, fixes: [] };
  const byName = new Map();
  for (const c of classes) (byName.get(c.name) || byName.set(c.name, []).get(c.name)).push(c);

  const edits = [];
  const fixes = [];
  for (const [name, decls] of byName) {
    if (decls.length < 2) continue;
    let sawCtor = false;
    const bodies = decls.map((d) => {
      let body = code.slice(d.bodyStart, d.bodyEnd);
      const ctor = findTopLevelCtor(body);
      if (ctor && sawCtor) body = body.slice(0, ctor.start) + body.slice(ctor.end); // drop the 2nd+ constructor (else "may only have one constructor")
      else if (ctor) sawCtor = true;
      return body.trim();
    });
    const first = decls[0];
    const header = `class ${name}${first.extendsClause ? " " + first.extendsClause : ""} {`;
    edits.push({ start: first.start, end: first.end, text: `${header}\n  ${bodies.join("\n\n  ")}\n}` });
    for (let k = 1; k < decls.length; k++) edits.push({ start: decls[k].start, end: decls[k].end, text: "" });
    fixes.push(`merged ${decls.length} duplicate "class ${name}" declarations into one (the model split one class into separate blocks → "Identifier '${name}' has already been declared")`);
  }
  if (!edits.length) return { code, fixes: [] };

  edits.sort((a, b) => b.start - a.start); // apply right-to-left so offsets stay valid
  let out = code;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  out = out.replace(/\n{3,}/g, "\n\n");

  if (jsSyntaxError(neutralizeModule(out))) return { code, fixes: [] }; // merge didn't actually fix it — bail, let verifyProject report
  return { code: out, fixes };
}

/** Apply dedupeClasses to every top-level .js/.mjs/.cjs in a project IN PLACE. Returns the fixes. */
export function mergeDuplicateClasses(projectDir) {
  const fixes = [];
  let files = [];
  try {
    files = fs.readdirSync(projectDir).filter((f) => /\.(js|mjs|cjs)$/i.test(f) && !f.startsWith(".codelab"));
  } catch {
    return fixes;
  }
  for (const f of files) {
    const p = path.join(projectDir, f);
    let src;
    try {
      src = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const { code, fixes: ff } = dedupeClasses(src);
    if (code !== src) {
      try {
        fs.writeFileSync(p, code, "utf8");
        fixes.push(...ff.map((m) => `${f}: ${m}`));
      } catch {
        /* best-effort */
      }
    }
  }
  return fixes;
}

// ---- attributeChangedCallback signature repair --------------------------------------
// The model often writes `attributeChangedCallback(changedAttributes, oldValue) { if
// (changedAttributes.has('rating')) … }` — but the spec signature is
// (name, oldValue, newValue) where `name` is the attribute name STRING, not a Set. So
// `name.has(…)` throws a TypeError the moment a watched attribute changes (e.g. on a
// click that calls this.setAttribute) → the component renders but never updates. The
// first arg is ALWAYS a string here, so `firstParam.has('literal')` is unambiguously a
// bug → rewrite it to `firstParam === 'literal'` (correct AND minimal). Parse-checked.

const escapeReg = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rewrite the buggy `<name>.has('attr')` pattern inside attributeChangedCallback. PURE. */
export function repairAttrCallback(code) {
  if (typeof code !== "string" || !code) return { code, fixes: [] };
  const re = /\battributeChangedCallback\s*\(/g;
  const edits = [];
  let m;
  while ((m = re.exec(code))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchDelim(code, parenOpen);
    if (parenClose < 0) continue;
    const firstParam = (code.slice(parenOpen + 1, parenClose).split(",")[0] || "").replace(/=.*$/s, "").trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(firstParam)) continue; // empty / destructured — can't safely rewrite
    const bm = /^\s*\{/.exec(code.slice(parenClose + 1));
    if (!bm) continue;
    const braceOpen = parenClose + bm[0].length;
    const braceClose = matchDelim(code, braceOpen);
    if (braceClose < 0) continue;
    const body = code.slice(braceOpen + 1, braceClose);
    const hasRe = new RegExp(escapeReg(firstParam) + "\\s*\\.\\s*has\\s*\\(\\s*(['\"][^'\"]*['\"])\\s*\\)", "g");
    const fixedBody = body.replace(hasRe, firstParam + " === $1");
    if (fixedBody !== body) edits.push({ start: braceOpen + 1, end: braceClose, text: fixedBody });
    re.lastIndex = braceClose; // don't rescan inside the body we just handled
  }
  if (!edits.length) return { code, fixes: [] };
  edits.sort((a, b) => b.start - a.start);
  let out = code;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  if (jsSyntaxError(neutralizeModule(out))) return { code, fixes: [] }; // never ship a broken rewrite
  return { code: out, fixes: [`fixed attributeChangedCallback: its first argument is the attribute NAME (a string), not a Set — replaced .has('…') with === '…' so attribute changes (e.g. click-to-update) work`] };
}

/** Apply repairAttrCallback to every top-level .js/.mjs/.cjs in a project IN PLACE. */
export function fixAttrCallbacks(projectDir) {
  const fixes = [];
  let files = [];
  try {
    files = fs.readdirSync(projectDir).filter((f) => /\.(js|mjs|cjs)$/i.test(f) && !f.startsWith(".codelab"));
  } catch {
    return fixes;
  }
  for (const f of files) {
    const p = path.join(projectDir, f);
    let src;
    try {
      src = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    const { code, fixes: ff } = repairAttrCallback(src);
    if (code !== src) {
      try {
        fs.writeFileSync(p, code, "utf8");
        fixes.push(...ff.map((msg) => `${f}: ${msg}`));
      } catch {
        /* best-effort */
      }
    }
  }
  return fixes;
}

/**
 * Wire a real Supabase project into generated FRONTEND code: replace whatever value is assigned
 * to SUPABASE_URL / SUPABASE_ANON_KEY (and a direct createClient("url","key") call) with the
 * configured project URL + anon key. Deterministic so a tiny model never has to reproduce a
 * ~300-char JWT — it writes the const names (the reference teaches them) and Oxy fills the values.
 * Only runs when both are configured. Edge functions are NOT touched (they read Deno.env on the
 * server). Mutates top-level .js/.mjs/.html in place; returns the files changed.
 */
export function injectSupabaseConfig(projectDir, url, anonKey) {
  const fixes = [];
  if (!url || !anonKey) return fixes;
  const U = JSON.stringify(String(url));
  const K = JSON.stringify(String(anonKey));
  let files = [];
  try {
    files = fs.readdirSync(projectDir).filter((f) => /\.(js|mjs|html?)$/i.test(f) && !f.startsWith(".codelab"));
  } catch {
    return fixes;
  }
  for (const f of files) {
    const p = path.join(projectDir, f);
    let src;
    try {
      src = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    let out = src
      .replace(/(\bSUPABASE_URL\b\s*[:=]\s*)(['"])[^'"]*\2/g, (_m, pre) => pre + U)
      .replace(/(\bSUPABASE_ANON_KEY\b\s*[:=]\s*)(['"])[^'"]*\2/g, (_m, pre) => pre + K)
      // direct createClient("url", "key") with string literals (no consts)
      .replace(/(createClient\(\s*)(['"])[^'"]*\2(\s*,\s*)(['"])[^'"]*\4/g, (_m, g1, _q, sep) => g1 + U + sep + K);
    if (out !== src) {
      try {
        fs.writeFileSync(p, out, "utf8");
        fixes.push(f);
      } catch {
        /* best-effort */
      }
    }
  }
  return fixes;
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

  // read index.html once — for module-script detection AND the link-existence check below
  const idx = files.find((f) => f.toLowerCase() === "index.html");
  let html = "";
  if (idx) {
    try {
      html = fs.readFileSync(path.join(projectDir, idx), "utf8");
    } catch {}
  }
  // scripts loaded as type="module" legitimately use top-level await/import — don't flag those
  const moduleScripts = new Set();
  for (const re of [
    /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*\bsrc\s*=\s*["']([^"']+)["']/gi,
    /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*\btype\s*=\s*["']module["']/gi,
  ]) {
    for (const m of html.matchAll(re)) moduleScripts.add(m[1].split(/[?#]/)[0].replace(/^\.?\//, "").toLowerCase());
  }

  for (const f of files) {
    if (!/\.(js|mjs|cjs)$/i.test(f)) continue;
    if (moduleScripts.has(f.toLowerCase())) continue; // loaded as a module — top-level await/import is valid
    let code = "";
    try {
      code = fs.readFileSync(path.join(projectDir, f), "utf8");
    } catch {
      continue;
    }
    // skip ES modules — vm.Script can't parse import/export and that's legitimate
    if (/^\s*(import|export)\b/m.test(code)) continue;
    const err = jsSyntaxError(code);
    if (err) {
      const dup = /Identifier '(.+?)' has already been declared/.exec(err);
      if (dup) issues.push(`${f}: "${dup[1]}" is declared more than once at the top level — you split one definition into duplicate blocks. Merge them into a SINGLE \`class ${dup[1]}\` (or one const/let) so the file parses.`);
      else issues.push(`${f} has a JavaScript syntax error: ${err}`);
    }
  }

  if (idx) {
    const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    for (const ref of refs) {
      if (/^(https?:|data:|blob:|#|mailto:|tel:|\/\/)/i.test(ref)) continue; // external/anchor
      const clean = ref.split(/[?#]/)[0].replace(/^\.?\//, "");
      if (clean && /\.(css|js|mjs)$/i.test(clean) && !present.has(clean.toLowerCase())) {
        issues.push(`index.html references "${ref}" but that file was never created`);
      }
    }
    // a custom element DEFINED in JS but never PLACED in the HTML => the page renders empty
    // (a common "scaffolded but left a placeholder comment" failure — exactly the star-rating WC bug).
    const defined = new Set();
    for (const f of files) {
      if (!/\.(js|mjs|cjs)$/i.test(f)) continue;
      let code = "";
      try {
        code = fs.readFileSync(path.join(projectDir, f), "utf8");
      } catch {
        continue;
      }
      for (const m of code.matchAll(/customElements\.define\(\s*["'`]([a-z][a-z0-9-]*-[a-z0-9-]*)["'`]/gi)) defined.add(m[1].toLowerCase());
      // a Web Component that drives its OWN re-render via this.setAttribute but never declares
      // static observedAttributes => attributeChangedCallback never fires, so the update silently
      // does nothing (the click-to-rate footgun). Gated on this.setAttribute so a leftover/dead
      // attributeChangedCallback (the component re-renders directly) is NOT falsely flagged.
      if (/\battributeChangedCallback\b/.test(code) && !/\bobservedAttributes\b/.test(code) && /\bthis\.setAttribute\(/.test(code)) {
        issues.push(`${f}: uses this.setAttribute to trigger a re-render but declares no static observedAttributes — the change never fires attributeChangedCallback, so the update won't show. Add static get observedAttributes(){return ['value']}, or update the DOM directly in the handler.`);
      }
    }
    const htmlLc = html.toLowerCase();
    for (const tag of defined) {
      if (!htmlLc.includes(`<${tag}`)) issues.push(`custom element <${tag}> is defined but never used in index.html — the page renders empty; add <${tag}></${tag}> where it should appear`);
    }
  }
  return issues;
}
