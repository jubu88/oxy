// Oxy jailed backend — the tool-execution layer. Ported from the Reasoning Lab
// bench (code-lab/server.mjs) verbatim except for path rebasing and a small
// refactor: the request handler is exported as `codelabHandler` so it serves
// BOTH the Vite dev-server plugin (codeLabPlugin, for the UI) AND a standalone
// node:http launcher (server/serve.mjs, for headless builds with zero install).
//
// It is the TRUST BOUNDARY for the local model: the model only emits tool calls;
// this code executes them under strict rules. Each build lives in its own folder
// under workspace/projects/<id>/; path-escape, SSRF, size and extension limits
// are all enforced here. Drop nothing security-related.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

// vision model used to critique rendered designs. gemma4:e4b's vision is too weak
// (it hallucinated on test images), so default to a dedicated small VLM. moondream
// (1.7GB) is fast (~25s); qwen2.5vl:3b is more accurate but slower. Override with VISION_MODEL.
const VISION_MODEL = process.env.VISION_MODEL || "moondream";
// where the vision critique sends its screenshot (Ollama-compatible /api/chat)
const VISION_URL = process.env.OXY_VISION_URL || "http://localhost:11434/api/chat";
let sharedBrowser = null; // reused Playwright browser instance

// Anchor to the repo root via cwd (robust whether loaded directly, via the
// standalone launcher, or bundled into Vite's config — where import.meta.url
// would point at a temp file). All run modes launch from the repo root.
const ROOT = process.env.OXY_ROOT || process.cwd();
const PROJECTS = path.resolve(ROOT, "workspace", "projects");

// local Stable Diffusion (stable-diffusion.cpp). Paths are overridable via env;
// feature degrades gracefully (tool reports "unavailable") if absent.
const SD_CLI = process.env.SD_CLI || path.resolve(ROOT, "..", "sd", "vulkan", "sd-cli.exe");
const SD_MODEL = process.env.SD_MODEL || path.resolve(ROOT, "..", "sd", "sd-v1-5.safetensors");
const SD_TIMEOUT_MS = 240_000;
let sdBusy = false; // SD is heavy — one generation at a time

