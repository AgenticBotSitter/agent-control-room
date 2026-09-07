import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../../persistence/database";
import { projectWorkspaceTimeSchemaV1 as time } from "../../../project-workspace/v1";
import { absFeedInputSchema, AbsFeedDecodeError, decodeAbsFeed } from "./feed-decoder";
import { PostgresAbsNewsStoreV1 } from "./postgres-store";

const configuration = absFeedInputSchema.omit({ xml: true, observedAt: true });
const failedRead = z.object({ checkedAt: time, reason: z.enum(["read_failed", "read_timed_out", "source_refused"]) }).strict();
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const value = await work(tx); await check(); return value; } });

/** Trusted ingestion composition, not an HTTP or network authority boundary.
 * Accepts text from a separately authorized reader. No fetching, timers, jobs or retries.
 * Decoding finishes before SQL; source health and story versions then commit together. */
export class AbsFeedIngestionService {
  private readonly config: z.infer<typeof configuration>;
  private readonly key: Uint8Array;
  constructor(private readonly db: DatabaseClient, value: unknown, key: Uint8Array) {
    this.config = configuration.parse(value);
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("news_key_invalid");
    this.key = Uint8Array.from(key);
  }
  async ingest(xml: unknown, observedAt: unknown) {
    const checkedAt = time.parse(observedAt);
    let decoded: Awaited<ReturnType<typeof decodeAbsFeed>>;
    try { decoded = await decodeAbsFeed({ ...this.config, xml, observedAt: checkedAt }); }
    catch (error) {
      if (!(error instanceof AbsFeedDecodeError)) throw error;
      return this.save(checkedAt, undefined, error.code);
    }
    return this.save(checkedAt, decoded);
  }
  async recordReadFailure(value: unknown) {
    const failure = failedRead.parse(value);
    return this.save(failure.checkedAt, undefined, failure.reason);
  }
  private async save(checkedAt: string, decoded?: Awaited<ReturnType<typeof decodeAbsFeed>>, reason?: string) {
    const { tenantId, workspaceId, projectId, source } = this.config;
    return this.db.transaction(async tx => {
      // Same workspace lock used by managed owner operations. Future ingestion SQL
      // roles need only the corresponding lock-column privilege, not project mutation.
      const workspace = (await tx.query(`SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, workspaceId])).rows[0];
      if (!workspace) throw new Error("news_workspace_not_found");
      const store = new PostgresAbsNewsStoreV1(joined(tx), { tenantId, workspaceId, projectId }, this.key);
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
        safeStatusCode: decoded ? decoded.state === "available" ? "feed_parsed" : "feed_partially_parsed" : reason!,
        checkedAt, ...(lastSuccessfulAt ? { lastSuccessfulAt } : {}),
        ...(decoded ? { itemCount: decoded.stories.length } : {}), grantsNetworkAuthority: false,
      });
      return { ...result, discoveryCuration: decoded?.discoveryCuration ?? null,
        rejectedCount: decoded?.rejectedCount ?? null, duplicateCount: decoded?.duplicateCount ?? null,
        startsWork: false as const };
    });
  }
}
