import { z } from "zod";
import type { DatabaseClient } from "../../../persistence/database";
import { CanonicalStore } from "../../../persistence/canonical-store";
import { absFeedJobReferenceSchema } from "../../../persistence/pg-boss-abs-feed-worker";
import { localId } from "../../../harness/v1/native-run-identifiers";
import { AbsFeedPlanStore } from "./feed-plan-store";
import { createAbsFeedCollection } from "./feed-collection";
import { PostgresAbsNewsStoreV1 } from "./postgres-store";
import { captureAbsCurrentSourceAuthority, type AbsCurrentSourceAuthority } from "./current-source-authority";
import { createControlCenterCollection } from "./control-center-collection";
import { PostgresNewsSourceSettings } from "./source-settings";
import type { PinnedFetchDependencies } from "../../../vendor/control-center/pinned-fetch";

/** Unmounted, trusted collector composition. Its required source guard must represent
 * separately established current local/source authority; this module cannot manufacture
 * that authority or replace a remote node's protected claim. Construction is inert.
 * Startup must verify separate least-privilege logins on the same authoritative DB;
 * object inequality below only catches accidental direct resource reuse.
 * The optional factory is an internal dependency seam, never a request field. */
export function createAbsFeedJobExecution(databases: { coordinator: DatabaseClient; ingestion: DatabaseClient }, value: unknown, key: Uint8Array,
  source: AbsCurrentSourceAuthority, clock: () => number = Date.now,
  factory: typeof createAbsFeedCollection = createAbsFeedCollection,
  discoveryPorts?: Required<Pick<PinnedFetchDependencies, "lookup" | "fetch">>) {
  const { coordinator: db, ingestion } = databases;
  if (!db || !ingestion || db === ingestion) throw new Error("abs_feed_execution_database_separation_required");
  const scope = z.object({ tenantId: localId, workspaceId: localId, projectId: localId, nodeId: localId, executorId: localId }).strict().parse(value);
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("abs_feed_execution_config_invalid");
  const capturedKey = Uint8Array.from(key), assertSource = captureAbsCurrentSourceAuthority(source);
  const projectScope = { tenantId: scope.tenantId, workspaceId: scope.workspaceId, projectId: scope.projectId };
  const plans = new AbsFeedPlanStore(db, projectScope, capturedKey), store = new CanonicalStore(db);
  const news = new PostgresAbsNewsStoreV1(ingestion, projectScope, capturedKey);
  const ports = discoveryPorts ? { lookup: discoveryPorts.lookup.bind(discoveryPorts), fetch: discoveryPorts.fetch.bind(discoveryPorts) } : undefined;
  return Object.freeze({ async collect(value: unknown, signal: AbortSignal) {
    const reference = absFeedJobReferenceSchema.parse(value);
    if (!(signal instanceof AbortSignal) || signal.aborted || reference.tenantId !== scope.tenantId || reference.projectId !== scope.projectId)
      throw new Error("abs_feed_execution_unavailable");
    const work = await plans.get(reference.jobId);
    if (!work || work.job.authority.allowedExecutor !== scope.executorId) throw new Error("abs_feed_execution_unavailable");
    const discovery = work.plan.schema === "control-room.abs-discovery-plan/v1" ? work.plan.configuration : undefined;
    if (discovery && !ports) throw new Error("abs_feed_execution_unavailable");
    if (discovery) {
      const setting = await new PostgresNewsSourceSettings(ingestion, projectScope, capturedKey).get(discovery.source.sourceId);
      if (!setting?.source.enabled || setting.revision !== discovery.expectedRevision
        || setting.source.name !== discovery.source.sourceLabel || setting.source.url !== discovery.source.endpointUrl)
        throw new Error("abs_feed_execution_unavailable");
    }
    const endpoint = work.plan.configuration.source.endpointUrl;
    assertSource(endpoint); if (signal.aborted) throw new Error("abs_feed_execution_unavailable");
    const startedAt = clock();
    const marker = await store.beginAbsFeedAttempt({ ...scope, jobId: reference.jobId, attemptId: reference.attemptId,
      effectId: reference.effectId, operationDigest: reference.operationDigest, inputDigest: work.job.inputDigest }, clock);
    const deadline = Date.parse(marker.deadline), controller = new AbortController();
    const cancel = () => controller.abort(); signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, Math.max(0, deadline - clock()));
    const current = (url: string = endpoint): undefined => {
      const now = clock();
      if (!Number.isSafeInteger(now) || now < startedAt || now >= deadline || signal.aborted || controller.signal.aborted)
        throw new Error("abs_feed_execution_unavailable");
      if (discovery && !discovery.allowedOrigins.includes(new URL(url).origin + "/")) throw new Error("abs_feed_execution_unavailable");
      assertSource(url);
    };
    const guardedIngestion: DatabaseClient = { query: ingestion.query.bind(ingestion),
      transaction: work => ingestion.transactionWithPreCommitCheck(work, current),
      transactionWithPreCommitCheck: (work, check) => ingestion.transactionWithPreCommitCheck(work, async () => { await check(); current(); }) };
    let collection: ReturnType<typeof createAbsFeedCollection> | ReturnType<typeof createControlCenterCollection> | undefined;
    const settlement = { tenantId: scope.tenantId, projectId: scope.projectId, nodeId: scope.nodeId,
      jobId: reference.jobId, attemptId: reference.attemptId, effectId: reference.effectId, markerDigest: marker.markerDigest };
    try {
      let outcome: "confirmed" | "failed" | "ambiguous" = "ambiguous", receiptDigest: string | undefined;
      try {
        current();
        collection = discovery
          ? createControlCenterCollection(guardedIngestion, { ...projectScope, sourceId: discovery.source.sourceId,
            expectedRevision: discovery.expectedRevision, limits: discovery.limits }, capturedKey, { assertCurrent: current }, ports!, clock)
          : factory(ingestion, work.plan.configuration, capturedKey, { assertCurrent: current });
        const result = await collection.collect(controller.signal);
        await collection.close(); current();
        const checked = await news.verifyCollectionReceipt(result.receipt);
        const expected = work.plan.configuration.source;
        if (checked.status.sourceId !== expected.sourceId || checked.status.label !== expected.sourceLabel
          || (!discovery && checked.status.sourceKind !== expected.sourceKind) || !checked.status.checkedAt
          || Date.parse(checked.status.checkedAt) < startedAt || Date.parse(checked.status.checkedAt) > clock())
          throw new Error("abs_feed_result_mismatch");
        current();
        const articleSummary = "articleExtraction" in result ? z.object({ attempted: z.number().int().min(0).max(10),
          saved: z.number().int().min(0).max(10), unavailable: z.number().int().min(0).max(10),
          skipped: z.number().int().min(0) }).strict()
          .refine(value => value.saved + value.unavailable === value.attempted).parse(result.articleExtraction) : undefined;
        const articlesComplete = discovery?.limits.maxArticles
          ? !!articleSummary && articleSummary.unavailable === 0
            && articleSummary.attempted === Math.min(discovery.limits.maxArticles, checked.storyCount)
            && articleSummary.skipped + articleSummary.attempted === checked.storyCount
          : !articleSummary;
        outcome = checked.status.state === "available" && articlesComplete ? "confirmed" : "failed";
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
