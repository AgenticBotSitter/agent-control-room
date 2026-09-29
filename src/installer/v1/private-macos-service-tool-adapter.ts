import { isAbsolute, join, normalize } from "node:path";
import { createMacosLocalServicePackageV1 } from "../../harness/v1/macos-local-service-package";
import { sha256Digest } from "../../security/canonical-digest";
import { MACOS_SERVICE_OWNER_ACTION_SIMULATION_V1, macosServiceIdentityDigestV1 } from "./macos-service-owner-action";
import { PRIVATE_MACOS_SERVICE_FINAL_OBSERVATION_V1, PRIVATE_MACOS_SERVICE_LABEL_V1,
  PRIVATE_MACOS_SERVICE_TOOL_V1, type PrivateMacosServiceFinalObservationRequestV1,
  type PrivateMacosServiceOwnerToolV1, type PrivateMacosServiceToolRequestV1 } from
  "./private-macos-service-owner-runner";

/**
 * Production-shaped boundary beneath the accepted macOS service owner runner.
 * Node cannot provide descriptor-relative no-follow LaunchAgent publication or
 * an identity-bound service-manager operation, so this module deliberately
 * requires one separately reviewed native port and supplies no fallback.
 */
export const PRIVATE_MACOS_SERVICE_TOOL_ADAPTER_V1 =
  "control-room.private-macos-service-tool-adapter/v1" as const;
export const PRIVATE_MACOS_SERVICE_NATIVE_PORT_V1 =
  "control-room.private-macos-service-native-port/v1" as const;
export const PRIVATE_MACOS_SERVICE_NATIVE_RECEIPT_V1 =
  "control-room.private-macos-service-native-receipt/v1" as const;

const operations = Object.freeze(["verify_supervisor_readiness", "verify_release", "verify_service_definition",
  "install_service_definition", "start_service", "verify_service_health"] as const);
type Operation = typeof operations[number];
type PackageInput = Parameters<typeof createMacosLocalServicePackageV1>[0];

export type PrivateMacosServiceNativeStepRequestV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_NATIVE_PORT_V1;
  operation: Operation;
  label: typeof PRIVATE_MACOS_SERVICE_LABEL_V1;
  launchAgentPath: string;
  lifecycleDigest: string;
  requestDigest: string;
  releaseDigest: string;
  serviceDefinitionDigest: string;
  expectedDefinitionParentIdentityDigest: string;
  expectedDefinitionIdentityDigest: string | null;
  expectedServiceIdentityDigest: string;
  serviceDefinition?: string;
  deadlineUnixMs: number;
  signal: AbortSignal;
}>;

export type PrivateMacosServiceNativeStepReceiptV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_NATIVE_RECEIPT_V1;
  operation: Operation;
  outcome: "succeeded" | "failed_before_effect";
  label: typeof PRIVATE_MACOS_SERVICE_LABEL_V1;
  launchAgentPath: string;
  requestDigest: string;
  lifecycleDigest: string;
  releaseDigest: string;
  serviceDefinitionDigest: string;
  definitionParentIdentityDigest: string;
  definitionIdentityDigest: string | null;
  serviceIdentityDigest: string;
}>;

export type PrivateMacosServiceNativePortV1 = Readonly<{
  schema: typeof PRIVATE_MACOS_SERVICE_NATIVE_PORT_V1;
  performStep(request: PrivateMacosServiceNativeStepRequestV1): Promise<PrivateMacosServiceNativeStepReceiptV1>;
  observeInstalledService(request: PrivateMacosServiceFinalObservationRequestV1, signal: AbortSignal): Promise<unknown>;
  cleanup(signal: AbortSignal): Promise<Readonly<{ outcome: "confirmed" }>>;
}>;

type Input = Readonly<{
  lifecycleDigest: string;
  releaseDigest: string;
  expectedLaunchAgentsDirectoryIdentityDigest: string;
  servicePackageInput: PackageInput;
  ownerHome: string;
  launchAgentPath: string;
  nativePort: PrivateMacosServiceNativePortV1;
}>;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
function sanitized(kind: "refused" | "uncertain"): Error {
  const error = new Error(`private_macos_service_tool_adapter_${kind}`); error.stack = undefined; return error;
}
const refused = (): never => { throw sanitized("refused"); };
const uncertain = (): never => { throw sanitized("uncertain"); };

function exact(value: unknown, names: readonly string[]) {
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

function digest(value: unknown) {
  if (typeof value !== "string" || !digestPattern.test(value)) return refused();
  return value;
}

function canonicalPath(value: unknown) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || !isAbsolute(value)
    || normalize(value) !== value || /[\u0000-\u001f\u007f]/u.test(value)) return refused();
  return value;
}

