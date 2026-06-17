// Sandboxed command execution for the opt-in, OFF-BY-DEFAULT run_command tool.
//
// SECURITY: a small local model driving a shell is dangerous. Modes:
//   "container" (default/recommended): run in a throwaway, NETWORK-LESS Docker
//      container with ONLY the project dir mounted (at /work), plus memory/CPU/
//      pids/time caps. Worst case is confined to the discarded container.
//   "host" (UNSAFE, explicit opt-in): run on the host, cwd-jailed to the project,
//      with a timeout + output cap. NOT real isolation — intended only when Oxy
//      itself runs inside a VM / k8s pod. The backend requires a deliberate choice.
//   "disabled" (default): refuse.
// Obvious host-wreckers are refused in ANY mode (defense in depth).
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const DEFAULT_IMAGE = process.env.OXY_SANDBOX_IMAGE || "alpine:3.20";

// Catastrophic patterns refused regardless of mode (a container contains them, but
// refusing early is cheap defense-in-depth and protects an ill-advised host run).
const DANGEROUS = [
  /\brm\s+-[a-z]*r[a-z]*\s+(-[a-z]*\s+)*(\/|~|\$HOME|\.\.)/i, // rm -rf of an absolute path / ~ / ..
  /\bmkfs\b/i,
  /\bdd\b[^\n|]*\bof=\/dev\//i,
  /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/i,
  /:\s*\(\s*\)\s*\{[^}]*\|[^}]*\}\s*;\s*:/, // fork bomb :(){ :|:& };:
  /\b(chmod|chown)\s+-[a-z]*R[a-z]*\s+\/(?!work)/i, // recursive perms on host root
  />\s*\/dev\/(sd[a-z]|nvme|disk)/i,
  /\b(mkfs|fdisk|parted)\b/i,
];

export function isDangerous(command) {
  return DANGEROUS.some((re) => re.test(command));
}

/** Build the `docker run …` argv (pure — unit-tested). Network off, project-only mount. */
export function dockerArgs(command, projectDir, opts = {}) {
  return [
    "run",
    "--rm",
    "--network",
    opts.network || "none",
    "-v",
    `${projectDir}:/work`,
    "-w",
    "/work",
    "--memory",
    opts.memory || "512m",
    "--cpus",
    String(opts.cpus ?? 1),
    "--pids-limit",
    String(opts.pids ?? 256),
    opts.image || DEFAULT_IMAGE,
    "sh",
    "-lc",
    command,
  ];
}

export async function dockerAvailable() {
  try {
    await execFileP("docker", ["info"], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

function spawnCapped(cmd, args, { cwd, timeoutMs = 30000, maxOutput = 16000 } = {}) {
  return new Promise((resolve) => {
    let out = "";
    let killed = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, output: `spawn error: ${e?.message ?? e}`, code: -1, timedOut: false });
    }
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    const onData = (d) => {
      out += d;
      if (out.length > maxOutput) {
        out = out.slice(0, maxOutput) + "\n…[output truncated]";
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `spawn error: ${e.message}`, code: -1, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: !killed && code === 0, output: out.trim() || "(no output)", code, timedOut: killed });
    });
  });
}

/** Execute a model-requested command under the chosen sandbox. `dryRun` returns the
 *  planned invocation WITHOUT executing — used by tests to verify the safety plumbing. */
export async function runCommand(command, projectDir, opts = {}) {
  const mode = opts.mode || "disabled";
  const cmd = String(command || "").trim();
  if (!cmd) return { ok: false, output: "error: empty command" };
  if (mode === "disabled") return { ok: false, output: "error: the terminal tool is disabled (enable it in Settings)" };
  if (isDangerous(cmd)) return { ok: false, output: "error: refused — command matches a destructive pattern" };

  if (mode === "container") {
    const argv = dockerArgs(cmd, projectDir, opts);
    if (opts.dryRun) return { ok: true, dryRun: true, mode, argv };
    if (!(await dockerAvailable())) return { ok: false, output: "error: Docker not available — install Docker Desktop, or choose unsafe host mode in Settings" };
    return { ...(await spawnCapped("docker", argv, { timeoutMs: opts.timeoutMs, maxOutput: opts.maxOutput })), mode };
  }
  if (mode === "host") {
    const [bin, baseArgs] = process.platform === "win32" ? ["cmd", ["/c", cmd]] : ["sh", ["-lc", cmd]];
    if (opts.dryRun) return { ok: true, dryRun: true, mode, argv: [bin, ...baseArgs], cwd: projectDir };
    return { ...(await spawnCapped(bin, baseArgs, { cwd: projectDir, timeoutMs: opts.timeoutMs, maxOutput: opts.maxOutput })), mode };
  }
  return { ok: false, output: `error: unknown sandbox mode "${mode}"` };
}
