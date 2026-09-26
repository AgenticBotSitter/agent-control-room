import { z } from "zod";
import type { HermesLocalDispatchPreparationV1 } from "../../harness/hermes-local-v1";
import type { HermesLocalQueueDeliveryTarget } from "./task-assignment-coordinator";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const unavailable = (): never => { throw new Error("hermes_local_executor_unavailable"); };

export function hermesLocalQueueTargetToDispatchReferenceV1(tenantIdValue: unknown, value: unknown) {
  const tenantId = id.parse(tenantIdValue);
  const target = z.object({ kind: z.literal("hermes-local"), nodeId: id, leaseId: id,
    task: z.object({ projectId: id, jobId: id, attemptId: id, inputDigest: digest }).strict(),
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict().parse(value);
  return Object.freeze({ tenantId, projectId: target.task.projectId, jobId: target.task.jobId,
    attemptId: target.task.attemptId, leaseId: target.leaseId, inputDigest: target.task.inputDigest });
}

/** Joins an already-created generic local CLI delivery bridge to the current
 * Hermes queue locator. The surrounding protected host owns the executable,
 * profile, model, provider, authority fence, receipt port, and publisher. */
export function createHermesLocalQueueExecutorV1(input: Readonly<{
  tenantId: string;
  preparation: Pick<HermesLocalDispatchPreparationV1, "prepare" | "assertCurrent">;
  delivery: Readonly<{ deliver(delivery: unknown, route: unknown, receivedAt: string, signal?: AbortSignal): Promise<{ state: string }> }>;
  clock?: () => number;
}>) {
  if (!input || !input.preparation || typeof input.preparation.prepare !== "function" || typeof input.preparation.assertCurrent !== "function"
    || !input.delivery || typeof input.delivery.deliver !== "function") unavailable();
  const tenantId = id.parse(input.tenantId), clock = input.clock ?? Date.now;
  if (typeof clock !== "function") unavailable();
  return Object.freeze({ async deliver(target: HermesLocalQueueDeliveryTarget, signal: AbortSignal) {
    if (!(signal instanceof AbortSignal) || signal.aborted) unavailable();
    const reference = hermesLocalQueueTargetToDispatchReferenceV1(tenantId, target);
    const prepared = await input.preparation.prepare(reference);
    await input.preparation.assertCurrent(reference, prepared);
    if (signal.aborted) unavailable();
    const now = clock();
    if (!Number.isSafeInteger(now) || now < 0) unavailable();
    const result = await input.delivery.deliver(prepared.delivery, prepared.route, new Date(now).toISOString(), signal);
    if (!result || result.state !== "published" || signal.aborted) unavailable();
  } });
}
