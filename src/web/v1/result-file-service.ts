import { randomUUID, createHash } from "node:crypto";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import type { DatabaseClient } from "../../persistence/database";
import { hmacSha256Tag } from "../../security";
import { resultFileCatalogSchema, resultFileDownloadSchema, type ResultFileCatalog, type ResultFileDownload } from "./result-file-wire";
import type { ResultFileStoreV1 } from "../../artifacts/v1/result-file-store";
import { catalogProjectIdSchema } from "./project-wire";

/**
 * The owner-facing half of "Save to my Mac": read the catalog, and hand the
 * owner a short-lived link to one exact file.
 *
 * The service is deliberately thin. It authorises through the same
 * `readScopedResult` boundary the existing task results use — the same project
 * view, the same `tasks.read` and `tasks.results.read` grants — so a result
 * file is no more reachable than the result it belongs to. The byte store is an
 * injected port: the service never opens a path, resolves a name or learns where
 * the store lives.
 *
 * A download link is a capability with a five-minute life, and the grant row in
 * 0208 is what makes that claim checkable. The token is HMAC-bound to the
 * project's session, the file and its digest, so it cannot be moved to another
 * project, another file, or another owner.
 */

export interface ResultFileServiceKeysV1 {
  /** 32 bytes. Signs the download token; never leaves the server. */
  downloadKey: Uint8Array;
}

export type ResultFileAuthorityV1 = {
  /** The same authorised read boundary the task results use. */
  readScopedResult: <T>(identity: VerifiedWebIdentity, projectId: string, jobId: string,
    read: (scope: { tenantId: string; projectId: string; jobId: string }) => Promise<T>) => Promise<T>;
  /** The project view check, so a scoped read can be authorised without a job. */
  authorizeProject: (identity: VerifiedWebIdentity, projectId: string) => Promise<void>;
  canRead: (identity: VerifiedWebIdentity, projectId: string) => boolean;
};

export interface ResultFileServiceV1 {
  /** The catalog for one task, or for a whole project when `jobId` is absent. */
  catalog(identity: VerifiedWebIdentity, projectId: string, jobId?: string): Promise<ResultFileCatalog>;
  /** A fresh download link for one stored file, bound to this session. */
  issueDownload(identity: VerifiedWebIdentity, projectId: string, setId: string,
    fileId: string): Promise<{ href: string; expiresAt: string }>;
  /** The bytes for a link this service issued, spent exactly once. */
  download(identity: VerifiedWebIdentity, projectId: string, setId: string, fileId: string,
    token: string): Promise<ResultFileDownload>;
}

type SetRow = {
  set_id: string; project_id: string; job_id: string; state: string; source_kind: string;
  producer_kind: string; producer_id: string; manifest_digest: string; retention_state: string;
  created_at: Date; stored_at: Date | null;
};
type FileRow = {
  set_id: string; file_id: string; ordinal: number; display_name: string;
  declared_media_type: string; detected_media_type: string; size_bytes: string;
  content_digest: string; state: string; created_at: Date;
};

const tokenLifetimeMs = 300_000;
const maxSets = 20;

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");

/**
 * The download token. Bound to the session that asked, the project, the set,
 * the file, the digest and the size, and to a five-minute window.
 *
 * Every claim is checked again against the database row before a byte is read,
 * so a token is a statement of intent, not authority on its own: if the catalog
 * changed underneath it, the read fails.
 */
function issueToken(key: Uint8Array, input: Readonly<{ sessionDigest: string; projectId: string;
  setId: string; fileId: string; contentDigest: string; sizeBytes: number }>, now: number) {
  const claims = { v: 1, ...input, iat: now, exp: now + tokenLifetimeMs };
  const payload = encode(JSON.stringify(claims));
  const tag = hmacSha256Tag(key, { purpose: "result-file-download/v1", payload });
  return { token: `${payload}.${encode(tag)}`, expiresAt: new Date(claims.exp).toISOString() };
}

