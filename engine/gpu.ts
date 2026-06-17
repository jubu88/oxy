// Coarse GPU/backend detection for engine routing. Mirrors llama-server's
// detectVariant primitives, but answers the product question the UI needs:
// "which engine actually uses this machine's GPU?"
//
// The key fact: Ollama offloads only to CUDA (NVIDIA), Metal (Apple), or ROCm
// (AMD on Linux) — NOT Vulkan. llama-server reaches Intel/AMD GPUs via Vulkan.
// So on a Vulkan-only machine (e.g. an Intel Iris Xe), Ollama silently runs on
// CPU while llama-server runs on the GPU — and we must not auto-pick Ollama there.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";

const execFileP = promisify(execFile);

export type Backend = "cuda" | "metal" | "vulkan" | "cpu";

async function hasNvidia(): Promise<boolean> {
  try {
    await execFileP("nvidia-smi", [], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function hasVulkan(): Promise<boolean> {
  if (process.platform === "win32") {
    return fs.existsSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "vulkan-1.dll"));
  }
  for (const p of ["/usr/lib/x86_64-linux-gnu/libvulkan.so.1", "/usr/lib/libvulkan.so.1", "/usr/lib64/libvulkan.so.1", "/lib/x86_64-linux-gnu/libvulkan.so.1"]) {
    if (fs.existsSync(p)) return true;
  }
  try {
    await execFileP("vulkaninfo", ["--summary"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export interface GpuInfo {
  /** the best backend llama-server would use here */
  backend: Backend;
  /** would Ollama offload to the GPU on this machine? (CUDA/Metal yes, Vulkan-only no) */
  ollamaUsesGpu: boolean;
}

let cached: Promise<GpuInfo> | null = null;

/** Detect once per process (nvidia-smi/vulkan probes are cheap but not free). */
export function detectGpu(): Promise<GpuInfo> {
  if (!cached) {
    cached = (async (): Promise<GpuInfo> => {
      if (process.platform === "darwin") return { backend: "metal", ollamaUsesGpu: true }; // Apple: both use Metal
      if (await hasNvidia()) return { backend: "cuda", ollamaUsesGpu: true }; // NVIDIA: both use CUDA
      if (await hasVulkan()) return { backend: "vulkan", ollamaUsesGpu: false }; // Intel/AMD: only llama-server (Vulkan); Ollama → CPU
      return { backend: "cpu", ollamaUsesGpu: false };
    })();
  }
  return cached;
}

export interface EngineRec {
  engine: "ollama" | "llama-server";
  backend: Backend;
  reason: string;
}

/** Prefer Ollama only when it would actually use the GPU; otherwise prefer
 *  llama-server (which reaches Intel/AMD GPUs via Vulkan). On a pure-CPU machine,
 *  Ollama is fine when present (zero-download convenience). */
export async function recommendEngine(ollamaPresent: boolean): Promise<EngineRec> {
  const { backend, ollamaUsesGpu } = await detectGpu();
  if (ollamaPresent && ollamaUsesGpu) return { engine: "ollama", backend, reason: `Ollama offloads to your ${backend.toUpperCase()} GPU` };
  if (backend === "vulkan") return { engine: "llama-server", backend, reason: ollamaPresent ? "Ollama would run on CPU here — llama-server uses your GPU via Vulkan" : "llama-server uses your GPU via Vulkan" };
  if (ollamaPresent) return { engine: "ollama", backend, reason: "no GPU detected; Ollama is ready (runs on CPU)" };
  return { engine: "llama-server", backend, reason: "no GPU detected (runs on CPU)" };
}
