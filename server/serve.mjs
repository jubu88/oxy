// Standalone launcher for the Oxy jailed backend — runs the same codelabHandler
// on a plain node:http server (no Vite), so headless builds and tests can execute
// tools with zero npm install. The React UI uses codeLabPlugin instead.
//
//   node server/serve.mjs            # listens on http://localhost:5173
//   PORT=5179 node server/serve.mjs
import http from "node:http";
import { codelabHandler, ensure } from "./server.mjs";

const PORT = Number(process.env.PORT) || 5173;

ensure();

const server = http.createServer((req, res) => {
  codelabHandler(req, res, () => {
    res.statusCode = 404;
    res.end("not found");
  });
});

server.listen(PORT, () => {
  console.log(`[oxy backend] listening on http://localhost:${PORT}  (tools under /codelab/api)`);
});
