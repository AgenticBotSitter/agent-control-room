import { join, normalize } from "node:path";
import { sha256Digest } from "../../security/canonical-digest";
import { PRIVATE_MACOS_SERVICE_FINAL_OBSERVATION_V1, PRIVATE_MACOS_SERVICE_LABEL_V1,
  type PrivateMacosServiceFinalObservationRequestV1 } from "./private-macos-service-owner-runner";
import { PRIVATE_MACOS_SERVICE_NATIVE_PORT_V1, PRIVATE_MACOS_SERVICE_NATIVE_RECEIPT_V1,
  type PrivateMacosServiceNativePortV1, type PrivateMacosServiceNativeStepReceiptV1,
  type PrivateMacosServiceNativeStepRequestV1 } from "./private-macos-service-tool-adapter";

/**
 * Narrow production composition beneath the reviewed macOS owner runner.
 *
 * This module does not import a filesystem or process API. The native host is
 * separately supplied by the owner-attended installation package and can only
 * receive the fixed service target and structured operations below. It is not
 * a generic command or supervisor interface.
 */
export const PRIVATE_MACOS_SERVICE_RUNTIME_PORT_V1 =
  "control-room.private-macos-service-runtime-port/v1" as const;
export const PRIVATE_MACOS_SERVICE_RUNTIME_HOST_V1 =
  "control-room.private-macos-service-runtime-host/v1" as const;
export const PRIVATE_MACOS_SERVICE_RUNTIME_RECEIPT_V1 =
  "control-room.private-macos-service-runtime-receipt/v1" as const;
export const PRIVATE_MACOS_SERVICE_RUNTIME_PREFLIGHT_V1 =
  "control-room.private-macos-service-runtime-preflight/v1" as const;
export const PRIVATE_MACOS_SERVICE_RUNTIME_AUTHORIZATION_V1 =
  "control-room.private-macos-service-runtime-authorization/v1" as const;

type ServiceState = "not_installed" | "stopped" | "running" | "unknown";
type ControlAction = "status" | "start" | "stop" | "restart";
type NativeOperation = PrivateMacosServiceNativeStepRequestV1["operation"] | "inspect_service_status" | "stop_service";

export type PrivateMacosServiceRuntimeHostRequestV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_RUNTIME_HOST_V1;
  operation: NativeOperation;
  ownerUid: number;
  launchctlDomain: string;
  launchctlTarget: string;
  label: typeof PRIVATE_MACOS_SERVICE_LABEL_V1;
  launchAgentPath: string;
  requestDigest: string;
  lifecycleDigest: string;
  releaseDigest: string;
  serviceDefinitionDigest: string;
  expectedDefinitionParentIdentityDigest: string;
  expectedDefinitionIdentityDigest: string | null;
  expectedServiceIdentityDigest: string;
  serviceDefinition?: string;
  deadlineUnixMs: number;
  signal: AbortSignal;
}>;

export type PrivateMacosServiceRuntimeHostReceiptV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_RUNTIME_RECEIPT_V1;
  operation: NativeOperation;
  outcome: "succeeded" | "failed_before_effect";
  ownerUid: number;
  launchctlDomain: string;
  launchctlTarget: string;
  label: typeof PRIVATE_MACOS_SERVICE_LABEL_V1;
  launchAgentPath: string;
  requestDigest: string;
  lifecycleDigest: string;
  releaseDigest: string;
  serviceDefinitionDigest: string;
  definitionParentIdentityDigest: string;
  definitionIdentityDigest: string | null;
  serviceIdentityDigest: string;
  state: ServiceState;
}>;

export type PrivateMacosServiceRuntimeHostV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_RUNTIME_HOST_V1;
  perform(request: PrivateMacosServiceRuntimeHostRequestV1): Promise<PrivateMacosServiceRuntimeHostReceiptV1>;
  observeHealth(request: PrivateMacosServiceRuntimeHostRequestV1): Promise<unknown>;
  cleanup(signal: AbortSignal): Promise<Readonly<{ outcome: "confirmed" }>>;
}>;

