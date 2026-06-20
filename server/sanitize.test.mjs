// Tests for the deterministic file-repair pass (server/sanitize.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeFileContent, sanitizeProject, verifyProject } from "./sanitize.mjs";

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
