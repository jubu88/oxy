# Oxy — build-out roadmap

Extracted from the Reasoning Lab research bench (`reasoning-lab/code-lab`). This
scaffold defines the architecture (`engine/engine.ts`) and the north star
(**simple, beautiful, just works, one-command install**). The build-out below is
best done in a dedicated Claude Code session rooted in this folder.

## Source to port (from reasoning-lab)
> Paths: the agent + UI live at the **reasoning-lab root** (`src/lib/codeagent.ts`,
> `src/components/CodeLabView.tsx`, `src/api/ollama.ts`); only the backend +
> headless driver are under `code-lab/` (`server.mjs`, `run-build.mjs`).
- `server.mjs` — the jailed backend (per-project workspace, safePath/checkExt,
  write/edit/read/list, zip export, SSRF-guarded web fetch/search, SD image gen,
  Playwright screenshot + vision critique, Stitch MCP client, **the `.codelab`
  checkpoint filter**). Keep as the backend; drop nothing security-related.
- `src/lib/codeagent.ts` — the agent loop: tools, `callTool`, design systems,
  **auto-compact + thinking-burst** (already built + validated), Stitch tool.
  Refactor so the loop calls `Engine.generate()` instead of Ollama directly.
- `src/components/CodeLabView.tsx` — reference for the build UI (we will redesign).
- `code-lab/run-build.mjs` — headless driver, useful for end-to-end testing.

## Phases
1. **Engine-agnostic agent core.** ✅ DONE — see `agent/` (`loop.ts`,
   `tools.ts`, `executor.ts`, `compaction.ts`, `types.ts`). Depends only on
   `Engine`; the inline Ollama fetch collapsed into one `engine.generate()` call.
   Compaction, burst, token accounting live in `loop.ts`; tool execution is
   pluggable behind `ToolExecutor` (default `HttpToolExecutor` → `/codelab`).
   Verified by `agent/loop.test.ts` against a FakeEngine — run `npm test` (uses
   Node 24's built-in TS type-stripping; no install needed).
2. **Local engine.** ✅ DONE — **managed llama-server** (`engine/llama-server.ts`):
   auto-downloads a prebuilt `llama-server` (no compiler) + the GGUF via `-hf`
   (default gemma4), auto-detects GPU (CUDA/Vulkan/CPU), drives it through
   `openai-compat`. Replaced the original in-process node-llama-cpp adapter, which
   was **dropped** — its bundled llama.cpp couldn't load gemma4, and it added ~750MB
   to `node_modules` for no unique benefit once llama-server existed.
3. **Adapters.** ✅ DONE — `engine/ollama.ts` (streaming `/api/chat`, native
   `tool_calls`; live-tested vs gemma4:e4b) and `engine/openai-compat.ts` (any
   OpenAI `/v1` server; the shared transport llama-server runs on). Text-emitted
   tool calls recovered by `engine/tool-parse.ts`.
4. **UI — design in Stitch, then wire React.** ✅ DONE — design generated in Stitch
   (`design/stitch-ui.html`), rebuilt in React (`src/`): prompt box, engine/model
   picker, context-pressure + compaction/burst cues, sandboxed preview, export.
   Builds run server-side via `/oxy/api/build` (NDJSON stream).
5. **Model manager (light).** ✅ DONE — default auto-downloads (managed llama-server
   via `-hf`); UI picker switches engine and takes any GGUF by HuggingFace ref /
   any Ollama model / any OpenAI-compatible base URL.
6. **Packaging.** ✅ `npm install` + `npm run dev` (UI) / `npm run oxy` (headless).
   Later: a Tauri desktop build for a true double-click app.

## Findings to port from the bench (the orchestration layer)
- [x] auto-compact (context checkpoint + fresh reseed)
- [x] thinking-burst (one-shot, ephemeral trace)
- [ ] agreement / best-of-N (judge with the vision critic)
- [ ] fresh-restart escalation on a stuck/looping build
- [ ] logprob-confidence routing (needs an engine that exposes logprobs)

## Known limitation to fix early
- `edit_file` `old_string` accuracy is poor on large hand-written files (the model
  can't reproduce exact snippets even after `read_file`). Fix with whitespace-
  tolerant / line-anchored matching, or anchor edits to unique IDs the model adds.
