// Render a known-content test image (the word "OXY") to a PNG, for the LiteRT-LM
// vision smoke test. node scripts/make-oxy-png.mjs [outPath]
import { chromium } from "playwright";
const out = process.argv[2] || "workspace/oxy-vision-test.png";
const b = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist"] });
const p = await b.newContext({ viewport: { width: 420, height: 200 } }).then((c) => c.newPage());
await p.setContent(`<body style="margin:0;display:flex;align-items:center;justify-content:center;height:200px;background:#fff"><h1 style="font:bold 96px Arial;color:#000">OXY</h1></body>`);
await p.screenshot({ path: out, type: "png" });
await b.close();
console.log("wrote " + out);
