// Shared helpers for mac:up and mac:down. Installed services use RUNTIME_STATE.
// A recorded pid is only ever signalled when its full command line is exactly the one this
// stack started for this protected root, so a recycled pid or another root's process is safe.
import { privateProcessLeaseAliveV1 } from "../../src/installer/shared/private-process-lock.mjs";
import { macLocalRuntimeDirectoryV1 } from "../../src/installer/shared/mac-local-runtime-directory.mjs";
import { stableFileBytesV1 } from "../../src/installer/shared/file-custody.mjs";
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export function protectedRootFromArguments(args) {
  const index = args.indexOf("--protected-root");
  const root = index === -1 ? process.env.CONTROL_ROOM_PROTECTED_ROOT : args[index + 1];
  return root && isAbsolute(root) && resolve(root) === root ? root : undefined;
}

export function runtimePaths(root) {
  const runtime = macLocalRuntimeDirectoryV1(root);
  return Object.freeze({ runtime, provider: join(runtime, "task-provider.mjs"),
    hostPid: join(runtime, "task-host.pid"), hostLog: join(runtime, "task-host.log"),
    hostState: join(runtime, "task-host-state.json"),
    fleetGatewayPid: join(runtime, "fleet-gateway.pid"), fleetGatewayLog: join(runtime, "fleet-gateway.log"),
    upgradePrevious: join(runtime, "upgrade-previous.json") });
}

export function supervisorLockPaths(root) {
  const { runtime } = runtimePaths(root);
  return Object.freeze({ hostLock: join(runtime, "task-host-supervisor.lock"), childLock: join(runtime, "task-host-child.lock") });
}

export const taskHostCommand = root => [process.execPath, "scripts/mac-local/start-task-host.mjs", "--owner-attended", "--protected-root", root];
export const hostCommand = root => [process.execPath, "scripts/mac-local/task-host-supervisor.mjs", "--protected-root", root];
export const FLEET_GATEWAY_PORT = 3212;
export const fleetGatewayCommand = root => [process.execPath, "scripts/mac-local/start-fleet-gateway.mjs",
  "--owner-attended", "--protected-root", root];

/** How the gateway reports a fatal start, and the one refusal that is not a
 * fault: no owner has run the separate attended `release:sign` step, so there
 * is nothing to distribute to remote machines yet. Both strings are declared
 * once, here, so the writer and the reader of the gateway log cannot drift. */
export const MAC_LOCAL_GATEWAY_ERROR_PREFIX_V1 = "mac-local-fleet-gateway: ";
export const MAC_LOCAL_CONNECTOR_RELEASE_MISSING_V1 = "mac_local_fleet_connector_release_missing";

/** Selects only this release's supervisor or the exact pre-supervisor direct host for the same root. */
export function recordedHostCommand(pid, root, isAlive = alive) {
  if (isAlive(pid, hostCommand(root))) return hostCommand(root);
  if (isAlive(pid, taskHostCommand(root))) return taskHostCommand(root);
  return undefined;
}

async function readRecordedPid(path) {
  try { const bytes = await stableFileBytesV1(path, 32, entry => {
    if ((entry.mode & 0o022) !== 0 || entry.uid !== process.getuid?.() && entry.uid !== 0) throw new Error();
  }); const text = bytes.toString("utf8").trim();
  if (!/^[0-9]{1,16}$/u.test(text)) throw new Error();
  const pid = Number(text); if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(); return pid; }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw new Error("recorded_pid_refused"); }
}

export async function readPid(path) { try { return await readRecordedPid(path); } catch { return undefined; } }

/** True only when the pid is alive and its full (untruncated, -ww) command line is exactly `command`. */
export function alive(pid, command, lease) {
  if (lease) return privateProcessLeaseAliveV1(lease.path, pid, command, lease.identity);
  try { return execFileSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim() === command.join(" "); }
  catch { return false; }
}

// A process that exits between the liveness check and the signal is already stopped.
const signal = (target, name) => { try { process.kill(target, name); return true; } catch { return false; } };

/** SIGTERM to the leader alone, so the task host can drain and reap its agents (each agent runs
 * in its own process group). Only if the grace period runs out is the leader's group killed. */
export async function stopRecorded(pidPath, command, graceSeconds) {
  const pid = await readRecordedPid(pidPath);
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

/** Upgrade-safe stop for a PID recorded by either the current supervisor or #361's direct host. */
export async function stopRecordedHost(pidPath, root, graceSeconds) {
  const pid = await readRecordedPid(pidPath);
  const command = pid ? recordedHostCommand(pid, root) : undefined;
  if (!command) { await rm(pidPath, { force: true }); return "not_running"; }
  return stopRecorded(pidPath, command, graceSeconds);
}