export type PrivateMacosServiceRuntimeControlRequestV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_RUNTIME_PORT_V1;
  action: ControlAction;
  operationId: string;
  lifecycleDigest: string;
  deadlineUnixMs: number;
  signal: AbortSignal;
}>;

export type PrivateMacosServiceRuntimeControlReceiptV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_RUNTIME_RECEIPT_V1;
  action: ControlAction;
  operationId: string;
  requestDigest: string;
  state: Exclude<ServiceState, "unknown">;
  replayed: boolean;
  returnsAtOwnerLogin: true;
  availableBeforeOwnerLogin: false;
}>;

export type PrivateMacosServiceRuntimeAuthorizationContextV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_RUNTIME_AUTHORIZATION_V1;
  action: Exclude<ControlAction, "status">;
  operationId: string;
  requestDigest: string;
  lifecycleDigest: string;
  signal: AbortSignal;
}>;

export type PrivateMacosServiceRuntimePortV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_RUNTIME_PORT_V1;
  nativePort: PrivateMacosServiceNativePortV1;
  preflight(input: Readonly<{ lifecycleDigest: string; deadlineUnixMs: number; signal: AbortSignal }>): Promise<Readonly<{
    schema: typeof PRIVATE_MACOS_SERVICE_RUNTIME_PREFLIGHT_V1;
    ready: true;
    state: Exclude<ServiceState, "unknown">;
    returnsAtOwnerLogin: true;
    availableBeforeOwnerLogin: false;
    startsService: false;
    performsWrite: false;
  }>>;
  control(request: PrivateMacosServiceRuntimeControlRequestV1): Promise<PrivateMacosServiceRuntimeControlReceiptV1>;
}>;

type Input = Readonly<{
  ownerUid: number;
  ownerHome: string;
  releaseDigest: string;
  serviceDefinitionDigest: string;
  expectedDefinitionParentIdentityDigest: string;
  expectedDefinitionIdentityDigest: string | null;
  serviceIdentityDigest: string;
  topologyPlanDigest: string;
  databaseAuthorityDigest: string;
  protectedDataBindingDigest: string;
  supervisorReadinessDigest: string;
  host: PrivateMacosServiceRuntimeHostV1;
  authorizeControl(context: PrivateMacosServiceRuntimeAuthorizationContextV1): Promise<Readonly<{
    schema: typeof PRIVATE_MACOS_SERVICE_RUNTIME_AUTHORIZATION_V1;
    action: Exclude<ControlAction, "status">;
    operationId: string;
    requestDigest: string;
    authorized: true;
  }>>;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const operationIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u;

function sanitized(kind: "refused" | "uncertain"): Error {
  const error = new Error(`private_macos_service_runtime_port_${kind}`);
  error.stack = undefined;
  return error;
}
const refused = (): never => { throw sanitized("refused"); };
const uncertain = (): never => { throw sanitized("uncertain"); };

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || names.some(name => !Object.prototype.hasOwnProperty.call(value, name))
    || keys.some(name => !names.includes(name)) || keys.some(name => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
    })) return refused();
  return value as Readonly<Record<string, unknown>>;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refused();
  return value;
}

function deadline(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= Date.now() || (value as number) > Date.now() + 300_000) return refused();
  return value as number;
}

function signal(value: unknown): AbortSignal {
  if (!value || typeof value !== "object" || typeof (value as AbortSignal).aborted !== "boolean"
    || typeof (value as AbortSignal).addEventListener !== "function") return refused();
  return value as AbortSignal;
}

async function bounded<T>(operation: Promise<T>, deadlineUnixMs: number, operationSignal: AbortSignal,
  effectEntered: boolean): Promise<T> {
  if (operationSignal.aborted || Date.now() >= deadlineUnixMs) return effectEntered ? uncertain() : refused();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(sanitized(effectEntered ? "uncertain" : "refused"));
    abort = fail;
    operationSignal.addEventListener("abort", fail, { once: true });
    timer = setTimeout(fail, Math.max(1, deadlineUnixMs - Date.now()));
  });
  try {
    const value = await Promise.race([operation, interrupted]);
    if (operationSignal.aborted || Date.now() >= deadlineUnixMs) return effectEntered ? uncertain() : refused();
    return value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort) operationSignal.removeEventListener("abort", abort);
  }
}

