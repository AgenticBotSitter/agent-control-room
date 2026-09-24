import type { NativeTaskSubmissionReference } from "../../persistence/native-task-submission";
import type { RemoteControllerWorkerMaterializerV1 } from "../../harness/v1/remote-controller-worker-materializer";
import type { RemoteControllerWorkerQueueDeliveryTarget } from "./task-assignment-coordinator";

const unavailable = (): never => { throw new Error("remote_controller_worker_queue_delivery_unavailable"); };

/**
 * The narrow queue-worker switch for the controller-worker remote route.  It
 * accepts only a canonical locator and invokes the installation-owned
 * materializer, which independently rebuilds the protected worker/session
 * binding. This switch owns neither a connection nor receipt persistence.
 */
export async function deliverVerifiedRemoteControllerWorkerQueueTaskV1(input: Readonly<{
  reference: NativeTaskSubmissionReference;
  signal: AbortSignal;
  target: RemoteControllerWorkerQueueDeliveryTarget;
  materializer: Pick<RemoteControllerWorkerMaterializerV1, "prepare" | "transmit">;
}>) {
  if (!input || !(input.signal instanceof AbortSignal) || input.signal.aborted
    || !input.materializer || typeof input.materializer.prepare !== "function" || typeof input.materializer.transmit !== "function") unavailable();
  const target = input.target, ref = input.reference;
  if (!target || target.kind !== "controller-worker-remote" || target.nodeId.length < 3 || target.leaseId.length < 3
    || !Number.isSafeInteger(target.leaseEpoch) || target.leaseEpoch < 1
    || target.task.projectId !== ref.projectId || target.task.jobId !== ref.jobId || target.task.attemptId !== ref.attemptId
    || target.task.inputDigest !== ref.inputDigest || target.startsWork !== false || target.grantsExecutionAuthority !== false) unavailable();
  const materialization = Object.freeze({ tenantId: ref.tenantId, projectId: ref.projectId, jobId: ref.jobId,
    attemptId: ref.attemptId, leaseId: target.leaseId, leaseEpoch: target.leaseEpoch, inputDigest: ref.inputDigest });
  const prepared = await input.materializer.prepare(materialization);
  if (input.signal.aborted) unavailable();
  const result = await input.materializer.transmit(materialization, prepared, input.signal);
  // A transport send is not acknowledgement. The existing queue retains this
  // as unresolved until the exact receipt has reached canonical persistence.
  if (input.signal.aborted || result.kind !== "already_recorded")
    throw new Error("native_task_delivery_unresolved");
  return Object.freeze({ disposition: "delivered" as const });
}
