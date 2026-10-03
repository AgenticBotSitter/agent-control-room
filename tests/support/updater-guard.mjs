import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";

export async function guardScratchV1(t, suffix) {
  const parent = join(process.cwd(), ".test-tmp");
  await mkdir(parent, { recursive: true });
  const root = await realpath(await mkdtemp(join(parent, `guard-${suffix.slice(0, 3)}-`)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Keep the group leader alive until finally, even after the command exits.
// Its status uses a separate pipe; stdout/stderr stay available through cleanup.
export async function execGuardV1(file, args, options) {
  const { spawn } = await import("node:child_process");
  const timeoutMs = options?.timeout ?? 15_000;
  let child, timer, ended, status, stdout = "", stderr = "";
  try {
    status = await new Promise((resolve, reject) => {
      // New group, same session. The direct child watches stdin even while the
      // command runs, so losing the test process also kills the owned group.
      const supervisor = `import os, select, signal, subprocess, sys
os.setpgid(0, 0)
try:
    command = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL)
    while command.poll() is None:
        if select.select([0], [], [], 0.02)[0] and not os.read(0, 1):
            break
    if command.poll() is not None:
        os.write(3, (str(command.returncode) + '\\n').encode())
        os.read(0, 1)
finally:
    os.killpg(os.getpgrp(), signal.SIGKILL)
`;
      child = spawn("python3", ["-c", supervisor, file, ...args],
        { ...options, detached: false, timeout: 0, stdio: ["pipe", "pipe", "pipe", "pipe"] });
      ended = new Promise(done => child.once("close", done));
      child.stdout.on("data", bytes => { stdout += bytes; });
      child.stderr.on("data", bytes => { stderr += bytes; });
      child.once("error", reject);
      let statusLine = "";
      child.stdio[3].on("data", bytes => {
        statusLine += bytes;
        if (statusLine.includes("\n")) resolve(Number(statusLine.trim()));
      });
      child.once("close", () => reject(new Error("guard_test_group_exited_before_cleanup")));
      timer = setTimeout(() => reject(Object.assign(new Error("guard test command timed out"),
        { code: "SIGKILL", killed: true })), timeoutMs);
    });
  } finally {
    clearTimeout(timer);
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
        child.kill("SIGKILL");
      }
      await ended;
    }
  }
  if (status !== 0) throw Object.assign(new Error(`guard test command exited: ${status}: ${stderr.slice(0, 4096)}`),
    { code: status, killed: false, stdout, stderr });
  return { stdout, stderr };
}