function capture(value: unknown) {
  const input = exact(value, ["lifecycleDigest", "releaseDigest", "expectedLaunchAgentsDirectoryIdentityDigest",
    "servicePackageInput", "ownerHome", "launchAgentPath", "nativePort"]);
  const native = exact(input.nativePort, ["schema", "performStep", "observeInstalledService", "cleanup"]);
  if (native.schema !== PRIVATE_MACOS_SERVICE_NATIVE_PORT_V1 || typeof native.performStep !== "function"
    || typeof native.observeInstalledService !== "function" || typeof native.cleanup !== "function") return refused();
  let servicePackageInput: PackageInput, package_: ReturnType<typeof createMacosLocalServicePackageV1>;
  try { servicePackageInput = structuredClone(input.servicePackageInput) as PackageInput;
    package_ = createMacosLocalServicePackageV1(servicePackageInput); } catch { return refused(); }
  if (package_.label !== PRIVATE_MACOS_SERVICE_LABEL_V1) return refused();
  const ownerHome = canonicalPath(input.ownerHome), launchAgentPath = canonicalPath(input.launchAgentPath);
  if (!/^\/Users\/[^/]+$/u.test(ownerHome)
    || launchAgentPath !== join(ownerHome, "Library", "LaunchAgents", `${PRIVATE_MACOS_SERVICE_LABEL_V1}.plist`)) return refused();
  return Object.freeze({ lifecycleDigest: digest(input.lifecycleDigest), releaseDigest: digest(input.releaseDigest),
    expectedLaunchAgentsDirectoryIdentityDigest: digest(input.expectedLaunchAgentsDirectoryIdentityDigest),
    expectedServiceIdentityDigest: macosServiceIdentityDigestV1(servicePackageInput), servicePackageInput, package_, ownerHome,
    launchAgentPath,
    performStep: (native.performStep as PrivateMacosServiceNativePortV1["performStep"]).bind(input.nativePort),
    observeInstalledService: (native.observeInstalledService as PrivateMacosServiceNativePortV1["observeInstalledService"])
      .bind(input.nativePort), cleanup: (native.cleanup as PrivateMacosServiceNativePortV1["cleanup"]).bind(input.nativePort) });
}

function captureStep(value: unknown, captured: ReturnType<typeof capture>, index: number) {
  const request = exact(value, ["schema", "requestDigest", "deadlineUnixMs", "step"]);
  const step = exact(request.step, ["schema", "lifecycleDigest", "action", "phase", "operation", "kind",
    "timeoutSeconds", "label", ...(index === 3 ? ["serviceDefinition"] : [])]);
  const operation = operations[index];
  if (request.schema !== PRIVATE_MACOS_SERVICE_TOOL_V1 || !operation || request.step === undefined
    || step.schema !== MACOS_SERVICE_OWNER_ACTION_SIMULATION_V1 || step.lifecycleDigest !== captured.lifecycleDigest
    || step.action !== "install" || step.phase !== "primary" || step.operation !== operation
    || step.kind !== (index === 3 ? "administrative_write" : index === 4 ? "service_transition" : "read")
    || step.label !== PRIVATE_MACOS_SERVICE_LABEL_V1 || !Number.isSafeInteger(request.deadlineUnixMs)
    || (request.deadlineUnixMs as number) <= Date.now() || step.timeoutSeconds !== (index === 4 ? 120 : 30)) return refused();
  if (index === 3) {
    const definition = exact(step.serviceDefinition, ["label", "plist", "startsWork", "grantsExecutionAuthority"]);
    if (definition.label !== PRIVATE_MACOS_SERVICE_LABEL_V1 || definition.plist !== captured.package_.plist
      || definition.startsWork !== false || definition.grantsExecutionAuthority !== false) return refused();
  }
  return Object.freeze({ requestDigest: digest(request.requestDigest), deadlineUnixMs: request.deadlineUnixMs as number,
    timeoutSeconds: step.timeoutSeconds as number, operation,
    serviceDefinition: index === 3 ? captured.package_.plist : undefined });
}

function receipt(value: unknown, request: PrivateMacosServiceNativeStepRequestV1) {
  try {
    const result = exact(value, ["schema", "operation", "outcome", "label", "launchAgentPath", "requestDigest",
      "lifecycleDigest", "releaseDigest", "serviceDefinitionDigest",
      "definitionParentIdentityDigest", "definitionIdentityDigest", "serviceIdentityDigest"]);
    if (result.schema !== PRIVATE_MACOS_SERVICE_NATIVE_RECEIPT_V1 || result.operation !== request.operation
      || result.label !== request.label || result.launchAgentPath !== request.launchAgentPath
      || result.requestDigest !== request.requestDigest || result.lifecycleDigest !== request.lifecycleDigest
      || result.releaseDigest !== request.releaseDigest || result.serviceDefinitionDigest !== request.serviceDefinitionDigest
      || (result.outcome !== "succeeded" && result.outcome !== "failed_before_effect")) return uncertain();
    if (digest(result.definitionParentIdentityDigest) !== request.expectedDefinitionParentIdentityDigest
      || digest(result.serviceIdentityDigest) !== request.expectedServiceIdentityDigest) return uncertain();
    const definitionIdentityDigest = result.definitionIdentityDigest === null ? null : digest(result.definitionIdentityDigest);
    if (request.operation === "install_service_definition") {
      if (result.outcome === "succeeded" && definitionIdentityDigest === null) return uncertain();
      if (result.outcome === "failed_before_effect" && definitionIdentityDigest !== request.expectedDefinitionIdentityDigest) return uncertain();
    } else if (definitionIdentityDigest !== request.expectedDefinitionIdentityDigest) return uncertain();
    return Object.freeze({ outcome: result.outcome as "succeeded" | "failed_before_effect", definitionIdentityDigest });
  } catch { return uncertain(); }
}

