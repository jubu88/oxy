// Phase 1 verification: drives the engine-agnostic loop with a scriptable
// FakeEngine + FakeExecutor (no real model, no backend, no install). Run with:
//   node --test agent/loop.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { runAgent } from "./loop.ts";
import { buildSystem, buildTools, TOOLS } from "./tools.ts";
import * as agentSurface from "./index.ts";
import type { AgentConfig, AgentStep, ToolContext, ToolExecutor } from "./types.ts";
import type { ChatMessage, Engine, EngineModelInfo, GenerateOptions, GenerateResult, ToolCall, ToolDef } from "../engine/engine.ts";

// --- scriptable fakes -------------------------------------------------------

/** Returns the next scripted turn per generate() call; records what it saw. */
class FakeEngine implements Engine {
  readonly id = "fake";
  callIndex = 0;
  seenMessages: ChatMessage[][] = [];
  seenThink: boolean[] = [];
  private turns: Array<Partial<GenerateResult>>;

  constructor(turns: Array<Partial<GenerateResult>>) {
    this.turns = turns;
  }

  async ensureReady(): Promise<void> {}
  async listModels(): Promise<EngineModelInfo[]> {
    return [];
  }
  async useModel(): Promise<void> {}

  async generate(messages: ChatMessage[], _tools: ToolDef[], opts: GenerateOptions): Promise<GenerateResult> {
    this.seenMessages.push(structuredClone(messages)); // snapshot — messages is mutated in place
    this.seenThink.push(!!opts.think);
    const turn = this.turns[Math.min(this.callIndex, this.turns.length - 1)];
    this.callIndex++;
    const res: GenerateResult = {
      content: turn.content ?? "",
      thinking: turn.thinking,
      toolCalls: turn.toolCalls ?? [],
      promptTokens: turn.promptTokens,
      evalTokens: turn.evalTokens,
      truncated: turn.truncated,
    };
    if (opts.onToken && res.content) opts.onToken(res.content);
    // mirror the real adapters: tick the progress meter for any generated tokens
    // (content OR tool-call args), which is what drives the live counter now.
    if (opts.onProgressTick && (res.content || res.toolCalls.length)) opts.onProgressTick();
    return res;
  }
}

/** Records tool calls; canned results, optionally overridden per call. */
class FakeExecutor implements ToolExecutor {
  calls: Array<{ name: string; args: any }> = [];
  private responder?: (name: string, args: any) => string | undefined;

  constructor(responder?: (name: string, args: any) => string | undefined) {
    this.responder = responder;
  }

  async call(name: string, args: any, _ctx: ToolContext): Promise<string> {
    this.calls.push({ name, args });
    if (this.responder) {
      const r = this.responder(name, args);
      if (r !== undefined) return r;
    }
    switch (name) {
      case "get_design_system":
        return `Style: ${args.style}\n:root{--primary:#000}`;
      case "write_file":
        return `wrote ${args.path} (${String(args.content ?? "").length} bytes)`;
      case "edit_file":
        return `edited ${args.path} (now 100 bytes)`;
      case "read_file":
        return "<html></html>";
      case "list_files":
        return JSON.stringify([{ path: "index.html", bytes: 1234 }]);
      case "review_design":
        return "DESIGN CRITIQUE:\n1. spacing too tight";
      case "done":
        return "done";
      default:
        return "ok";
    }
  }
}

function tc(name: string, args: any = {}): ToolCall {
  return { name, arguments: args };
}

function baseConfig(over: Partial<AgentConfig> = {}): AgentConfig {
  return { task: "build a todo app", project: "todo-2606", maxIterations: 10, temperature: 0.6, ...over };
}

// --- tests ------------------------------------------------------------------

test("public surface re-exports runAgent", () => {
  assert.equal(typeof agentSurface.runAgent, "function");
  assert.equal(typeof agentSurface.HttpToolExecutor, "function");
});

test("stitch tool + rule are gated behind useStitch", () => {
  assert.equal(TOOLS.length, 14);
  assert.ok(!buildTools({ useStitch: false }).some((t) => t.name === "design_with_stitch"));
  assert.ok(buildTools({ useStitch: true }).some((t) => t.name === "design_with_stitch"));
  assert.ok(!buildSystem(false).includes("design_with_stitch"));
  assert.ok(buildSystem(true).includes("design_with_stitch"));
});

test("runs tools in order and stops on done", async () => {
  const engine = new FakeEngine([
    { toolCalls: [tc("get_design_system", { style: "modern-saas" })] },
    { toolCalls: [tc("write_file", { path: "index.html", content: "<html></html>" })] },
    { toolCalls: [tc("review_design")] },
    { toolCalls: [tc("edit_file", { path: "index.html", old_string: "a", new_string: "b" })] },
    { toolCalls: [tc("done", { summary: "a todo app" })] },
  ]);
  const executor = new FakeExecutor();
  const steps: AgentStep[] = [];
  await runAgent(baseConfig(), { engine, executor, onStep: (s) => steps.push(s) });

  assert.deepEqual(
    executor.calls.map((c) => c.name),
    ["get_design_system", "write_file", "review_design", "edit_file", "done"],
  );
  assert.equal(steps.length, 5);
  assert.equal(steps.at(-1)!.done, true);
  assert.equal(engine.callIndex, 5); // stopped right after done — no 6th turn
});

