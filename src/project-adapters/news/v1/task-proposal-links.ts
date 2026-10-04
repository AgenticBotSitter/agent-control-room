import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../../persistence/database";
import { hmacSha256Tag } from "../../../security";
import { projectWorkspaceSafeIdSchemaV1 as id, parseExactProjectWorkspaceV1 } from "../../../project-workspace/v1";
import { parseNewsWorkOrderProposalV1 } from "./proposal";
import type { NewsWorkOrderProposalV1 } from "./types";
import { PostgresNewsStoreV1 } from "./postgres-store";

const scopeSchema = z.object({ tenantId: id, workspaceId: id, projectId: id }).strict();
const linkSchema = z.object({ jobId: id, proposal: z.unknown(), recordedAt: z.string().datetime({ offset: true }) }).strict();
type Scope = z.infer<typeof scopeSchema>;
export type NewsTaskProposalLinkV1 = Readonly<{ jobId: string; proposal: NewsWorkOrderProposalV1; recordedAt: string }>;
type Row = { job_id: string; proposal_id: string; proposal_digest: string; story_id: string; story_digest: string;
  payload: unknown; auth_tag: string; recorded_at: string | Date };

const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const value = await work(tx); await check(); return value; } });

/** Immutable provenance between one retained article proposal and one ordinary proposed task.
 * This is a record of source material only; it cannot queue, approve, or execute the task. */
export class PostgresNewsTaskProposalLinksV1 {
  private readonly scope: Scope;
  private readonly key: Uint8Array;
  constructor(private readonly db: DatabaseClient, scope: unknown, integrityKey: Uint8Array) {
    this.scope = scopeSchema.parse(scope);
    if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32) throw new Error("news_key_invalid");
    this.key = Uint8Array.from(integrityKey);
  }
  private values() { return [this.scope.tenantId, this.scope.workspaceId, this.scope.projectId]; }
  private tag(value: NewsTaskProposalLinkV1) {
    return hmacSha256Tag(this.key, { kind: "news-task-proposal-link/v1", ...this.scope, value });
  }
  private parse(row: Row): NewsTaskProposalLinkV1 {
    const candidate = linkSchema.parse({ jobId: row.job_id, proposal: row.payload, recordedAt: new Date(row.recorded_at).toISOString() });
    const proposal = parseNewsWorkOrderProposalV1(candidate.proposal);
    const value: NewsTaskProposalLinkV1 = Object.freeze({ jobId: candidate.jobId, proposal, recordedAt: candidate.recordedAt });
    const expected = Buffer.from(this.tag(value)), actual = Buffer.from(row.auth_tag);
    if (proposal.proposalId !== row.proposal_id || proposal.proposalDigest !== row.proposal_digest
      || proposal.storyId !== row.story_id || proposal.storyDigest !== row.story_digest
      || expected.length !== actual.length || !timingSafeEqual(actual, expected)) throw new Error("news_task_proposal_link_integrity_failed");
    return value;
  }
  async get(jobId: string) {
    const row = (await this.db.query<Row>(`SELECT job_id,proposal_id,proposal_digest,story_id,story_digest,payload,auth_tag,recorded_at
      FROM control_news_task_proposal_links WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND job_id=$4`,
    [...this.values(), id.parse(jobId)])).rows[0];
    return row ? this.parse(row) : undefined;
  }
  async saveInSession(tx: DatabaseSession, jobId: string, proposalValue: unknown, recordedAt: string) {
    const proposal = parseNewsWorkOrderProposalV1(proposalValue);
    if (proposal.tenantId !== this.scope.tenantId || proposal.workspaceId !== this.scope.workspaceId || proposal.projectId !== this.scope.projectId)
      throw new Error("news_task_proposal_link_scope_mismatch");
    const value: NewsTaskProposalLinkV1 = Object.freeze({ jobId: id.parse(jobId), proposal,
      recordedAt: z.string().datetime({ offset: true }).parse(recordedAt) });
    // Confirm that the exact HMAC-protected source version is still retained;
    // the SQL foreign key then keeps it retained after this link is written.
    if (!await new PostgresNewsStoreV1(joined(tx), this.scope, this.key).getStory(proposal.storyId, proposal.storyDigest))
      throw new Error("news_task_proposal_link_story_not_found");
    const inserted = await tx.query(`INSERT INTO control_news_task_proposal_links
      (tenant_id,workspace_id,project_id,job_id,proposal_id,proposal_digest,story_id,story_digest,payload,auth_tag,recorded_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) ON CONFLICT DO NOTHING RETURNING job_id`,
    [...this.values(), value.jobId, proposal.proposalId, proposal.proposalDigest, proposal.storyId, proposal.storyDigest,
      JSON.stringify(proposal), this.tag(value), value.recordedAt]);
    const rows = await tx.query<Row>(`SELECT job_id,proposal_id,proposal_digest,story_id,story_digest,payload,auth_tag,recorded_at
      FROM control_news_task_proposal_links WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3
      AND (job_id=$4 OR proposal_id=$5)`, [...this.values(), value.jobId, proposal.proposalId]);
    if (rows.rows.length !== 1) throw new Error("news_task_proposal_link_conflict");
    const saved = this.parse(rows.rows[0]!);
    if (saved.jobId !== value.jobId || saved.proposal.proposalDigest !== proposal.proposalDigest)
      throw new Error("news_task_proposal_link_conflict");
    return { link: saved, replayed: inserted.rows.length === 0, startsWork: false as const };
  }
}
