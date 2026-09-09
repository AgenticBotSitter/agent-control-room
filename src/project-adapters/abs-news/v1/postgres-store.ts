import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../../security";
import { ProjectWorkspaceContractErrorV1, projectWorkspaceSafeIdSchemaV1 as id,
  parseExactProjectWorkspaceV1, projectWorkspaceSourceStatusSchemaV1 } from "../../../project-workspace/v1";
import { parseAbsNewsStoryV1 } from "./story";
import { buildAbsNewsWorkOrderProposalV1, parseAbsNewsWorkOrderProposalV1 } from "./proposal";
import type { AbsNewsStoryV1, AbsNewsWorkOrderProposalV1 } from "./types";
import { INDUSTRY_FRESHNESS_HOURS, INDUSTRY_FUTURE_TOLERANCE_MINUTES } from "../../../vendor/control-center/freshness";
import { PostgresNewsStoryArchives } from "./story-archives";

const scopeSchema = z.object({ tenantId: id, workspaceId: id, projectId: id }).strict();
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
// Logical collection ceiling matches the borrowed sitemap walker. Individual
// persistence batches remain 100; all batches share the collection transaction.
export const absDiscoveryCollectionLimit = 100_000;
const collectionReceiptSchema = scopeSchema.extend({ schema: z.literal("control-room.abs-collection-receipt/v1"),
  sourceId: id, statusDigest: digestSchema,
  stories: z.array(z.object({ storyId: id, storyDigest: digestSchema }).strict()).max(absDiscoveryCollectionLimit),
  authTag: z.string().regex(/^hmac-sha256:[a-f0-9]{64}$/),
}).strict();
type Scope = z.infer<typeof scopeSchema>;
type Row = { payload: unknown; auth_tag: string };

/** Trusted application storage, not an HTTP authorization boundary. No connections,
 * migrations, background workers or feeds are started by constructing this store.
 * HMAC detects changed records, not whole-database rollback or factual accuracy. */
