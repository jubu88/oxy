// Tests for the curated-reference RAG: section parsing, topic matching, and the live
// getReference against the real reference/ corpus. node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseSections, pickReference, getReference, REFERENCE_LIBRARIES, libraryHint } from "./reference.mjs";

const REF_DIR = path.resolve(import.meta.dirname, "..", "reference");

test("parseSections splits a doc on ## headings", () => {
  const md = "# title\nintro\n\n## one\nbody one\n\n## two\nbody two";
  const s = parseSections(md);
  assert.equal(s.length, 2);
  assert.deepEqual(s.map((x) => x.heading), ["one", "two"]);
  assert.match(s[0].body, /body one/);
});

test("pickReference matches the topic by heading (weighted) and returns topic list", () => {
  const md = "## auth\nsign in with password\n\n## insert\nadd a row\n\n## realtime\nsubscribe to changes";
  const r = pickReference(md, "how do I insert a row");
  assert.ok(r.match && r.match[0].heading === "insert");
  assert.deepEqual(r.topics, ["auth", "insert", "realtime"]);
});

test("pickReference returns no match (with topics) when nothing overlaps", () => {
  const md = "## auth\nsign in\n\n## insert\nadd a row";
  const r = pickReference(md, "completely unrelated zzz");
  assert.equal(r.match, null);
  assert.deepEqual(r.topics, ["auth", "insert"]);
});

test("getReference: unknown library errors with the valid list", () => {
  const r = getReference(REF_DIR, "angular", "anything");
  assert.equal(r.ok, false);
  assert.match(r.error, /supabase/);
});

test("getReference: real corpora resolve a real topic to a snippet", () => {
  for (const lib of Object.keys(REFERENCE_LIBRARIES)) {
    const r = getReference(REF_DIR, lib, "setup");
    assert.equal(r.ok, true, `${lib} should load`);
    assert.ok(r.topics.length >= 3, `${lib} should have several topics`);
  }
  // a known Supabase topic returns its code
  const auth = getReference(REF_DIR, "supabase", "auth sign in");
  assert.match(auth.text, /signInWithPassword/);
  // react reference steers AWAY from a build toolchain (Oxy has no bundler)
  const react = getReference(REF_DIR, "react", "setup");
  assert.match(react.text.toLowerCase(), /no bundler|no-build|babel/);
});

test("getReference: an unmatched topic lists the available topics to retry", () => {
  const r = getReference(REF_DIR, "supabase", "zzz-nonexistent-topic");
  assert.equal(r.ok, true);
  assert.match(r.text, /Available topics:/);
});

test("libraryHint nudges only for known libraries (used by the build endpoint AND the benchmark)", () => {
  const sb = libraryHint("a notes app with Supabase auth and a database");
  assert.match(sb, /get_reference/);
  assert.match(sb, /schema\.sql/); // tells it to emit the SQL
  assert.match(libraryHint("a React todo SPA"), /react/i);
  assert.match(libraryHint("a React todo SPA"), /no.?build|bundler|cdn/i); // steers away from a build toolchain
  assert.match(libraryHint("a star rating web component"), /web-components/);
  assert.equal(libraryHint("a tip calculator"), ""); // plain app — stays lean
  assert.equal(libraryHint(""), "");
});
