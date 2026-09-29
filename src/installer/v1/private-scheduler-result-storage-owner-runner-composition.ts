import { types } from "node:util";
import { canonicalJson } from "../../security/canonical-digest";
import { createPrivateInstalledConfigurationV3NativeVerifierCustodyV1,
  type PrivateInstalledConfigurationNativeVerifierCustodyV1 } from
  "./private-installed-configuration-native-verifier-custody";
import { captureThreeWorkerActivationAggregateBindingV1 } from
  "./three-worker-activation-bundle-preflight";

/**
 * Inert protected composition for the future owner-attended scheduler and
 * result-storage proof. It can hold exact native installed-configuration
 * verifier custody, but it cannot read it or invoke a scheduler/storage host.
 * No outer host capability exists yet, so every invocation remains blocked.
 */
export const PRIVATE_SCHEDULER_RESULT_STORAGE_OWNER_RUNNER_COMPOSITION_V1 =
  "control-room.private-scheduler-result-storage-owner-runner-composition/v1" as const;
export const PRIVATE_SCHEDULER_RESULT_STORAGE_OWNER_RUNNER_INVOCATION_V1 =
  "control-room.private-scheduler-result-storage-owner-runner-invocation/v1" as const;

type Binding = ReturnType<typeof captureThreeWorkerActivationAggregateBindingV1>;
type Captured = Readonly<{ aggregate: object; binding: Binding;
  verifier?: PrivateInstalledConfigurationNativeVerifierCustodyV1 }>;
const compositions = new WeakMap<object, Captured>();

function refused(): never { const error = new Error("private_scheduler_result_storage_owner_runner_refused");
  error.stack = undefined; throw error; }
function exact(value: unknown, names: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return refused();
  const keys = Object.getOwnPropertyNames(value), result: Record<string, unknown> = {};
  if (keys.length !== names.length || keys.some(key => !names.includes(key))) return refused();
  for (const name of names) { const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return refused(); result[name] = descriptor.value; }
  return Object.freeze(result);
}

export type PrivateSchedulerResultStorageOwnerRunnerCompositionV1 = Readonly<{
  schema: typeof PRIVATE_SCHEDULER_RESULT_STORAGE_OWNER_RUNNER_COMPOSITION_V1;
  status: "blocked";
  blocker: "protected_configuration_custody_missing" | "owner_attended_scheduler_restore_host_missing";
  oneUse: true;
  providesGenericIssuer: false;
  acceptsSchedulerCallback: false;
  acceptsStorageCallback: false;
  acceptsRestoreCallback: false;
  performsEffectOnConstruction: false;
  opensProtectedConfiguration: false;
  opensScheduler: false;
  opensStorage: false;
  runsScheduledTask: false;
  runsBackup: false;
  runsRestore: false;
  capability: object;
}>;

/**
 * `postWriteVerificationCapability` may be omitted to represent the current
 * owner proof gap. When supplied it must be the genuine one-use capability
 * minted by the protected native owner writer; structural copies are refused.
 */
export function createPrivateSchedulerResultStorageOwnerRunnerCompositionV1(value: unknown):
PrivateSchedulerResultStorageOwnerRunnerCompositionV1 {
  const input = exact(value, ["aggregate", "postWriteVerificationCapability"]);
  if (!input.aggregate || typeof input.aggregate !== "object" || types.isProxy(input.aggregate)) return refused();
  const binding = captureThreeWorkerActivationAggregateBindingV1(input.aggregate);
  let verifier: PrivateInstalledConfigurationNativeVerifierCustodyV1 | undefined;
  if (input.postWriteVerificationCapability !== undefined)
    verifier = createPrivateInstalledConfigurationV3NativeVerifierCustodyV1(input.postWriteVerificationCapability);
  const capability = Object.freeze({ schema: PRIVATE_SCHEDULER_RESULT_STORAGE_OWNER_RUNNER_COMPOSITION_V1 });
  compositions.set(capability, Object.freeze({ aggregate: input.aggregate as object, binding, ...(verifier ? { verifier } : {}) }));
  return Object.freeze({ schema: PRIVATE_SCHEDULER_RESULT_STORAGE_OWNER_RUNNER_COMPOSITION_V1,
    status: "blocked" as const, blocker: verifier ? "owner_attended_scheduler_restore_host_missing" as const
      : "protected_configuration_custody_missing" as const, oneUse: true as const,
    providesGenericIssuer: false as const, acceptsSchedulerCallback: false as const,
    acceptsStorageCallback: false as const, acceptsRestoreCallback: false as const,
    performsEffectOnConstruction: false as const, opensProtectedConfiguration: false as const,
    opensScheduler: false as const, opensStorage: false as const, runsScheduledTask: false as const,
    runsBackup: false as const, runsRestore: false as const, capability });
}

/**
 * Burns one prepared composition. The future outer owner host must be an
 * opaque producer capability; no such producer exists today, so this function
 * refuses before loading configuration or calling any supplied value.
 */
export function invokePrivateSchedulerResultStorageOwnerRunnerV1(value: unknown): never {
  const input = exact(value, ["schema", "aggregate", "compositionCapability", "ownerInvocationCapability"]);
  if (input.schema !== PRIVATE_SCHEDULER_RESULT_STORAGE_OWNER_RUNNER_INVOCATION_V1
    || !input.compositionCapability || typeof input.compositionCapability !== "object"
    || types.isProxy(input.compositionCapability)) return refused();
  const captured = compositions.get(input.compositionCapability as object);
  if (!captured || !compositions.delete(input.compositionCapability as object)) return refused();
  const current = captureThreeWorkerActivationAggregateBindingV1(input.aggregate);
  if (input.aggregate !== captured.aggregate || canonicalJson(current) !== canonicalJson(captured.binding)) return refused();
  // A structural object/function is never owner presence or execution proof.
  // The verifier custody is intentionally retained but not opened here.
  void captured.verifier; void input.ownerInvocationCapability;
  return refused();
}
