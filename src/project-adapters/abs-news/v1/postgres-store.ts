import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../../persistence/database";
import { hmacSha256Tag } from "../../../security";
import { ProjectWorkspaceContractErrorV1, projectWorkspaceSafeIdSchemaV1 as id,
  parseExactProjectWorkspaceV1 } from "../../../project-workspace/v1";
import { parseAbsNewsStoryV1 } from "./story";
import { buildAbsNewsWorkOrderProposalV1, parseAbsNewsWorkOrderProposalV1 } from "./proposal";
import type { AbsNewsStoryV1, AbsNewsWorkOrderProposalV1 } from "./types";

const scopeSchema = z.object({ tenantId: id, workspaceId: id, projectId: id }).strict();
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
  async listStories(after?: string) {
    if (after !== undefined) id.parse(after);
    const rows = await this.db.query<Row & { story_id: string; story_digest: string }>(`SELECT DISTINCT ON (story_id COLLATE "C") story_id,story_digest,payload,auth_tag
      FROM control_abs_story_versions WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3
      AND ($4::text IS NULL OR story_id COLLATE "C">$4 COLLATE "C")
      ORDER BY story_id COLLATE "C",sequence DESC LIMIT 51`, [...this.values(), after ?? null]);
    const stories = rows.rows.slice(0, 50).map(row => {
      const story = this.story(row);
      if (story.storyId !== row.story_id || story.storyDigest !== row.story_digest) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
      return story;
    });
    return { stories, nextCursor: rows.rows.length > 50 ? stories.at(-1)!.storyId : null };
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
      if (story.storyId !== proposal.storyId || story.storyDigest !== proposal.storyDigest || story.verificationState !== "verified")
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