function captureInput(value: unknown) {
  const input = exact(value, ["ownerUid", "ownerHome", "releaseDigest", "serviceDefinitionDigest",
    "expectedDefinitionParentIdentityDigest", "expectedDefinitionIdentityDigest", "serviceIdentityDigest",
    "topologyPlanDigest", "databaseAuthorityDigest", "protectedDataBindingDigest", "supervisorReadinessDigest", "host",
    "authorizeControl"]);
  const host = exact(input.host, ["schema", "perform", "observeHealth", "cleanup"]);
  if (!Number.isSafeInteger(input.ownerUid) || (input.ownerUid as number) < 1 || (input.ownerUid as number) > 2_147_483_647
    || typeof input.ownerHome !== "string" || !/^\/Users\/[^/]+$/u.test(input.ownerHome)
    || normalize(input.ownerHome) !== input.ownerHome || /[\u0000-\u001f\u007f]/u.test(input.ownerHome)
    || host.schema !== PRIVATE_MACOS_SERVICE_RUNTIME_HOST_V1 || typeof host.perform !== "function"
    || typeof host.observeHealth !== "function" || typeof host.cleanup !== "function"
    || typeof input.authorizeControl !== "function") return refused();
  const expectedDefinitionIdentityDigest = input.expectedDefinitionIdentityDigest === null
    ? null : digest(input.expectedDefinitionIdentityDigest);
  const hostOwner = input.host as PrivateMacosServiceRuntimeHostV1;
  return Object.freeze({ ownerUid: input.ownerUid as number, ownerHome: input.ownerHome,
    launchAgentPath: join(input.ownerHome, "Library", "LaunchAgents", `${PRIVATE_MACOS_SERVICE_LABEL_V1}.plist`),
    launchctlDomain: `gui/${input.ownerUid}`, launchctlTarget: `gui/${input.ownerUid}/${PRIVATE_MACOS_SERVICE_LABEL_V1}`,
    releaseDigest: digest(input.releaseDigest), serviceDefinitionDigest: digest(input.serviceDefinitionDigest),
    expectedDefinitionParentIdentityDigest: digest(input.expectedDefinitionParentIdentityDigest),
    expectedDefinitionIdentityDigest, serviceIdentityDigest: digest(input.serviceIdentityDigest),
    topologyPlanDigest: digest(input.topologyPlanDigest), databaseAuthorityDigest: digest(input.databaseAuthorityDigest),
    protectedDataBindingDigest: digest(input.protectedDataBindingDigest),
    supervisorReadinessDigest: digest(input.supervisorReadinessDigest),
    perform: hostOwner.perform.bind(hostOwner), observeHealth: hostOwner.observeHealth.bind(hostOwner),
    cleanup: hostOwner.cleanup.bind(hostOwner),
    authorizeControl: (input as unknown as Input).authorizeControl.bind(input) });
}

function captureHostReceipt(value: unknown, request: PrivateMacosServiceRuntimeHostRequestV1) {
  const receipt = exact(value, ["schema", "operation", "outcome", "ownerUid", "launchctlDomain", "launchctlTarget",
    "label", "launchAgentPath", "requestDigest", "lifecycleDigest", "releaseDigest", "serviceDefinitionDigest",
    "definitionParentIdentityDigest", "definitionIdentityDigest", "serviceIdentityDigest", "state"]);
  if (receipt.schema !== PRIVATE_MACOS_SERVICE_RUNTIME_RECEIPT_V1 || receipt.operation !== request.operation
    || receipt.outcome !== "succeeded" && receipt.outcome !== "failed_before_effect"
    || receipt.ownerUid !== request.ownerUid || receipt.launchctlDomain !== request.launchctlDomain
    || receipt.launchctlTarget !== request.launchctlTarget || receipt.label !== request.label
    || receipt.launchAgentPath !== request.launchAgentPath || receipt.requestDigest !== request.requestDigest
    || receipt.lifecycleDigest !== request.lifecycleDigest || receipt.releaseDigest !== request.releaseDigest
    || receipt.serviceDefinitionDigest !== request.serviceDefinitionDigest
    || digest(receipt.definitionParentIdentityDigest) !== request.expectedDefinitionParentIdentityDigest
    || digest(receipt.serviceIdentityDigest) !== request.expectedServiceIdentityDigest
    || !["not_installed", "stopped", "running", "unknown"].includes(receipt.state as string)) return uncertain();
  const identity = receipt.definitionIdentityDigest === null ? null : digest(receipt.definitionIdentityDigest);
  if (request.operation === "install_service_definition" && receipt.outcome === "succeeded" && identity === null) return uncertain();
  if (request.operation === "install_service_definition" && receipt.outcome === "failed_before_effect"
    && identity !== request.expectedDefinitionIdentityDigest) return uncertain();
  if (request.operation !== "install_service_definition" && identity !== request.expectedDefinitionIdentityDigest) return uncertain();
  return Object.freeze({ outcome: receipt.outcome as "succeeded" | "failed_before_effect",
    state: receipt.state as ServiceState, definitionIdentityDigest: identity });
}

