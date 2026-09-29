// Protected full-host configuration loader. This is intentionally separate
// from operator-config.mjs: ordinary website settings can never enable a task
// queue, native listener, or worker route.
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export const schema = "control-room.private-vps-configuration/v1";
export const PRIVATE_VPS_AGENT_TASK_PROVIDER_V1 = "control-room.private-vps-agent-task-provider/v1";

const refuse = () => { throw new Error("private_agent_task_operator_configuration_invalid"); };

function providerModule(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== null && Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== 2 || !names.includes("schema") || !names.includes("createConfiguration")
    || value.schema !== PRIVATE_VPS_AGENT_TASK_PROVIDER_V1 || typeof value.createConfiguration !== "function") return refuse();
  return value;
}

function providerInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refuse();
  const names = Object.getOwnPropertyNames(value);
  if (names.length !== 3 || !["operatorSettings", "trustedInputs", "nativeHttps"].every(name => names.includes(name))) return refuse();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refuse();
  }
  if (!value.operatorSettings || typeof value.operatorSettings !== "object" || !value.trustedInputs
    || typeof value.trustedInputs !== "object" || !value.nativeHttps || typeof value.nativeHttps !== "object") return refuse();
  return value;
}

const installedRuntime = Object.freeze({
  providerPath: () => process.env.CONTROL_ROOM_AGENT_TASK_PROVIDER_FILE,
  validatePath: async path => {
    const { validatePrivateVpsConfigurationPath } = await import("../scripts/run-private-vps.mjs");
    return validatePrivateVpsConfigurationPath(path);
  },
  loadProvider: path => import(pathToFileURL(path).href),
  loadAssembler: () => import("../dist-vps/server/agentTaskOperator.js"),
});

/**
 * The provider file is owner-held executable configuration, not uploaded data
 * or a browser setting. It creates the already-defined trusted input graph;
 * this loader only validates its fixed shape and calls the existing fail-closed
 * assembler. Importing the module has no network, database, listener, queue,
 * worker, or credential-store effect.
 */
export async function createConfiguration({ signal } = {}, runtime = installedRuntime) {
  try {
    if (!(signal instanceof AbortSignal) || signal.aborted || !runtime || typeof runtime.providerPath !== "function"
      || typeof runtime.validatePath !== "function" || typeof runtime.loadProvider !== "function"
      || typeof runtime.loadAssembler !== "function") return refuse();
    const path = runtime.providerPath();
    if (typeof path !== "string" || !isAbsolute(path)) return refuse();
    await runtime.validatePath(path);
    if (signal.aborted) return refuse();
    const provider = providerModule(await runtime.loadProvider(path));
    const input = providerInput(await provider.createConfiguration({ signal }));
    if (signal.aborted) return refuse();
    const module = await runtime.loadAssembler();
    if (typeof module?.assemblePrivateAgentTaskOperatorConfiguration !== "function") return refuse();
    const assembled = module.assemblePrivateAgentTaskOperatorConfiguration(input.operatorSettings, input.trustedInputs);
    if (!assembled || typeof assembled !== "object" || !Number.isSafeInteger(assembled.port)
      || !assembled.configuration || typeof assembled.configuration !== "object") return refuse();
    if (signal.aborted) return refuse();
    return Object.freeze({ mode: "agent-tasks", port: assembled.port, configuration: assembled.configuration,
      nativeHttps: input.nativeHttps });
  } catch {
    return refuse();
  }
}
