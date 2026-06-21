# Oxy

**Build good-looking web apps with a tiny local model — free, private, on the hardware you already have.**

Describe the app you want; a model running **entirely on your machine** builds it —
writing the files, styling them with a real design system, previewing the result,
and checking its own work. No cloud account, no API key, nothing to configure.

The headline: it works beautifully with **gemma4 E2B**, a *tiny* (~2B-class) model.
You do **not** need a big GPU, 32 GB of RAM, or a paid API. On a plain laptop with
**integrated graphics** (an Intel Iris Xe iGPU), Oxy runs the default model in about
**5 GB of RAM at ~11 tokens/sec** and turns out a clean little web app in **a minute
or two** — entirely offline, for free. A bigger model makes bigger apps; the point is
you don't *need* one to get a genuinely nice result.

> Oxy is the productized descendant of the **Reasoning Lab** research bench, where
> the orchestration techniques below were discovered and measured. The bench keeps
> experimenting; proven findings get ported here.

## The goal

Big models don't fit on a laptop like this — a 7B crawls and a 12B barely runs (see
[Performance](#performance-verified)). So Oxy's mission is the opposite of "just use a
bigger model": make the **smallest capable model** — **gemma4 E2B** (or **E4B** for
harder work) — a genuine **expert at building web apps**, by wrapping it in
orchestration and a skill that keeps improving from real use.

