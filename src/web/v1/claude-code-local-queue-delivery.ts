import type { NativeTaskSubmissionReference } from "../../persistence/native-task-submission";
import type { ClaudeCodeLocalQueueDeliveryTarget } from "./task-assignment-coordinator";

const fail = (): never => { throw new Error("claude_code_local_queue_delivery_unavailable"); };

/** The one narrow switch from the shared queue to an installation-owned Claude
 * composition. It neither starts Claude nor adds a broker or authority. */
export async function deliverVerifiedClaudeCodeLocalQueueTaskV1(input: Readonly<{
  reference: NativeTaskSubmissionReference;
  signal: AbortSignal;
  target: ClaudeCodeLocalQueueDeliveryTarget;
  deliver(target: ClaudeCodeLocalQueueDeliveryTarget, signal: AbortSignal): Promise<void>;
}>) {
  if (!input || !(input.signal instanceof AbortSignal) || input.signal.aborted || typeof input.deliver !== "function") fail();
  const target = input.target;
  if (!target || target.kind !== "claude-code-local" || target.task.projectId !== input.reference.projectId
    || target.task.jobId !== input.reference.jobId || target.task.attemptId !== input.reference.attemptId
    || target.task.inputDigest !== input.reference.inputDigest || target.startsWork !== false
    || target.grantsExecutionAuthority !== false) fail();
  await input.deliver(target, input.signal);
  if (input.signal.aborted) fail();
  return Object.freeze({ disposition: "delivered" as const });
}
