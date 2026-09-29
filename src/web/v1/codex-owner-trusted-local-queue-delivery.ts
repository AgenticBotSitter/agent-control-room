import type { NativeTaskSubmissionReference } from "../../persistence/native-task-submission";
import type { CodexOwnerTrustedLocalQueueDeliveryTarget } from "./task-assignment-coordinator";

const fail = (): never => { throw new Error("codex_owner_trusted_local_queue_delivery_unavailable"); };

/** The single narrow hand-off from the shared queue to the protected local
 * Codex composition. This neither starts Codex nor creates an alternate
 * authority, queue, scheduler, or result path. */
export async function deliverVerifiedCodexOwnerTrustedLocalQueueTaskV1(input: Readonly<{
  reference: NativeTaskSubmissionReference;
  signal: AbortSignal;
  target: CodexOwnerTrustedLocalQueueDeliveryTarget;
  deliver(target: CodexOwnerTrustedLocalQueueDeliveryTarget, signal: AbortSignal): Promise<void>;
}>) {
  if (!input || !(input.signal instanceof AbortSignal) || input.signal.aborted || typeof input.deliver !== "function") fail();
  const target = input.target;
  if (!target || target.kind !== "codex-owner-trusted-local" || target.task.projectId !== input.reference.projectId
    || target.task.jobId !== input.reference.jobId || target.task.attemptId !== input.reference.attemptId
    || target.task.inputDigest !== input.reference.inputDigest || target.startsWork !== false
    || target.grantsExecutionAuthority !== false) fail();
  await input.deliver(target, input.signal);
  if (input.signal.aborted) fail();
  return Object.freeze({ disposition: "delivered" as const });
}