**Web is the focus today.** The same machinery is meant to extend later to other
targets (**Android / iOS**), each with its **own skill file** and a web/android/ios
selector in the UI — though native mobile on a ~2B model is an open question, not a
promise. See [Roadmap](#roadmap).

## What you can do

- **Build from a prompt.** Type "a tip calculator", "a pomodoro timer", "a tic-tac-toe
  game" → a working, styled, single-page app you can preview and export.
- **Pick a design — or let the model choose.** A **design picker** offers **12 design
  systems**: *modern-saas, warm-artisan, playful, minimal-mono, dark-dashboard,
  brutalist, glass, editorial, terminal, organic, corporate, vibrant*. Same prompt,
  very different looks.
- **Self-learning, gated.** With **auto-learn** on, Oxy reviews every build in the
  background and — once enough lessons accumulate — automatically promotes an
  improvement to its own skill, **but only if the change beats a held-out benchmark**.
  It gets better the more you use it, and can never silently get worse. Toggle it (and
  whether builds even use the learned skill) in Settings.
- **Use any model — download it in-app.** Settings has a model picker plus a
  **Hugging Face browser**: search/curated GGUF list (cached, with a Refresh button),
  a **Download now** button with live progress, or paste any `hf:repo:quant` ref and
  Oxy validates it before adding. Models too big for your RAM are filtered out.
- **Ask mode.** A one-shot **multimodal Q&A** (no build): paste a screenshot, ask a
  question, get an answer streamed back.
- **Paste images into the prompt.** Multimodal builds — gemma4 actually *sees* the
  image you attach (a mockup, a logo, a screenshot to match).
- **The model checks its own work.** It can **screenshot the live preview** and
  **interact with the page** (click buttons, type into fields), read the console for
  errors, and fix what's broken — not just write code blind.
- **Iterate, don't restart.** Pick an existing project from the switcher and describe
  a change; the model reads the current files and edits in place.
- **Export.** One-click **Export .zip** of the generated project.

## Install & run

```sh
npm install
npm run dev      # open the UI; describe an app and press Build
```

On first use Oxy picks the engine that will actually use your GPU and (for the
managed engine) downloads a prebuilt `llama-server` binary — no compiler — plus the
default **gemma4 E2B** model, then runs it for you. CUDA / Vulkan / Metal are
auto-detected, else it falls back to CPU. The picker shows the **active backend**
(`VULKAN` / `CUDA` / `CPU`) so you're never unknowingly on CPU. Nothing to install
manually.

Prefer the terminal? Build headlessly:

```sh
npm run oxy      # default: managed llama-server + gemma4 E2B
# OXY_ENGINE=ollama OXY_MODEL=gemma4:e4b OXY_TASK="build a ..." npm run oxy
```

## The interface

![Oxy](design/screenshot.png)

A clean, calm **light** interface — designed in **Google Stitch**
(`design/stitch-ui.html`, regenerate with `node design/gen-stitch.mjs`) over a
subtle drifting pastel aurora. The **main page** is the build surface: a prompt box,
the design picker, a live build timeline that surfaces the orchestration
(per-step + overall timers, live token counter, context-pressure meter,
`thinking` / `compacted` cues), a sandboxed preview, and Export.

A dedicated **Settings** page holds everything else: engine + model picker, the
Hugging Face download browser, the improvement-feature toggles (below), per-tool
switches, and your Stitch key. **Bring your own keys** — the Stitch key is saved to a
git-ignored file, never committed and never sent back to the browser.

## Why a tiny model works here

The model isn't the product — the **orchestration layer** is. Small local models are
weak on their own, so Oxy wraps them in techniques that make them punch far above
their weight. All of these are **toggleable in Settings** (flip one off to A/B it):

- **Auto-learn (gated promote)** — review every build, and after enough lessons
  accumulate, propose a skill edit, **benchmark it against the current skill, and
  deploy only on a strict win** (margin + no per-task regression). Self-improving,
  never degrading.
- **Use the learned skill** — build with the tuned `skill/system.md`, or flip it off
  to compare against the built-in baseline prompt.
- **Auto-compact** — when the context fills, Oxy checkpoints the build state to disk
  and continues from a fresh, small context. Lets a small model build things bigger
  than its context window, and makes builds resumable after a crash/sleep.
- **Thinking-burst / recovery bursts** — the model reasons hard for exactly one step
  after a design critique or an error, then goes quiet again (the trace never bloats
  context).
- **Idle timeout** — abort a generation only after 120 s of *silence*, not on a fixed
  total cap, so a slow-but-working build finishes instead of reboot-looping.
- **Downscale attached images** — shrink big screenshots before sending, for far
  faster vision prefill on an iGPU.
- **Model-aware server reuse** — restart llama-server when you pick a different model
  instead of silently serving the old one.

Plus: a **jailed workspace** (the model can only touch its own project folder), a
**sandboxed preview**, real **SVG icons**, optional local **Stable Diffusion** images
and **Google Stitch** design.

## Performance (verified)

On a 16 GB laptop with an **Intel Iris Xe iGPU** (integrated graphics, Vulkan), no
discrete GPU:

| model            | quant            | RAM     | speed         |
| ---------------- | ---------------- | ------- | ------------- |
| **gemma4 E2B**   | Q4_K_M + q8_0 KV | ~4.6 GB | ~11.5 tok/s   |
| gemma4 E4B       | Q4_K_M           | ~7 GB   | ~6.3 tok/s    |

A "hello world" page builds in ~70 s; small interactive apps in a couple of minutes.
The big wins came from forcing a single full-context slot (`-np 1`), quantizing the
KV cache (`-ctk/-ctv q8_0`) to stay out of swap, skipping gemma4's default
thinking, and downscaling vision input — see `skillopt/` and the engine notes.

## Engines

Inference runs through one `Engine` interface (`engine/engine.ts`) so the agent loop
is backend-agnostic:

- **`engine/llama-server.ts`** — **the default.** On first use Oxy downloads a
  *prebuilt* `llama-server` from llama.cpp's releases (no compiler) and fetches the
  GGUF itself (`-hf`, default **gemma4 E2B**), runs it in the background, and drives
  it via the OpenAI-compatible adapter. **Auto-detects your GPU** (NVIDIA→CUDA, else
  Vulkan, else CPU; macOS→Metal), falling back to CPU if the GPU backend fails.
  Override with `OXY_LLAMA_VARIANT`. Tracks the latest llama.cpp release to run new
  models.
- **`engine/ollama.ts`** — for people who already run Ollama (instant, reuses your
  pulled models, e.g. `gemma4:e4b`); used automatically when Ollama is detected.
- **`engine/openai-compat.ts`** — the shared transport under llama-server/Ollama; also
  works standalone against **any OpenAI-compatible server** (LM Studio, Jan, vLLM, a
  remote endpoint) — point it at a base URL in the model picker.

Oxy prefers Ollama only when it would offload to your GPU (CUDA/Metal); on a
Vulkan-only machine (e.g. an Intel iGPU) Ollama runs on CPU, so Oxy prefers the
**managed llama-server** (Vulkan) — and the UI shows which backend is active. With no
Ollama it uses llama-server so a fresh clone gets gemma4 with nothing to install. The
routing is `engine/gpu.ts`; tool calls that small models emit as text are recovered
by a known-tool-gated parser (`engine/tool-parse.ts`).

## Architecture

```
agent/      engine-agnostic loop: tools, auto-compact, thinking-burst, token accounting
engine/     Engine interface + llama-server (managed), ollama, openai-compat adapters
server/     jailed backend (file tools, preview, SSRF-guarded web, SD, Stitch,
            self-check, auto-learn) — mounted in Vite (codeLabPlugin) or run via serve.mjs
driver/     headless build driver (run-build.ts)
src/        the React UI (main build page + Settings), designed in Stitch
design/     the Stitch-generated design reference
skill/      system.md — the agent "skill" (optimizable prompt) builds read
skillopt/   self-optimizing-skill loop: supervisor (watch) + promote (gated deploy)
```

## Self-optimizing skill (SkillOpt)

The agent's `SYSTEM` prompt lives in `skill/system.md` — a small, inspectable "skill"
that every build reads. Oxy improves it two ways, **watch-always, deploy-gated**:

- **Watch (always on by default).** A supervisor reviews each finished build in the
  background and journals what went well / wrong to `skillopt/journal.jsonl`. Never
  blocks or affects your build.
- **Promote (gated).** Turn the journaled lessons into one focused skill edit, then
  **accept it only if it beats the current skill on a held-out benchmark** (median-of-K
  validation, a margin, and no per-task regression). The model weights never change;
  only the text does — and it can never get silently worse.

So the full loop is: **you build → a supervisor journals one lesson per build →** once
**`OXY_PROMOTE_EVERY`** (default 10) fresh lessons pile up, **a gated promote runs in
the background:** it benchmarks the current skill, asks a strong optimizer for one
journal-informed edit, benchmarks that candidate, and **deploys it only on a strict
win.** The **Auto-learn panel** in the UI makes this visible — it shows when a promote
is running, its progress + timer, the current-vs-candidate scores, the pass/fail
outcome, and the lessons mined from your builds, so the self-improvement isn't a black
box. The promote runs in the background, never during a build, on a separate model
port so it won't disturb a build you're running.

> **Skills are tuned for gemma4 E2B.** The benchmark gate runs every candidate on the
> **default model (gemma4 E2B)** — so a deployed skill is one *measured* to help **that**
> model. In principle a better prompt helps any model, but Oxy can't run the benchmark
> on every model you might pick, so on **other models a learned skill is unverified**: it
> may help, or occasionally hurt. Flip **Use the learned skill** off in Settings to fall
> back to the neutral built-in prompt on a model you haven't validated. (Note too: a ~2B
> model degrades with a longer prompt, so the skill is deliberately kept *lean* — more
> rules dilute its attention.)

