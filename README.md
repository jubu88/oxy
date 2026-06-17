# Oxy

**Build web apps with a local LLM. Simple, beautiful, just works.**

Oxy is a local-first coding tool: describe the app you want, and a model running
**entirely on your machine** builds it — writing the files, generating images and
icons, previewing the result, and refining its own design. No cloud account, no
API keys required, nothing to configure.

> Oxy is the productized descendant of the **Reasoning Lab** research bench, where
> the orchestration techniques below were discovered and measured. The bench keeps
> experimenting; proven findings get ported here.

## Why it's different

The model isn't the product — the **orchestration layer** is. Small local models
are weak on their own, so Oxy wraps them in techniques that make them punch far
above their weight:

- **Auto-compact** — when the context fills, Oxy checkpoints the build state to
  disk and continues from a fresh, small context. Lets a small model build things
  bigger than its context window, and makes builds resumable after a crash/sleep.
- **Thinking-burst** — the model reasons hard for exactly one step after a design
  critique or an error, then goes quiet again (the trace never bloats context).
- *(porting from the bench)* agreement/best-of-N, fresh-restart escalation, and
  logprob-confidence routing.

Plus: a **jailed workspace** (the model can only touch its own project folder), a
**sandboxed preview**, real **SVG icons** and a **design system**, optional local
**Stable Diffusion** images and **Google Stitch** design.

## Install & run

```sh
npm install      # ships prebuilt llama.cpp binaries (CPU + Vulkan/Metal/CUDA, auto-detected)
npm run dev      # open the UI; describe an app and press Build
```

On first use Oxy picks an engine automatically: if **Ollama** is running it uses
that (fast, nothing to download); otherwise the in-process **node-llama-cpp**
engine downloads a small default coder model on the first build. A GPU is used
automatically if you have one; otherwise it runs on CPU.

Prefer the terminal? Build headlessly:

```sh
npm run oxy      # OXY_TASK="build a ..." OXY_ENGINE=ollama|node-llama OXY_MODEL=... npm run oxy
```

## The interface

![Oxy](design/screenshot.png)

A futuristic, minimal command deck — designed in **Google Stitch**
(`design/stitch-ui.html`, regenerate with `node design/gen-stitch.mjs`) and built
in React over an animated WebGL nebula. It has a prompt box, an engine/model
picker, a live build timeline that surfaces the orchestration (context-pressure
meter, `thinking` / `compacted` cues), a sandboxed preview, and one-click
**Export .zip**.

- **Iterate, don't restart.** Pick an existing project from the switcher and
  describe a change — the model reads the current files and edits in place.
- **Bring your own keys.** The Settings panel saves your Stitch API key to a
  git-ignored file (never committed, never sent back to the browser).

## Engines

Inference runs through one `Engine` interface (`engine/engine.ts`) so the agent
loop is backend-agnostic:

- **`engine/llama-server.ts`** — **managed, recommended for the latest models.** On
  first use Oxy downloads a *prebuilt* `llama-server` from llama.cpp's releases (no
  compiler) plus the GGUF (default **gemma4 E4B**), runs it in the background, and
  drives it via the OpenAI-compatible adapter. You still just `npm run dev` — Oxy
  manages everything, and **auto-detects your GPU** (NVIDIA→CUDA, else Vulkan, else
  CPU; macOS→Metal), falling back to CPU if the GPU backend fails. This runs models
  the in-process engine can't load yet (e.g. gemma4). Override with `OXY_LLAMA_VARIANT`.
- **`engine/node-llama.ts`** — in-process via
  [`node-llama-cpp`](https://node-llama-cpp.withcat.ai) (bundled), the leanest path:
  no server process at all. Auto-downloads a small coder GGUF; plug in any GGUF by
  HuggingFace ref. (Bound to its bundled llama.cpp, so brand-new architectures like
  `gemma4` won't load until node-llama-cpp updates — use llama-server for those now.)
- **`engine/ollama.ts`** — for people who already run Ollama (also has the newest
  models, e.g. `gemma4:e4b`); used automatically when Ollama is detected.
- **`engine/openai-compat.ts`** — the generic adapter under llama-server/Ollama; also
  works standalone against **any OpenAI-compatible server** (LM Studio, Jan, vLLM, a
  remote endpoint) — point it at a base URL in the model picker.

When Ollama is running Oxy uses it (gemma4, instant). Otherwise it defaults to the
**managed llama-server** so a fresh clone gets gemma4 with nothing to install. Pick
`node-llama` in the model picker for the no-download, fully in-process path.

The loop uses the low-level `LlamaChat.generateResponse` (not the auto-tool-running
`LlamaChatSession.prompt`), so the compaction/burst/strategy seam stays exposed —
see `engine/engine.ts` for the architecture.

## Architecture

```
agent/      engine-agnostic loop: tools, auto-compact, thinking-burst, token accounting
engine/     Engine interface + node-llama-cpp and ollama adapters
server/     jailed backend (file tools, preview, SSRF-guarded web, SD, Stitch) —
            mounted in Vite (codeLabPlugin) or run standalone (serve.mjs)
driver/     headless build driver (run-build.ts)
src/        the React UI (designed in Stitch)
design/     the Stitch-generated design reference
```

## Develop

```sh
npm test         # agent-loop + adapter unit tests (Node's built-in runner, no extra deps)
npm run typecheck
npm run build    # type-check + production bundle
```

## Status

v0.1 — working end to end (build via the UI or `npm run oxy`), verified on **both**
engines: a real in-process **node-llama-cpp** build (auto-downloaded GGUF, no
Ollama, no compiler) and an **Ollama** build. See [PLAN.md](PLAN.md) for the
roadmap and [DESIGN.md](DESIGN.md) for where we're headed — generating **backends**
with small-context models (spec-first, per-file), **mobile** (iOS/Android) targets,
and the curated-vs-generic **MCP** decision.
