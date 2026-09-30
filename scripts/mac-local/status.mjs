// Read-only health for the Mac-local task host, whether directly started or launchd-managed.
// Usage: pnpm mac:status -- --protected-root ABSOLUTE_PATH
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { alive, FLEET_GATEWAY_PORT, fleetGatewayCommand, hostCommand, protectedRootFromArguments, readPid,
  recordedHostCommand, runtimePaths, taskHostCommand } from "./stack.mjs";
import { serviceInstalled, serviceStatus } from "./service.mjs";
import { readHostState, readRecoverableHostState } from "./task-host-supervisor.mjs";

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
  const { state, unreadable } = await readRecoverableHostState(paths.hostState,
    runtime.readHostState ?? readHostState);
  const stateWarning = unreadable ? "task-host-state.json is unreadable and was ignored" : undefined;
  const exactAlive = runtime.alive ?? alive;
  const processAlive = Boolean(pid && state?.state === "running" && state.pid === pid
    && exactAlive(pid, hostCommand(root)));
  const childAlive = Boolean(processAlive && Number.isSafeInteger(state.childPid)
    && exactAlive(state.childPid, taskHostCommand(root)));
  const legacyAlive = Boolean(pid && !state && recordedHostCommand(pid, root, exactAlive));
  const serving = (childAlive || legacyAlive) && await (runtime.portOpen ?? portOpen)(port);
  if (serving) return Object.freeze({ status: "running", exitCode: 0, pid, service,
    ...(stateWarning ? { stateWarning } : {}) });
  if (legacyAlive) return Object.freeze({ status: "unhealthy", exitCode: 1, pid, service,
    reason: "recorded host process is running but not serving", ...(stateWarning ? { stateWarning } : {}) });
  if (processAlive) return Object.freeze({ status: "unhealthy", exitCode: 1, pid, service,
    reason: childAlive ? "host process is running but not serving" : "host supervisor is running but its task host is not",
    ...(stateWarning ? { stateWarning } : {}) });
  const reason = state?.state === "stopped" && typeof state.reason === "string" ? state.reason
    : state?.state === "running" ? "its supervisor disappeared without recording an exit" : "no stop reason was recorded";
  return Object.freeze({ status: installed && service?.loaded && service.enabled !== false ? "dead/restarting" : "dead",
    exitCode: 1, service, reason: `host stopped because ${reason}`, ...(stateWarning ? { stateWarning } : {}) });
}

export async function inspectMacLocalFleetGateway(root, runtime = {}) {
  const paths = runtimePaths(root), pid = await (runtime.readPid ?? readPid)(paths.fleetGatewayPid);
  const exactAlive = runtime.alive ?? alive;
  if (!pid || !exactAlive(pid, fleetGatewayCommand(root)))
    return Object.freeze({ status: "dead", exitCode: 1, reason: "no exact recorded fleet gateway process" });
  if (!await (runtime.portOpen ?? portOpen)(FLEET_GATEWAY_PORT))
    return Object.freeze({ status: "unhealthy", exitCode: 1, pid, reason: "fleet gateway is running but not serving" });
  return Object.freeze({ status: "running", exitCode: 0, pid });
}

async function main() {
  const root = protectedRootFromArguments(process.argv.slice(2));
  if (!root) throw new Error("--protected-root ABSOLUTE_PATH (or CONTROL_ROOM_PROTECTED_ROOT) is required");
  const configuration = JSON.parse(await (await import("node:fs/promises")).readFile(`${root}/config/mac-local.json`, "utf8"));
  if (!Number.isSafeInteger(configuration.port) || configuration.port < 1 || configuration.port > 65_535)
    throw new Error("mac_local_status_configuration_invalid");
  const result = await inspectMacLocalHost(root, configuration.port);
  const service = result.service ? ` service=${result.service.state}` : " service=not_installed";
  const warning = result.stateWarning ? ` warning=${result.stateWarning}` : "";
  if (result.status === "running") {
    const gateway = await inspectMacLocalFleetGateway(root);
    if (gateway.status === "running")
      console.log(`mac:status running pid=${result.pid}${service} fleet_gateway=running gateway_pid=${gateway.pid}${warning}`);
    else {
      console.error(`mac:status unhealthy: ${gateway.reason}${service} fleet_gateway=${gateway.status}${warning}`);
      process.exitCode = gateway.exitCode;
      return;
    }
  }
  else console.error(`mac:status ${result.status}: ${result.reason}${service}${warning}`);
  process.exitCode ??= result.exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch(error => {
    console.error(`mac:status FAILED ${error instanceof Error ? error.message : "unknown"}`);
    process.exitCode = 2;
  });
}