/** Builds an inert tool. Effects occur only when the owner runner invokes it. */
export function createPrivateMacosServiceToolAdapterV1(input: unknown): PrivateMacosServiceOwnerToolV1 {
  const captured = capture(input); let index = 0, requestDigest: string | undefined;
  let definitionIdentityDigest: string | null = null, inFlight = false, terminal = false;
  return Object.freeze({ schema: PRIVATE_MACOS_SERVICE_TOOL_V1,
    async executeStep(value: PrivateMacosServiceToolRequestV1, signal: AbortSignal) {
      if (inFlight || terminal) return refused();
      inFlight = true;
      try {
      const step = captureStep(value, captured, index);
      if (signal.aborted || (requestDigest !== undefined && requestDigest !== step.requestDigest)) return refused();
      requestDigest = step.requestDigest;
      const now = Date.now(), nativeDeadlineUnixMs = Math.min(step.deadlineUnixMs, now + step.timeoutSeconds * 1000);
      if (nativeDeadlineUnixMs <= now) return refused();
      const nativeRequest = Object.freeze({ schema: PRIVATE_MACOS_SERVICE_NATIVE_PORT_V1, operation: step.operation,
        label: PRIVATE_MACOS_SERVICE_LABEL_V1, launchAgentPath: captured.launchAgentPath,
        lifecycleDigest: captured.lifecycleDigest, requestDigest: step.requestDigest, releaseDigest: captured.releaseDigest,
        serviceDefinitionDigest: sha256Digest(captured.package_.plist),
        expectedDefinitionParentIdentityDigest: captured.expectedLaunchAgentsDirectoryIdentityDigest,
        expectedDefinitionIdentityDigest: definitionIdentityDigest,
        expectedServiceIdentityDigest: captured.expectedServiceIdentityDigest,
        ...(step.serviceDefinition === undefined ? {} : { serviceDefinition: step.serviceDefinition }),
        deadlineUnixMs: nativeDeadlineUnixMs, signal });
      let result: unknown;
      try { result = await captured.performStep(nativeRequest); } catch { terminal = true; return uncertain(); }
      if (signal.aborted) return uncertain();
      const checked = receipt(result, nativeRequest);
      if (checked.outcome === "succeeded") {
        if (step.operation === "install_service_definition") definitionIdentityDigest = checked.definitionIdentityDigest;
        index += 1;
      } else terminal = true;
      return Object.freeze({ outcome: checked.outcome });
      } catch (error) { terminal = true; throw error; }
      finally { inFlight = false; }
    },
    async observeFinal(value: PrivateMacosServiceFinalObservationRequestV1, signal: AbortSignal) {
      const observation = exact(value, ["schema", "operation", "requestDigest", "lifecycleDigest", "label",
        "expectedReleaseDigest", "expectedServiceIdentityDigest", "expectedServiceDefinitionDigest", "deadlineUnixMs"]);
      if (index !== operations.length || signal.aborted || observation.schema !== PRIVATE_MACOS_SERVICE_TOOL_V1
        || observation.operation !== "observe_installed_service" || observation.label !== PRIVATE_MACOS_SERVICE_LABEL_V1
        || observation.lifecycleDigest !== captured.lifecycleDigest || observation.expectedReleaseDigest !== captured.releaseDigest
        || observation.expectedServiceIdentityDigest !== captured.expectedServiceIdentityDigest
        || observation.expectedServiceDefinitionDigest !== sha256Digest(captured.package_.plist)
        || observation.requestDigest !== requestDigest || !Number.isSafeInteger(observation.deadlineUnixMs)
        || (observation.deadlineUnixMs as number) <= Date.now()) return uncertain();
      try {
        const result = await captured.observeInstalledService(Object.freeze({ ...value }), signal);
        if (signal.aborted) return uncertain();
        const record = exact(result, ["schema", "requestDigest", "lifecycleDigest", "installedServiceDefinitionDigest",
          "serviceObservation"]);
        if (record.schema !== PRIVATE_MACOS_SERVICE_FINAL_OBSERVATION_V1) return uncertain();
        return result;
      } catch { return uncertain(); }
    },
    async cleanup(signal: AbortSignal) {
      if (signal.aborted) return uncertain();
      try { const result = exact(await captured.cleanup(signal), ["outcome"]);
        if (signal.aborted) return uncertain();
        if (result.outcome !== "confirmed") return uncertain(); return Object.freeze({ outcome: "confirmed" as const }); }
      catch { return uncertain(); }
    },
  });
}
