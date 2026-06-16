# Oxy — build-out roadmap

Extracted from the Reasoning Lab research bench (`reasoning-lab/code-lab`). This
scaffold defines the architecture (`engine/engine.ts`) and the north star
(**simple, beautiful, just works, one-command install**). The build-out below is
best done in a dedicated Claude Code session rooted in this folder.

## Source to port (from reasoning-lab/code-lab)
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
1. **Engine-agnostic agent core.** Lift the loop out of `codeagent.ts` into
   `agent/` so it depends only on `Engine` (engine/engine.ts). Compaction, burst,
   token accounting, tool execution all live here. Keep history in `ChatMessage[]`.
2. **node-llama-cpp adapter** (`engine/node-llama.ts`). Use the LOW-LEVEL
   `LlamaChat.generateResponse` (NOT `LlamaChatSession.prompt`, which auto-runs
   tools and would hide the orchestration seam). Map our `ChatMessage[]`/`ToolDef[]`
   in, surface `functionCalls` out without executing, return prompt/eval token
   counts (for the compaction meter) and the reasoning trace when `think`.
   `ensureReady()` downloads a small default coder GGUF from HuggingFace on first run.
3. **Ollama adapter** (`engine/ollama.ts`). Port the existing streaming `/api/chat`
   integration as an optional adapter behind the same interface.
4. **UI — design in Stitch, then wire React.** ONE clean flow: a prompt box, a
   subtle model/engine indicator, live build progress (with the context-pressure +
   compaction/burst cues), a preview, and export. Minimal. Beautiful. No clutter.
5. **Model manager (light).** Default model auto-downloads; a small picker to plug
   in any GGUF by HuggingFace ref. Don't over-build — "just works" first.
6. **Packaging.** One-command install today (`npm install`); later, a Tauri desktop
   build for a true double-click app.

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
