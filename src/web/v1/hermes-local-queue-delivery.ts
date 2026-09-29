import type { NativeTaskSubmissionReference } from "../../persistence/native-task-submission";
import type { HermesLocalQueueDeliveryTarget } from "./task-assignment-coordinator";

const fail = (): never => { throw new Error("hermes_local_queue_delivery_unavailable"); };

/** Narrow switch from the shared queue to the installation-owned current
 * Hermes composition. It carries only a canonical locator, never task text,
 * a command, credential, profile, model, or workspace path. */
export async function deliverVerifiedHermesLocalQueueTaskV1(input: Readonly<{
  reference: NativeTaskSubmissionReference;
  signal: AbortSignal;
  target: HermesLocalQueueDeliveryTarget;
  deliver(target: HermesLocalQueueDeliveryTarget, signal: AbortSignal): Promise<void>;
}>) {
  if (!input || !(input.signal instanceof AbortSignal) || input.signal.aborted || typeof input.deliver !== "function") fail();
  const target = input.target;
  if (!target || target.kind !== "hermes-local" || target.task.projectId !== input.reference.projectId
    || target.task.jobId !== input.reference.jobId || target.task.attemptId !== input.reference.attemptId
    || target.task.inputDigest !== input.reference.inputDigest || target.startsWork !== false
    || target.grantsExecutionAuthority !== false) fail();
  await input.deliver(target, input.signal);
  if (input.signal.aborted) fail();
  return Object.freeze({ disposition: "delivered" as const });
}
