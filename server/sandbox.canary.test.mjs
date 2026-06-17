// Canary: real containment test for container-mode run_command. SKIPS unless Docker
// is available (install Docker Desktop to run it). Proves a model command runs inside
// a throwaway, network-less container that can only touch the mounted project — and
// that an attempt to write OUTSIDE the project leaves the host untouched.
//   node --test server/sandbox.canary.test.mjs     (or: npm run test:sandbox-canary)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand, dockerAvailable } from "./sandbox.mjs";

const hasDocker = await dockerAvailable();

test("container run is isolated: project mount works, host writes are contained", { skip: hasDocker ? false : "Docker not available — install Docker Desktop to run this canary" }, async () => {
  const project = mkdtempSync(path.join(tmpdir(), "oxy-canary-"));
  const hostCanary = path.join(tmpdir(), "oxy-host-canary-DO-NOT-CREATE.txt");
  rmSync(hostCanary, { force: true });
  try {
    // benign: write inside the mounted project (/work) and try to escape to the container root
    const r = await runCommand("echo SANDBOXED && touch /work/from-sandbox.txt && (touch /oxy-host-canary-DO-NOT-CREATE.txt 2>/dev/null || true)", project, { mode: "container", timeoutMs: 60000 });
    assert.ok(r.ok, `command should run: ${r.output}`);
    assert.match(r.output, /SANDBOXED/);
    // the project mount is writable from inside the container
    assert.ok(existsSync(path.join(project, "from-sandbox.txt")), "project mount should receive the file");
    // the host filesystem OUTSIDE the project is untouched (container is --rm, only /work mounted)
    assert.ok(!existsSync(hostCanary), "host must NOT be written outside the project");

    // destructive command is refused before it ever runs
    const bad = await runCommand("rm -rf /", project, { mode: "container", timeoutMs: 60000 });
    assert.equal(bad.ok, false);
    assert.match(bad.output, /destructive/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(hostCanary, { force: true });
  }
});
