// Live check: gemma4 vision through Oxy's attachment plumbing. Renders a known
// image (the word "OXY"), sends it to the llama-server engine as an image
// attachment, and checks the model reads it back — proving Attachment → OpenAI
// content-parts → llama-server --mmproj → gemma4 vision works end to end.
//   OXY_MODEL=<gemma4.gguf> node scripts/check-multimodal.ts
import { chromium } from "playwright";
import { LlamaServerEngine } from "../engine/llama-server.ts";

const WORD = "OXY";

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
  let data: string;
  try {
    const page = await browser.newContext({ viewport: { width: 420, height: 200 } }).then((c) => c.newPage());
    await page.setContent(`<body style="margin:0;display:flex;align-items:center;justify-content:center;height:200px;background:#fff"><h1 style="font:bold 96px Arial,sans-serif;color:#000;letter-spacing:4px">${WORD}</h1></body>`);
    data = (await page.screenshot({ type: "png" })).toString("base64");
  } finally {
    await browser.close();
  }
  console.log(`[multimodal] rendered test image (${Math.round(data.length / 1024)} KB base64), word="${WORD}"`);

  const engine = new LlamaServerEngine({ modelRef: process.env.OXY_MODEL });
  await engine.ensureReady();
  const res = await engine.generate(
    [{ role: "user", content: `What word is written in this image? Reply with ONLY that word.`, attachments: [{ kind: "image", mime: "image/png", data }] }],
    [],
    { temperature: 0, numPredict: 20 },
  );
  await (engine as { dispose?: () => Promise<void> }).dispose?.().catch(() => {});

  const said = (res.content || "").trim();
  console.log(`[multimodal] model said: ${JSON.stringify(said)}`);
  const ok = new RegExp(WORD, "i").test(said);
  console.log(ok ? "PASS — gemma4 read the image through the attachment path ✓" : "CHECK — model did not return the word (inspect: vision wiring vs model misread)");
  process.exit(ok ? 0 : 2);
}
main().catch((e) => {
  console.error("[multimodal] failed:", e?.stack ?? e);
  process.exit(1);
});
