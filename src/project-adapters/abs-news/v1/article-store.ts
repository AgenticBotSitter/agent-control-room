import { z } from "zod";
import type { DatabaseClient } from "../../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../../security";
import { projectWorkspaceSafeIdSchemaV1 as id, projectWorkspaceDigestSchemaV1 as digest } from "../../../project-workspace/v1";
import { PostgresAbsNewsStoreV1 } from "./postgres-store";
import { articleDetailRecordSchema, type ArticleDetailRecord } from "./article-record";

function parseArticleDetailRecord(value: unknown): ArticleDetailRecord {
  const record = articleDetailRecordSchema.parse(value);
  const { detailDigest, ...material } = record;
  if (sha256Digest(material) !== detailDigest) throw new Error("news_article_integrity_failed");
  return record;
}

const scopeSchema = z.object({ tenantId: id, workspaceId: id, projectId: id }).strict();
type Row = { payload: unknown; auth_tag: string; detail_digest: string };
/** Trusted persistence only; caller owns authorization. Never fetches or starts a task. */
export class PostgresArticleDetails {
  private readonly scope: z.infer<typeof scopeSchema>;
  private readonly key: Uint8Array;
  constructor(private readonly db: DatabaseClient, scope: unknown, key: Uint8Array) {
    this.scope = scopeSchema.parse(scope);
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("news_key_invalid");
    this.key = Uint8Array.from(key);
  }
  private values() { return [this.scope.tenantId, this.scope.workspaceId, this.scope.projectId]; }
  private tag(record: ArticleDetailRecord) { return hmacSha256Tag(this.key, { kind: "abs-article-detail/v1", ...this.scope, payload: record }); }
  private verify(row: Row) {
    const record = parseArticleDetailRecord(row.payload);
    for (const key of ["tenantId", "workspaceId", "projectId"] as const)
      if (record[key] !== this.scope[key]) throw new Error("news_article_scope_mismatch");
    if (row.detail_digest !== record.detailDigest || row.auth_tag !== this.tag(record)) throw new Error("news_article_integrity_failed");
    return record;
  }
  async get(storyId: string, storyDigest: string, detailDigest?: string) {
    id.parse(storyId); digest.parse(storyDigest); if (detailDigest !== undefined) digest.parse(detailDigest);
    const row = (await this.db.query<Row>(`SELECT payload,auth_tag,detail_digest FROM control_abs_article_details
      WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND story_id=$4 AND story_digest=$5
        AND ($6::text IS NULL OR detail_digest=$6)
      ORDER BY recorded_at DESC,detail_digest COLLATE "C" DESC LIMIT 1`,
    [...this.values(), storyId, storyDigest, detailDigest ?? null])).rows[0];
    if (!row) return undefined;
    const record = this.verify(row);
    if (record.storyId !== storyId || record.storyDigest !== storyDigest || detailDigest !== undefined && record.detailDigest !== detailDigest)
      throw new Error("news_article_integrity_failed");
    return record;
  }
  async save(value: unknown) {
    const record = parseArticleDetailRecord(value);
    for (const key of ["tenantId", "workspaceId", "projectId"] as const)
      if (record[key] !== this.scope[key]) throw new Error("news_article_scope_mismatch");
    return this.db.transaction(async tx => {
      const joined: DatabaseClient = { query: tx.query.bind(tx), transaction: work => work(tx),
        transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } };
      const story = await new PostgresAbsNewsStoreV1(joined, this.scope, this.key).getStory(record.storyId, record.storyDigest);
      if (!story || story.canonicalUrl !== record.canonicalUrl) throw new Error("news_article_source_mismatch");
      const inserted = await tx.query(`INSERT INTO control_abs_article_details
        (tenant_id,workspace_id,project_id,story_id,story_digest,detail_digest,payload,auth_tag)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING RETURNING detail_digest`,
      [...this.values(), record.storyId, record.storyDigest, record.detailDigest, JSON.stringify(record), this.tag(record)]);
      const saved = await new PostgresArticleDetails(joined, this.scope, this.key).get(record.storyId, record.storyDigest, record.detailDigest);
      if (!saved) throw new Error("news_article_integrity_failed");
      return { record: saved, replayed: inserted.rows.length === 0 };
    });
  }
}