test("recovers a coder model's ```html code block as a write_file (adapter)", async () => {
  const engine = new FakeEngine([
    { content: "Here is the page:\n```html\n<!DOCTYPE html><html><body><h1>Bank</h1></body></html>\n```" }, // code, no tool call
    { toolCalls: [tc("done", { summary: "ok" })] },
  ]);
  const executor = new FakeExecutor();
  await runAgent(baseConfig(), { engine, executor, onStep: () => {} });
  const write = executor.calls.find((c) => c.name === "write_file");
  assert.ok(write, "the ```html block should have been recovered as a write_file");
  assert.equal(write!.args.path, "index.html");
  assert.match(write!.args.content, /<!DOCTYPE html>/);
});

test("stops early after 3 dead turns with no tool call (weak model can't drive the loop)", async () => {
  const engine = new FakeEngine([{ content: "I will plan my approach carefully." }]); // never a tool call, no code
  const notices: string[] = [];
  await runAgent(baseConfig({ maxIterations: 20 }), { engine, executor: new FakeExecutor(), onStep: () => {}, onNotice: (m) => notices.push(m) });
  assert.equal(engine.callIndex, 3, "should give up at 3 dead turns, not run all 20");
  assert.ok(notices.some((n) => /no tool calls/i.test(n)), "should surface why it stopped");
});

test("respects maxIterations when the model never calls done", async () => {
  const engine = new FakeEngine([{ toolCalls: [tc("write_file", { path: "index.html", content: "x" })] }]);
  const steps: AgentStep[] = [];
  await runAgent(baseConfig({ maxIterations: 3 }), { engine, executor: new FakeExecutor(), onStep: (s) => steps.push(s) });
  assert.equal(steps.length, 3);
  assert.equal(engine.callIndex, 3);
  assert.ok(steps.every((s) => s.done === false));
});

test("thinking trace is emitted for display but never persisted into history", async () => {
  const engine = new FakeEngine([
    { content: "let me think", thinking: "SECRET_REASONING_TOKENS", toolCalls: [tc("write_file", { path: "index.html", content: "x" })] },
    { toolCalls: [tc("done", { summary: "x" })] },
  ]);
  const steps: AgentStep[] = [];
  await runAgent(baseConfig(), { engine, executor: new FakeExecutor(), onStep: (s) => steps.push(s) });

  assert.equal(steps[0].thinking, "SECRET_REASONING_TOKENS"); // reaches the UI
  const turn2Blob = JSON.stringify(engine.seenMessages[1]); // history the 2nd turn saw
  assert.ok(!turn2Blob.includes("SECRET_REASONING_TOKENS"), "reasoning must not leak into prefill");
  assert.ok(turn2Blob.includes("let me think"), "assistant content IS persisted");
});

test("a design critique arms a one-shot thinking burst on the next turn only", async () => {
  const engine = new FakeEngine([
    { toolCalls: [tc("write_file", { path: "index.html", content: "x" })] }, // turn0: no burst
    { toolCalls: [tc("review_design")] }, // turn1: returns CRITIQUE -> arm next
    { toolCalls: [tc("edit_file", { path: "index.html", old_string: "a", new_string: "b" })] }, // turn2: burst ON, no new trigger
    { toolCalls: [tc("done", { summary: "x" })] }, // turn3: burst OFF again
  ]);
  await runAgent(baseConfig(), { engine, executor: new FakeExecutor(), onStep: () => {} });
  assert.deepEqual(engine.seenThink, [false, false, true, false]);
});

test("a tool error arms a burst on the next turn", async () => {
  const engine = new FakeEngine([
    { toolCalls: [tc("write_file", { path: "index.html", content: "x" })] },
    { toolCalls: [tc("done", { summary: "x" })] },
  ]);
  const executor = new FakeExecutor((name) => (name === "write_file" ? "error: too many files" : undefined));
  await runAgent(baseConfig(), { engine, executor, onStep: () => {} });
  assert.deepEqual(engine.seenThink, [false, true]);
});

test("a truncated generation arms a burst on the next turn", async () => {
  const engine = new FakeEngine([
    { toolCalls: [tc("write_file", { path: "index.html", content: "x" })], truncated: true },
    { toolCalls: [tc("done", { summary: "x" })] },
  ]);
  await runAgent(baseConfig(), { engine, executor: new FakeExecutor(), onStep: () => {} });
  assert.deepEqual(engine.seenThink, [false, true]);
});

test("seeded console errors arm a burst on the very first turn", async () => {
  const engine = new FakeEngine([{ toolCalls: [tc("done", { summary: "x" })] }]);
  await runAgent(baseConfig({ consoleErrors: ["ReferenceError: foo is not defined"] }), {
    engine,
    executor: new FakeExecutor(),
    onStep: () => {},
  });
  assert.equal(engine.seenThink[0], true);
});

