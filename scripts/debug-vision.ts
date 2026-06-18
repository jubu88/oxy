// Debug: hit the running llama-server /v1 directly (stream:false) to see exactly
// what it does with an image_url content part vs a text-only control.
import { LlamaServerEngine } from "../engine/llama-server.ts";
import { chromium } from "playwright";

async function main() {
  const engine = new LlamaServerEngine({ modelRef: process.env.OXY_MODEL });
  await engine.ensureReady();
  const url = `http://127.0.0.1:${process.env.OXY_LLAMA_PORT || 8080}/v1/chat/completions`;

  const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newContext({ viewport: { width: 420, height: 200 } }).then((c) => c.newPage());
  await page.setContent(`<body style="margin:0;display:flex;align-items:center;justify-content:center;height:200px;background:#fff"><h1 style="font:bold 96px Arial;color:#000">OXY</h1></body>`);
  const data = (await page.screenshot({ type: "png" })).toString("base64");
  await browser.close();

  const raw = async (label: string, messages: any) => {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages, stream: false, max_tokens: 120, temperature: 0.2 }) });
      const j: any = await r.json();
      console.log(`${label}: HTTP ${r.status} · finish=${j.choices?.[0]?.finish_reason} · err=${j.error ? JSON.stringify(j.error).slice(0, 200) : "none"}`);
      console.log(`  content=${JSON.stringify(j.choices?.[0]?.message?.content ?? null)}`);
    } catch (e: any) {
      console.log(`${label}: fetch error ${String(e?.message ?? e).slice(0, 160)}`);
    }
  };

  await raw("TEXT  ", [{ role: "user", content: "Reply with exactly one word: READY" }]);
  await raw("VISION", [{ role: "user", content: [{ type: "text", text: "Describe this image in one short sentence." }, { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }] }]);

  await (engine as { dispose?: () => Promise<void> }).dispose?.().catch(() => {});
  process.exit(0);
}
main().catch((e) => {
  console.error("debug-vision failed:", e?.stack ?? e);
  process.exit(1);
});