// Google Stitch — optional CLOUD UI designer. Generates a polished, complete
// HTML page from a text prompt via the official Stitch MCP server (stateless,
// API-key auth). CLOUD, not local: the prompt is sent to Google. Key comes from
// STITCH_API_KEY, else the gitignored stitch.key.local at the repo root. Feature
// degrades gracefully (tool reports "unavailable") when no key is present.
const STITCH_ENDPOINT = process.env.STITCH_ENDPOINT || "https://stitch.googleapis.com/mcp";
const STITCH_TIMEOUT_MS = 290_000; // under undici's 300s headers cap, so our abort fires first
let stitchBusy = false; // one cloud generation at a time
function stitchApiKey() {
  if (process.env.STITCH_API_KEY) return process.env.STITCH_API_KEY.trim();
  try {
    const m = fs.readFileSync(path.resolve(ROOT, "stitch.key.local"), "utf8").match(/STITCH_API_KEY=(.+)/);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

// Tool gating + terminal sandbox mode (oxy.settings.json, gitignored). run_command
// is OFF by default; terminal mode defaults to the isolated container.
const SETTINGS_PATH = path.resolve(ROOT, "oxy.settings.json");
const DEFAULT_TOOLS = { web_search: true, web_fetch: true, generate_image: true, run_command: false };
// Toggleable "improvement" features — persisted so they can be A/B tested with/without.
// Defaults reflect the recommended (improved) behavior.
const DEFAULT_FEATURES = {
  thinking: false, //         model reasons each turn (OFF = fast: straight to tool calls)
  autoCompact: true, //       checkpoint + reseed when the context fills (long builds)
  recoveryBursts: true, //    one-shot reasoning burst after an error/critique/ramble
  downscaleImages: true, //   shrink large attached images before sending (client-side)
  idleTimeout: true, //       abort a generate only after 120s idle (vs an old 600s total cap)
  modelAwareReuse: true, //   restart llama-server when a different model is selected
};
const FEATURE_KEYS = Object.keys(DEFAULT_FEATURES);
// Saved llama-server model refs shown in the Settings picker (the user can add any HF
// GGUF). Seeded with the two gemma4 options; the default (e2b) is first.
const DEFAULT_MODELS = ["hf:unsloth/gemma-4-E2B-it-GGUF:Q4_K_M", "hf:ggml-org/gemma-4-E4B-it-GGUF:Q4_K_M"];
const sanitizeModels = (arr) =>
  Array.isArray(arr) ? [...new Set(arr.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim()))].slice(0, 40) : null;
function readSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    const saved = sanitizeModels(s.llamaModels);
    return {
      tools: { ...DEFAULT_TOOLS, ...(s.tools || {}) },
      terminalMode: ["container", "host", "disabled"].includes(s.terminalMode) ? s.terminalMode : "container",
      features: { ...DEFAULT_FEATURES, ...(s.features || {}) },
      llamaModels: [...new Set([...DEFAULT_MODELS, ...(saved || [])])],
    };
  } catch {
    return { tools: { ...DEFAULT_TOOLS }, terminalMode: "container", features: { ...DEFAULT_FEATURES }, llamaModels: [...DEFAULT_MODELS] };
  }
}
function writeSettings(next) {
  const cur = readSettings();
  const tools = { ...cur.tools };
  if (next.tools && typeof next.tools === "object") for (const k of Object.keys(DEFAULT_TOOLS)) if (typeof next.tools[k] === "boolean") tools[k] = next.tools[k];
  const terminalMode = ["container", "host", "disabled"].includes(next.terminalMode) ? next.terminalMode : cur.terminalMode;
  const features = { ...cur.features };
  if (next.features && typeof next.features === "object") for (const k of FEATURE_KEYS) if (typeof next.features[k] === "boolean") features[k] = next.features[k];
  const incoming = sanitizeModels(next.llamaModels);
  const llamaModels = [...new Set([...DEFAULT_MODELS, ...(incoming || cur.llamaModels)])];
  const merged = { tools, terminalMode, features, llamaModels };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

// ---- downloadable-model catalog (browse + download from Hugging Face) ----
const OXY_HOME = path.join(os.homedir(), ".oxy");
const CATALOG_PATH = path.join(OXY_HOME, "model-catalog.json");
const CATALOG_TTL_MS = 7 * 24 * 3600 * 1000; // a week — refresh button bypasses it
// Targeted searches for small, build-friendly GGUF models (kept curated so the list is
// useful, not the whole noisy HF index). Each picks the smallest sensible 4-bit quant.
const HF_QUERIES = ["gemma-4-it GGUF", "Qwen2.5-Coder Instruct GGUF", "Qwen3 GGUF", "Llama-3.2 Instruct GGUF"];
const QUANT_PREF = ["Q4_K_M", "Q4_K_S", "Q4_0", "Q5_K_M", "Q3_K_M", "Q8_0"];
function pickQuant(ggufs) {
  const real = ggufs.filter((g) => !/mmproj/i.test(g));
  for (const q of QUANT_PREF) {
    const f = real.find((g) => g.toLowerCase().includes(q.toLowerCase()));
    if (f) return q;
  }
  const m = real[0] && real[0].match(/(Q\d[0-9A-Z_]*|BF16|F16)/i);
  return m ? m[1] : null;
}
async function fetchModelCatalog() {
  const out = new Map();
  for (const q of HF_QUERIES) {
    try {
      const url = `https://huggingface.co/api/models?search=${encodeURIComponent(q)}&filter=gguf&sort=downloads&direction=-1&limit=8&full=true`;
      const r = await fetch(url, { headers: { "User-Agent": "oxy", Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (!r.ok) continue;
      const arr = await r.json();
      for (const m of arr) {
        const repo = m.id || m.modelId;
        if (!repo || out.has(repo)) continue;
        // skip models too big for a 16GB iGPU machine: a "<N>B" size >= 9, or MoE
        // (A<N>B) — they'd OOM. The custom "Add" field still allows any ref.
        const sz = repo.match(/(\d+(?:\.\d+)?)\s*b\b/i);
        if ((sz && parseFloat(sz[1]) >= 9) || /A\d+B/i.test(repo)) continue;
        const ggufs = (m.siblings || []).map((s) => s.rfilename || "").filter((f) => f.toLowerCase().endsWith(".gguf"));
        const quant = pickQuant(ggufs);
        if (!quant) continue;
        out.set(repo, { ref: `hf:${repo}:${quant}`, repo, quant, downloads: m.downloads || 0 });
      }
    } catch {
      /* one query failing is fine */
    }
  }
  return [...out.values()].sort((a, b) => b.downloads - a.downloads).slice(0, 30);
}
function readCatalog() {
  try {
    return JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
  } catch {
    return null;
  }
}
// HF hub cache dir for a repo (where -hf downloads land): models--<org>--<repo>
function hfRepoCacheDir(repo) {
  return path.join(os.homedir(), ".cache", "huggingface", "hub", "models--" + repo.replace(/\//g, "--"));
}
function dirSizeBytes(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += dirSizeBytes(p);
      else
        try {
          total += fs.statSync(p).size;
        } catch {}
    }
  } catch {}
  return total;
}
// total bytes to download for an hf:repo:quant (the matching gguf + sibling mmproj).
// Uses the tree API, which (unlike ?full=true siblings) carries real file sizes.
async function hfDownloadBytes(repo, quant) {
  try {
    const r = await fetch(`https://huggingface.co/api/models/${repo}/tree/main?recursive=1`, { headers: { "User-Agent": "oxy" }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) return 0;
    const data = await r.json();
    const files = Array.isArray(data) ? data : [];
    let model = 0;
    const mmprojSizes = [];
    for (const f of files) {
      const name = (f.path || "").toLowerCase();
      if (!name.endsWith(".gguf")) continue;
      const size = f.size || (f.lfs && f.lfs.size) || 0;
      if (/mmproj/i.test(name)) mmprojSizes.push(size);
      else if (!quant || name.includes(quant.toLowerCase())) model += size;
    }
    // one model gguf + the single projector llama.cpp pairs with (use the smallest)
    return model + (mmprojSizes.length ? Math.min(...mmprojSizes) : 0);
  } catch {
    return 0;
  }
}

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 80;
const MAX_FETCH_BYTES = 200 * 1024;
const FETCH_TIMEOUT_MS = 12_000;
// the model may only WRITE these text source types (never arbitrary binaries)
const ALLOWED_EXT = new Set([".html", ".htm", ".css", ".js", ".mjs", ".json", ".svg", ".txt", ".md", ".csv"]);
// these may be SERVED for preview / included in zips (e.g. SD-generated images)
const MIME = {
  ".html": "text/html", ".htm": "text/html", ".css": "text/css",
  ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".svg": "image/svg+xml", ".txt": "text/plain", ".md": "text/plain", ".csv": "text/csv",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
};

export function ensure() {
  fs.mkdirSync(PROJECTS, { recursive: true });
}

function isSafeId(id) {
  return typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,70}$/.test(id);
}

function projectRoot(id) {
  if (!isSafeId(id)) throw new Error("invalid project id");
  const root = path.join(PROJECTS, id);
  return root;
}

// resolve a model-supplied relative path, jailed to the given project folder
function safePath(id, rel) {
  const root = projectRoot(id);
  if (typeof rel !== "string" || rel.includes("\0")) throw new Error("invalid path");
  const cleaned = rel.replace(/^[/\\]+/, "");
  const p = path.resolve(root, cleaned);
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error("path escapes project");
  return p;
}

function checkExt(p) {
  const ext = path.extname(p).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw new Error(`extension not allowed: ${ext || "(none)"}`);
}

function slugify(s) {
  return (
    String(s || "project")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project"
  );
}

function createProject(name) {
  ensure();
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(2, 12); // yyMMddHHmm
  let id = `${slugify(name)}-${stamp}`;
  let n = 1;
  while (fs.existsSync(path.join(PROJECTS, id))) id = `${slugify(name)}-${stamp}-${n++}`;
  fs.mkdirSync(path.join(PROJECTS, id), { recursive: true });
  return id;
}

function listProjects() {
  ensure();
  return fs
    .readdirSync(PROJECTS)
    .filter((d) => fs.statSync(path.join(PROJECTS, d)).isDirectory())
    .map((d) => {
      const files = listFiles(d);
      return { id: d, files: files.length, hasIndex: files.some((f) => f.path === "index.html"), mtime: fs.statSync(path.join(PROJECTS, d)).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function listFiles(id) {
  const root = projectRoot(id);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir)) {
      // hide engine-internal checkpoint (.codelab-state.json) from every consumer:
      // the model's list_files, the zip export, the UI file list, and project counts.
      if (name.startsWith(".codelab")) continue;
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else out.push({ path: rel, bytes: st.size });
    }
  };
  walk(root, "");
  return out;
}

// ---- dependency-free STORED zip (no compression) ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

function ssrfBlocked(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return "invalid url";
  }
  if (!/^https?:$/.test(u.protocol)) return "only http(s) allowed";
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h.endsWith(".local") || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h))
    return "blocked host (private/loopback)";
  return null;
}

function htmlToText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

async function webFetch(url) {
  const blocked = ssrfBlocked(url);
  if (blocked) throw new Error(blocked);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Oxy/0.1" } });
    const ct = res.headers.get("content-type") ?? "";
    const raw = (await res.text()).slice(0, MAX_FETCH_BYTES * 4);
    const text = /html/i.test(ct) ? htmlToText(raw) : raw;
    return { status: res.status, contentType: ct, text: text.slice(0, MAX_FETCH_BYTES) };
  } finally {
    clearTimeout(timer);
  }
}

async function webSearch(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; Oxy/0.1)" } });
    const html = await res.text();
    const results = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && results.length < 6) {
      let link = m[1];
      const dd = link.match(/uddg=([^&]+)/);
      if (dd) link = decodeURIComponent(dd[1]);
      results.push({ title: htmlToText(m[2]), url: link });
    }
    return { results };
  } finally {
    clearTimeout(timer);
  }
}

