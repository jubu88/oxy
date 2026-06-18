// Confirm the Oxy LiteRtLmEngine decodes gemma4 vision end-to-end (Attachment ->
// OpenAI image_url -> litert-lm serve -> gemma4 vision).
//   OXY_LITERTLM_BIN=<path> node scripts/check-litert-engine.ts
import { readFileSync } from "node:fs";
import { LiteRtLmEngine } from "../engine/litert-lm.ts";

const data = readFileSync("workspace/oxy-vision-test.png").toString("base64");
const engine = new LiteRtLmEngine({});
await engine.ensureReady();
const res = await engine.generate(
  [{ role: "user", content: "What word is written in this image? Reply with only the word.", attachments: [{ kind: "image", mime: "image/png", data }] }],
  [],
  { temperature: 0, numPredict: 20 },
);
const said = (res.content || "").trim();
console.log("LiteRtLmEngine vision result:", JSON.stringify(said));
const ok = /oxy/i.test(said);
console.log(ok ? "PASS — LiteRtLmEngine decodes gemma4 vision ✓" : "FAIL");
await engine.dispose().catch(() => {});
process.exit(ok ? 0 : 2);
