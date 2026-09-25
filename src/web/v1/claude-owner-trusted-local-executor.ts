import { z } from "zod";
import type { ClaudeCodeLocalDispatchPreparationV1 } from "../../harness/claude-code-v1/dispatch-preparation";
import { claudeCodeLocalQueueTargetToDispatchReferenceV1 } from "./claude-code-local-executor";
import type { ClaudeCodeLocalQueueDeliveryTarget } from "./task-assignment-coordinator";

const unavailable = (): never => { throw new Error("claude_owner_trusted_local_executor_unavailable"); };

/** The Mac-local Claude route uses the same one-shot CLI bridge as the other
 * local agents. The VPS installed-process route has a different authority
 * ceremony and must not be used here. */
export function createClaudeOwnerTrustedLocalQueueExecutorV1(input: Readonly<{
  tenantId: string;
  preparation: Pick<ClaudeCodeLocalDispatchPreparationV1, "prepare" | "assertCurrent">;
  delivery: Readonly<{ deliver(delivery: unknown, route: unknown, receivedAt: string, signal?: AbortSignal): Promise<{ state: string }> }>;
  clock?: () => number;
}>) {
  if (!input?.preparation || typeof input.preparation.prepare !== "function"
    || typeof input.preparation.assertCurrent !== "function" || typeof input.delivery?.deliver !== "function") unavailable();
  const clock = input.clock ?? Date.now;
  if (typeof clock !== "function") unavailable();
  return Object.freeze({ async deliver(target: ClaudeCodeLocalQueueDeliveryTarget, signal: AbortSignal) {
    if (!(signal instanceof AbortSignal) || signal.aborted) unavailable();
    const reference = claudeCodeLocalQueueTargetToDispatchReferenceV1(input.tenantId, target);
    const prepared = await input.preparation.prepare(reference);
    await input.preparation.assertCurrent(reference, prepared);
    if (signal.aborted) unavailable();
    const receivedAt = new Date(clock()).toISOString();
    if (!z.string().datetime().safeParse(receivedAt).success) unavailable();
    const outcome = await input.delivery.deliver(prepared.delivery, prepared.route, receivedAt, signal);
    if (!outcome || outcome.state !== "published" || signal.aborted) unavailable();
    return Object.freeze({ disposition: "delivered" as const });
  } });
}
