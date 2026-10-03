import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { POST_HEALTH_SERVICE_ROLES_V1, composeServiceBundleV1, validateServiceRolesV1 } from "./bundle.mjs";
import { createInProcessServiceElevatedPortV1, verifyServiceReceiptV1 } from "./elevated.mjs";

const refuse = code => { throw Object.assign(new Error(code), { code }); };

export function guardServiceInstallResultV1(result, root, roles, servicePolicy) {
  if (!result || !["completed", "unchanged"].includes(result.outcome)) refuse("services_batch_uncertain");
  const receipt = verifyServiceReceiptV1(result.receipt, root, servicePolicy);
  const expected = validateServiceRolesV1(roles, { batch: true });
  if (receipt.roles.join("\0") !== expected.join("\0")) refuse("services_batch_uncertain");
  return receipt;
}

export async function installServicesV1(input, options = {}) {
  const bundle = composeServiceBundleV1(input);
  const port = options.elevatedPort ?? createInProcessServiceElevatedPortV1(options.runtime);
  if (!port || typeof port.install !== "function") refuse("services_batch_uncertain");
  const signal = options.signal ?? new AbortController().signal;
  const result = await port.install(bundle, signal);
  const receipt = guardServiceInstallResultV1(result, input.root, input.roles, input.servicePolicy);
  return Object.freeze({ bundleDigest: bundle.bundleDigest, receipt });
}

export async function uninstallServicesV1(input, options = {}) {
  const port = options.elevatedPort ?? createInProcessServiceElevatedPortV1(options.runtime);
  if (!port || typeof port.uninstall !== "function" || !input || typeof input.root !== "string") {
    refuse("services_batch_uncertain");
  }
  const signal = options.signal ?? new AbortController().signal;
  const result = await port.uninstall(input, signal);
  if (result?.outcome !== "removed") refuse("services_batch_uncertain");
  return Object.freeze({ outcome: "removed" });
}

export async function recoverServicesV1(input, options = {}) {
  const port = options.elevatedPort ?? createInProcessServiceElevatedPortV1(options.runtime);
  if (!port || typeof port.recover !== "function" || !input || typeof input.root !== "string") {
    refuse("services_batch_uncertain");
  }
  const roles = validateServiceRolesV1(input.roles, { batch: true });
  const signal = options.signal ?? new AbortController().signal;
  const result = await port.recover({ root: input.root, roles,
    ...(input.servicePolicy === undefined ? {} : { servicePolicy: input.servicePolicy }),
    ...(input.receipt === undefined ? {} : { receipt: input.receipt }) }, signal);
  if (result?.outcome !== "recovered" || result.roles?.join("\0") !== roles.join("\0")
    || result.usedReceipt !== (input.receipt !== undefined)) refuse("services_batch_uncertain");
  return Object.freeze({ outcome: "recovered", roles, usedReceipt: result.usedReceipt });
}

function defaultHeartbeatRuntime() {
  return Object.freeze({
    now: () => Date.now(),
    sleep: milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds)),
    async read(path) {
      const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 2 || stat.size > 16_384) {
          refuse("services_heartbeat_refused");
        }
        return (await handle.readFile()).toString("utf8");
      } finally { await handle.close(); }
    },
  });
}

export async function waitForUpdaterHeartbeatV1(root, after, options = {}) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root || root === "/"
    || !Number.isFinite(after)) refuse("services_heartbeat_refused");
  const runtime = Object.freeze({ ...defaultHeartbeatRuntime(), ...options.runtime });
  const timeoutMs = options.timeoutMs ?? 30_000, pollMs = options.pollMs ?? 250;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > timeoutMs
    || typeof runtime.now !== "function" || typeof runtime.sleep !== "function" || typeof runtime.read !== "function") {
    refuse("services_heartbeat_refused");
  }
  const signal = options.signal ?? new AbortController().signal, deadline = runtime.now() + timeoutMs;
  const path = join(root, "updater-state", "heartbeat");
  while (runtime.now() <= deadline) {
    if (!(signal instanceof AbortSignal) || signal.aborted) refuse("services_heartbeat_refused");
    try {
      const heartbeat = JSON.parse(await runtime.read(path));
      const at = Date.parse(heartbeat?.at ?? "");
      if (heartbeat?.schema === "control-room.updater-heartbeat/v1" && Number.isFinite(at) && at >= after
        && at <= runtime.now() + 5_000) return Object.freeze({ accepted: true, at: heartbeat.at });
    } catch (error) {
      if (!["ENOENT", "services_heartbeat_refused", "SyntaxError"].includes(error?.code ?? error?.name)) throw error;
    }
    const remaining = deadline - runtime.now();
    if (remaining <= 0) break;
    await runtime.sleep(Math.min(pollMs, remaining));
  }
  refuse("services_heartbeat_refused");
}

/** Step 27b: only after caller-held health and known-good acceptances, with bootout undo on heartbeat failure. */
export async function startPostHealthServicesV1(input, options = {}) {
  const roles = validateServiceRolesV1(input?.roles, { batch: true });
  if (roles.join("\0") !== POST_HEALTH_SERVICE_ROLES_V1.join("\0")
    || options.healthAccepted !== true || options.knownGoodAccepted !== true) refuse("services_batch_uncertain");
  const heartbeatRuntime = Object.freeze({ ...defaultHeartbeatRuntime(), ...options.heartbeatRuntime });
  const after = heartbeatRuntime.now();
  const installed = await installServicesV1(input, options);
  try {
    const heartbeat = await waitForUpdaterHeartbeatV1(input.root, after, { runtime: heartbeatRuntime,
      timeoutMs: options.heartbeatTimeoutMs, pollMs: options.heartbeatPollMs, signal: options.signal });
    return Object.freeze({ ...installed, heartbeat });
  } catch (cause) {
    try { await uninstallServicesV1({ root: input.root, receipt: installed.receipt,
      ...(input.servicePolicy === undefined ? {} : { servicePolicy: input.servicePolicy }) },
      { elevatedPort: options.elevatedPort, runtime: options.runtime }); }
    catch (rollbackError) {
      throw Object.assign(new Error("services_batch_uncertain", { cause }),
        { code: "services_batch_uncertain", rollbackError });
    }
    throw Object.assign(new Error("services_heartbeat_refused", { cause }), { code: "services_heartbeat_refused" });
  }
}

export async function restartServicesV1(input, options = {}) {
  if (!input || typeof input.root !== "string") refuse("services_batch_uncertain");
  const roles = validateServiceRolesV1(input.roles);
  const port = options.elevatedPort ?? createInProcessServiceElevatedPortV1(options.runtime);
  if (!port || typeof port.restart !== "function") refuse("services_batch_uncertain");
  const signal = options.signal ?? new AbortController().signal;
  const result = await port.restart(input.root, roles, signal, input.servicePolicy);
  if (result?.restarted?.join("\0") !== roles.join("\0")) refuse("services_batch_uncertain");
  return Object.freeze({ restarted: roles });
}
