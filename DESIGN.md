# Oxy — design notes (where we're headed)

Working notes on the harder questions beyond v0.1. The north star: **fully
functional apps built by a model running entirely on your machine.** The hard
constraint that shapes everything: **local models have small context windows**
(often 4–16k usable tokens), so we cannot hold a whole app in context.

## 1. Generating backends with a small-context model

A static page fits in one turn. A real backend (routes, data model, multiple
files) does not. The plan, reusing machinery Oxy already has:

- **Spec-first.** Before any code, the model produces a small **manifest**: the
  data model, the route list, and the file list with a one-line purpose each.
  This manifest is the durable artifact — it's exactly the kind of structured
  state the **auto-compact checkpoint** (`.codelab-state.json`) already persists,
  so it survives compaction and crashes. The whole app is never in context; the
  manifest is.
- **One file at a time.** Generate each file in its own turn, with only what it
  needs in context: its manifest entry + the **signatures** (exports, route
  shapes, table columns) of the files it imports — not their full source. A
  `get_signatures(path)` tool returns just the public surface. This keeps every
  turn small regardless of total app size; auto-compact resets between files.
- **Single-file-friendly runtime.** Choose a stack where a unit of work fits a
  small context: e.g. **Hono + SQLite** (one route file + one schema file),
  generated and verifiable in isolation. Avoid frameworks that need wide
  cross-file context to be correct.
- **Verify per unit, not globally.** Extend the `review_design` idea to backends:
  a per-file/per-route check (typecheck, a smoke request) so errors surface while
  that file is still the thing in context — feeding the existing thinking-burst.
- **Jail unchanged.** The backend runs in the same jailed workspace; the existing
  SSRF guard / extension allow-list / path jail extend to server files. Running
  generated server code is the one genuinely new risk surface — sandbox it (a
  child process with no network + a tmp FS), never the host.

Net: the orchestration layer (compaction, per-turn minimal context, burst) is
already the mechanism; backends need a **spec/manifest + signature-retrieval +
per-file verify** loop on top, not a bigger model.

## 2. Iterating on a project (shipped in v0.1)

Builds are no longer one-shot. Pick a project (UI dropdown, or `OXY_PROJECT=` for
the headless driver) and describe a change; the loop seeds the model with the
**current file list** (not contents) and frames the task as a modification —
read before editing, prefer `edit_file`, keep what works. This is the same
seeding pattern as the compaction resume, and it's the foundation backends build
on (generate manifest → iterate file by file).

## 3. MCP tools — curated now, generic later (recommendation)

Should arbitrary MCP servers be exposed to the model? **Not yet.**

- **Why curated:** small models degrade as the tool list grows — selection
  accuracy drops sharply past a handful of tools, so a big generic MCP surface
  makes builds *worse*, not better. Arbitrary tools are also a jailbreak / SSRF /
  exfiltration surface pointed straight at the jail.
- **What to do:** keep a small, curated tool set (the current file/web/image/Stitch
  tools). Treat valuable integrations as first-class curated tools (Stitch is the
  template). Add specific MCP servers **behind an explicit "advanced" opt-in** in
  Settings, one at a time, each reviewed — never an open "connect any MCP" door
  for the model by default.
- **Settings (shipped):** users bring their own keys (e.g. the Stitch API key) via
  the Settings panel, written to a git-ignored file and never returned to the
  client. The same panel is where opt-in integrations would live.
