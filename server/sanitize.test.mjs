// Tests for the deterministic file-repair pass (server/sanitize.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeFileContent, sanitizeProject, verifyProject, repairModuleScripts, injectSupabaseConfig } from "./sanitize.mjs";

// ---- sanitizeFileContent (pure) ----

test("strips a <script> wrapper around a .js file — the exact banking-app bug", () => {
  const wrapped = `<script>\nconst x = 1;\nfunction go(){ return x; }\n</script>`;
  const { content, fixes } = sanitizeFileContent("app.js", wrapped);
  assert.equal(content, `const x = 1;\nfunction go(){ return x; }`);
  assert.equal(fixes.length, 1);
  assert.match(fixes[0], /Unexpected token/);
});

test("leaves a clean .js file untouched (no false positives)", () => {
  const clean = `const grid = document.getElementById('grid');\nfunction render(){}`;
  const { content, fixes } = sanitizeFileContent("app.js", clean);
  assert.equal(content, clean);
  assert.equal(fixes.length, 0);
});

test("does NOT strip a <script> string in the MIDDLE of a .js file", () => {
  const code = `el.innerHTML = "<script>evil()</script>"; const ok = 1;`;
  const { content } = sanitizeFileContent("app.js", code);
  assert.equal(content, code); // only a wrapping tag at start/end is stripped
});

test("strips a ```js markdown fence from a .js file", () => {
  const fenced = "```js\nconst a = 1;\nconsole.log(a);\n```";
  const { content } = sanitizeFileContent("app.js", fenced);
  assert.equal(content, "const a = 1;\nconsole.log(a);");
});

test("strips a <style> wrapper from a .css file", () => {
  const wrapped = `<style>\nbody { margin: 0; }\n</style>`;
  const { content, fixes } = sanitizeFileContent("style.css", wrapped);
  assert.equal(content, `body { margin: 0; }`);
  assert.equal(fixes.length, 1);
});

test("NEVER strips inner <script> tags from an .html file (legitimate there)", () => {
  const html = `<!DOCTYPE html><html><body><h1>Hi</h1><script src="app.js"></script></body></html>`;
  const { content, fixes } = sanitizeFileContent("index.html", html);
  assert.equal(content, html);
  assert.equal(fixes.length, 0);
});

test("strips a ```html fence around a whole page", () => {
  const fenced = "```html\n<!DOCTYPE html><html></html>\n```";
  const { content } = sanitizeFileContent("index.html", fenced);
  assert.equal(content, "<!DOCTYPE html><html></html>");
});

test("no-ops on empty / non-string", () => {
  assert.deepEqual(sanitizeFileContent("app.js", ""), { content: "", fixes: [] });
  assert.deepEqual(sanitizeFileContent("app.js", null), { content: null, fixes: [] });
});

// ---- verifyProject (filesystem) ----

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oxy-verify-"));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content, "utf8");
  return dir;
}

