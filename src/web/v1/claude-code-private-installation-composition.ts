import type { ControllerWorkerDeliveryV1 } from "../../harness/v1/controller-worker-delivery";
import type { ClaudeCodeProcessBindingV1 } from "../../harness/claude-code-v1/owned-process-session";
import { createPrivateClaudeCodeInstalledProcessHostV1 } from
  "../../harness/claude-code-v1/private-installed-process-host";
import type { PrivateClaudeCodeInstalledProcessHostConfigurationV1 } from
  "../../harness/claude-code-v1/private-process-acquisition";
import { captureClaudeCodeTextReviewInvocationConfigurationV1 } from
  "../../harness/claude-code-v1/text-review-invocation-policy";
import type { ClaudeCodeLocalAssignedTaskExecutionV1 } from
  "../../harness/claude-code-v1/assigned-task-execution";
import { createClaudeCodeLocalQueueExecutorV1 } from "./claude-code-local-executor";
import type { ClaudeCodeLocalQueueDeliveryTarget } from "./task-assignment-coordinator";
import { assertSynchronousFence } from "../../security/synchronous-fence";
import { verifyLocalClaudePostInstallAdmissionReceiptV1, type LocalClaudePostInstallAdmissionV1 } from
  "../../installer/v1/local-claude-post-install-admission";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "../../harness/claude-code-v1/task-planning-contract";
import { DurableResultReviewSubmissionServiceV1 } from "../../completion-gate/v1/durable-result-review-submission";
import { RoutedTaskResultInspectionServiceV1 } from "../../completion-gate/v1/routed-result-inspection";
import type { AwaitableRollbackCheckpointStoreV1 } from "../../security";

export const CLAUDE_CODE_PRIVATE_INSTALLATION_COMPOSITION_V1 =
  "control-room.claude-code-private-installation-composition/v1" as const;

type DeliveryWithoutAcquire = Omit<ClaudeCodeLocalAssignedTaskExecutionV1["delivery"], "acquire">;
type ExecutionInput = Omit<ClaudeCodeLocalAssignedTaskExecutionV1, "delivery" | "assertAuthority"> & Readonly<{
  delivery: DeliveryWithoutAcquire;
}>;

export type ClaudeCodePrivateInstallationCompositionInputV1 = Readonly<{
  tenantId: string;
  admission: LocalClaudePostInstallAdmissionV1;
  installedProcessConfiguration: PrivateClaudeCodeInstalledProcessHostConfigurationV1;
  ports: Parameters<typeof createPrivateClaudeCodeInstalledProcessHostV1>[1];
  execution: ExecutionInput;
  /** Installation-owned Completion Gate checkpoint store. The composer uses it
   * to build the review-submission service itself; callers cannot inject a
   * look-alike review callback into the private delivery graph. */
  reviewCheckpoints: AwaitableRollbackCheckpointStoreV1;
  assertCurrentProcess(binding: ClaudeCodeProcessBindingV1): void;
  assertCurrentDelivery(delivery: ControllerWorkerDeliveryV1): void;
}>;

export type ClaudeCodePrivateInstalledDeliverCapabilityV1 = Readonly<{
  deliver(target: ClaudeCodeLocalQueueDeliveryTarget, signal: AbortSignal): Promise<void>;
}>;

const branded = new WeakSet<object>();
const deliveryKeys = new WeakMap<object, Uint8Array>();
const unavailable = (): never => { const error = new Error("claude_code_private_installation_composition_unavailable"); error.stack = undefined; throw error; };