function captureNativeRequest(value: unknown): PrivateMacosServiceNativeStepRequestV1 {
  const withDefinition = value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "serviceDefinition");
  const request = exact(value, ["schema", "operation", "label", "launchAgentPath", "lifecycleDigest", "requestDigest",
    "releaseDigest", "serviceDefinitionDigest", "expectedDefinitionParentIdentityDigest",
    "expectedDefinitionIdentityDigest", "expectedServiceIdentityDigest", ...(withDefinition ? ["serviceDefinition"] : []),
    "deadlineUnixMs", "signal"]);
  if (request.schema !== PRIVATE_MACOS_SERVICE_NATIVE_PORT_V1 || !["verify_supervisor_readiness", "verify_release",
    "verify_service_definition", "install_service_definition", "start_service", "verify_service_health"]
    .includes(request.operation as string) || request.label !== PRIVATE_MACOS_SERVICE_LABEL_V1
    || typeof request.launchAgentPath !== "string" || typeof request.operation !== "string"
    || (request.operation === "install_service_definition") !== withDefinition
    || (withDefinition && typeof request.serviceDefinition !== "string")) return refused();
  if (withDefinition && sha256Digest(request.serviceDefinition) !== digest(request.serviceDefinitionDigest)) return refused();
  const expectedDefinitionIdentityDigest = request.expectedDefinitionIdentityDigest === null
    ? null : digest(request.expectedDefinitionIdentityDigest);
  return Object.freeze({ schema: PRIVATE_MACOS_SERVICE_NATIVE_PORT_V1,
    operation: request.operation as PrivateMacosServiceNativeStepRequestV1["operation"],
    label: PRIVATE_MACOS_SERVICE_LABEL_V1, launchAgentPath: request.launchAgentPath,
    lifecycleDigest: digest(request.lifecycleDigest), requestDigest: digest(request.requestDigest),
    releaseDigest: digest(request.releaseDigest), serviceDefinitionDigest: digest(request.serviceDefinitionDigest),
    expectedDefinitionParentIdentityDigest: digest(request.expectedDefinitionParentIdentityDigest),
    expectedDefinitionIdentityDigest, expectedServiceIdentityDigest: digest(request.expectedServiceIdentityDigest),
    ...(withDefinition ? { serviceDefinition: request.serviceDefinition as string } : {}),
    deadlineUnixMs: deadline(request.deadlineUnixMs), signal: signal(request.signal) });
}

function captureFinalObservationRequest(value: unknown): PrivateMacosServiceFinalObservationRequestV1 {
  const request = exact(value, ["schema", "operation", "requestDigest", "lifecycleDigest", "label",
    "expectedReleaseDigest", "expectedServiceIdentityDigest", "expectedServiceDefinitionDigest", "deadlineUnixMs"]);
  if (request.schema !== "control-room.private-macos-service-tool/v1"
    || request.operation !== "observe_installed_service" || request.label !== PRIVATE_MACOS_SERVICE_LABEL_V1) return refused();
  return Object.freeze({ schema: "control-room.private-macos-service-tool/v1", operation: "observe_installed_service",
    requestDigest: digest(request.requestDigest), lifecycleDigest: digest(request.lifecycleDigest),
    label: PRIVATE_MACOS_SERVICE_LABEL_V1, expectedReleaseDigest: digest(request.expectedReleaseDigest),
    expectedServiceIdentityDigest: digest(request.expectedServiceIdentityDigest),
    expectedServiceDefinitionDigest: digest(request.expectedServiceDefinitionDigest),
    deadlineUnixMs: deadline(request.deadlineUnixMs) });
}

