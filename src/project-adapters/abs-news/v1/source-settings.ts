import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../../security";
import { projectWorkspaceSafeIdSchemaV1 as id, projectWorkspaceLabelSchemaV1 as label,
  projectWorkspaceTimeSchemaV1 as time } from "../../../project-workspace/v1";
import { absNewsDiscoveryEndpointSchemaV1 as url } from "./schemas";

const scopeSchema = z.object({ tenantId: id, workspaceId: id, projectId: id }).strict();
// Upstream IndustrySource shape plus an owner-controlled enabled flag.
export const newsSourceSettingSchema = z.object({ id, name: label, url, enabled: z.boolean() }).strict();
const recordSchema = z.object({ source: newsSourceSettingSchema, revision: z.number().int().min(1).max(2_147_483_647), updatedAt: time }).strict();
type RecordValue = z.infer<typeof recordSchema>;
type Row = { source_id: string; revision: number; payload: unknown; auth_tag: string };

/** Application storage only, not an authorization boundary. No fetch/schedule is
 * created by a setting. Caller must authenticate owner changes before invoking. */
export class PostgresNewsSourceSettings {
  private readonly scope: z.infer<typeof scopeSchema>;
  private readonly key: Uint8Array;
  constructor(private readonly db: DatabaseClient, scope: unknown, key: Uint8Array) {
    this.scope = scopeSchema.parse(scope);
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("news_key_invalid");
    this.key = Uint8Array.from(key);
  }
  private values() { return [this.scope.tenantId, this.scope.workspaceId, this.scope.projectId]; }
  private tag(payload: RecordValue) { return hmacSha256Tag(this.key, { kind: "abs-source-setting/v1", ...this.scope, payload }); }
  private parse(row: Row) {
    const value = recordSchema.parse(row.payload);
    if (value.source.id !== row.source_id || value.revision !== row.revision || this.tag(value) !== row.auth_tag)
      throw new Error("news_source_setting_integrity_failed");
    return value;
  }
  private async read(db: DatabaseSession, sourceId: string) {
    const row = (await db.query<Row>(`SELECT source_id,revision,payload,auth_tag FROM control_abs_source_settings
      WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND source_id=$4 ORDER BY revision DESC LIMIT 1`, [...this.values(), id.parse(sourceId)])).rows[0];
    return row ? this.parse(row) : undefined;
  }
  get(sourceId: string) { return this.read(this.db, sourceId); }
  async list(after?: string) {
    if (after !== undefined) id.parse(after);
    const rows = (await this.db.query<Row>(`SELECT DISTINCT ON (source_id COLLATE "C") source_id,revision,payload,auth_tag
      FROM control_abs_source_settings WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3
      AND ($4::text IS NULL OR source_id COLLATE "C">$4 COLLATE "C")
      ORDER BY source_id COLLATE "C",revision DESC LIMIT 51`, [...this.values(), after ?? null])).rows;
    const sources = rows.slice(0, 50).map(row => this.parse(row));
    return { sources, nextCursor: rows.length > 50 ? sources.at(-1)!.source.id : null };
  }
  async save(value: unknown, expectedRevision: unknown, updatedAt: unknown) {
    const source = newsSourceSettingSchema.parse(value), expected = z.number().int().min(0).max(2_147_483_646).parse(expectedRevision);
    const record = recordSchema.parse({ source, revision: expected + 1, updatedAt });
    return this.db.transaction(async tx => {
      const workspace = (await tx.query(`SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, this.values().slice(0, 2))).rows[0];
      if (!workspace) throw new Error("news_workspace_not_found");
      const project = (await tx.query(`SELECT id FROM projects WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR SHARE`, this.values())).rows[0];
      if (!project) throw new Error("news_project_not_found");
      const previous = await this.read(tx, source.id);
      if (previous && sha256Digest(previous) === sha256Digest(record)) return { record: previous, replayed: true, startsWork: false as const };
      if ((previous?.revision ?? 0) !== expected) throw new Error("news_source_setting_conflict");
      if (previous && Date.parse(record.updatedAt) < Date.parse(previous.updatedAt)) throw new Error("news_source_setting_stale");
      await tx.query(`INSERT INTO control_abs_source_settings (tenant_id,workspace_id,project_id,source_id,revision,payload,auth_tag)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`, [...this.values(), source.id, record.revision, JSON.stringify(record), this.tag(record)]);
      return { record, replayed: false, startsWork: false as const };
    });
  }
}
