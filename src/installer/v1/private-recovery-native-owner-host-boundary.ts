import { types } from "node:util";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1,
  privateRecoveryNativeFixedArgvV1 } from "./private-recovery-native-execution-host";
import { privateRecoveryReviewedToolPathsV1 } from "./private-recovery-tool-preflight";
import { consumePrivateSchedulerResultStorageObservationHostBlockedV1 } from
  "./private-scheduler-result-storage-observation-host";
import { captureThreeWorkerActivationAggregateBindingV1 } from
  "./three-worker-activation-bundle-preflight";

/**
 * Protected outer boundary for the future native recovery sidecar. The
 * current release has a reviewed tool closure and an injectable sequencing
 * host, but no verified sidecar custody able to own verification, launch and
 * final-currentness checks. This boundary therefore has no success branch.
 */
export const PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BOUNDARY_V1 =
  "control-room.private-recovery-native-owner-host-boundary/v1" as const;
export const PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BIND_V1 =
  "control-room.private-recovery-native-owner-host-bind/v1" as const;

type Binding = ReturnType<typeof captureThreeWorkerActivationAggregateBindingV1>;
type Captured = Readonly<{ aggregate: object; binding: Binding; sourceReportDigest: string;
  boundaryDigest: string }>;
const boundaries = new WeakMap<object, Captured>();

function refused(): never {
  const error = new Error("private_recovery_native_owner_host_boundary_refused");
  error.stack = undefined;
  throw error;
}

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))
    || names.some(name => !keys.includes(name))) return refused();
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return refused();
    result[name] = descriptor.value;
  }
  return Object.freeze(result);
}

export type PrivateRecoveryNativeOwnerHostBoundaryV1 = Readonly<{
  schema: typeof PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BOUNDARY_V1;
  status: "blocked";
  blocker: "verified_recovery_native_sidecar_custody_missing";
  sourceReportDigest: string;
  protocol: typeof PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1;
  fixedArgvDigest: string;
  reviewedToolClosureDigest: string;
  requiredOuterCapability: "opaque_verified_recovery_native_sidecar";
  oneUse: true;
  acceptsConfiguration: false;
  acceptsExecutablePath: false;
  acceptsVerifyExecutionCallback: false;
  acceptsPrepareLaunchCallback: false;
  acceptsAssertCurrentCallback: false;
  providesExecutionAuthority: false;
  performsEffectOnConstruction: false;
  readsProtectedConfiguration: false;
  opensStorage: false;
  opensDatabase: false;
  startsProcess: false;
  boundaryDigest: string;
  capability: object;
}>;

/**
 * Converts only a genuine, same-aggregate blocked observation into one opaque
 * outer-boundary capability. It deliberately accepts none of the injectable
 * ports used by the lower-level recovery sequencing host.
 */
export function createPrivateRecoveryNativeOwnerHostBoundaryV1(value: unknown):
PrivateRecoveryNativeOwnerHostBoundaryV1 {
  const input = exact(value, ["schema", "aggregate", "blockedObservationCapability"]);
  if (input.schema !== PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BOUNDARY_V1
    || !input.aggregate || typeof input.aggregate !== "object" || types.isProxy(input.aggregate)) return refused();
  const binding = captureThreeWorkerActivationAggregateBindingV1(input.aggregate);
  const source = consumePrivateSchedulerResultStorageObservationHostBlockedV1({
    aggregate: input.aggregate, capability: input.blockedObservationCapability });
  const material = Object.freeze({ schema: PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BOUNDARY_V1,
    status: "blocked" as const, blocker: "verified_recovery_native_sidecar_custody_missing" as const,
    sourceReportDigest: source.reportDigest, protocol: PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1,
    fixedArgvDigest: sha256Digest({ purpose: `${PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BOUNDARY_V1}:argv`,
      argv: privateRecoveryNativeFixedArgvV1 }), reviewedToolClosureDigest: sha256Digest({
      purpose: `${PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BOUNDARY_V1}:reviewed-tools`,
      paths: privateRecoveryReviewedToolPathsV1 }),
    requiredOuterCapability: "opaque_verified_recovery_native_sidecar" as const, oneUse: true as const,
    acceptsConfiguration: false as const, acceptsExecutablePath: false as const,
    acceptsVerifyExecutionCallback: false as const, acceptsPrepareLaunchCallback: false as const,
    acceptsAssertCurrentCallback: false as const, providesExecutionAuthority: false as const,
    performsEffectOnConstruction: false as const, readsProtectedConfiguration: false as const,
    opensStorage: false as const, opensDatabase: false as const, startsProcess: false as const });
  const boundaryDigest = sha256Digest({ ...material, binding });
  const capability = Object.freeze({ schema: PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BOUNDARY_V1 });
  boundaries.set(capability, Object.freeze({ aggregate: input.aggregate as object, binding,
    sourceReportDigest: source.reportDigest, boundaryDigest }));
  return Object.freeze({ ...material, boundaryDigest, capability });
}

/**
 * Burns the boundary before refusing. No public creator can mint the required
 * sidecar capability today; structural functions and objects are never
 * treated as native authority and are never invoked.
 */
export function bindPrivateRecoveryNativeOwnerHostV1(value: unknown): never {
  const input = exact(value, ["schema", "aggregate", "boundaryCapability", "nativeSidecarCapability"]);
  if (input.schema !== PRIVATE_RECOVERY_NATIVE_OWNER_HOST_BIND_V1
    || !input.aggregate || typeof input.aggregate !== "object" || types.isProxy(input.aggregate)
    || !input.boundaryCapability || typeof input.boundaryCapability !== "object"
    || types.isProxy(input.boundaryCapability)) return refused();
  const captured = boundaries.get(input.boundaryCapability as object);
  if (!captured || !boundaries.delete(input.boundaryCapability as object)) return refused();
  const current = captureThreeWorkerActivationAggregateBindingV1(input.aggregate);
  if (captured.aggregate !== input.aggregate || canonicalJson(current) !== canonicalJson(captured.binding)) return refused();
  void captured.sourceReportDigest; void captured.boundaryDigest; void input.nativeSidecarCapability;
  return refused();
}
