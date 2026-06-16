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

## Install (one command)

```sh
npm install      # ships prebuilt llama.cpp binaries (CPU + Vulkan/Metal/CUDA, auto-detected)
npm run dev      # on first run, Oxy auto-downloads a small default model — then just build
```

No Ollama, no separate inference server, no compiler. A GPU is used automatically
if you have one; otherwise it runs on CPU.

## Engine

Inference runs **in-process** via [`node-llama-cpp`](https://node-llama-cpp.withcat.ai)
(bundled). You can plug in any GGUF model from HuggingFace. An **Ollama adapter** is
available for people who already run Ollama. Both sit behind one `Engine` interface
(`engine/engine.ts`) — see that file for the architecture.

## Status

v0.1 — scaffold. See [PLAN.md](PLAN.md) for the build-out roadmap.