/** A bare `{ deliver }` callback cannot cross the private operator boundary. */
export function isClaudeCodePrivateInstalledDeliverCapabilityV1(value: unknown):
  value is ClaudeCodePrivateInstalledDeliverCapabilityV1 {
  if (!value || typeof value !== "object" || !branded.has(value) || !Object.isFrozen(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const names = Object.getOwnPropertyNames(value);
  const descriptor = Object.getOwnPropertyDescriptor(value, "deliver");
  return names.length === 1 && names[0] === "deliver" && !!descriptor && "value" in descriptor
    && typeof descriptor.value === "function" && descriptor.enumerable === true;
}

/**
 * Joins the admitted installed process host to the existing assigned-task and
 * queue executor. Construction is inert; only the branded `deliver` method can
 * reach queue execution, and every call repeats the synchronous retained fence.
 */
export function createClaudeCodePrivateInstallationCompositionV1(
  input: ClaudeCodePrivateInstallationCompositionInputV1): ClaudeCodePrivateInstalledDeliverCapabilityV1 {
  try {
    if (!input || typeof input.assertCurrentProcess !== "function" || typeof input.assertCurrentDelivery !== "function"
      || !input.execution || !input.execution.delivery || !input.execution.protectedStorage
      || typeof input.execution.protectedStorage.put !== "function"
      || typeof input.execution.protectedStorage.read !== "function"
      || !input.reviewCheckpoints || typeof input.reviewCheckpoints.read !== "function"
      || typeof input.reviewCheckpoints.advance !== "function" || typeof input.reviewCheckpoints.initialize !== "function") unavailable();
    const installedProcessConfiguration = captureClaudeCodeTextReviewInvocationConfigurationV1(
      input.installedProcessConfiguration);
    const binding = input.execution.delivery.binding;
    if (binding.adapterId !== CLAUDE_CODE_LOCAL_ADAPTER_V1) unavailable();
    const expectedAdmission = { installationId: input.admission.installationId,
      originalInstallationPlanDigest: input.admission.originalInstallationPlanDigest,
      originalInstallationPlanRevision: input.admission.originalInstallationPlanRevision,
      originalTopologyPlanDigest: input.admission.originalTopologyPlanDigest, releaseDigest: input.admission.releaseDigest,
      databaseAuthorityDigest: input.admission.databaseAuthorityDigest,
      schedulerAuthorityDigest: input.admission.schedulerAuthorityDigest, adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1,
      workerId: binding.workerId,
      adapterRevision: binding.adapterRevision, processConfiguration: installedProcessConfiguration,
      workspaceBindingDigest: installedProcessConfiguration.workingDirectoryBindingDigest } as const;
    verifyLocalClaudePostInstallAdmissionReceiptV1(input.admission, expectedAdmission);
    const assertProcess = input.assertCurrentProcess.bind(input);
    const assertDelivery = input.assertCurrentDelivery.bind(input);
    const host = createPrivateClaudeCodeInstalledProcessHostV1(installedProcessConfiguration, input.ports,
      Object.freeze({ assertCurrent(processBinding: ClaudeCodeProcessBindingV1) {
        verifyLocalClaudePostInstallAdmissionReceiptV1(input.admission, expectedAdmission);
        assertSynchronousFence(() => assertProcess(processBinding), unavailable);
      } }));
    // Result publication is not allowed to take a caller-provided review
    // callback. Build the same narrowly scoped service used by the installed
    // Hermes route from the already-bound result configuration and protected
    // storage. It can only register an authenticated pending owner review.
    if (input.execution.results.reviewSubmission !== undefined) unavailable();
    const reviewSubmission = new DurableResultReviewSubmissionServiceV1(input.execution.results.db, {
      integrityKey: input.execution.results.integrityKey, reviewIntegrityKey: input.execution.results.reviewKey,
      checkpoints: input.reviewCheckpoints, storageClass: input.execution.results.storageClass,
      storage: input.execution.protectedStorage,
    });
    const execution: ClaudeCodeLocalAssignedTaskExecutionV1 = Object.freeze({ ...input.execution,
      results: Object.freeze({ ...input.execution.results, reviewSubmission }),
      delivery: Object.freeze({ ...input.execution.delivery, acquire: host.acquire }),
      assertAuthority(delivery: ControllerWorkerDeliveryV1) {
        verifyLocalClaudePostInstallAdmissionReceiptV1(input.admission, expectedAdmission);
        assertSynchronousFence(() => assertDelivery(delivery), unavailable);
      } });
    const queue = createClaudeCodeLocalQueueExecutorV1({ tenantId: input.tenantId, execution });
    const capability = Object.freeze({ async deliver(target: ClaudeCodeLocalQueueDeliveryTarget, signal: AbortSignal) {
      verifyLocalClaudePostInstallAdmissionReceiptV1(input.admission, expectedAdmission);
      if (!(signal instanceof AbortSignal) || signal.aborted) unavailable();
      return queue.deliver(target, signal);
    } });
    // Older source-only composition tests intentionally omit the receipt key
    // because they never construct a result-inspection bridge. Keep delivery
    // composition inert in that case; the later bridge extension refuses it.
    const receiptKey = input.execution.delivery.integrityKey;
    if (receiptKey instanceof Uint8Array && receiptKey.length === 32)
      deliveryKeys.set(capability, Uint8Array.from(receiptKey));
    branded.add(capability);
    return capability;
  } catch { return unavailable(); }
}

/** The branded Claude delivery capability can contribute only its private
 * receipt verifier to the existing installed Hermes inspection route. It
 * cannot reveal a key, alter task data, or create another worker route. */
export function extendInstalledResultInspectionWithClaudeV1(capability: unknown, source: unknown): RoutedTaskResultInspectionServiceV1 {
  if (!isClaudeCodePrivateInstalledDeliverCapabilityV1(capability)
    || !(source instanceof RoutedTaskResultInspectionServiceV1)) return unavailable();
  const key = deliveryKeys.get(capability);
  if (!key) return unavailable();
  return source.withClaudeDeliveryIntegrityKey(key);
}
