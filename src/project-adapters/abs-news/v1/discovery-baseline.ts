import { z } from "zod";
import type { DatabaseSession } from "../../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../../security";
import { projectWorkspaceTimeSchemaV1 as time } from "../../../project-workspace/v1";
import { absNewsDiscoveryEndpointSchemaV1 as url } from "./schemas";

// Preserve upstream snapshot semantics; bound serialized state without truncation.
export const discoverySnapshotSchema = z.object({ sourceUrl: url, endpoint: url,
  checkedAt: time, mode: z.enum(["feed", "sitemap"]).optional(),
  urls: z.record(z.string().max(2000), z.string().max(100)),
}).strict().refine(value => Object.keys(value.urls).length <= 100_000
  && Buffer.byteLength(JSON.stringify(value)) <= 8 * 1024 * 1024, "news_baseline_too_large");
type Scope = { tenantId: string; workspaceId: string; projectId: string; source: { id: string; url: string } };
const values = (scope: Scope) => [scope.tenantId, scope.workspaceId, scope.projectId, scope.source.id, scope.source.url];
const tag = (scope: Scope, key: Uint8Array, payload: unknown) => hmacSha256Tag(key,
  { kind: "abs-discovery-baseline/v1", scope: values(scope), payload });

export async function readDiscoveryBaseline(db: DatabaseSession, scope: Scope, key: Uint8Array) {
  const row = (await db.query<{ payload: unknown; auth_tag: string; checked_at: string | Date }>(
    `SELECT payload,auth_tag,checked_at FROM control_abs_discovery_baselines
     WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 AND source_id=$4 AND source_url=$5
     ORDER BY checked_at DESC LIMIT 1`, values(scope))).rows[0];
  if (!row) return undefined;
  const snapshot = discoverySnapshotSchema.parse(row.payload);
  if (snapshot.sourceUrl !== scope.source.url || tag(scope, key, snapshot) !== row.auth_tag
    || Date.parse(snapshot.checkedAt) !== new Date(row.checked_at).getTime()) throw new Error("news_baseline_integrity_failed");
  return snapshot;
}

/** Caller holds the workspace lock and shares the article transaction. */
export async function saveDiscoveryBaseline(db: DatabaseSession, scope: Scope, key: Uint8Array,
  value: unknown, expected: unknown) {
  const snapshot = discoverySnapshotSchema.parse(value);
  if (snapshot.sourceUrl !== scope.source.url) throw new Error("news_source_mismatch");
  const current = await readDiscoveryBaseline(db, scope, key);
  if (current && sha256Digest(current) === sha256Digest(snapshot)) return;
  if (sha256Digest(current ?? null) !== sha256Digest(expected ?? null)) throw new Error("news_baseline_conflict");
  if (current && Date.parse(snapshot.checkedAt) <= Date.parse(current.checkedAt)) throw new Error("news_baseline_stale");
  await db.query(`INSERT INTO control_abs_discovery_baselines
    (tenant_id,workspace_id,project_id,source_id,source_url,checked_at,payload,auth_tag)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
  [...values(scope), snapshot.checkedAt, JSON.stringify(snapshot), tag(scope, key, snapshot)]);
}