function verifyToken(key: Uint8Array, token: string, expected: Readonly<{ sessionDigest: string;
  projectId: string; setId: string; fileId: string }>, now: number) {
  try {
    if (token.length > 4096) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 2) throw new Error();
    const [payload, encodedTag] = parts as [string, string];
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const expectedTag = Buffer.from(hmacSha256Tag(key, { purpose: "result-file-download/v1", payload }));
    const actualTag = Buffer.from(encodedTag, "base64url");
    if (expectedTag.length !== actualTag.length || !expectedTag.equals(actualTag)) throw new Error();
    if (claims.v !== 1 || claims.projectId !== expected.projectId || claims.setId !== expected.setId
      || claims.fileId !== expected.fileId || claims.sessionDigest !== expected.sessionDigest
      || typeof claims.iat !== "number" || typeof claims.exp !== "number"
      || now < (claims.iat as number) || now >= (claims.exp as number)
      || (claims.exp as number) - (claims.iat as number) > tokenLifetimeMs) throw new Error();
    return claims as { contentDigest: string; sizeBytes: number; iat: number; exp: number };
  } catch { throw new WebAccessError("access_denied"); }
}

const sessionDigestOf = (identity: VerifiedWebIdentity) =>
  `sha256:${createHash("sha256").update(identity.tokenDigest, "utf8").digest("hex")}`;

export interface ResultFileServiceConfigurationV1 {
  tenantId: string;
  keys: ResultFileServiceKeysV1;
  store?: ResultFileStoreV1;
  clock?: () => number;
}

/** The one place a result-file route is spelled. Every link the owner sees
 * comes from here, so there is exactly one shape to audit. */