Or run the promote by hand:

```sh
# optimize on a fast model, deploy the skill (it transfers to the local default)
OXY_ENGINE=ollama OXY_OPT_MODEL=gpt-oss:120b-cloud npm run skillopt
npm run skillopt:promote     # gated deploy from the journaled real-build lessons
```

A full offline optimize run is slow (it's "training" — many builds), so optimize on a
fast model and let the tuned skill transfer to the local model. The loop logic and
scorer are unit-tested. Disable the whole thing with the Settings toggle or
`OXY_AUTO_PROMOTE=0` / `OXY_SUPERVISOR=0`.

## Develop

```sh
npm test         # agent-loop + adapter unit tests (Node's built-in runner, no extra deps)
npm run typecheck
npm run build    # type-check + production bundle
```

## Roadmap

Oxy is still early; the throughline is **deepening the small model's web expertise**
before widening scope.

- **RAG for real backends (next).** Retrieval-augmented generation so the model can
  write **Supabase** edge functions, SQL schemas, and DB queries correctly — pulling the
  exact API/usage it needs into context instead of guessing. This fits Oxy's model
  perfectly: the frontend stays static and calls the cloud backend, so there's still no
  local build step. Because a ~2B model degrades with a longer prompt, retrieval must be
  **surgical** — inject only the few snippets that matter, never dump docs.
- **More frontend libraries — selectively.** **Web Components** are a cheap, native fit
  (no build step) and a good RAG target. **React / Next are deferred:** they need a
  bundler/SSR runtime Oxy doesn't have, so there the bottleneck is the *runtime*, not the
  model's knowledge — RAG alone wouldn't unlock them. (If ever: client-only Vite + React
  long before Next.)
- **Other platforms (later, aspirational).** Android (Kotlin Compose) / iOS (Swift)
  would each get their **own skill file** and benchmark, picked via a web/android/ios
  selector in the UI. Native mobile on a tiny local model is an open question — kept in
  mind, not promised. Web stays the focus.

See [PLAN.md](PLAN.md) and [DESIGN.md](DESIGN.md) for deeper notes.

## Status

v0.1 — working end to end (build via the UI or `npm run oxy`), verified with real
**gemma4 E2B** builds through the managed **llama-server** (GPU auto-detected, no
Ollama, no compiler) and via **Ollama**. Where it's headed next is the
[Roadmap](#roadmap) above.

## Safety & license

Oxy is **MIT-licensed** ([LICENSE](LICENSE)) — free to use, modify, and distribute.
It is provided **"AS IS", with no warranty and no liability**: a local model writes
files, fetches the web, and (if you enable powerful tools) can run commands. **You
are solely responsible for what you run and for any consequences.** Treat the model's
output as untrusted and run Oxy in an isolated environment (a VM, container, or other
sandbox) — especially before enabling any command/terminal tool, which should only be
used inside a disposable VM or a gated environment (e.g. Kubernetes). Powerful tools
are **off by default** and toggled per-tool in Settings.