export class PostgresAbsNewsStoreV1 {
  private readonly scope: Scope;
  private readonly key: Uint8Array;
  constructor(private readonly db: DatabaseClient, scope: Scope, key: Uint8Array,
    private readonly clock: () => Date = () => new Date()) {
    this.scope = parseExactProjectWorkspaceV1(scopeSchema, scope);
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    this.key = Uint8Array.from(key);
  }
  private values() { return [this.scope.tenantId, this.scope.workspaceId, this.scope.projectId]; }
  private check(value: Scope) {
    if (value.tenantId !== this.scope.tenantId || value.workspaceId !== this.scope.workspaceId || value.projectId !== this.scope.projectId)
      throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  }
  private tag(kind: string, payload: unknown) { return hmacSha256Tag(this.key, { kind, ...this.scope, payload }); }
  private story(row: Row): AbsNewsStoryV1 {
    const value = parseAbsNewsStoryV1(row.payload); this.check(value);
    if (this.tag("story", value) !== row.auth_tag) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return value;
  }
  private proposal(row: Row): AbsNewsWorkOrderProposalV1 {
    const value = parseAbsNewsWorkOrderProposalV1(row.payload); this.check(value);
    if (this.tag("proposal", value) !== row.auth_tag) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return value;
  }
  private async project(tx: DatabaseSession) {
    const row = (await tx.query(`SELECT id FROM projects WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR SHARE`, this.values())).rows[0];
    if (!row) throw new ProjectWorkspaceContractErrorV1("not_found");
  }
  async saveStory(value: unknown) {
    const story = parseAbsNewsStoryV1(value); this.check(story);
    return this.db.transaction(async tx => {
      await this.project(tx);
      const inserted = await tx.query(`INSERT INTO control_abs_story_versions
        (tenant_id,workspace_id,project_id,story_id,story_digest,payload,auth_tag,recorded_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT DO NOTHING RETURNING story_id`,
      [...this.values(), story.storyId, story.storyDigest, JSON.stringify(story), this.tag("story", story), this.clock().toISOString()]);
      const row = (await tx.query<Row>(`SELECT payload,auth_tag FROM control_abs_story_versions
        WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND story_id=$4 AND story_digest=$5`,
      [...this.values(), story.storyId, story.storyDigest])).rows[0];
      if (!row) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
      const saved = this.story(row);
      if (saved.storyId !== story.storyId || saved.storyDigest !== story.storyDigest) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
      return { story: saved, replayed: inserted.rows.length === 0 };
    });
  }
  /** Commit one bounded ingestion batch atomically; reuse the exact single-story
   * validation/replay path. A failed item cannot leave a partially published batch. */
  async saveStories(values: unknown) {
    if (!Array.isArray(values) || values.length > 100) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    const stories = values.map(value => { const story = parseAbsNewsStoryV1(value); this.check(story); return story; });
    return this.db.transaction(async tx => {
      const joined: DatabaseClient = { query: tx.query.bind(tx), transaction: async work => work(tx),
        transactionWithPreCommitCheck: async (work, check) => { const value = await work(tx); await check(); return value; } };
      const store = new PostgresAbsNewsStoreV1(joined, this.scope, this.key, this.clock);
      let inserted = 0, replayed = 0;
      for (const story of stories) {
        if ((await store.saveStory(story)).replayed) replayed++; else inserted++;
      }
      return { inserted, replayed };
    });
  }
  private sourceStatus(value: unknown) {
    const status = parseExactProjectWorkspaceV1(projectWorkspaceSourceStatusSchemaV1, value);
    if (!status.checkedAt || status.lastSuccessfulAt && Date.parse(status.lastSuccessfulAt) > Date.parse(status.checkedAt)
      || status.state === "unavailable" && status.itemCount !== undefined)
      throw new ProjectWorkspaceContractErrorV1("invalid_input");
    return status;
  }
  private source(row: Row & { source_id: string; status_digest: string; checked_at: Date | string }) {
    const status = this.sourceStatus(row.payload);
    if (status.sourceId !== row.source_id || sha256Digest(status) !== row.status_digest
      || new Date(status.checkedAt!).getTime() !== new Date(row.checked_at).getTime()
      || this.tag("source", status) !== row.auth_tag) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return status;
  }
  async saveSourceStatus(value: unknown) {
    const status = this.sourceStatus(value), digest = sha256Digest(status);
    return this.db.transaction(async tx => {
      await this.project(tx);
      const inserted = await tx.query(`INSERT INTO control_abs_source_observations
        (tenant_id,workspace_id,project_id,source_id,status_digest,checked_at,payload,auth_tag,recorded_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT DO NOTHING RETURNING source_id`,
      [...this.values(), status.sourceId, digest, status.checkedAt, JSON.stringify(status), this.tag("source", status), this.clock().toISOString()]);
      const row = (await tx.query<Row & { source_id: string; status_digest: string; checked_at: Date | string }>(
        `SELECT payload,auth_tag,source_id,status_digest,checked_at FROM control_abs_source_observations
         WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND source_id=$4 AND status_digest=$5`,
      [...this.values(), status.sourceId, digest])).rows[0];
      if (!row) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
      return { status: this.source(row), replayed: inserted.rows.length === 0 };
    });
  }
  async listSourceStatuses(after?: string) {
    if (after !== undefined) id.parse(after);
    const rows = await this.db.query<Row & { source_id: string; status_digest: string; checked_at: Date | string }>(
      `SELECT DISTINCT ON (source_id COLLATE "C") source_id,status_digest,checked_at,payload,auth_tag
       FROM control_abs_source_observations WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3
       AND ($4::text IS NULL OR source_id COLLATE "C">$4 COLLATE "C")
       ORDER BY source_id COLLATE "C",checked_at DESC,sequence DESC LIMIT 51`, [...this.values(), after ?? null]);
    const statuses = rows.rows.slice(0, 50).map(row => this.source(row));
    return { statuses, nextCursor: rows.rows.length > 50 ? statuses.at(-1)!.sourceId : null };
  }
  async getSourceStatus(sourceId: string, digest?: string) {
    id.parse(sourceId);
    if (digest !== undefined) digestSchema.parse(digest);
    const row = (await this.db.query<Row & { source_id: string; status_digest: string; checked_at: Date | string }>(
      `SELECT source_id,status_digest,checked_at,payload,auth_tag FROM control_abs_source_observations
       WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND source_id=$4
       AND ($5::text IS NULL OR status_digest=$5)
       ORDER BY checked_at DESC,sequence DESC LIMIT 1`, [...this.values(), sourceId, digest ?? null])).rows[0];
    return row ? this.source(row) : undefined;
  }
  /** Source outcome and its articles must be visible together, including empty feeds. */
  async saveCollection(values: unknown, statusValue: unknown) {
    const status = this.sourceStatus(statusValue);
    if (!Array.isArray(values) || values.length > absDiscoveryCollectionLimit) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    const stories = values.map(value => { const story = parseAbsNewsStoryV1(value); this.check(story); return story; });
    if (stories.length && !["available", "partial"].includes(status.state)
      || ["available", "partial"].includes(status.state) && status.itemCount !== stories.length
      || stories.some(story => story.sourceEvidence.some(evidence => evidence.sourceId !== status.sourceId
        || evidence.observedAt !== status.checkedAt || evidence.sourceLabel !== status.label || evidence.sourceKind !== status.sourceKind)))
      throw new ProjectWorkspaceContractErrorV1("invalid_input");
    return this.db.transaction(async tx => {
      const joined: DatabaseClient = { query: tx.query.bind(tx), transaction: async work => work(tx),
        transactionWithPreCommitCheck: async (work, check) => { const value = await work(tx); await check(); return value; } };
      const store = new PostgresAbsNewsStoreV1(joined, this.scope, this.key, this.clock);
      const saved = { inserted: 0, replayed: 0 };
      for (let offset = 0; offset < stories.length; offset += 100) {
        const batch = await store.saveStories(stories.slice(offset, offset + 100));
        saved.inserted += batch.inserted; saved.replayed += batch.replayed;
      }
      const source = await store.saveSourceStatus(status);
      const payload = { schema: "control-room.abs-collection-receipt/v1" as const, ...this.scope,
        sourceId: status.sourceId, statusDigest: sha256Digest(source.status),
        stories: stories.map(story => ({ storyId: story.storyId, storyDigest: story.storyDigest }))
          .sort((a, b) => a.storyId < b.storyId ? -1 : a.storyId > b.storyId ? 1 : 0) };
      if (new Set(payload.stories.map(story => story.storyId)).size !== payload.stories.length)
        throw new ProjectWorkspaceContractErrorV1("invalid_input");
      const receipt = { ...payload, authTag: this.tag("collection-receipt", payload) };
      return { ...saved, status: source.status, statusReplayed: source.replayed, receipt };
    });
  }
  /** Verifies the exact retained versions, not today's latest source/story values.
   * Evidence integrity is not factual verification, network permission or job completion. */
  async verifyCollectionReceipt(value: unknown) {
    const { authTag, ...receipt } = collectionReceiptSchema.parse(value); this.check(receipt);
    if (authTag !== this.tag("collection-receipt", receipt)
      || receipt.stories.some((story, index) => index > 0 && receipt.stories[index - 1].storyId >= story.storyId))
      throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return this.db.transaction(async tx => {
      const joined: DatabaseClient = { query: tx.query.bind(tx), transaction: async work => work(tx),
        transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } };
      const store = new PostgresAbsNewsStoreV1(joined, this.scope, this.key, this.clock);
      await this.project(tx);
      const status = await store.getSourceStatus(receipt.sourceId, receipt.statusDigest);
      if (!status || (["available", "partial"].includes(status.state) ? status.itemCount !== receipt.stories.length : receipt.stories.length !== 0))
        throw new ProjectWorkspaceContractErrorV1("integrity_failed");
      for (const reference of receipt.stories) {
        const story = await store.getStory(reference.storyId, reference.storyDigest);
        if (!story || story.sourceEvidence.some(source => source.sourceId !== status.sourceId || source.observedAt !== status.checkedAt
          || source.sourceLabel !== status.label || source.sourceKind !== status.sourceKind))
          throw new ProjectWorkspaceContractErrorV1("integrity_failed");
      }
      return { receiptDigest: sha256Digest(receipt), status, storyCount: receipt.stories.length, grantsNetworkAuthority: false as const };
    });
  }
  async listStories(after?: string, filter: { view: "all" | "history" | "archive" | "fresh"; observedAt: string;
    order?: "id" | "important" | "newest" | "oldest" } = { view: "all", observedAt: new Date().toISOString() }) {
    if (after !== undefined) id.parse(after);
    const selected = z.object({ view: z.enum(["all", "history", "archive", "fresh"]), observedAt: z.string().datetime({ offset: true }),
      order: z.enum(["id", "important", "newest", "oldest"]).default("id") }).strict().parse(filter);
    const now = Date.parse(selected.observedAt);
    // Authenticate classifications before they can exclude a row. Filtering raw
    // overlay columns first would let corrupted records silently hide stories.
    const archiveSnapshot = await new PostgresNewsStoryArchives(this.db, this.scope, this.key).snapshot();
    const archivedIds = [...archiveSnapshot.values()].filter(record => record.archived).map(record => record.storyId);
    const restoredIds = [...archiveSnapshot.values()].filter(record => !record.archived).map(record => record.storyId);
    const rows = await this.db.query<Row & { story_id: string; story_digest: string }>(`WITH latest AS (SELECT DISTINCT ON (story_id COLLATE "C") story_id,story_digest,payload,auth_tag
      FROM control_abs_story_versions WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3
      ORDER BY story_id COLLATE "C",sequence DESC), classified AS (
      SELECT *, CASE WHEN story_id=ANY($9::text[]) THEN 'archive'
        WHEN story_id=ANY($10::text[]) AND payload->>'queue'='archive' THEN 'earlier'
        ELSE payload->>'queue' END AS effective_queue FROM latest), dated AS (
      SELECT *, regexp_replace(COALESCE(payload->>'publishedAt',payload->>'discoveredAt'),
        '(\\.[0-9]{3})[0-9]+', '\\1')::timestamptz AS story_time FROM classified), filtered AS (
      SELECT * FROM dated WHERE $5='all'
        OR ($5='archive' AND effective_queue='archive')
        OR ($5='history' AND effective_queue<>'archive')
        OR ($5='fresh' AND effective_queue<>'archive'
          AND story_time BETWEEN $6::timestamptz AND $7::timestamptz)),
      ranked AS (SELECT *, row_number() OVER (ORDER BY
        CASE WHEN $8='important' THEN (payload->>'priorityScore')::numeric END DESC,
        CASE WHEN $8 IN ('important','newest') THEN story_time END DESC,
        CASE WHEN $8='oldest' THEN story_time END ASC,
        story_id COLLATE "C") AS ordinal FROM filtered)
      SELECT story_id,story_digest,payload,auth_tag FROM ranked
      WHERE $4::text IS NULL OR ($8='id' AND story_id COLLATE "C">$4 COLLATE "C")
        OR ($8<>'id' AND ordinal>(SELECT ordinal FROM ranked WHERE story_id=$4))
      ORDER BY ordinal LIMIT 51`, [...this.values(), after ?? null, selected.view,
      new Date(now - INDUSTRY_FRESHNESS_HOURS * 3600000).toISOString(), new Date(now + INDUSTRY_FUTURE_TOLERANCE_MINUTES * 60000).toISOString(), selected.order, archivedIds, restoredIds]);
    const archiveStates: Record<string, { archived: boolean; revision: number }> = Object.create(null);
    const stories = rows.rows.slice(0, 50).map(row => {
      const story = this.story(row);
      if (story.storyId !== row.story_id || story.storyDigest !== row.story_digest) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
      const record = archiveSnapshot.get(story.storyId);
      if (record) {
        archiveStates[story.storyId] = { archived: record.archived, revision: record.revision };
      }
      return story;
    });
    return { stories, archiveStates, nextCursor: rows.rows.length > 50 ? stories.at(-1)!.storyId : null };
  }
  async getStory(storyId: string, digest?: string) {
    id.parse(storyId);
    if (digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(digest)) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    const row = (await this.db.query<Row & { story_digest: string }>(`SELECT payload,auth_tag,story_digest
      FROM control_abs_story_versions WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND story_id=$4
      AND ($5::text IS NULL OR story_digest=$5) ORDER BY sequence DESC LIMIT 1`, [...this.values(), storyId, digest ?? null])).rows[0];
    if (!row) return undefined;
    const story = this.story(row);
    if (story.storyId !== storyId || story.storyDigest !== row.story_digest) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return story;
  }
  async getProposal(proposalId: string) {
    id.parse(proposalId);
    const row = (await this.db.query<Row & { proposal_digest: string; story_id: string; story_digest: string; idempotency_key: string }>(
      `SELECT payload,auth_tag,proposal_digest,story_id,story_digest,idempotency_key FROM control_abs_research_proposals
       WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND proposal_id=$4`, [...this.values(), proposalId])).rows[0];
    if (!row) return undefined;
    const proposal = this.proposal(row);
    if (proposal.proposalId !== proposalId || proposal.proposalDigest !== row.proposal_digest
      || proposal.storyId !== row.story_id || proposal.storyDigest !== row.story_digest || proposal.proposalIdempotencyKey !== row.idempotency_key)
      throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return proposal;
  }
  async saveProposal(value: unknown) {
    const proposal = parseAbsNewsWorkOrderProposalV1(value); this.check(proposal);
    return this.db.transaction(async tx => {
      await this.project(tx);
      const source = (await tx.query<Row>(`SELECT payload,auth_tag FROM control_abs_story_versions
        WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND story_id=$4 AND story_digest=$5`,
      [...this.values(), proposal.storyId, proposal.storyDigest])).rows[0];
      if (!source) throw new ProjectWorkspaceContractErrorV1("not_found");
      const story = this.story(source);
      if (story.storyId !== proposal.storyId || story.storyDigest !== proposal.storyDigest)
        throw new ProjectWorkspaceContractErrorV1("replay_drift");
      const rebuilt = buildAbsNewsWorkOrderProposalV1({ ...this.scope, story, proposalId: proposal.proposalId,
        actionId: proposal.actionId, requestedTitle: proposal.requestedTitle, goal: proposal.goal,
        requestedPlatform: proposal.requestedPlatform, requestedByActorDigest: proposal.requestedByActorDigest,
        requestedAt: proposal.requestedAt });
      if (rebuilt.proposalDigest !== proposal.proposalDigest) throw new ProjectWorkspaceContractErrorV1("replay_drift");
      const inserted = await tx.query(`INSERT INTO control_abs_research_proposals
        (tenant_id,workspace_id,project_id,proposal_id,proposal_digest,idempotency_key,story_id,story_digest,payload,auth_tag,recorded_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) ON CONFLICT DO NOTHING RETURNING proposal_id`,
      [...this.values(), proposal.proposalId, proposal.proposalDigest, proposal.proposalIdempotencyKey, proposal.storyId,
        proposal.storyDigest, JSON.stringify(proposal), this.tag("proposal", proposal), this.clock().toISOString()]);
      const rows = await tx.query<Row>(`SELECT payload,auth_tag FROM control_abs_research_proposals
        WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND (proposal_id=$4 OR idempotency_key=$5)`,
      [...this.values(), proposal.proposalId, proposal.proposalIdempotencyKey]);
      if (rows.rows.length !== 1) throw new ProjectWorkspaceContractErrorV1("replay_drift");
      const saved = this.proposal(rows.rows[0]);
      if (saved.proposalDigest !== proposal.proposalDigest) throw new ProjectWorkspaceContractErrorV1("replay_drift");
      return { proposal: saved, replayed: inserted.rows.length === 0 };
    });
  }
}