function hostRequest(captured: ReturnType<typeof captureInput>, operation: NativeOperation, lifecycleDigest: string,
  requestDigest: string, deadlineUnixMs: number, signal: AbortSignal,
  expectedDefinitionIdentityDigest: string | null, serviceDefinition?: string) {
  return Object.freeze({ schema: PRIVATE_MACOS_SERVICE_RUNTIME_HOST_V1, operation,
    ownerUid: captured.ownerUid, launchctlDomain: captured.launchctlDomain, launchctlTarget: captured.launchctlTarget,
    label: PRIVATE_MACOS_SERVICE_LABEL_V1, launchAgentPath: captured.launchAgentPath, requestDigest,
    lifecycleDigest, releaseDigest: captured.releaseDigest, serviceDefinitionDigest: captured.serviceDefinitionDigest,
    expectedDefinitionParentIdentityDigest: captured.expectedDefinitionParentIdentityDigest,
    expectedDefinitionIdentityDigest,
    expectedServiceIdentityDigest: captured.serviceIdentityDigest,
    ...(serviceDefinition === undefined ? {} : { serviceDefinition }), deadlineUnixMs, signal });
}

function captureControlRequest(value: unknown) {
  const request = exact(value, ["schema", "action", "operationId", "lifecycleDigest", "deadlineUnixMs", "signal"]);
  if (request.schema !== PRIVATE_MACOS_SERVICE_RUNTIME_PORT_V1
    || !["status", "start", "stop", "restart"].includes(request.action as string)
    || typeof request.operationId !== "string" || !operationIdPattern.test(request.operationId)
    || !request.signal || typeof request.signal !== "object") return refused();
  return Object.freeze({ action: request.action as ControlAction, operationId: request.operationId,
    lifecycleDigest: digest(request.lifecycleDigest), deadlineUnixMs: deadline(request.deadlineUnixMs),
    signal: signal(request.signal) });
}

function nativeReceipt(request: PrivateMacosServiceNativeStepRequestV1,
  checked: ReturnType<typeof captureHostReceipt>): PrivateMacosServiceNativeStepReceiptV1 {
  return Object.freeze({ schema: PRIVATE_MACOS_SERVICE_NATIVE_RECEIPT_V1, operation: request.operation,
    outcome: checked.outcome, label: request.label, launchAgentPath: request.launchAgentPath,
    requestDigest: request.requestDigest, lifecycleDigest: request.lifecycleDigest, releaseDigest: request.releaseDigest,
    serviceDefinitionDigest: request.serviceDefinitionDigest,
    definitionParentIdentityDigest: request.expectedDefinitionParentIdentityDigest,
    definitionIdentityDigest: checked.definitionIdentityDigest, serviceIdentityDigest: request.expectedServiceIdentityDigest });
}

/**
 * Composes the fixed native service port. Construction is inert. Effects are
 * possible only through the injected host after an exact request is accepted.
 */
