import { z } from "zod";
import type { CodexOwnerTrustedLocalPreparedDispatchV1, CodexOwnerTrustedLocalDispatchReferenceV1 } from "../../harness/codex-v1/owner-trusted-local-dispatch-preparation";
import type { CodexOwnerTrustedLocalQueueDeliveryTarget } from "./task-assignment-coordinator";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const unavailable = (): never => { throw new Error("codex_owner_trusted_local_executor_unavailable"); };
const unresolved = (): never => { throw new Error("codex_owner_trusted_local_queue_delivery_unresolved"); };

/** Converts only the verified queue locator into the smaller canonical
 * reconstruction reference. No task prompt, command, model, account, path,
 * or local process data can cross this boundary. */
export function codexOwnerTrustedLocalQueueTargetToDispatchReferenceV1(tenantIdValue: unknown, value: unknown): CodexOwnerTrustedLocalDispatchReferenceV1 {
  const tenantId = id.parse(tenantIdValue);
  const target = z.object({ kind: z.literal("codex-owner-trusted-local"), nodeId: id, leaseId: id,
    task: z.object({ projectId: id, jobId: id, attemptId: id, inputDigest: digest }).strict(),
    startsWork: z.literal(false), grantsExecutionAuthority: z.literal(false) }).strict().parse(value);
  return Object.freeze({ tenantId, projectId: target.task.projectId, jobId: target.task.jobId,
    attemptId: target.task.attemptId, leaseId: target.leaseId, inputDigest: target.task.inputDigest });
}

type Preparation = Readonly<{
  prepare(reference: CodexOwnerTrustedLocalDispatchReferenceV1): Promise<CodexOwnerTrustedLocalPreparedDispatchV1>;
  assertCurrent(reference: CodexOwnerTrustedLocalDispatchReferenceV1, prepared: unknown): Promise<void>;
}>;
type Delivery = Readonly<{
  deliver(delivery: unknown, route: unknown, receivedAt: string, signal?: AbortSignal): Promise<Readonly<{ state: string }>>;
}>;

/**
 * Protected-host bridge from the one shared queue to the previously composed
 * local Codex CLI delivery. The injected delivery owns the existing durable
 * receipt, final authority recheck, fixed process policy, and canonical result
 * publisher. This executor adds none of those things and acknowledges the
 * queue only after that existing publisher reports success.
 */
export function createCodexOwnerTrustedLocalQueueExecutorV1(input: Readonly<{
  tenantId: string;
  preparation: Preparation;
  delivery: Delivery;
  clock?: () => number;
}>) {
  if (!input || !input.preparation || typeof input.preparation.prepare !== "function"
    || typeof input.preparation.assertCurrent !== "function" || !input.delivery || typeof input.delivery.deliver !== "function") unavailable();
  const tenantId = id.parse(input.tenantId), preparation = input.preparation, delivery = input.delivery, clock = input.clock ?? Date.now;
  if (typeof clock !== "function") unavailable();
  return Object.freeze({ async deliver(target: CodexOwnerTrustedLocalQueueDeliveryTarget, signal: AbortSignal) {
    if (!(signal instanceof AbortSignal) || signal.aborted) unavailable();
    const reference = codexOwnerTrustedLocalQueueTargetToDispatchReferenceV1(tenantId, target);
    const prepared = await preparation.prepare(reference);
    await preparation.assertCurrent(reference, prepared);
    if (signal.aborted) unavailable();
    const receivedAt = new Date(clock()).toISOString();
    if (!z.string().datetime().safeParse(receivedAt).success) unavailable();
    const outcome = await delivery.deliver(prepared.delivery, prepared.route, receivedAt, signal);
    if (!outcome || outcome.state !== "published" || signal.aborted) unresolved();
    await preparation.assertCurrent(reference, prepared);
    return Object.freeze({ disposition: "delivered" as const });
  } });
}