test("verifyProject flags a JS syntax error (the stray-brace bug)", () => {
  const dir = tmpProject({
    "index.html": `<script src="app.js"></script>`,
    "app.js": `function f(){ return 1; }\n}`, // stray trailing brace
  });
  const issues = verifyProject(dir);
  assert.ok(issues.some((i) => /app\.js.*syntax error/i.test(i)), issues.join(" | "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("verifyProject flags a linked file that was never created", () => {
  const dir = tmpProject({ "index.html": `<link rel="stylesheet" href="style.css"><script src="app.js"></script>`, "app.js": `const ok = 1;` });
  const issues = verifyProject(dir);
  assert.ok(issues.some((i) => /style\.css.*never created/i.test(i)), issues.join(" | "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("verifyProject is clean for a valid project", () => {
  const dir = tmpProject({ "index.html": `<link rel="stylesheet" href="style.css"><script src="app.js"></script>`, "app.js": `const ok = 1;`, "style.css": `body{}` });
  assert.deepEqual(verifyProject(dir), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sanitizeProject heals a broken app.js on disk in place", () => {
  const dir = tmpProject({ "app.js": `<script>\nconst a = 1;\n</script>` });
  const fixes = sanitizeProject(dir);
  assert.equal(fixes.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, "app.js"), "utf8"), `const a = 1;`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- repairModuleScripts (filesystem) ----

test("repairModuleScripts: classic <script> + top-level await -> type=module (the live Supabase bug)", () => {
  const dir = tmpProject({
    "index.html": `<!DOCTYPE html><body><script src="app.js"></script></body>`,
    "app.js": `const s = await fetch("/x");\nconsole.log(s);`, // top-level await — dies as a classic script
  });
  const fixes = repairModuleScripts(dir);
  assert.equal(fixes.length, 1);
  assert.match(fs.readFileSync(path.join(dir, "index.html"), "utf8"), /<script\s+type="module"\s+src="app\.js">/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("repairModuleScripts: classic <script> + static import -> type=module", () => {
  const dir = tmpProject({
    "index.html": `<script src="app.js"></script>`,
    "app.js": `import { createClient } from "https://esm.sh/@supabase/supabase-js@2";\nconst c = createClient("u", "k");`,
  });
  repairModuleScripts(dir);
  assert.match(fs.readFileSync(path.join(dir, "index.html"), "utf8"), /type="module"/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("repairModuleScripts: leaves plain classic / remote / babel / already-module scripts untouched", () => {
  const dir = tmpProject({
    "index.html":
      `<script src="app.js"></script>` +
      `<script src="https://cdn.example/x.js"></script>` +
      `<script type="text/babel" src="b.js"></script>` +
      `<script type="module" src="m.js"></script>`,
    "app.js": `const x = 1; function go(){ return x; }`, // plain classic JS — valid as-is
    "b.js": `const j = 1;`,
    "m.js": `import "./x.js";`,
  });
  const fixes = repairModuleScripts(dir);
  assert.equal(fixes.length, 0, fixes.join(" | "));
  assert.match(fs.readFileSync(path.join(dir, "index.html"), "utf8"), /<script src="app\.js">/); // unchanged
  fs.rmSync(dir, { recursive: true, force: true });
});

test("verifyProject: top-level await flagged for a classic script, but NOT once it's a module", () => {
  const classic = tmpProject({ "index.html": `<script src="app.js"></script>`, "app.js": `const s = await fetch("/x");` });
  assert.ok(verifyProject(classic).some((i) => /await is only valid/i.test(i)));
  fs.rmSync(classic, { recursive: true, force: true });

  const moduled = tmpProject({ "index.html": `<script type="module" src="app.js"></script>`, "app.js": `const s = await fetch("/x");` });
  assert.deepEqual(verifyProject(moduled), []); // module: top-level await is legitimate
  fs.rmSync(moduled, { recursive: true, force: true });
});

test("verifyProject flags a custom element defined-but-never-placed (the empty star-rating bug)", () => {
  const dir = tmpProject({
    "index.html": `<div id="c"><!-- the element goes here --></div><script src="app.js"></script>`,
    "app.js": `class StarRating extends HTMLElement {} customElements.define("star-rating", StarRating);`,
  });
  const issues = verifyProject(dir);
  assert.ok(issues.some((i) => /star-rating.*defined but never used/i.test(i)), issues.join(" | "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("verifyProject is clean when the custom element IS placed in the HTML", () => {
  const dir = tmpProject({
    "index.html": `<star-rating></star-rating><script src="app.js"></script>`,
    "app.js": `customElements.define("star-rating", class extends HTMLElement {});`,
  });
  assert.deepEqual(verifyProject(dir).filter((i) => /custom element/i.test(i)), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("verifyProject flags attributeChangedCallback without observedAttributes (click-does-nothing WC bug)", () => {
  const dir = tmpProject({
    "index.html": `<star-rating></star-rating><script src="app.js"></script>`,
    "app.js": `class S extends HTMLElement { attributeChangedCallback(){ this.render(); } onClick(v){ this.setAttribute("value", v); } } customElements.define("star-rating", S);`,
  });
  const issues = verifyProject(dir);
  assert.ok(issues.some((i) => /observedAttributes/i.test(i)), issues.join(" | "));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("verifyProject is clean when observedAttributes IS declared", () => {
  const dir = tmpProject({
    "index.html": `<star-rating></star-rating><script src="app.js"></script>`,
    "app.js": `class S extends HTMLElement { static get observedAttributes(){ return ["value"]; } attributeChangedCallback(){ this.render(); } } customElements.define("star-rating", S);`,
  });
  assert.deepEqual(verifyProject(dir).filter((i) => /observedAttributes/i.test(i)), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("verifyProject does NOT flag a dead attributeChangedCallback when the component re-renders directly", () => {
  const dir = tmpProject({
    "index.html": `<star-rating></star-rating><script src="app.js"></script>`,
    // click calls updateRating directly (no this.setAttribute round-trip) — the leftover callback is harmless
    "app.js": `class S extends HTMLElement { attributeChangedCallback(){ this.render(); } onClick(v){ this.updateRating(v); } updateRating(){} } customElements.define("star-rating", S);`,
  });
  assert.deepEqual(verifyProject(dir).filter((i) => /observedAttributes/i.test(i)), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- injectSupabaseConfig (filesystem) ----

test("injectSupabaseConfig fills the URL/anon-key consts + createClient literals", () => {
  const dir = tmpProject({
    "app.js":
      `const SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";\n` +
      `const SUPABASE_ANON_KEY = "YOUR-ANON-KEY";\n` +
      `const c = createClient("https://x.supabase.co", "old-key");`,
  });
  const fixed = injectSupabaseConfig(dir, "https://real.supabase.co", "eyJreal.JWT");
  assert.deepEqual(fixed, ["app.js"]);
  const out = fs.readFileSync(path.join(dir, "app.js"), "utf8");
  assert.match(out, /SUPABASE_URL = "https:\/\/real\.supabase\.co"/);
  assert.match(out, /SUPABASE_ANON_KEY = "eyJreal\.JWT"/);
  assert.match(out, /createClient\("https:\/\/real\.supabase\.co", "eyJreal\.JWT"\)/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("injectSupabaseConfig is a no-op when the project isn't configured", () => {
  const dir = tmpProject({ "app.js": `const SUPABASE_URL = "x";` });
  assert.deepEqual(injectSupabaseConfig(dir, "", ""), []);
  assert.equal(fs.readFileSync(path.join(dir, "app.js"), "utf8"), `const SUPABASE_URL = "x";`);
  fs.rmSync(dir, { recursive: true, force: true });
});