test("auto-compacts when context pressure crosses the trigger, reseeding from a checkpoint", async () => {
  const engine = new FakeEngine([
    { toolCalls: [tc("write_file", { path: "index.html", content: "x" })], promptTokens: 3000, evalTokens: 100 }, // turn0: low pressure
    { toolCalls: [tc("edit_file", { path: "index.html", old_string: "a", new_string: "b" })], promptTokens: 12000, evalTokens: 200 }, // turn1: high -> compact
    { toolCalls: [tc("done", { summary: "x" })], promptTokens: 1000 }, // turn2: runs on the reseeded history
  ]);
  const executor = new FakeExecutor();
  const steps: AgentStep[] = [];
  await runAgent(baseConfig(), { engine, executor, onStep: (s) => steps.push(s) });

  assert.equal(steps[0].compacted, false);
  assert.equal(steps[1].compacted, true);
  // checkpoint persisted + file list re-fetched through the executor
  assert.ok(executor.calls.some((c) => c.name === "write_file" && c.args.path === ".codelab-state.json"));
  assert.ok(executor.calls.some((c) => c.name === "list_files"));
  // turn2 saw a freshly reseeded history: exactly [system, resume-user]
  const turn2 = engine.seenMessages[2];
  assert.equal(turn2.length, 2);
  assert.equal(turn2[0].role, "system");
  assert.equal(turn2[1].role, "user");
  assert.ok(turn2[1].content.includes("CONTINUING an in-progress build"));
  assert.ok(turn2[1].content.includes("index.html"), "the seeded file list should mention index.html");
});

test("does not compact at iteration 0 even under high pressure (cooldown)", async () => {
  const engine = new FakeEngine([
    { toolCalls: [tc("write_file", { path: "index.html", content: "x" })], promptTokens: 99000 }, // turn0: huge but i-lastCompactIter=1 < 2
    { toolCalls: [tc("done", { summary: "x" })] },
  ]);
  const steps: AgentStep[] = [];
  await runAgent(baseConfig(), { engine, executor: new FakeExecutor(), onStep: (s) => steps.push(s) });
  assert.equal(steps[0].compacted, false);
});

test("nudges once when a turn produces no tool calls", async () => {
  const engine = new FakeEngine([
    { content: "I will now describe my plan in prose." }, // turn0: no tool calls
    { toolCalls: [tc("done", { summary: "x" })] },
  ]);
  await runAgent(baseConfig(), { engine, executor: new FakeExecutor(), onStep: () => {} });
  const turn1 = engine.seenMessages[1];
  // a no-tool-call turn gets nudged toward calling a tool (wording varies by whether it rambled)
  assert.ok(turn1.some((m) => m.role === "user" && /tool/i.test(m.content)));
});

test("rambling without a tool call triggers a forceful nudge + a burst next turn", async () => {
  const engine = new FakeEngine([
    { content: "Sure! Here is the full HTML for your page: <!doctype html><html><head>… (long prose, no tool call)" },
    { toolCalls: [tc("write_file", { path: "index.html", content: "x" })] },
    { toolCalls: [tc("done", { summary: "x" })] },
  ]);
  await runAgent(baseConfig(), { engine, executor: new FakeExecutor(), onStep: () => {} });
  const turn1 = engine.seenMessages[1];
  assert.ok(turn1.some((m) => m.role === "user" && /CALL the write_file tool/i.test(m.content)));
  assert.equal(engine.seenThink[1], true); // a reasoning burst is armed after rambling
});

test("systemOverride (the deployed/optimized skill) is used as the system prompt", async () => {
  const engine = new FakeEngine([{ toolCalls: [tc("done", { summary: "x" })] }]);
  await runAgent(baseConfig({ systemOverride: "OPTIMIZED SKILL TEXT" }), { engine, executor: new FakeExecutor(), onStep: () => {} });
  assert.equal(engine.seenMessages[0][0].role, "system");
  assert.equal(engine.seenMessages[0][0].content, "OPTIMIZED SKILL TEXT");
});

test("stops immediately when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const engine = new FakeEngine([{ toolCalls: [tc("write_file", { path: "index.html", content: "x" })] }]);
  const steps: AgentStep[] = [];
  await runAgent(baseConfig(), { engine, executor: new FakeExecutor(), onStep: (s) => steps.push(s), signal: controller.signal });
  assert.equal(engine.callIndex, 0);
  assert.equal(steps.length, 0);
});

test("streams live progress via onProgress", async () => {
  const engine = new FakeEngine([
    { content: "building...", toolCalls: [tc("write_file", { path: "index.html", content: "x" })] },
    { toolCalls: [tc("done", { summary: "x" })] },
  ]);
  const progress: string[] = [];
  await runAgent(baseConfig(), { engine, executor: new FakeExecutor(), onStep: () => {}, onProgress: (p) => progress.push(p.text) });
  assert.ok(progress.includes("building..."));
});
