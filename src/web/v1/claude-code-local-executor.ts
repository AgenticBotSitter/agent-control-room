import { z } from "zod";
import type { ClaudeCodeLocalAssignedTaskExecutionV1 } from "../../harness/claude-code-v1/assigned-task-execution";
import { executeAssignedClaudeCodeLocalTaskV1 } from "../../harness/claude-code-v1/assigned-task-execution";
import type { ClaudeCodeLocalQueueDeliveryTarget } from "./task-assignment-coordinator";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const unavailable = (): never => { throw new Error("claude_code_local_executor_unavailable"); };
const unresolved = (): never => { throw new Error("claude_code_local_queue_delivery_unresolved"); };

/** The shared queue may acknowledge only a result that entered the existing
 * review path. All other outcomes deliberately remain visible for recovery or
 * operator attention and must not look like completed delivery. */
export function requireClaudeCodeQueuePublicationV1(value: unknown): void {
  const state = z.object({ state: z.enum(["published_pending_review", "recovered_pending_review", "terminal_result_uncertain", "not_started"]) }).passthrough()
    .parse(value).state;
  if (state !== "published_pending_review" && state !== "recovered_pending_review") unresolved();
}

/** Converts only a fully reconstructed queue target into the dispatch reader's
 * narrow locator. No prompt, command, settings, credential, workspace or raw
 * process output can cross this boundary. */
export function claudeCodeLocalQueueTargetToDispatchReferenceV1(tenantIdValue: unknown, value: unknown) {
  const tenantId = id.parse(tenantIdValue);
  const target = z.object({ kind: z.literal("claude-code-local"), nodeId: id, leaseId: id,
    task: z.object({ projectId: id, jobId: id, attemptId: id, inputDigest: digest }).strict(),
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict().parse(value);
  return Object.freeze({ tenantId, projectId: target.task.projectId, jobId: target.task.jobId,
    attemptId: target.task.attemptId, leaseId: target.leaseId, inputDigest: target.task.inputDigest });
}

/** Installation-owned endpoint used only after the shared queue has verified
 * the target. Constructing it cannot start Claude. */
export function createClaudeCodeLocalQueueExecutorV1(input: Readonly<{
  tenantId: string;
  execution: ClaudeCodeLocalAssignedTaskExecutionV1;
}>) {
  if (!input || !input.execution) unavailable();
  const tenantId = id.parse(input.tenantId), execution = input.execution;
  return Object.freeze({ async deliver(target: ClaudeCodeLocalQueueDeliveryTarget, signal: AbortSignal) {
    if (!(signal instanceof AbortSignal) || signal.aborted) unavailable();
    const reference = claudeCodeLocalQueueTargetToDispatchReferenceV1(tenantId, target);
    const outcome = await executeAssignedClaudeCodeLocalTaskV1(execution, reference, signal);
    // A queue acknowledgement means a result reached the ordinary review
    // path. Receipt uncertainty and missing/altered staged evidence need
    // attention; treating either as delivery would silently lose that work.
    requireClaudeCodeQueuePublicationV1(outcome);
    if (signal.aborted) unavailable();
  } });
}
