// Safety tests for the run_command sandbox — no real commands are executed
// (dryRun returns the planned invocation). node --test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDangerous, dockerArgs, runCommand } from "./sandbox.mjs";

test("isDangerous blocks catastrophic commands", () => {
  for (const c of ["rm -rf /", "rm -rf ~", "rm -rf /usr", "sudo rm -fr /home", ":(){ :|:& };:", "mkfs.ext4 /dev/sda", "dd if=/dev/zero of=/dev/sda", "shutdown now", "reboot"]) {
    assert.equal(isDangerous(c), true, `should block: ${c}`);
  }
});

test("isDangerous allows ordinary project commands", () => {
  for (const c of ["ls -la", "npm test", "echo hello", "node build.js", "rm -rf node_modules", "cat package.json", "git status"]) {
    assert.equal(isDangerous(c), false, `should allow: ${c}`);
  }
});

test("dockerArgs builds a network-less, project-scoped, capped invocation", () => {
  const argv = dockerArgs("ls", "/projects/p1");
  assert.deepEqual(argv.slice(0, 8), ["run", "--rm", "--network", "none", "-v", "/projects/p1:/work", "-w", "/work"]);
  assert.ok(argv.includes("--memory") && argv.includes("--pids-limit"));
  assert.deepEqual(argv.slice(-3), ["sh", "-lc", "ls"]); // command passed to sh -lc
});

test("runCommand refuses when disabled (default)", async () => {
  const r = await runCommand("ls", "/p", {});
  assert.equal(r.ok, false);
  assert.match(r.output, /disabled/);
});

test("runCommand refuses a destructive command in any mode", async () => {
  const r = await runCommand("rm -rf /", "/p", { mode: "host", dryRun: true });
  assert.equal(r.ok, false);
  assert.match(r.output, /destructive/);
});

test("container mode (dry-run) plans a docker invocation, executes nothing", async () => {
  const r = await runCommand("npm test", "/projects/p1", { mode: "container", dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.mode, "container");
  assert.equal(r.argv[0], "run");
  assert.ok(r.argv.includes("/projects/p1:/work"));
  assert.deepEqual(r.argv.slice(-3), ["sh", "-lc", "npm test"]);
});

test("host mode (dry-run) is cwd-jailed to the project", async () => {
  const r = await runCommand("ls", "/projects/p1", { mode: "host", dryRun: true });
  assert.equal(r.dryRun, true);
  assert.equal(r.mode, "host");
  assert.equal(r.cwd, "/projects/p1");
});
