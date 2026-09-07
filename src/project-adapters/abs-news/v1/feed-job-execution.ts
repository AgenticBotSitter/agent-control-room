import { z } from "zod";
import type { DatabaseClient } from "../../../persistence/database";
import { CanonicalStore } from "../../../persistence/canonical-store";
import { absFeedJobReferenceSchema } from "../../../persistence/pg-boss-abs-feed-worker";
import { localId } from "../../../harness/v1/native-run-identifiers";
import { AbsFeedPlanStore } from "./feed-plan-store";
import { createAbsFeedCollection } from "./feed-collection";
import { PostgresAbsNewsStoreV1 } from "./postgres-store";
import { captureAbsCurrentSourceAuthority, type AbsCurrentSourceAuthority } from "./current-source-authority";

/** Unmounted, trusted collector composition. Its required source guard must represent
 * separately established current local/source authority; this module cannot manufacture
 * that authority or replace a remote node's protected claim. Construction is inert.
 * The optional factory is an internal dependency seam, never a request field. */
export function createAbsFeedJobExecution(db: DatabaseClient, value: unknown, key: Uint8Array,
  source: AbsCurrentSourceAuthority, clock: () => number = Date.now,
  factory: typeof createAbsFeedCollection = createAbsFeedCollection) {
  const scope = z.object({ tenantId: localId, workspaceId: localId, projectId: localId, nodeId: localId, executorId: localId }).strict().parse(value);
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("abs_feed_execution_config_invalid");
  const capturedKey = Uint8Array.from(key), assertSource = captureAbsCurrentSourceAuthority(source);
  const projectScope = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, projectId: scope.projectId };
  const plans = new AbsFeedPlanStore(db, projectScope, capturedKey), store = new CanonicalStore(db);
  const news = new PostgresAbsNewsStoreV1(db, projectScope, capturedKey);
  return Object.freeze({ async collect(value: unknown, signal: AbortSignal) {
    const reference = absFeedJobReferenceSchema.parse(value);
    if (!(signal instanceof AbortSignal) || signal.aborted || reference.tenantId !== scope.tenantId || reference.projectId !== scope.projectId)
      throw new Error("abs_feed_execution_unavailable");
    const work = await plans.get(reference.jobId);
    if (!work || work.job.authority.allowedExecutor !== scope.executorId) throw new Error("abs_feed_execution_unavailable");
    const endpoint = work.plan.configuration.source.endpointUrl;
    assertSource(endpoint); if (signal.aborted) throw new Error("abs_feed_execution_unavailable");
    const startedAt = clock();
    const marker = await store.beginAbsFeedAttempt({ ...scope, jobId: reference.jobId, attemptId: reference.attemptId,
      effectId: reference.effectId, operationDigest: reference.operationDigest, inputDigest: work.job.inputDigest }, clock);
    const deadline = Date.parse(marker.deadline), controller = new AbortController();
    const cancel = () => controller.abort(); signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, Math.max(0, deadline - clock()));
    const current = (): undefined => {
      const now = clock();
      if (!Number.isSafeInteger(now) || now < startedAt || now >= deadline || signal.aborted || controller.signal.aborted)
        throw new Error("abs_feed_execution_unavailable");
      assertSource(endpoint);
    };
    let collection: ReturnType<typeof createAbsFeedCollection> | undefined;
    const settlement = { tenantId: scope.tenantId, projectId: scope.projectId, nodeId: scope.nodeId,
      jobId: reference.jobId, attemptId: reference.attemptId, effectId: reference.effectId, markerDigest: marker.markerDigest };
    try {
      let outcome: "confirmed" | "failed" | "ambiguous" = "ambiguous", receiptDigest: string | undefined;
      try {
        current(); collection = factory(db, work.plan.configuration, capturedKey, { assertCurrent: current });
        const result = await collection.collect(controller.signal);
        await collection.close(); current();
        const checked = await news.verifyCollectionReceipt(result.receipt);
        const expected = work.plan.configuration.source;
        if (checked.status.sourceId !== expected.sourceId || checked.status.label !== expected.sourceLabel
          || checked.status.sourceKind !== expected.sourceKind || !checked.status.checkedAt
          || Date.parse(checked.status.checkedAt) < startedAt || Date.parse(checked.status.checkedAt) > clock())
          throw new Error("abs_feed_result_mismatch");
        current();
        outcome = checked.status.state === "available" ? "confirmed" : "failed";
        if (outcome === "confirmed") receiptDigest = checked.receiptDigest;
      } catch {
        // Once marked, missing results, cancellation, cleanup failure and storage
        // uncertainty never authorize a second read or become successful news.
        cancel(); outcome = "ambiguous"; receiptDigest = undefined;
        try { await collection?.close(); } catch { /* Retain uncertainty below. */ }
      }
      const result = await store.settleAbsFeedAttempt({ ...settlement, outcome, ...(receiptDigest ? { receiptDigest } : {}) }, clock);
      return { disposition: result.effectState === "confirmed" ? "delivered" as const : "held" as const };
    } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
  } });
}
