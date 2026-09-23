import { z } from "zod";
import { executeAndPublishAssignedHermes021MacosTaskV1 } from "../../harness/hermes-021-v1/completed-task-publication";
import type { Hermes021MacosAssignedTaskExecutionV1 } from "../../harness/hermes-021-v1/assigned-task-execution";
import type { DurableResultPublicationConfigurationV1 } from "../../artifacts/v1/durable-result-publication";
import type { ControllerWorkerDeliveryV1 } from "../../harness/v1/controller-worker-delivery";
import type { Hermes021LocalQueueDeliveryTarget } from "./task-assignment-coordinator";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const unavailable = (): never => { throw new Error("hermes_021_local_executor_unavailable"); };
const unresolved = (): never => { throw new Error("hermes_021_local_queue_delivery_unresolved"); };

/** The shared queue may acknowledge a Hermes delivery only after its terminal
 * result entered the ordinary pending-review path. A cancellation, lost local
 * reply, or incomplete publication remains visible for recovery or owner
 * attention; it must never look like successful queue delivery. */
export function requireHermes021LocalQueuePublicationV1(value: unknown): void {
  const publication = z.object({ publication: z.object({}).passthrough().optional() }).passthrough().parse(value).publication;
  // `executeAndPublishAssignedHermes021MacosTaskV1` creates this member only
  // after the existing durable publisher has accepted the exact terminal
  // evidence and produced its review target. The queue boundary intentionally
  // needs no second, divergent copy of that publisher's private shape.
  if (publication === undefined) unresolved();
}

/** Convert only a verified local-queue target into the dispatch reader's
 * narrow reference. This deliberately has no task text, runner command,
 * credential, workspace path, or browser-selected authority. */
export function hermes021LocalQueueTargetToDispatchReferenceV1(tenantIdValue: unknown, value: unknown) {
  const tenantId = id.parse(tenantIdValue);
  const target = z.object({ kind: z.literal("hermes-021-local"), nodeId: id,
    leaseId: id, task: z.object({ projectId: id, jobId: id, attemptId: id, inputDigest: digest }).strict(),
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict().parse(value);
  return Object.freeze({ tenantId, projectId: target.task.projectId,
    jobId: target.task.jobId, attemptId: target.task.attemptId, leaseId: target.leaseId,
    inputDigest: target.task.inputDigest });
}

/**
 * Installation-owned bridge from the existing shared task queue to the local Hermes worker's
 * already-reviewed local composition. It adds no scheduler, broker, database,
 * or Hermes API. The surrounding installation supplies the tenant scope and
 * the private runner; merely constructing this bridge does not invoke Hermes.
 */
export function createHermes021LocalQueueExecutorV1(input: Readonly<{
  tenantId: string;
  execution: Hermes021MacosAssignedTaskExecutionV1;
  results: DurableResultPublicationConfigurationV1;
  assertAuthority: (delivery: ControllerWorkerDeliveryV1) => void;
}>) {
  if (!input || !input.execution || !input.results || typeof input.assertAuthority !== "function") unavailable();
  const tenantId = id.parse(input.tenantId);
  const execution = input.execution, results = input.results, assertAuthority = input.assertAuthority.bind(input);
  return Object.freeze({ async deliver(target: Hermes021LocalQueueDeliveryTarget, signal: AbortSignal) {
    if (!(signal instanceof AbortSignal) || signal.aborted) unavailable();
    const reference = hermes021LocalQueueTargetToDispatchReferenceV1(tenantId, target);
    const result = await executeAndPublishAssignedHermes021MacosTaskV1({ execution, results, assertAuthority },
      reference, signal);
    requireHermes021LocalQueuePublicationV1(result);
    if (signal.aborted) unavailable();
    return result;
  } });
}