export function createPrivateMacosServiceRuntimePortV1(input: unknown): PrivateMacosServiceRuntimePortV1 {
  const captured = captureInput(input);
  const completed = new Map<string, Readonly<{ digest: string; receipt: PrivateMacosServiceRuntimeControlReceiptV1 }>>();
  const inFlight = new Map<string, Readonly<{ digest: string; promise: Promise<PrivateMacosServiceRuntimeControlReceiptV1> }>>();
  const uncertainOperations = new Map<string, string>();
  let definitionIdentityDigest = captured.expectedDefinitionIdentityDigest;
  let nativeInFlight = false;
  let mutationInFlight = false;
  let mutationOutcomeUncertain = false;

  async function invoke(operation: NativeOperation, lifecycleDigest: string, requestDigest: string,
    deadlineUnixMs: number, signal: AbortSignal, expectedIdentity: string | null = definitionIdentityDigest,
    serviceDefinition?: string) {
    if (signal.aborted) return refused();
    const mutating = operation === "install_service_definition" || operation === "start_service" || operation === "stop_service";
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.max(1, deadlineUnixMs - Date.now()));
    const request = hostRequest(captured, operation, lifecycleDigest, requestDigest, deadlineUnixMs, controller.signal,
      expectedIdentity, serviceDefinition);
    try {
      let value: unknown;
      try { value = await bounded(captured.perform(request), deadlineUnixMs, controller.signal, mutating); }
      catch { return uncertain(); }
      try {
        const result = captureHostReceipt(value, request);
        if (signal.aborted || controller.signal.aborted) return uncertain();
        return result;
      } catch { return uncertain(); }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  async function observe(lifecycleDigest: string, requestDigest: string, deadlineUnixMs: number, signal: AbortSignal) {
    const checked = await invoke("inspect_service_status", lifecycleDigest, requestDigest, deadlineUnixMs, signal);
    if (checked.outcome !== "succeeded" || checked.state === "unknown") return refused();
    return checked.state;
  }

  async function controlOnce(request: ReturnType<typeof captureControlRequest>, requestDigest: string) {
    if (request.action !== "status") {
      let result: unknown;
      try { result = await bounded(captured.authorizeControl(Object.freeze({
        schema: PRIVATE_MACOS_SERVICE_RUNTIME_AUTHORIZATION_V1, action: request.action,
        operationId: request.operationId, requestDigest, lifecycleDigest: request.lifecycleDigest,
        signal: request.signal })), request.deadlineUnixMs, request.signal, false); }
      catch { return refused(); }
      const authorization = exact(result, ["schema", "action", "operationId", "requestDigest", "authorized"]);
      if (authorization.schema !== PRIVATE_MACOS_SERVICE_RUNTIME_AUTHORIZATION_V1 || authorization.action !== request.action
        || authorization.operationId !== request.operationId || authorization.requestDigest !== requestDigest
        || authorization.authorized !== true || request.signal.aborted || Date.now() >= request.deadlineUnixMs) return refused();
    }
    const before = await observe(request.lifecycleDigest, requestDigest, request.deadlineUnixMs, request.signal);
    if (request.action === "status") return before;
    let effectSucceeded = false;
    try {
      if (request.action === "start") {
        if (before !== "stopped") return refused();
        const result = await invoke("start_service", request.lifecycleDigest, requestDigest,
          request.deadlineUnixMs, request.signal);
        if (result.outcome !== "succeeded") return refused();
        effectSucceeded = true;
      } else if (request.action === "stop") {
        if (before !== "running") return refused();
        const result = await invoke("stop_service", request.lifecycleDigest, requestDigest,
          request.deadlineUnixMs, request.signal);
        if (result.outcome !== "succeeded") return refused();
        effectSucceeded = true;
      } else {
        if (before !== "running") return refused();
        const stopped = await invoke("stop_service", request.lifecycleDigest, requestDigest,
          request.deadlineUnixMs, request.signal);
        if (stopped.outcome !== "succeeded") return refused();
        effectSucceeded = true;
        if (request.signal.aborted || Date.now() >= request.deadlineUnixMs) return uncertain();
        const started = await invoke("start_service", request.lifecycleDigest, requestDigest,
          request.deadlineUnixMs, request.signal);
        // Once the known stop has happened, a failed or lost start cannot be
        // retried or described as a clean refusal. Reconciliation is required.
        if (started.outcome !== "succeeded") return uncertain();
      }
      if (request.signal.aborted || Date.now() >= request.deadlineUnixMs) return uncertain();
      const after = await observe(request.lifecycleDigest, requestDigest, request.deadlineUnixMs, request.signal);
      const expected = request.action === "stop" ? "stopped" : "running";
      if (after !== expected) return uncertain();
      return after;
    } catch (error) {
      if (effectSucceeded) return uncertain();
      throw error;
    }
  }

  async function performStep(value: PrivateMacosServiceNativeStepRequestV1) {
      if (nativeInFlight) return refused();
      nativeInFlight = true;
      let ownsMutation = false;
      try {
        const request = captureNativeRequest(value);
        if (request.launchAgentPath !== captured.launchAgentPath || request.releaseDigest !== captured.releaseDigest
          || request.serviceDefinitionDigest !== captured.serviceDefinitionDigest
          || request.expectedDefinitionParentIdentityDigest !== captured.expectedDefinitionParentIdentityDigest
          || request.expectedServiceIdentityDigest !== captured.serviceIdentityDigest
          || request.expectedDefinitionIdentityDigest !== definitionIdentityDigest) return refused();
        const mutating = request.operation === "install_service_definition" || request.operation === "start_service";
        if (mutating) {
          if (mutationOutcomeUncertain) return uncertain();
          if (mutationInFlight) return refused();
          mutationInFlight = true; ownsMutation = true;
        }
        const checked = await invoke(request.operation, request.lifecycleDigest, request.requestDigest,
          request.deadlineUnixMs, request.signal, request.expectedDefinitionIdentityDigest, request.serviceDefinition);
        if (request.operation === "install_service_definition" && checked.outcome === "succeeded") {
          definitionIdentityDigest = checked.definitionIdentityDigest;
        }
        return nativeReceipt(request, checked);
      } catch (error) {
        if (ownsMutation && error instanceof Error && error.message.endsWith("_uncertain")) mutationOutcomeUncertain = true;
        throw error;
      } finally {
        if (ownsMutation) mutationInFlight = false;
        nativeInFlight = false;
      }
  }

  async function observeInstalledService(value: PrivateMacosServiceFinalObservationRequestV1,
    operationSignal: AbortSignal) {
    const checkedRequest = captureFinalObservationRequest(value), checkedSignal = signal(operationSignal);
    if (checkedSignal.aborted || checkedRequest.expectedReleaseDigest !== captured.releaseDigest
      || checkedRequest.expectedServiceIdentityDigest !== captured.serviceIdentityDigest
      || checkedRequest.expectedServiceDefinitionDigest !== captured.serviceDefinitionDigest) return uncertain();
    const controller = new AbortController();
    const abort = () => controller.abort();
    checkedSignal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.max(1, checkedRequest.deadlineUnixMs - Date.now()));
    const request = hostRequest(captured, "verify_service_health", checkedRequest.lifecycleDigest,
      checkedRequest.requestDigest, checkedRequest.deadlineUnixMs, controller.signal, definitionIdentityDigest);
    let result: unknown;
    try {
      result = await bounded(captured.observeHealth(request), checkedRequest.deadlineUnixMs, controller.signal, false);
      if (checkedSignal.aborted || controller.signal.aborted || Date.now() >= checkedRequest.deadlineUnixMs) return uncertain();
    } catch { return uncertain(); }
    finally {
      clearTimeout(timer);
      checkedSignal.removeEventListener("abort", abort);
    }
    let health: Readonly<Record<string, unknown>>, healthObservationDigest: string;
    try {
      health = exact(result, ["state", "healthObservationDigest"]);
      if (health.state !== "running") return uncertain();
      healthObservationDigest = digest(health.healthObservationDigest);
    } catch { return uncertain(); }
    const observation = Object.freeze({ state: "running" as const, topologyPlanDigest: captured.topologyPlanDigest,
      releaseDigest: captured.releaseDigest, serviceIdentityDigest: captured.serviceIdentityDigest,
      databaseAuthorityDigest: captured.databaseAuthorityDigest,
      protectedDataBindingDigest: captured.protectedDataBindingDigest,
      supervisorReadinessDigest: captured.supervisorReadinessDigest,
      observationDigest: healthObservationDigest });
    return Object.freeze({ schema: PRIVATE_MACOS_SERVICE_FINAL_OBSERVATION_V1,
      requestDigest: checkedRequest.requestDigest, lifecycleDigest: checkedRequest.lifecycleDigest,
      installedServiceDefinitionDigest: captured.serviceDefinitionDigest, serviceObservation: observation });
  }

  async function cleanup(operationSignal: AbortSignal) {
    const checkedSignal = signal(operationSignal);
    if (checkedSignal.aborted) return uncertain();
    const controller = new AbortController();
    const abort = () => controller.abort();
    checkedSignal.addEventListener("abort", abort, { once: true });
    const deadlineUnixMs = Date.now() + 30_000;
    const timer = setTimeout(abort, 30_000);
    try {
      const value = await bounded(captured.cleanup(controller.signal), deadlineUnixMs, controller.signal, true);
      if (checkedSignal.aborted || controller.signal.aborted) return uncertain();
      const result = exact(value, ["outcome"]);
      if (result.outcome !== "confirmed") return uncertain();
      return Object.freeze({ outcome: "confirmed" as const });
    } catch { return uncertain(); }
    finally {
      clearTimeout(timer);
      checkedSignal.removeEventListener("abort", abort);
    }
  }

  const nativePort: PrivateMacosServiceNativePortV1 = Object.freeze({
    schema: PRIVATE_MACOS_SERVICE_NATIVE_PORT_V1,
    performStep,
    observeInstalledService,
    cleanup,
  });

  return Object.freeze({ schema: PRIVATE_MACOS_SERVICE_RUNTIME_PORT_V1, nativePort,
    async preflight(value) {
      const request = exact(value, ["lifecycleDigest", "deadlineUnixMs", "signal"]);
      const state = await observe(digest(request.lifecycleDigest), sha256Digest({ purpose: "private-macos-service-runtime-preflight/v1",
        lifecycleDigest: request.lifecycleDigest }), deadline(request.deadlineUnixMs), signal(request.signal));
      return Object.freeze({ schema: PRIVATE_MACOS_SERVICE_RUNTIME_PREFLIGHT_V1, ready: true as const, state,
        returnsAtOwnerLogin: true as const, availableBeforeOwnerLogin: false as const,
        startsService: false as const, performsWrite: false as const });
    },
    async control(value) {
      const request = captureControlRequest(value);
      const mutating = request.action !== "status";
      const requestDigest = sha256Digest({ purpose: "private-macos-service-runtime-control/v1",
        action: request.action, operationId: request.operationId, lifecycleDigest: request.lifecycleDigest });
      const done = completed.get(request.operationId);
      if (done) {
        if (done.digest !== requestDigest) return refused();
        return Object.freeze({ ...done.receipt, replayed: true as const });
      }
      const running = inFlight.get(request.operationId);
      if (running) {
        if (running.digest !== requestDigest) return refused();
        const receipt = await running.promise;
        return Object.freeze({ ...receipt, replayed: true as const });
      }
      const poisoned = uncertainOperations.get(request.operationId);
      if (poisoned !== undefined) {
        if (poisoned !== requestDigest) return refused();
        return uncertain();
      }
      if (request.signal.aborted) return refused();
      if (completed.size + uncertainOperations.size + inFlight.size >= 256) return refused();
      if (mutating) {
        if (mutationOutcomeUncertain) return uncertain();
        if (mutationInFlight) return refused();
        mutationInFlight = true;
      }
      const promise = (async () => {
        const state = await controlOnce(request, requestDigest);
        const receipt = Object.freeze({ schema: PRIVATE_MACOS_SERVICE_RUNTIME_RECEIPT_V1, action: request.action,
          operationId: request.operationId, requestDigest, state, replayed: false as const,
          returnsAtOwnerLogin: true as const, availableBeforeOwnerLogin: false as const });
        completed.set(request.operationId, Object.freeze({ digest: requestDigest, receipt }));
        return receipt;
      })();
      inFlight.set(request.operationId, Object.freeze({ digest: requestDigest, promise }));
      try { return await promise; }
      catch (error) {
        if (error instanceof Error && error.message === "private_macos_service_runtime_port_uncertain") {
          uncertainOperations.set(request.operationId, requestDigest);
          if (mutating) mutationOutcomeUncertain = true;
        }
        throw error;
      }
      finally {
        if (mutating) mutationInFlight = false;
        inFlight.delete(request.operationId);
      }
    },
  });
}
