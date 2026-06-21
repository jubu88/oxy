// Per-model configuration shared by the server, the supervisor journal, and the gated
// promote — they MUST agree on these so a build's skill file, its journaled lessons, and
// the promote that benchmarks/deploys for that model all line up. Pure; unit-tested.

// A stable, filesystem-safe key for a model REF (used for skill/<key>.md and the journal
// `model` tag). Same model at a different quant = same key (quant doesn't change the skill);
// different size/variant (e2b vs e4b) = different key. Both the server and promote.ts derive
// the key from the SAME ref string, so they always match.
export function modelKey(ref) {
  let s = String(ref || "default").trim().toLowerCase();
  if (s.startsWith("hf:")) {
    // hf:org/repo:quant -> repo (drop the quant tag and the org)
    s = (s.slice(3).split(":")[0].split("/").pop() || s);
  } else if (s.includes("/") || s.endsWith(".gguf")) {
    // a path or URL -> basename without extension
    s = (s.split(/[\\/]/).pop() || s).replace(/\.gguf$/, "");
  } else {
    // ollama-style "name:tag" -> keep the tag (it's the variant, e.g. e4b)
    s = s.replace(/:/g, "-");
  }
  s = s.replace(/(-(?:it|instruct|gguf|chat|q[0-9][a-z0-9_.]*))+$/g, ""); // strip quant/format noise
  s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "default";
}

// Step (assistant-turn) budget for a model. Bigger/slower models tend to over-scope and
// run out before finishing the entry file, so give them more turns — at the cost of more
// wall-clock. Tunable; overridable per build via the request's maxIterations.
export function maxStepsFor(ref) {
  const s = String(ref || "").toLowerCase();
  if (/(?:^|[^a-z0-9])(?:e2b|2b|1b|1\.5b|0\.5b)(?:[^a-z0-9]|$)/.test(s)) return 14; // tiny (gemma E2B etc.)
  if (/(?:^|[^a-z0-9])(?:e4b|4b|3b)(?:[^a-z0-9]|$)/.test(s)) return 18; // small (gemma E4B, Qwen-3B)
  if (/(?:^|[^a-z0-9])(?:7b|8b|9b|11b)(?:[^a-z0-9]|$)/.test(s)) return 22; // mid
  if (/(?:^|[^a-z0-9])(?:12b|13b|14b|24b|27b|30b|32b|70b)(?:[^a-z0-9]|$)/.test(s)) return 28; // large
  return 14; // unknown -> conservative default
}