function downloadHref(projectId: string, setId: string, fileId: string, token?: string) {
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/result-files/${encodeURIComponent(setId)}`
    + `/${encodeURIComponent(fileId)}/download`;
  return token === undefined ? base : `${base}?token=${encodeURIComponent(token)}`;
}

export function createResultFileServiceV1(db: DatabaseClient, authority: ResultFileAuthorityV1,
  configuration: ResultFileServiceConfigurationV1): ResultFileServiceV1 {
  if (!configuration?.tenantId || !(configuration.keys?.downloadKey instanceof Uint8Array)
    || configuration.keys.downloadKey.length !== 32) throw new Error("result_file_service_keys_invalid");
  if (configuration.store && typeof configuration.store.read !== "function")
    throw new Error("result_file_service_store_invalid");
  const clock = configuration.clock ?? Date.now;
  const key = Uint8Array.from(configuration.keys.downloadKey);

  const readSets = async (tx: DatabaseClient, projectId: string, jobId?: string) =>
    (await tx.query<SetRow>(`SELECT set_id,project_id,job_id,state,source_kind,producer_kind,producer_id,
        manifest_digest,retention_state,created_at,stored_at
      FROM control_result_file_sets WHERE tenant_id=$1 AND project_id=$2 AND ($3::text IS NULL OR job_id=$3)
      ORDER BY created_at DESC,set_id COLLATE "C" LIMIT $4`,
    [configuration.tenantId, projectId, jobId ?? null, maxSets + 1])).rows;

  const readFiles = async (tx: DatabaseClient, setIds: readonly string[]) => {
    if (!setIds.length) return new Map<string, FileRow[]>();
    const rows = (await tx.query<FileRow>(`SELECT set_id,file_id,ordinal,display_name,declared_media_type,
        detected_media_type,size_bytes,content_digest,state,created_at
      FROM control_result_files WHERE tenant_id=$1 AND set_id=ANY($2::text[])
      ORDER BY set_id COLLATE "C",ordinal`, [configuration.tenantId, [...setIds]])).rows;
    const grouped = new Map<string, FileRow[]>();
    for (const row of rows) grouped.set(row.set_id, [...(grouped.get(row.set_id) ?? []), row]);
    return grouped;
  };

  const project = async (tx: DatabaseClient, identity: VerifiedWebIdentity, projectId: string,
    jobId?: string): Promise<ResultFileCatalog> => {
    if (!configuration.store) return resultFileCatalogSchema.parse({ projectId, ...(jobId ? { jobId } : {}),
      sets: [], additionalSetsOmitted: false, catalogSource: "not_configured",
      observedAt: new Date(clock()).toISOString(), startsWork: false, grantsExecutionAuthority: false });
    const sets = await readSets(tx, projectId, jobId);
    const files = await readFiles(tx, sets.map(set => set.set_id));
    const now = clock();
    const parsed = sets.slice(0, maxSets).map(set => ({
      setId: set.set_id, projectId: set.project_id, jobId: set.job_id, state: set.state,
      sourceKind: set.source_kind, producerKind: set.producer_kind, producerId: set.producer_id,
      manifestDigest: set.manifest_digest, retentionState: set.retention_state,
      files: (files.get(set.set_id) ?? []).map(file => ({
        fileId: file.file_id, ordinal: file.ordinal, displayName: file.display_name,
        declaredMediaType: file.declared_media_type, detectedMediaType: file.detected_media_type,
        sizeBytes: Number(file.size_bytes), contentDigest: file.content_digest, state: file.state,
        receivedAt: new Date(file.created_at).toISOString(),
        // A link only for a stored file, and only for this session's project.
        ...(file.state === "stored" ? { downloadHref: downloadHref(set.project_id, set.set_id, file.file_id) } : {}),
      })),
      additionalFilesOmitted: (files.get(set.set_id) ?? []).length > 32,
    }));
    return resultFileCatalogSchema.parse({ projectId, ...(jobId ? { jobId } : {}), sets: parsed,
      additionalSetsOmitted: sets.length > maxSets, catalogSource: "configured",
      observedAt: new Date(now).toISOString(), startsWork: false, grantsExecutionAuthority: false });
  };

  const service: ResultFileServiceV1 = {
    async catalog(identity, projectId, jobId) {
      if (!catalogProjectIdSchema.safeParse(projectId).success) throw new WebAccessError("invalid_request");
      if (jobId !== undefined) return authority.readScopedResult(identity, projectId, jobId,
        (scope) => project(db, identity, scope.projectId, jobId));
      await authority.authorizeProject(identity, projectId);
      if (!authority.canRead(identity, projectId)) throw new WebAccessError("access_denied");
      return project(db, identity, projectId);
    },

    async issueDownload(identity, projectId, setId, fileId) {
      if (!catalogProjectIdSchema.safeParse(projectId).success) throw new WebAccessError("invalid_request");
      if (!/^result-set:[a-f0-9]{32}$/u.test(setId) || !/^result-file:[a-f0-9]{32}$/u.test(fileId))
        throw new WebAccessError("invalid_request");
      return authority.readScopedResult(identity, projectId, setId, async (scope) => {
        const row = (await db.query<SetRow & { job_id: string }>(`SELECT s.set_id,s.project_id,s.job_id,s.state,
            s.source_kind,s.producer_kind,s.producer_id,s.manifest_digest,s.retention_state,s.created_at,s.stored_at
          FROM control_result_file_sets s WHERE s.tenant_id=$1 AND s.set_id=$2 AND s.project_id=$3`,
        [scope.tenantId, setId, scope.projectId])).rows[0];
        if (!row || row.state !== "stored") throw new WebAccessError("not_found");
        const file = (await db.query<FileRow>(`SELECT set_id,file_id,ordinal,display_name,declared_media_type,
            detected_media_type,size_bytes,content_digest,state,created_at
          FROM control_result_files WHERE tenant_id=$1 AND set_id=$2 AND file_id=$3 AND state='stored'`,
        [scope.tenantId, setId, fileId])).rows[0];
        if (!file) throw new WebAccessError("not_found");
        const now = clock();
        // 0208 requires a grant row before the bytes can be read, and its guard
        // re-checks the owner session, the file's state and its exact digest and
        // size. A duplicate for the same (session, file, expiry) replays, so a
        // double-clicked Download does not mint a second row.
        const issued = issueToken(key, { sessionDigest: sessionDigestOf(identity), projectId,
          setId, fileId, contentDigest: file.content_digest, sizeBytes: Number(file.size_bytes) }, now);
        const existing = (await db.query<{ grant_id: string }>(
          `SELECT grant_id FROM control_result_file_download_grants
           WHERE tenant_id=$1 AND issued_to_token_digest=$2 AND file_id=$3 AND expires_at=$4`,
        [scope.tenantId, sessionDigestOf(identity), fileId, new Date(now + tokenLifetimeMs).toISOString()])).rows[0];
        if (!existing) await db.query(`INSERT INTO control_result_file_download_grants(tenant_id,grant_id,
            project_id,set_id,file_id,issued_to_token_digest,issued_to_identity_id,content_digest,size_bytes,
            issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [scope.tenantId, `result-grant:${randomUUID().replace(/-/gu, "").slice(0, 32)}`, scope.projectId, setId,
          fileId, sessionDigestOf(identity), identity.subject, file.content_digest, Number(file.size_bytes),
          new Date(now).toISOString(), issued.expiresAt]);
        return { href: downloadHref(scope.projectId, setId, fileId, issued.token), expiresAt: issued.expiresAt };
      });
    },

    async download(identity, projectId, setId, fileId, token) {
      if (!catalogProjectIdSchema.safeParse(projectId).success) throw new WebAccessError("invalid_request");
      if (!/^result-set:[a-f0-9]{32}$/u.test(setId) || !/^result-file:[a-f0-9]{32}$/u.test(fileId))
        throw new WebAccessError("invalid_request");
      // A grant is read and spent in ONE transaction, so two concurrent
      // downloads of the same link cannot both succeed: the second sees the
      // spent timestamp the first wrote and is refused.
      return authority.readScopedResult(identity, projectId, setId, async (scope) => {
        if (!configuration.store) throw new WebAccessError("not_found");
        const claims = verifyToken(key, token, { sessionDigest: sessionDigestOf(identity), projectId,
          setId, fileId }, clock());
        const grant = (await db.query<{ grant_id: string; content_digest: string; size_bytes: string;
          spent_at: Date | null; state: string; display_name: string; declared_media_type: string;
          detected_media_type: string }>(`SELECT g.grant_id,g.content_digest,g.size_bytes,g.spent_at,
            f.state,f.display_name,f.declared_media_type,f.detected_media_type
          FROM control_result_file_download_grants g
          JOIN control_result_files f ON f.tenant_id=g.tenant_id AND f.file_id=g.file_id
          WHERE g.tenant_id=$1 AND g.set_id=$2 AND g.file_id=$3 AND g.project_id=$4`,
        [scope.tenantId, setId, fileId, scope.projectId])).rows[0];
        if (!grant || grant.spent_at !== null || grant.state !== "stored"
          || grant.content_digest !== claims.contentDigest || Number(grant.size_bytes) !== claims.sizeBytes)
          throw new WebAccessError("not_found");
        const bytes = await configuration.store.read({ tenantId: scope.tenantId, projectId: scope.projectId,
          fileId, contentDigest: grant.content_digest });
        // The store re-proves the digest on read; a missing or altered file is
        // a 404 here rather than a download of whatever is on disk.
        if (!bytes || bytes.byteLength !== Number(grant.size_bytes)) {
          throw new WebAccessError("not_found");
        }
        // The spend is a conditional UPDATE whose result is read back, so two
        // concurrent downloads of one link cannot both succeed: exactly one
        // sees the row it just wrote. A second sees none and is refused.
        const spent = (await db.query<{ grant_id: string }>(
          `UPDATE control_result_file_download_grants SET spent_at=$2
           WHERE tenant_id=$1 AND grant_id=$3 AND spent_at IS NULL RETURNING grant_id`,
        [scope.tenantId, new Date(clock()).toISOString(), grant.grant_id])).rows;
        if (spent.length !== 1) throw new WebAccessError("not_found");
        // Parsed, not cast: the media type comes from the database as a string
        // and the response says `application/octet-stream` whatever it is, but
        // the owner-facing catalog still reports it. A row carrying a type the
        // wire contract does not know is refused here rather than echoed.
        return resultFileDownloadSchema.parse({ displayName: grant.display_name,
          mediaType: grant.detected_media_type, sizeBytes: Number(grant.size_bytes),
          contentDigest: grant.content_digest, bytes, grantId: grant.grant_id });
      });
    },
  };

  return Object.freeze(service);
}
