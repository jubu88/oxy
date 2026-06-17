// One-time setup for local image generation (the generate_image tool). Downloads
// a prebuilt VULKAN stable-diffusion.cpp binary + an SD 1.5 model into <repo>/../sd,
// where Oxy's server looks for them (SD_CLI / SD_MODEL). The Vulkan build runs on
// the iGPU (~4× CPU on an Iris Xe). Streams to disk (no multi-GB RAM spike).
//   node scripts/setup-sd.mjs
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SD_DIR = path.resolve(HERE, "..", "..", "sd"); // C:/Users/sgiur/Dev/sd
const VULKAN_DIR = path.join(SD_DIR, "vulkan");
const MODEL_PATH = path.join(SD_DIR, "sd-v1-5.safetensors");
const MODEL_URL = "https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/v1-5-pruned-emaonly-fp16.safetensors";
const RELEASES_JSON = "https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest";

const log = (m) => console.log(`[setup-sd] ${m}`);

async function download(url, dest) {
  log(`downloading ${path.basename(dest)} …`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  log(`  saved ${(fs.statSync(dest).size / 1e6).toFixed(0)} MB → ${dest}`);
}

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const h = findFile(full, name);
      if (h) return h;
    } else if (e.name.toLowerCase() === name.toLowerCase()) return full;
  }
  return null;
}

async function setupBinary() {
  if (fs.existsSync(path.join(VULKAN_DIR, "sd-cli.exe"))) return log("sd-cli.exe already present");
  fs.mkdirSync(VULKAN_DIR, { recursive: true });
  const rel = await (await fetch(RELEASES_JSON, { headers: { "User-Agent": "oxy" } })).json();
  const asset = (rel.assets ?? []).find((a) => /win-vulkan-x64\.zip$/i.test(a.name));
  if (!asset) throw new Error("no win-vulkan asset in the latest stable-diffusion.cpp release");
  const zip = path.join(VULKAN_DIR, asset.name);
  await download(asset.browser_download_url, zip);
  await execFileP("powershell", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${VULKAN_DIR}' -Force`]);
  fs.rmSync(zip, { force: true });
  // locate the CLI (releases name it sd-cli.exe; older ones sd.exe), flatten its
  // dir into VULKAN_DIR (so its DLLs are siblings), and ensure sd-cli.exe exists.
  const sdExe = findFile(VULKAN_DIR, "sd-cli.exe") || findFile(VULKAN_DIR, "sd.exe");
  if (!sdExe) throw new Error("sd binary not found after extraction");
  const dir = path.dirname(sdExe);
  if (path.resolve(dir) !== path.resolve(VULKAN_DIR)) {
    for (const f of fs.readdirSync(dir)) fs.renameSync(path.join(dir, f), path.join(VULKAN_DIR, f));
  }
  const cli = path.join(VULKAN_DIR, "sd-cli.exe");
  if (!fs.existsSync(cli)) fs.copyFileSync(path.join(VULKAN_DIR, path.basename(sdExe)), cli);
  log("sd-cli.exe ready (Vulkan)");
}

async function setupModel() {
  if (fs.existsSync(MODEL_PATH)) return log("model already present");
  await download(MODEL_URL, MODEL_PATH);
}

(async () => {
  log(`target: ${SD_DIR}`);
  await setupBinary();
  await setupModel();
  log("done — restart the dev server; /oxy/api/status will report sd:true and generate_image activates.");
})().catch((e) => {
  console.error("[setup-sd] failed:", e?.stack ?? e);
  process.exit(1);
});
