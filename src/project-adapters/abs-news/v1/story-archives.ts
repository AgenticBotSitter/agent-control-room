import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../../persistence/database";
import { hmacSha256Tag } from "../../../security";
import { projectWorkspaceSafeIdSchemaV1 as id, projectWorkspaceTimeSchemaV1 as time } from "../../../project-workspace/v1";

const scopeSchema = z.object({ tenantId: id, workspaceId: id, projectId: id }).strict();
export const newsArchiveRecordSchema = z.object({ storyId: id, archived: z.boolean(),
  revision: z.number().int().min(1).max(2_147_483_647), updatedAt: time }).strict();
type ArchiveRecord = z.infer<typeof newsArchiveRecordSchema>;
export type NewsArchiveRow = { story_id: string; revision: number; archived: boolean; payload: unknown; auth_tag: string };

/** Local classification only. It cannot change source versions or grant task authority.
 * Caller owns authentication; changes require an existing scoped story. */
export class PostgresNewsStoryArchives {
  private readonly scope: z.infer<typeof scopeSchema>;
  private readonly key: Uint8Array;
  constructor(private readonly db: DatabaseClient, scope: unknown, key: Uint8Array) {
    this.scope = scopeSchema.parse(scope);
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("news_key_invalid");
    this.key = Uint8Array.from(key);
  }
  private values() { return [this.scope.tenantId, this.scope.workspaceId, this.scope.projectId]; }
  private tag(payload: ArchiveRecord) { return hmacSha256Tag(this.key, { kind: "abs-story-archive/v1", ...this.scope, payload }); }
  verify(row: NewsArchiveRow) {
    const value = newsArchiveRecordSchema.parse(row.payload);
    if (value.storyId !== row.story_id || value.revision !== row.revision || value.archived !== row.archived || this.tag(value) !== row.auth_tag)
      throw new Error("news_archive_integrity_failed");
    return value;
  }
  private async read(tx: DatabaseSession, storyId: string) {
    const row = (await tx.query<NewsArchiveRow>(`SELECT story_id,revision,archived,payload,auth_tag FROM control_abs_story_archives
      WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND story_id=$4 ORDER BY revision DESC LIMIT 1`, [...this.values(), id.parse(storyId)])).rows[0];
    return row ? this.verify(row) : undefined;
  }
  get(storyId: string) { return this.read(this.db, storyId); }
  async snapshot() {
    const records = new Map<string, ArchiveRecord>(); let after: string | undefined;
    for (;;) {
      const rows = (await this.db.query<NewsArchiveRow>(`SELECT DISTINCT ON (story_id COLLATE "C") story_id,revision,archived,payload,auth_tag
        FROM control_abs_story_archives WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3
        AND ($4::text IS NULL OR story_id COLLATE "C">$4 COLLATE "C") ORDER BY story_id COLLATE "C",revision DESC LIMIT 1000`, [...this.values(), after ?? null])).rows;
      for (const row of rows) {
        const record = this.verify(row); records.set(record.storyId, record);
        if (records.size > 100_000) throw new Error("news_archive_snapshot_limit");
      }
      if (rows.length < 1000) return records;
      after = rows.at(-1)!.story_id;
    }
  }
  async save(storyId: string, archived: boolean, expectedRevision: number, updatedAt: string) {
    const expected = z.number().int().min(0).max(2_147_483_646).parse(expectedRevision);
    const record = newsArchiveRecordSchema.parse({ storyId, archived, revision: expected + 1, updatedAt });
    return this.db.transaction(async tx => {
      if (!(await tx.query("SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR UPDATE", this.values().slice(0, 2))).rows.length)
        throw new Error("news_workspace_not_found");
      if (!(await tx.query("SELECT story_id FROM control_abs_story_versions WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND story_id=$4 LIMIT 1", [...this.values(), storyId])).rows.length)
        throw new Error("news_story_not_found");
      const previous = await this.read(tx, storyId);
      if (previous?.revision === record.revision && previous.archived === record.archived)
        return { record: previous, replayed: true, startsWork: false as const };
      if ((previous?.revision ?? 0) !== expected || previous && Date.parse(record.updatedAt) < Date.parse(previous.updatedAt))
        throw new Error("news_archive_conflict");
      // Keep new classifications within the read bound. Existing articles can
      // always be restored or archived again without consuming another slot.
      if (!previous) {
        const count = (await tx.query<{ count: string }>(`SELECT count(DISTINCT story_id)::text AS count
          FROM control_abs_story_archives WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3`, this.values())).rows[0];
        if (Number(count.count) >= 100_000) throw new Error("news_archive_snapshot_limit");
      }
      await tx.query(`INSERT INTO control_abs_story_archives(tenant_id,workspace_id,project_id,story_id,revision,archived,payload,auth_tag)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [...this.values(), storyId, record.revision, archived, record, this.tag(record)]);
      return { record, replayed: false, startsWork: false as const };
    });
  }
}
