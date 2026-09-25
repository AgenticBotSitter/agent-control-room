// Shared helpers for mac:up and mac:down. Runtime state lives in <protected>/runtime (0700).
// A recorded pid is only ever signalled when its full command line is exactly the one this
// stack started for this protected root, so a recycled pid or another root's process is safe.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const TUNNEL_SCHEMA = "control-room.mac-local-tunnel/v1";
const SSH_TARGET = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/u;

export function protectedRootFromArguments(args) {
  const index = args.indexOf("--protected-root");
  const root = index === -1 ? process.env.CONTROL_ROOM_PROTECTED_ROOT : args[index + 1];
  return root && isAbsolute(root) && resolve(root) === root ? root : undefined;
}

export function runtimePaths(root) {
  const runtime = join(root, "runtime");
  return Object.freeze({ runtime, provider: join(runtime, "task-provider.mjs"),
    hostPid: join(runtime, "task-host.pid"), hostLog: join(runtime, "task-host.log"),
    tunnelPid: join(runtime, "tunnel.pid"), tunnelLog: join(runtime, "tunnel.log") });
}

export const hostCommand = root => [process.execPath, "scripts/mac-local/start-task-host.mjs", "--owner-attended", "--protected-root", root];
export const tunnelCommand = tunnel => ["/usr/bin/ssh", "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
  "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
  "-L", `127.0.0.1:${tunnel.localPort}:127.0.0.1:${tunnel.remotePort}`, tunnel.sshTarget];

/** Owner-held tunnel settings. The SSH target never enters the repository. */
export function captureTunnel(value, database) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort().join(",") : "";
  if (keys !== "localPort,remotePort,schema,sshTarget" || value.schema !== TUNNEL_SCHEMA
    || typeof value.sshTarget !== "string" || !SSH_TARGET.test(value.sshTarget)
    || !Number.isInteger(value.localPort) || value.localPort < 1024 || value.localPort > 65535
    || !Number.isInteger(value.remotePort) || value.remotePort < 1 || value.remotePort > 65535
    || database?.host !== "127.0.0.1" || database.port !== value.localPort) throw new Error("mac_local_tunnel_config_invalid");
  return Object.freeze({ ...value });
}

/** Reads <protected>/config/tunnel.json if present (0600, not a symlink). Undefined means no tunnel. */
export async function readTunnel(root) {
  const path = join(root, "config/tunnel.json");
  if (!existsSync(path)) return undefined;
  for (const file of [path, join(root, "config/mac-local.json")]) {
    const entry = await lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) throw new Error("mac_local_tunnel_config_invalid");
  }
  const mac = JSON.parse(await readFile(join(root, "config/mac-local.json"), "utf8"));
  return captureTunnel(JSON.parse(await readFile(path, "utf8")), mac.database);
}

export async function readPid(path) {
  try { const pid = Number((await readFile(path, "utf8")).trim()); return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined; }
  catch { return undefined; }
}

/** True only when the pid is alive and its full (untruncated, -ww) command line is exactly `command`. */
export function alive(pid, command) {
  try { return execFileSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim() === command.join(" "); }
  catch { return false; }
}

// A process that exits between the liveness check and the signal is already stopped.
const signal = (target, name) => { try { process.kill(target, name); return true; } catch { return false; } };

/** SIGTERM to the leader alone, so the task host can drain and reap its agents (each agent runs
 * in its own process group). Only if the grace period runs out is the leader's group killed. */
export async function stopRecorded(pidPath, command, graceSeconds) {
  const pid = await readPid(pidPath);
  if (!pid || !alive(pid, command)) { await rm(pidPath, { force: true }); return "not_running"; }
  signal(pid, "SIGTERM");
  for (let i = 0; i < graceSeconds * 2 && alive(pid, command); i++) await new Promise(r => setTimeout(r, 500));
  if (alive(pid, command)) {
    if (!signal(-pid, "SIGKILL")) signal(pid, "SIGKILL");
    await new Promise(r => setTimeout(r, 500));
  }
  if (alive(pid, command)) return "still_running";
  await rm(pidPath, { force: true });
  return "stopped";
}
