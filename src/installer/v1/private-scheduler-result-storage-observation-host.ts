import { types } from "node:util";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1,
  privateRecoveryNativeFixedArgvV1 } from "./private-recovery-native-execution-host";
import { privateRecoveryReviewedToolPathsV1 } from "./private-recovery-tool-preflight";
import { captureThreeWorkerActivationAggregateBindingV1 } from
  "./three-worker-activation-bundle-preflight";

/**
 * A blocked-only description of the native authority still required to
 * observe one real scheduled run and one disposable restore. The repository
 * has a reviewed recovery tool closure and fixed native protocol, but its
 * execution host still receives caller-supplied ports. It has no protected
 * scheduler observer. Consequently this module deliberately exposes no ready
 * state and accepts no callback or execution port.
 */
export const PRIVATE_SCHEDULER_RESULT_STORAGE_OBSERVATION_HOST_V1 =
  "control-room.private-scheduler-result-storage-observation-host/v1" as const;

export const privateSchedulerResultStorageObservationHostBlockersV1 = Object.freeze([
  "noninjectable_scheduler_observation_host_missing",
  "noninjectable_recovery_native_port_missing",
] as const);

type Binding = ReturnType<typeof captureThreeWorkerActivationAggregateBindingV1>;
type Captured = Readonly<{ aggregate: object; binding: Binding; reportDigest: string }>;
const blockedCapabilities = new WeakMap<object, Captured>();

function refused(): never {
  const error = new Error("private_scheduler_result_storage_observation_host_refused");
  error.stack = undefined;
  throw error;
}

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return refused();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))) return refused();
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return refused();
    result[name] = descriptor.value;
  }
  return Object.freeze(result);
}

export type PrivateSchedulerResultStorageObservationHostBlockedV1 = Readonly<{
  schema: typeof PRIVATE_SCHEDULER_RESULT_STORAGE_OBSERVATION_HOST_V1;
  status: "blocked";
  blockers: typeof privateSchedulerResultStorageObservationHostBlockersV1;
  installationId: string;
  releaseDigest: string;
  topologyPlanDigest: string;
  schedulerRequirement: Readonly<{
    actualScheduledRunObservationRequired: true;
    noninjectableOwnerHostRequired: true;
    protectedConfigurationCustodyRequired: true;
  }>;
  recoveryRequirement: Readonly<{
    protocol: typeof PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1;
    fixedArgvDigest: string;
    reviewedToolClosureDigest: string;
    disposableDatabaseRestoreRequired: true;
    protectedArtifactRestoreRequired: true;
    noninjectableNativePortRequired: true;
  }>;
  acceptsSchedulerCallback: false;
  acceptsRecoveryCallback: false;
  providesEvidenceIssuer: false;
  performsEffect: false;
  startsProcess: false;
  opensDatabase: false;
  readsStorage: false;
  writesStorage: false;
  reportDigest: string;
  capability: object;
}>;

/**
 * Captures only an existing opaque activation aggregate. Extra properties,
 * including structural scheduler/recovery callbacks, are rejected without
 * being read. This is negative evidence, not activation readiness.
 */
export function assessPrivateSchedulerResultStorageObservationHostV1(value: unknown):
PrivateSchedulerResultStorageObservationHostBlockedV1 {
  const input = exact(value, ["aggregate"]);
  if (!input.aggregate || typeof input.aggregate !== "object" || types.isProxy(input.aggregate)) return refused();
  const binding = captureThreeWorkerActivationAggregateBindingV1(input.aggregate);
  const schedulerRequirement = Object.freeze({ actualScheduledRunObservationRequired: true as const,
    noninjectableOwnerHostRequired: true as const, protectedConfigurationCustodyRequired: true as const });
  const recoveryRequirement = Object.freeze({ protocol: PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1,
    fixedArgvDigest: sha256Digest({ purpose: `${PRIVATE_SCHEDULER_RESULT_STORAGE_OBSERVATION_HOST_V1}:argv`,
      argv: privateRecoveryNativeFixedArgvV1 }),
    reviewedToolClosureDigest: sha256Digest({
      purpose: `${PRIVATE_SCHEDULER_RESULT_STORAGE_OBSERVATION_HOST_V1}:reviewed-tools`,
      paths: privateRecoveryReviewedToolPathsV1 }), disposableDatabaseRestoreRequired: true as const,
    protectedArtifactRestoreRequired: true as const, noninjectableNativePortRequired: true as const });
  const reportMaterial = Object.freeze({ schema: PRIVATE_SCHEDULER_RESULT_STORAGE_OBSERVATION_HOST_V1,
    status: "blocked" as const, blockers: privateSchedulerResultStorageObservationHostBlockersV1,
    ...binding, schedulerRequirement, recoveryRequirement, acceptsSchedulerCallback: false as const,
    acceptsRecoveryCallback: false as const, providesEvidenceIssuer: false as const, performsEffect: false as const,
    startsProcess: false as const, opensDatabase: false as const, readsStorage: false as const,
    writesStorage: false as const });
  const reportDigest = sha256Digest(reportMaterial);
  const capability = Object.freeze({ schema: PRIVATE_SCHEDULER_RESULT_STORAGE_OBSERVATION_HOST_V1 });
  blockedCapabilities.set(capability, Object.freeze({ aggregate: input.aggregate as object, binding, reportDigest }));
  return Object.freeze({ ...reportMaterial, reportDigest, capability });
}

/** Consumes the process-local capability only to confirm the blocked finding. */
export function consumePrivateSchedulerResultStorageObservationHostBlockedV1(value: unknown):
Readonly<{ schema: typeof PRIVATE_SCHEDULER_RESULT_STORAGE_OBSERVATION_HOST_V1; status: "blocked";
  reportDigest: string }> {
  const input = exact(value, ["aggregate", "capability"]);
  if (!input.aggregate || typeof input.aggregate !== "object" || types.isProxy(input.aggregate)
    || !input.capability || typeof input.capability !== "object" || types.isProxy(input.capability)) return refused();
  const captured = blockedCapabilities.get(input.capability as object);
  if (!captured || !blockedCapabilities.delete(input.capability as object)) return refused();
  const current = captureThreeWorkerActivationAggregateBindingV1(input.aggregate);
  if (captured.aggregate !== input.aggregate || canonicalJson(current) !== canonicalJson(captured.binding)) return refused();
  return Object.freeze({ schema: PRIVATE_SCHEDULER_RESULT_STORAGE_OBSERVATION_HOST_V1,
    status: "blocked" as const, reportDigest: captured.reportDigest });
}