const REPORTER = `<script>(function(){function s(t,a){try{parent.postMessage({__codelab:true,type:t,text:Array.prototype.map.call(a,function(x){try{return typeof x==='object'?JSON.stringify(x):String(x)}catch(e){return String(x)}}).join(' ')},'*')}catch(e){}}
window.addEventListener('error',function(e){s('error',[(e.message||'error')+' @ '+(e.filename||'')+':'+(e.lineno||0)])});
window.addEventListener('unhandledrejection',function(e){s('error',['unhandledrejection: '+((e.reason&&e.reason.message)||e.reason)])});
['log','warn','error'].forEach(function(k){var o=console[k];console[k]=function(){s(k,arguments);o.apply(console,arguments)}});})();</script>`;
function injectReporter(html) {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + REPORTER);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + REPORTER);
  return REPORTER + html;
}

function clampDim(v, def) {
  const n = Math.round(Number(v) || def);
  return Math.max(64, Math.min(512, Math.round(n / 64) * 64));
}

// generate an image with stable-diffusion.cpp into the project (PNG only).
// The prompt is passed as a spawn arg (array form) — never through a shell — so
// there is no command-injection surface.
async function generateImage(project, rel, prompt, opts = {}) {
  if (!fs.existsSync(SD_CLI)) throw new Error("image generation unavailable (sd-cli not installed)");
  if (!fs.existsSync(SD_MODEL)) throw new Error("image generation unavailable (SD model not found)");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("prompt required");
  if (sdBusy) throw new Error("an image is already generating — try again when it finishes");
  // force a .png inside the project
  const safe = String(rel || "image.png").replace(/\.[^./\\]*$/, "") + ".png";
  const out = safePath(project, safe);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const W = clampDim(opts.width, 384);
  const H = clampDim(opts.height, 384);
  const steps = Math.max(4, Math.min(20, Math.round(Number(opts.steps) || 14)));
  const args = ["-m", SD_MODEL, "-p", prompt.slice(0, 500), "-o", out, "--steps", String(steps), "-W", String(W), "-H", String(H), "--cfg-scale", "7"];

  sdBusy = true;
  const t0 = Date.now();
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(SD_CLI, args, { windowsHide: true });
      const timer = setTimeout(() => { child.kill(); reject(new Error("image generation timed out")); }, SD_TIMEOUT_MS);
      let errTail = "";
      child.stderr.on("data", (d) => { errTail = (errTail + d).slice(-500); });
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(out)) resolve();
        else reject(new Error(`sd-cli exited ${code}: ${errTail.slice(-200)}`));
      });
    });
  } finally {
    sdBusy = false;
  }
  return { path: safe, bytes: fs.statSync(out).size, seconds: Math.round((Date.now() - t0) / 1000), width: W, height: H };
}

