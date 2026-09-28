// Read-only health for the Mac-local task host, whether directly started or launchd-managed.
// Usage: pnpm mac:status -- --protected-root ABSOLUTE_PATH
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { alive, hostCommand, protectedRootFromArguments, readPid, runtimePaths, taskHostCommand } from "./stack.mjs";
import { serviceInstalled, serviceStatus } from "./service.mjs";
import { readHostState } from "./task-host-supervisor.mjs";

const portOpen = port => new Promise(resolve => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.setTimeout(1_000);
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("timeout", () => { socket.destroy(); resolve(false); });
  socket.once("error", () => resolve(false));
});

export async function inspectMacLocalHost(root, port, runtime = {}) {
  const paths = runtimePaths(root);
  const installed = await (runtime.serviceInstalled ?? serviceInstalled)();
  const service = installed ? await (runtime.serviceStatus ?? serviceStatus)(
    { protectedRoot: root, logPath: paths.hostLog, env: runtime.env ?? process.env }) : undefined;
  const recordedPid = await (runtime.readPid ?? readPid)(paths.hostPid);
  const pid = service?.pid ?? recordedPid;
  const state = await (runtime.readHostState ?? readHostState)(paths.hostState);
  const exactAlive = runtime.alive ?? alive;
  const processAlive = Boolean(pid && state?.state === "running" && state.pid === pid
    && exactAlive(pid, hostCommand(root)));
  const childAlive = Boolean(processAlive && Number.isSafeInteger(state.childPid)
    && exactAlive(state.childPid, taskHostCommand(root)));
  const serving = childAlive && await (runtime.portOpen ?? portOpen)(port);
  if (serving) return Object.freeze({ status: "running", exitCode: 0, pid, service });
  if (processAlive) return Object.freeze({ status: "unhealthy", exitCode: 1, pid, service,
    reason: childAlive ? "host process is running but not serving" : "host supervisor is running but its task host is not" });
  const reason = state?.state === "stopped" && typeof state.reason === "string" ? state.reason
    : state?.state === "running" ? "its supervisor disappeared without recording an exit" : "no stop reason was recorded";
  return Object.freeze({ status: installed && service?.loaded && service.enabled !== false ? "dead/restarting" : "dead",
    exitCode: 1, service, reason: `host stopped because ${reason}` });
}

async function main() {
  const root = protectedRootFromArguments(process.argv.slice(2));
  if (!root) throw new Error("--protected-root ABSOLUTE_PATH (or CONTROL_ROOM_PROTECTED_ROOT) is required");
  const configuration = JSON.parse(await (await import("node:fs/promises")).readFile(`${root}/config/mac-local.json`, "utf8"));
  if (!Number.isSafeInteger(configuration.port) || configuration.port < 1 || configuration.port > 65_535)
    throw new Error("mac_local_status_configuration_invalid");
  const result = await inspectMacLocalHost(root, configuration.port);
  const service = result.service ? ` service=${result.service.state}` : " service=not_installed";
  if (result.status === "running") console.log(`mac:status running pid=${result.pid}${service}`);
  else console.error(`mac:status ${result.status}: ${result.reason}${service}`);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch(error => {
    console.error(`mac:status FAILED ${error instanceof Error ? error.message : "unknown"}`);
    process.exitCode = 2;
  });
}
