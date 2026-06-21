// Unit tests for Stitch reuse screen-selection. node --test.
// The fetch-existing flow (list_screens -> pick -> download) is validated live against the
// real API; this guards the one piece of pure logic — picking WHICH existing screen to reuse.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickStitchScreen } from "./server.mjs";

const screens = [
  { title: "Products", htmlUrl: "u-products" },
  { title: "Dashboard", htmlUrl: "u-dashboard" },
  { title: "Settings", htmlUrl: "u-settings" },
  { title: "Statements", htmlUrl: "u-statements" },
  { title: "Payments", htmlUrl: "u-payments" },
];

test("picks the screen whose title matches the prompt", () => {
  assert.equal(pickStitchScreen(screens, "the settings screen with profile and security").title, "Settings");
  assert.equal(pickStitchScreen(screens, "payments screen to send money").title, "Payments");
  assert.equal(pickStitchScreen(screens, "show recent statements and transactions").title, "Statements");
});

test("prefers a primary screen (dashboard) when the prompt names several / is generic", () => {
  // a whole-app prompt mentions many screens; the dashboard tie-break wins
  assert.equal(pickStitchScreen(screens, "a banking app with a dashboard, payments and settings").title, "Dashboard");
  // a generic prompt with no title words still resolves to the primary screen
  assert.equal(pickStitchScreen(screens, "build the main app page").title, "Dashboard");
});

test("falls back to the first screen when nothing matches and there's no primary", () => {
  const noPrimary = [
    { title: "Alpha", htmlUrl: "u-a" },
    { title: "Bravo", htmlUrl: "u-b" },
  ];
  assert.equal(pickStitchScreen(noPrimary, "something entirely unrelated").title, "Alpha");
});

test("ignores short noise words so they don't create false matches", () => {
  // "the", "to", "of" are <=2 chars after split and must not match anything
  const r = pickStitchScreen(screens, "the to of");
  assert.equal(r.title, "Dashboard"); // no real overlap -> primary tie-break
});