// screenshot a project's index.html with Playwright. Loaded via file:// so the
// (untrusted) page runs in chromium with NO access to our backend API.
async function screenshotProject(project) {
  const indexPath = safePath(project, "index.html");
  if (!fs.existsSync(indexPath)) throw new Error("no index.html to screenshot");
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("visual review unavailable (playwright not installed)");
  }
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    sharedBrowser = await chromium.launch({ headless: true });
  }
  // render the true 1280px DESKTOP layout, but rasterize at 0.6x so the output
  // image is ~768px — small enough for the vision encoder, without collapsing
  // the page to a mobile layout (which a small viewport would do)
  const ctx = await sharedBrowser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 0.6 });
  const page = await ctx.newPage();
  try {
    await page.goto(pathToFileURL(indexPath).href, { waitUntil: "networkidle", timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(600); // let fonts/images settle
    const buf = await page.screenshot({ fullPage: false, type: "png" });
    return buf;
  } finally {
    await ctx.close();
  }
}

const CRITIQUE_PROMPT =
  "You are a senior UI/UX designer reviewing a screenshot of a web page. Judge ONLY what you can see: visual hierarchy, spacing and alignment, color and contrast, readability, and overall balance. List the 3 most important, concrete, actionable problems to fix (e.g. 'the hero heading has low contrast on the background', 'cards are unevenly spaced'). If it looks good, say so. Be specific and brief — bullet points.";

async function reviewDesign(project, modelOverride) {
  const shot = await screenshotProject(project);
  const b64 = shot.toString("base64");
  const res = await fetch(VISION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: modelOverride || VISION_MODEL,
      messages: [{ role: "user", content: CRITIQUE_PROMPT, images: [b64] }],
      stream: false,
      think: false,
      keep_alive: "10m",
      options: { temperature: 0, num_predict: 400 },
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error));
  return { critique: data.message?.content ?? "", screenshotBytes: shot.length };
}

// minimal MCP client for the (stateless) Stitch server: one POST per call with
// the API-key header. Parses plain JSON or SSE-wrapped JSON ("data: {…}").
async function stitchMcp(method, params, timeoutMs = STITCH_TIMEOUT_MS) {
  const key = stitchApiKey();
  if (!key) throw new Error("design_with_stitch unavailable — set STITCH_API_KEY (or create stitch.key.local)");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(STITCH_ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "x-goog-api-key": key },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    const text = await res.text();
    let body = text;
    if (text.includes("data:")) {
      const m = text.match(/data:\s*(\{[\s\S]*\})/);
      if (m) body = m[1];
    }
    let j;
    try {
      j = JSON.parse(body);
    } catch {
      throw new Error(`Stitch returned non-JSON (HTTP ${res.status}): ${text.slice(0, 160)}`);
    }
    if (j.error) throw new Error(`Stitch: ${typeof j.error === "string" ? j.error : JSON.stringify(j.error).slice(0, 200)}`);
    return j.result ?? {};
  } finally {
    clearTimeout(timer);
  }
}
const stitchCall = (name, args, t) => stitchMcp("tools/call", { name, arguments: args }, t);

