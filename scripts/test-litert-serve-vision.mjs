// Verify litert-lm's OpenAI-compatible serve decodes an image sent as an
// image_url content part (the format Oxy's OpenAICompatEngine already produces).
import { readFileSync } from "node:fs";
const base = `http://localhost:${process.env.PORT || 9379}/v1`;
const img = readFileSync("workspace/oxy-vision-test.png").toString("base64");

let up = false;
for (let i = 0; i < 180; i++) {
  try {
    const r = await fetch(`${base}/models`);
    if (r.ok) { console.log("models:", JSON.stringify(await r.json()).slice(0, 200)); up = true; break; }
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
if (!up) { console.log("server never came up"); process.exit(1); }

const body = {
  model: "oxy-gemma4",
  stream: false,
  messages: [{ role: "user", content: [{ type: "text", text: "What word is written in this image? Reply with only the word." }, { type: "image_url", image_url: { url: `data:image/png;base64,${img}` } }] }],
};
const r = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
console.log("status:", r.status);
const j = await r.json().catch(async () => ({ raw: (await r.text()).slice(0, 300) }));
console.log("content:", JSON.stringify(j.choices?.[0]?.message?.content ?? j).slice(0, 400));
process.exit(0);
