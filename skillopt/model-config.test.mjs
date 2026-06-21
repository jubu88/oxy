// Tests for per-model config: the model key (skill file + journal tag) and step budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelKey, maxStepsFor } from "./model-config.mjs";

test("modelKey: hf refs drop org + quant, keep the size variant", () => {
  assert.equal(modelKey("hf:unsloth/gemma-4-E2B-it-GGUF:Q4_K_M"), "gemma-4-e2b");
  assert.equal(modelKey("hf:ggml-org/gemma-4-E4B-it-GGUF:Q4_K_M"), "gemma-4-e4b");
  // same model, different quant => same key (quant doesn't change the skill)
  assert.equal(modelKey("hf:unsloth/gemma-4-E2B-it-GGUF:Q8_0"), "gemma-4-e2b");
  // e2b and e4b must be DISTINCT (the whole point of per-model skills)
  assert.notEqual(modelKey("hf:unsloth/gemma-4-E2B-it-GGUF:Q4_K_M"), modelKey("hf:ggml-org/gemma-4-E4B-it-GGUF:Q4_K_M"));
});

test("modelKey: ollama name:tag keeps the tag (the variant)", () => {
  assert.equal(modelKey("gemma4:e4b"), "gemma4-e4b");
  assert.equal(modelKey("gemma4:e2b"), "gemma4-e2b");
  assert.notEqual(modelKey("gemma4:e2b"), modelKey("gemma4:e4b"));
});

test("modelKey: paths -> basename; empty -> default; always sanitized", () => {
  assert.equal(modelKey("/models/My-Model-4B.gguf"), "my-model-4b");
  assert.equal(modelKey(""), "default");
  assert.equal(modelKey(undefined), "default");
  assert.match(modelKey("hf:Qwen/Qwen2.5-Coder-3B-Instruct-GGUF:Q4_K_M"), /^[a-z0-9.\-]+$/);
});

test("maxStepsFor scales with model size", () => {
  assert.equal(maxStepsFor("hf:unsloth/gemma-4-E2B-it-GGUF:Q4_K_M"), 14); // tiny
  assert.equal(maxStepsFor("hf:ggml-org/gemma-4-E4B-it-GGUF:Q4_K_M"), 18); // small
  assert.equal(maxStepsFor("hf:Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M"), 22); // mid
  assert.equal(maxStepsFor("hf:unsloth/gemma-4-12b-it-GGUF:Q4_K_M"), 28); // large
  assert.equal(maxStepsFor("some-unknown-model"), 14); // default
  // a "12b" must NOT be mistaken for the "2b" (tiny) rule
  assert.notEqual(maxStepsFor("hf:unsloth/gemma-4-12b-it-GGUF:Q4_K_M"), maxStepsFor("hf:unsloth/gemma-4-E2B-it-GGUF:Q4_K_M"));
});