// generate a screen with Stitch and return its HTML, fetched from the download URL.
// Flow (verified against the live API): create_project -> generate_screen_from_text
// -> outputComponents[].design.screens[].htmlCode.downloadUrl -> fetch the HTML.
export async function stitchGenerate(prompt, opts = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("prompt required");
  if (stitchBusy) throw new Error("a Stitch generation is already running — try again when it finishes");
  stitchBusy = true;
  const t0 = Date.now();
  try {
    const cp = await stitchCall("create_project", { title: String(opts.title || "oxy").slice(0, 60) }, 60_000);
    const projectId = String(cp.structuredContent?.name || "").replace(/^projects\//, "");
    if (!projectId) throw new Error("could not create a Stitch project");
    const args = { projectId, prompt: prompt.slice(0, 2000), deviceType: opts.deviceType === "MOBILE" ? "MOBILE" : "DESKTOP" };
    if (opts.designSystem) args.designSystem = opts.designSystem;
    const g = await stitchCall("generate_screen_from_text", args);
    let url;
    for (const oc of g.structuredContent?.outputComponents ?? [])
      for (const s of oc?.design?.screens ?? [])
        if (s?.htmlCode?.downloadUrl) {
          url = s.htmlCode.downloadUrl;
          break;
        }
    if (!url) throw new Error("Stitch returned no HTML download URL");
    const hres = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    let html = await hres.text();
    if (!/<html|<!doctype/i.test(html)) throw new Error("Stitch download was not HTML");
    if (Buffer.byteLength(html, "utf8") > MAX_FILE_BYTES) html = html.slice(0, MAX_FILE_BYTES);
    return { html, stitchProjectId: projectId, seconds: Math.round((Date.now() - t0) / 1000) };
  } finally {
    stitchBusy = false;
  }
}

// Construct an Engine from a request body (shared by /build and /ask).
async function engineFromBody(body, features = DEFAULT_FEATURES) {
  if (body.engine === "openai") {
    const { OpenAICompatEngine } = await import("../engine/openai-compat.ts");
    return new OpenAICompatEngine({ baseUrl: body.baseUrl, model: body.model, apiKey: body.apiKey, idleTimeout: features.idleTimeout });
  }
  if (body.engine === "llama-server") {
    const { LlamaServerEngine } = await import("../engine/llama-server.ts");
    return new LlamaServerEngine({ modelRef: body.model || undefined, idleTimeout: features.idleTimeout, modelAwareReuse: features.modelAwareReuse });
  }
  const { OllamaEngine } = await import("../engine/ollama.ts");
  return new OllamaEngine({ model: body.model });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 25 * 1024 * 1024) reject(new Error("body too large")); // generous: base64 images/audio attachments
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

// The single request handler — connect-style (req, res, next). Used by both the
// Vite plugin and the standalone node:http launcher. Requests that don't start
// with /codelab/ are passed to next().
export async function codelabHandler(req, res, next) {
  const u = req.url || "";
  if (!u.startsWith("/codelab/") && !u.startsWith("/oxy/")) return next();
  const [pathPart, queryPart] = u.split("?");
  const query = new URLSearchParams(queryPart || "");

  try {
    // ---- Oxy: what's available (for the UI engine/model picker) ----
    if (pathPart === "/oxy/api/status" && req.method === "GET") {
      let ollamaUp = false;
      let models = [];
      try {
        const v = await fetch("http://localhost:11434/api/version", { signal: AbortSignal.timeout(1500) });
        ollamaUp = v.ok;
        if (ollamaUp) {
          const t = await (await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(2500) })).json();
          models = (t.models ?? []).map((m) => m.name);
        }
      } catch {
        /* ollama not running */
      }
      // smart engine routing: prefer Ollama only when it offloads to the GPU
      // (CUDA/Metal); on a Vulkan-only machine Ollama is CPU, so prefer llama-server.
      const { detectGpu, recommendEngine } = await import("../engine/gpu.ts");
      const gpu = await detectGpu();
      const rec = await recommendEngine(ollamaUp);
      const settings = readSettings();
      return sendJson(res, 200, {
        ok: true,
        engines: { ollama: ollamaUp, "llama-server": true },
        gpu: gpu.backend,
        ollamaUsesGpu: gpu.ollamaUsesGpu,
        recommended: rec.engine,
        recommendReason: rec.reason,
        stitch: !!stitchApiKey(),
        sd: fs.existsSync(SD_CLI) && fs.existsSync(SD_MODEL),
        models,
        tools: settings.tools,
        terminalMode: settings.terminalMode,
        features: settings.features,
        llamaModels: settings.llamaModels,
      });
    }

    // ---- Oxy: save the user's Stitch API key (to the gitignored stitch.key.local).
    // The key is never returned to the client — only its presence (via /status). ----
    if (pathPart === "/oxy/api/settings" && req.method === "POST") {
      const body = await readBody(req);
      try {
        if (typeof body.stitchApiKey === "string") {
          const keyPath = path.resolve(ROOT, "stitch.key.local");
          if (body.stitchApiKey.trim()) fs.writeFileSync(keyPath, `STITCH_API_KEY=${body.stitchApiKey.trim()}\n`, "utf8");
          else if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
        }
        let settings = readSettings();
        if (body.tools || body.terminalMode || body.features || body.llamaModels) settings = writeSettings({ tools: body.tools, terminalMode: body.terminalMode, features: body.features, llamaModels: body.llamaModels });
        return sendJson(res, 200, { ok: true, stitch: !!stitchApiKey(), tools: settings.tools, terminalMode: settings.terminalMode, features: settings.features, llamaModels: settings.llamaModels });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) });
      }
    }

    // ---- Oxy: validate a Hugging Face model ref before adding it (catch typos in ~1s
    // instead of a 900s boot hang). Checks the repo exists and has a GGUF of that quant. ----
    if (pathPart === "/oxy/api/model/check" && req.method === "POST") {
      const body = await readBody(req);
      let ref = String(body.ref || "").trim().replace(/^hf:/, "");
      // local path / URL — can't validate via HF, accept as-is
      if (!ref) return sendJson(res, 200, { ok: false, error: "enter a model ref" });
      if (/^https?:\/\//i.test(ref) || ref.includes("\\") || ref.split("/").length > 2) {
        return sendJson(res, 200, { ok: true, note: "non-HF ref — used as-is, not validated" });
      }
      const m = ref.match(/^([^/:]+\/[^/:]+)(?::(.+))?$/);
      if (!m) return sendJson(res, 200, { ok: false, error: "expected org/repo:Quant (e.g. unsloth/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M)" });
      const repo = m[1];
      const quant = m[2];
      try {
        const r = await fetch(`https://huggingface.co/api/models/${repo}`, { headers: { "User-Agent": "oxy" }, signal: AbortSignal.timeout(10000) });
        if (r.status === 404 || r.status === 401) return sendJson(res, 200, { ok: false, error: `repo not found (or private) on Hugging Face: ${repo}` });
        if (!r.ok) return sendJson(res, 200, { ok: false, error: `Hugging Face check failed (HTTP ${r.status})` });
        const j = await r.json();
        const ggufs = (j.siblings || []).map((s) => s.rfilename || "").filter((f) => f.toLowerCase().endsWith(".gguf"));
        if (!ggufs.length) return sendJson(res, 200, { ok: false, error: `${repo} has no GGUF files (llama-server needs GGUF)` });
        if (quant && !ggufs.some((f) => f.toLowerCase().includes(quant.toLowerCase()))) {
          const quants = [...new Set(ggufs.map((f) => (f.match(/(UD-)?(Q\d[0-9A-Z_]*|BF16|F16|F32)/i) || [, , ""])[2]).filter(Boolean))];
          return sendJson(res, 200, { ok: false, error: `quant "${quant}" not in ${repo}. Available: ${quants.slice(0, 8).join(", ")}` });
        }
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: `Hugging Face check failed: ${String(e?.message ?? e).slice(0, 120)}` });
      }
    }

    // ---- Oxy: browse downloadable models (curated HF GGUF search), cached to disk.
    // ?refresh=1 re-pulls from Hugging Face (for newer models). ----
    if (pathPart === "/oxy/api/model/list" && req.method === "GET") {
      const refresh = /[?&]refresh=1\b/.test(req.url || "");
      let cat = readCatalog();
      if (refresh || !cat || !cat.cachedAt || Date.now() - cat.cachedAt > CATALOG_TTL_MS) {
        const models = await fetchModelCatalog();
        if (models.length) {
          cat = { models, cachedAt: Date.now() };
          try {
            fs.mkdirSync(OXY_HOME, { recursive: true });
            fs.writeFileSync(CATALOG_PATH, JSON.stringify(cat), "utf8");
          } catch {}
        } else if (!cat) cat = { models: [], cachedAt: Date.now() };
      }
      return sendJson(res, 200, { ok: true, models: cat.models, cachedAt: cat.cachedAt });
    }

    // ---- Oxy: download a model NOW (prewarm llama.cpp's -hf cache by loading it),
    // streaming progress (% from the growing HF cache dir). The model is ready after. ----
    if (pathPart === "/oxy/api/model/download" && req.method === "POST") {
      const body = await readBody(req);
      let ref = String(body.ref || "").trim();
      if (!ref) return sendJson(res, 200, { ok: false, error: "ref required" });
      if (!ref.startsWith("hf:") && !/^https?:/i.test(ref) && !ref.includes("\\") && ref.split("/").length <= 2) ref = "hf:" + ref;
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-store");
      const send = (o) => {
        try {
          res.write(JSON.stringify(o) + "\n");
        } catch {}
      };
      try {
        send({ type: "status", message: "resolving on Hugging Face…" });
        let total = 0;
        let repoDir = null;
        if (ref.startsWith("hf:")) {
          const m = ref.slice(3).match(/^([^/:]+\/[^/:]+)(?::(.+))?$/);
          if (m) {
            total = await hfDownloadBytes(m[1], m[2]);
            repoDir = hfRepoCacheDir(m[1]);
          }
        }
        send({ type: "status", message: "downloading & loading… (first time can take a few minutes)" });
        const { LlamaServerEngine } = await import("../engine/llama-server.ts");
        const eng = new LlamaServerEngine({ modelRef: ref });
        let done = false;
        let err = null;
        const boot = eng.ensureReady().then(() => (done = true)).catch((e) => {
          done = true;
          err = e;
        });
        const t0 = Date.now();
        while (!done) {
          const sz = repoDir ? dirSizeBytes(repoDir) : 0;
          send({ type: "progress", pct: total ? Math.min(99, Math.round((sz / total) * 100)) : null, mb: Math.round(sz / 1e6), totalMb: Math.round(total / 1e6), secs: Math.round((Date.now() - t0) / 1000) });
          await new Promise((r) => setTimeout(r, 1200));
        }
        await boot;
        if (err) send({ type: "error", message: String(err?.message ?? err).slice(0, 200) });
        else send({ type: "done", ref });
      } catch (e) {
        send({ type: "error", message: String(e?.message ?? e) });
      } finally {
        res.end();
      }
      return;
    }

    // ---- run_command tool: gated + sandboxed shell execution. The backend is the
    // authoritative gate — it refuses unless run_command is enabled in settings,
    // regardless of what the model emits. ----
    if (pathPart === "/codelab/api/run-command" && req.method === "POST") {
      const body = await readBody(req);
      const settings = readSettings();
      if (!settings.tools.run_command) return sendJson(res, 200, { ok: false, error: "run_command is disabled — enable the terminal tool in Settings" });
      const project = String(body.project || "");
      const command = String(body.command || "");
      const projectDir = path.join(PROJECTS, project);
      if (!project || !path.resolve(projectDir).startsWith(path.resolve(PROJECTS)) || !fs.existsSync(projectDir)) {
        return sendJson(res, 200, { ok: false, error: "unknown project" });
      }
      try {
        const { runCommand } = await import("./sandbox.mjs");
        const r = await runCommand(command, projectDir, { mode: settings.terminalMode, timeoutMs: 30000, maxOutput: 16000 });
        return sendJson(res, 200, { ok: r.ok, output: r.output ?? (r.ok ? "(ran)" : "error"), mode: r.mode });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) });
      }
    }

    // ---- Oxy: run a build server-side, streaming AgentStep events as NDJSON ----
    if (pathPart === "/oxy/api/build" && req.method === "POST") {
      const body = await readBody(req);
      const task = body.task;
      if (typeof task !== "string" || !task.trim()) return sendJson(res, 200, { ok: false, error: "task required" });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-store");
      const send = (obj) => {
        try {
          res.write(JSON.stringify(obj) + "\n");
        } catch {
          /* client gone */
        }
      };
      const ac = new AbortController();
      req.on("close", () => ac.abort());
      try {
        // dynamic imports keep native modules out of Vite's config-load bundling
        const { runAgent, HttpToolExecutor, createProject } = await import("../agent/index.ts");
        const features = readSettings().features;
        const engine = await engineFromBody(body, features);
        send({ type: "status", message: "loading model…" });
        await engine.ensureReady();
        const baseUrl = `http://${req.headers.host}`;
        // continue an existing project (iterate) when an id is supplied, else create one
        let project = typeof body.project === "string" && body.project ? body.project : null;
        const iterate = !!project;
        if (!project) project = await createProject(task.slice(0, 40), baseUrl);
        send({ type: "project", project, iterate });
        const executor = new HttpToolExecutor({ baseUrl });
        // use the deployed (e.g. SkillOpt-tuned) skill if present
        const skillPath = path.resolve(ROOT, "skill", "system.md");
        const systemOverride = fs.existsSync(skillPath) ? fs.readFileSync(skillPath, "utf8") : undefined;
        // multimodal attachments (images/audio) from the client — validate the shape
        const attachments = Array.isArray(body.attachments)
          ? body.attachments.filter((a) => a && (a.kind === "image" || a.kind === "audio") && typeof a.mime === "string" && typeof a.data === "string").slice(0, 6)
          : undefined;
        // distinct phase so a long image-encode (vision prefill) doesn't look hung:
        // "reading your N image(s)…" stays up through prefill until the first token lands.
        const imgCount = attachments ? attachments.filter((a) => a.kind === "image").length : 0;
        send({ type: "status", message: imgCount ? `reading your ${imgCount} image${imgCount > 1 ? "s" : ""}…` : "generating…" });
        let lastTok = 0;
        const toolLog = []; // for the continuous-improvement supervisor review
        let finished = false;
        await runAgent(
          {
            task,
            project,
            maxIterations: Number(body.maxIterations) || 14,
            temperature: Number(body.temperature) || 0.6,
            useStitch: !!body.useStitch,
            iterate,
            systemOverride,
            attachments: attachments && attachments.length ? attachments : undefined,
            enabledTools: readSettings().tools,
            thinking: features.thinking, // gemma4 otherwise burns its budget reasoning (default OFF)
            autoCompact: features.autoCompact,
            recoveryBursts: features.recoveryBursts,
          },
          {
            engine,
            executor,
            signal: ac.signal,
            onStep: (s) => {
              for (const t of s.toolCalls) toolLog.push(t.name);
              if (s.done) finished = true;
              lastTok = 0; // a turn landed — the live counter resets per turn, so reset the throttle too
              send({ type: "step", step: s });
            },
            onProgress: (p) => {
              // emit the first token of each turn immediately (so the meter lights up fast),
              // then throttle to every ~20. p.tokens resets per turn; lastTok is reset in onStep.
              if (p.tokens === 1 || p.tokens - lastTok >= 20) {
                lastTok = p.tokens;
                send({ type: "progress", iteration: p.iteration, tokens: p.tokens });
              }
            },
          },
        );
        send({ type: "done", project });
        // continuous improvement: review THIS build in the background (best-effort,
        // never blocks the response). watch-always; deploy stays gated (promote.ts).
        if (process.env.OXY_SUPERVISOR !== "0" && !ac.signal.aborted) {
          (async () => {
            try {
              const { reviewBuild } = await import("../skillopt/supervisor.ts");
              const { OllamaEngine } = await import("../engine/ollama.ts");
              const sup = new OllamaEngine({ model: process.env.OXY_SUPERVISOR_MODEL || process.env.OXY_OPT_MODEL || "gpt-oss:120b-cloud" });
              await sup.ensureReady();
              let fileCount = 0;
              try {
                fileCount = fs.readdirSync(path.join(PROJECTS, project)).filter((f) => !f.startsWith(".codelab")).length;
              } catch {}
              await reviewBuild({ task, project, toolLog, finished, errors: [], fileCount, iterate }, sup, systemOverride ?? "");
            } catch {
              /* supervisor is best-effort; never affects the build */
            }
          })();
        }
      } catch (e) {
        send({ type: "error", message: String(e?.message ?? e) });
      } finally {
        res.end();
      }
      return;
    }

    // ---- Oxy: ASK — one-shot multimodal Q&A (no build, no tools, no project),
    // streamed. Far lighter than a build; for "what's in this image?" etc. ----
    if (pathPart === "/oxy/api/ask" && req.method === "POST") {
      const body = await readBody(req);
      const task = body.task;
      if (typeof task !== "string" || !task.trim()) return sendJson(res, 200, { ok: false, error: "question required" });
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/x-ndjson");
      res.setHeader("Cache-Control", "no-store");
      const send = (obj) => {
        try {
          res.write(JSON.stringify(obj) + "\n");
        } catch {
          /* client gone */
        }
      };
      const ac = new AbortController();
      req.on("close", () => ac.abort());
      try {
        const features = readSettings().features;
        const engine = await engineFromBody(body, features);
        send({ type: "status", message: "loading model…" });
        await engine.ensureReady();
        const attachments = Array.isArray(body.attachments)
          ? body.attachments.filter((a) => a && (a.kind === "image" || a.kind === "audio") && typeof a.mime === "string" && typeof a.data === "string").slice(0, 6)
          : undefined;
        // keep a clear phase up through the (slow) image-encode prefill
        const imgCount = attachments ? attachments.filter((a) => a.kind === "image").length : 0;
        send({ type: "status", message: imgCount ? `reading your ${imgCount} image${imgCount > 1 ? "s" : ""}…` : "thinking…" });
        let answer = "";
        let lastLen = 0;
        const result = await engine.generate(
          [{ role: "user", content: task, attachments: attachments && attachments.length ? attachments : undefined }],
          [],
          {
            temperature: Number(body.temperature) || 0.4,
            numPredict: Number(body.numPredict) || 1024,
            think: features.thinking, // default OFF (fast answers); the thinking feature can enable it
            signal: ac.signal,
            onToken: (t) => {
              answer += t;
              send({ type: "delta", text: t });
              if (answer.length - lastLen >= 24) {
                lastLen = answer.length;
                send({ type: "progress", iteration: 0, tokens: answer.length });
              }
            },
          },
        );
        send({ type: "answer", text: result.content || answer });
        send({ type: "done" });
      } catch (e) {
        send({ type: "error", message: String(e?.message ?? e) });
      } finally {
        res.end();
      }
      return;
    }

    // ---- preview: /codelab/preview/<projectId>/<file...> ----
    if (pathPart.startsWith("/codelab/preview/")) {
      const rest = decodeURIComponent(pathPart.slice("/codelab/preview/".length));
      const slash = rest.indexOf("/");
      const id = slash === -1 ? rest : rest.slice(0, slash);
      let rel = slash === -1 ? "index.html" : rest.slice(slash + 1) || "index.html";
      const p = safePath(id, rel);
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const ext = path.extname(p).toLowerCase();
      res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      if (ext === ".html" || ext === ".htm") res.end(injectReporter(fs.readFileSync(p, "utf8")));
      else fs.createReadStream(p).pipe(res);
      return;
    }

    // ---- export: GET /codelab/api/export?project=id ----
    if (pathPart === "/codelab/api/export" && req.method === "GET") {
      const id = query.get("project");
      const entries = listFiles(id).map((f) => ({ name: f.path, data: fs.readFileSync(safePath(id, f.path)) }));
      if (entries.length === 0) throw new Error("empty project");
      const zip = makeZip(entries);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${id}.zip"`);
      res.end(zip);
      return;
    }

    // ---- project management ----
    if (pathPart === "/codelab/api/projects" && req.method === "GET") {
      return sendJson(res, 200, { projects: listProjects() });
    }
    if (pathPart === "/codelab/api/project/new" && req.method === "POST") {
      const { name } = await readBody(req);
      return sendJson(res, 200, { ok: true, id: createProject(name) });
    }

    // ---- file tools (project-scoped) ----
    if (pathPart === "/codelab/api/list" && req.method === "GET") {
      return sendJson(res, 200, { files: listFiles(query.get("project")) });
    }
    if (pathPart === "/codelab/api/read" && req.method === "POST") {
      const { project, path: rel } = await readBody(req);
      const p = safePath(project, rel);
      if (!fs.existsSync(p)) return sendJson(res, 200, { ok: false, error: "file does not exist" });
      return sendJson(res, 200, { ok: true, content: fs.readFileSync(p, "utf8") });
    }
    if (pathPart === "/codelab/api/edit" && req.method === "POST") {
      const { project, path: rel, old_string, new_string } = await readBody(req);
      const p = safePath(project, rel);
      checkExt(p);
      if (!fs.existsSync(p)) return sendJson(res, 200, { ok: false, error: "file does not exist — use write_file to create it" });
      if (typeof old_string !== "string" || old_string === "") return sendJson(res, 200, { ok: false, error: "old_string is required" });
      const content = fs.readFileSync(p, "utf8");
      const matches = content.split(old_string).length - 1;
      if (matches === 0) return sendJson(res, 200, { ok: false, error: "old_string not found in the file — copy the exact text to replace" });
      const updated = content.replace(old_string, typeof new_string === "string" ? new_string : "");
      if (Buffer.byteLength(updated, "utf8") > MAX_FILE_BYTES) return sendJson(res, 200, { ok: false, error: "result too large" });
      fs.writeFileSync(p, updated, "utf8");
      return sendJson(res, 200, { ok: true, path: rel, replacedFirstOf: matches, bytes: Buffer.byteLength(updated, "utf8") });
    }
    if (pathPart === "/codelab/api/write" && req.method === "POST") {
      const { project, path: rel, content } = await readBody(req);
      const p = safePath(project, rel);
      checkExt(p);
      if (typeof content !== "string") throw new Error("content must be a string");
      if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("file too large");
      if (listFiles(project).length >= MAX_FILES && !fs.existsSync(p)) throw new Error("too many files");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content, "utf8");
      return sendJson(res, 200, { ok: true, path: rel, bytes: Buffer.byteLength(content, "utf8") });
    }
    if (pathPart === "/codelab/api/web-fetch" && req.method === "POST") {
      const { url } = await readBody(req);
      return sendJson(res, 200, { ok: true, ...(await webFetch(url)) });
    }
    if (pathPart === "/codelab/api/web-search" && req.method === "POST") {
      const { query: q } = await readBody(req);
      return sendJson(res, 200, { ok: true, ...(await webSearch(q)) });
    }
    if (pathPart === "/codelab/api/generate-image" && req.method === "POST") {
      const { project, path: rel, prompt, width, height, steps } = await readBody(req);
      const r = await generateImage(project, rel, prompt, { width, height, steps });
      return sendJson(res, 200, { ok: true, ...r });
    }
    if (pathPart === "/codelab/api/sd-status" && req.method === "GET") {
      return sendJson(res, 200, { available: fs.existsSync(SD_CLI) && fs.existsSync(SD_MODEL), busy: sdBusy });
    }
    if (pathPart === "/codelab/api/review" && req.method === "POST") {
      const { project, model } = await readBody(req);
      return sendJson(res, 200, { ok: true, ...(await reviewDesign(project, model)) });
    }
    if (pathPart === "/codelab/api/stitch-status" && req.method === "GET") {
      return sendJson(res, 200, { available: !!stitchApiKey(), busy: stitchBusy });
    }
    if (pathPart === "/codelab/api/design-stitch" && req.method === "POST") {
      const { project, path: rel, prompt, deviceType, designSystem } = await readBody(req);
      const r = await stitchGenerate(prompt, { deviceType, designSystem, title: project });
      // write the generated HTML into the jailed project (so we don't push
      // ~10KB of HTML back through the model's context). Reuses the write jail.
      const target = rel || "index.html";
      const p = safePath(project, target);
      checkExt(p);
      if (listFiles(project).length >= MAX_FILES && !fs.existsSync(p)) throw new Error("too many files");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, r.html, "utf8");
      return sendJson(res, 200, {
        ok: true,
        path: target,
        bytes: Buffer.byteLength(r.html, "utf8"),
        seconds: r.seconds,
        preview: r.html.slice(0, 600),
      });
    }
    if (pathPart === "/codelab/api/icon" && req.method === "GET") {
      const name = (query.get("name") || "").replace(/[^a-z0-9-]/gi, "");
      const set = (query.get("set") || "lucide").replace(/[^a-z0-9-]/gi, "");
      if (!name) throw new Error("icon name required");
      // fixed host (Iconify), so no SSRF surface
      const ic = await fetch(`https://api.iconify.design/${set}/${name}.svg`).catch(() => null);
      const svg = ic && ic.ok ? await ic.text() : "";
      if (!svg.startsWith("<svg")) return sendJson(res, 200, { ok: false, error: `icon not found: ${set}:${name}` });
      return sendJson(res, 200, { ok: true, svg });
    }

    res.statusCode = 404;
    return sendJson(res, 404, { ok: false, error: "unknown codelab route" });
  } catch (e) {
    return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) });
  }
}

// Vite dev-server plugin: mounts the same handler under /codelab/* in-process.
export function codeLabPlugin() {
  return {
    name: "oxy-codelab-backend",
    configureServer(server) {
      ensure();
      server.middlewares.use(codelabHandler);
    },
  };
}
