import type { DatabaseClient, DatabaseSession } from "../../../persistence/database";
import type { AbsNewsStoryV1 } from "./types";
import { PostgresAbsNewsStoreV1 } from "./postgres-store";
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const value = await work(tx); await check(); return value; } });
export type DiscoveryBatch = { stories: AbsNewsStoryV1[]; state: "available" | "partial";
  rejectedCount: number; duplicateCount: number; discoveryCuration?: unknown; statusCode?: string };
/** Shared atomic persistence for decoded feed and borrowed source discovery.
 * Caller validates input, scope and source; this reuses existing stale-write fences. */
export async function saveAbsNewsDiscovery(db: DatabaseClient,
  config: { tenantId: string; workspaceId: string; projectId: string;
    source: { sourceId: string; sourceLabel: string; sourceKind: "rss" | "atom" | "sitemap" } },
  key: Uint8Array, checkedAt: string, decoded?: DiscoveryBatch, reason?: string,
  saveBaseline?: (tx: DatabaseSession) => Promise<void>) {
    const { tenantId, workspaceId, projectId, source } = config;
    return db.transaction(async tx => {
      // Same workspace lock used by managed owner operations. Future ingestion SQL
      // roles need only the corresponding lock-column privilege, not project mutation.
      const workspace = (await tx.query(`SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, workspaceId])).rows[0];
      if (!workspace) throw new Error("news_workspace_not_found");
      const store = new PostgresAbsNewsStoreV1(joined(tx), { tenantId, workspaceId, projectId }, key);
      const previous = await store.getSourceStatus(source.sourceId);
      // Do not let delayed reads append old article content as the newest story version.
      // Refusal is terminal for this observation; it is not permission to fetch again.
      if (previous?.checkedAt && Date.parse(checkedAt) < Date.parse(previous.checkedAt)) throw new Error("news_observation_stale");
      // Canonical story identity is shared across sources, unlike source status.
      // Check each retained story under the same workspace lock before any write.
      for (const story of decoded?.stories ?? []) {
        const current = await store.getStory(story.storyId);
        if (current && Date.parse(current.lastVerifiedAt) > Date.parse(checkedAt)) throw new Error("news_observation_stale");
      }
      // Older arriving observations cannot borrow a success that happened in their future.
      const priorSuccess = previous?.lastSuccessfulAt && Date.parse(previous.lastSuccessfulAt) <= Date.parse(checkedAt)
        ? previous.lastSuccessfulAt : undefined;
      const lastSuccessfulAt = decoded?.state === "available" ? checkedAt : priorSuccess;
      const result = await store.saveCollection(decoded?.stories ?? [], {
        sourceId: source.sourceId, sourceKind: source.sourceKind, label: source.sourceLabel,
        mode: "configured", state: decoded?.state ?? "unavailable",
        safeStatusCode: decoded ? decoded.statusCode ?? (decoded.state === "available" ? "feed_parsed" : "feed_partially_parsed") : reason!,
        checkedAt, ...(lastSuccessfulAt ? { lastSuccessfulAt } : {}),
        ...(decoded ? { itemCount: decoded.stories.length } : {}), grantsNetworkAuthority: false,
      });
      await saveBaseline?.(tx);
      return { ...result, discoveryCuration: decoded?.discoveryCuration ?? null,
        rejectedCount: decoded?.rejectedCount ?? null, duplicateCount: decoded?.duplicateCount ?? null,
        startsWork: false as const };
    });
}
