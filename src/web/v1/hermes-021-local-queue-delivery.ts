import type { NativeTaskSubmissionReference } from "../../persistence/native-task-submission";
import type { Hermes021LocalQueueDeliveryTarget } from "./task-assignment-coordinator";

const fail = (): never => { throw new Error("hermes_021_local_queue_delivery_unavailable"); };

/**
 * The small, explicit switch between the shared queue worker and the
 * installation-owned local Hermes composition.  This is intentionally not a
 * generic broker: it accepts only a target already reconstructed by the
 * canonical coordinator, then passes it to a caller-owned executor.  The
 * executor remains responsible for the immediate pre-launch policy check,
 * terminal staging and result publication.
 */
export async function deliverVerifiedHermes021LocalQueueTaskV1(input: Readonly<{
  reference: NativeTaskSubmissionReference;
  signal: AbortSignal;
  target: Hermes021LocalQueueDeliveryTarget;
  deliver(target: Hermes021LocalQueueDeliveryTarget, signal: AbortSignal): Promise<void>;
}>) {
  if (!input || !(input.signal instanceof AbortSignal) || input.signal.aborted
    || typeof input.deliver !== "function") fail();
  const local = input.target;
  if (!local || local.kind !== "hermes-021-local") fail();
  if (local.task.projectId !== input.reference.projectId || local.task.jobId !== input.reference.jobId
    || local.task.attemptId !== input.reference.attemptId || local.task.inputDigest !== input.reference.inputDigest
    || local.startsWork !== false || local.grantsExecutionAuthority !== false || input.signal.aborted) fail();
  await input.deliver(local, input.signal);
  if (input.signal.aborted) fail();
  return Object.freeze({ disposition: "delivered" as const, startsWork: false as const,
    grantsExecutionAuthority: false as const });
}
