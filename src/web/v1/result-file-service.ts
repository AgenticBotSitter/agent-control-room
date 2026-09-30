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
  /** The same authorised read boundary the task results use. The `read` scope
   * carries the RESOLVED identity id from the authenticated transaction
   * (`actor.id`), not the caller's own `identity.subject`: on a Mac-local install
   * the subject is `owner:local` while the identity id is a tenant-scoped value,
   * and 0208's grant guard compares the row against `control_identities.id`. */
  readScopedResult: <T>(identity: VerifiedWebIdentity, projectId: string, jobId: string,
    read: (scope: { tenantId: string; projectId: string; jobId: string; identityId: string }) => Promise<T>) => Promise<T>;
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
  setId: string; fileId: string; contentDigest: string; sizeBytes: number; grantId: string }>, now: number) {
  const claims = { v: 1, ...input, iat: now, exp: now + tokenLifetimeMs };
  const payload = encode(JSON.stringify(claims));
  const tag = hmacSha256Tag(key, { purpose: "result-file-download/v1", payload });
  return { token: `${payload}.${encode(tag)}`, expiresAt: new Date(claims.exp).toISOString() };
}

function verifyToken(key: Uint8Array, token: string, expected: Readonly<{ sessionDigest: string;
  projectId: string; setId: string; fileId: string }>, now: number): Readonly<{ grantId: string;
  contentDigest: string; sizeBytes: number }> {
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
      || typeof claims.grantId !== "string" || !/^result-grant:[a-f0-9]{32}$/u.test(claims.grantId)
      || typeof claims.contentDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(claims.contentDigest)
      || typeof claims.sizeBytes !== "number" || !Number.isSafeInteger(claims.sizeBytes)
      || claims.sizeBytes < 0 || claims.sizeBytes > 268_435_456
      || typeof claims.iat !== "number" || typeof claims.exp !== "number"
      || now < (claims.iat as number) || now >= (claims.exp as number)
      || (claims.exp as number) - (claims.iat as number) > tokenLifetimeMs) throw new Error();
    return { grantId: claims.grantId, contentDigest: claims.contentDigest, sizeBytes: claims.sizeBytes };
  } catch { throw new WebAccessError("access_denied"); }
}

/** The value 0208's grant guard compares against `control_web_sessions.token_digest`.
 *
 * It is the session's OWN stored digest, NOT a hash of it. The table stores
 * `sha256(token)` and the service was writing `sha256(sha256(token))`, so the
 * guard could never match and every grant insert failed 42501 — the second bug
 * that stopped every real download. The binding to the session is already
 * enforced by `WebSessionAuthority`, which refuses an identity whose
 * `tokenDigest` has no live unrevoked session row; re-hashing it here added
 * nothing and broke the comparison. */
const sessionDigestOf = (identity: VerifiedWebIdentity) => identity.tokenDigest;

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

  /**
   * The set row, read BEFORE any authorisation, and read with the project the
   * caller's URL already names.
   *
   * The first bug the review found: this was passed to `readScopedResult` as
   * though a SET ID were a JOB ID. `WebTaskService.readScopedResult` looks its
   * third argument up as a job (`WHERE j.id=$3`), no job is named `result-set:…`,
   * and every real download answered `not_found` before a byte was read. The
   * service tests never saw it because they replaced `readScopedResult` with a
   * stub that ignored its arguments.
   *
   * So the job id is resolved HERE, from the set's own row, and it is that job
   * which is then authorised through the same boundary the task results use. The
   * set lookup is itself project-scoped, so a set belonging to another project is
   * a miss here and never reaches the authority at all — a result file is no
   * more reachable than the job it was produced for.
   */
  const readSetForJob = async (tx: DatabaseClient, tenantId: string, projectId: string, setId: string) =>
    (await tx.query<{ job_id: string }>(`SELECT job_id FROM control_result_file_sets
      WHERE tenant_id=$1 AND set_id=$2 AND project_id=$3`,
    [tenantId, setId, projectId])).rows[0];

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
      // Resolve the set's OWN job id, then authorise through that job. The set
      // lookup is project-scoped, so a set id from another project is a miss and
      // never reaches the authority; everything after this is the existing
      // `tasks.read` + `tasks.results.read` boundary for the job that produced
      // the file.
      const located = await readSetForJob(db, configuration.tenantId, projectId, setId);
      if (!located) throw new WebAccessError("not_found");
      return authority.readScopedResult(identity, projectId, located.job_id, async (scope) => {
        const row = (await db.query<SetRow>(`SELECT set_id,project_id,job_id,state,source_kind,producer_kind,
            producer_id,manifest_digest,retention_state,created_at,stored_at
          FROM control_result_file_sets WHERE tenant_id=$1 AND set_id=$2 AND project_id=$3 AND job_id=$4`,
        [scope.tenantId, setId, scope.projectId, located.job_id])).rows[0];
        if (!row || row.state !== "stored") throw new WebAccessError("not_found");
        const file = (await db.query<FileRow>(`SELECT set_id,file_id,ordinal,display_name,declared_media_type,
            detected_media_type,size_bytes,content_digest,state,created_at
          FROM control_result_files WHERE tenant_id=$1 AND set_id=$2 AND file_id=$3 AND state='stored'`,
        [scope.tenantId, setId, fileId])).rows[0];
        if (!file) throw new WebAccessError("not_found");
        const now = clock();
        // 0208 requires a grant row before the bytes can be read, and its guard
        // re-checks the owner session, the file's state and its exact digest and
        // size.
        // The grant id is part of the token's claims, so a download spends ITS OWN
        // grant and not whichever row the query plan happened to return first.
        const grantId = `result-grant:${randomUUID().replace(/-/gu, "").slice(0, 32)}`;
        const reissued = issueToken(key, { sessionDigest: sessionDigestOf(identity), projectId, setId, fileId,
          contentDigest: file.content_digest, sizeBytes: Number(file.size_bytes), grantId }, now);
        // A double-clicked Download must not mint a second row. The dedupe key is
        // (session, file, expiry) and its unique violation is what a losing racer
        // gets, so the insert is `ON CONFLICT DO NOTHING` and then re-reads the
        // winner: a SELECT-then-INSERT pair raced and turned 50 parallel mints
        // over 16 files into 16 successes and 34 x 503.
        await db.query(`INSERT INTO control_result_file_download_grants(tenant_id,grant_id,project_id,set_id,
            file_id,issued_to_token_digest,issued_to_identity_id,content_digest,size_bytes,issued_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (tenant_id,issued_to_token_digest,file_id,expires_at) DO NOTHING`,
        [scope.tenantId, grantId, scope.projectId, setId, fileId, sessionDigestOf(identity),
          scope.identityId, file.content_digest, Number(file.size_bytes),
          new Date(now).toISOString(), reissued.expiresAt]);
        // Whichever row now exists for this (session, file, expiry) is the one
        // this link spends, and the token names it, so mint and spend agree even
        // when a concurrent mint won the conflict.
        const live = (await db.query<{ grant_id: string }>(`SELECT grant_id
          FROM control_result_file_download_grants
          WHERE tenant_id=$1 AND issued_to_token_digest=$2 AND file_id=$3 AND expires_at=$4`,
        [scope.tenantId, sessionDigestOf(identity), fileId, reissued.expiresAt])).rows[0];
        if (!live) throw new WebAccessError("conflict");
        const link = live.grant_id === grantId ? reissued : issueToken(key, { sessionDigest: sessionDigestOf(identity),
          projectId, setId, fileId, contentDigest: file.content_digest, sizeBytes: Number(file.size_bytes),
          grantId: live.grant_id }, now);
        return { href: downloadHref(scope.projectId, setId, fileId, link.token), expiresAt: link.expiresAt };
      });
    },

    async download(identity, projectId, setId, fileId, token) {
      if (!catalogProjectIdSchema.safeParse(projectId).success) throw new WebAccessError("invalid_request");
      if (!/^result-set:[a-f0-9]{32}$/u.test(setId) || !/^result-file:[a-f0-9]{32}$/u.test(fileId))
        throw new WebAccessError("invalid_request");
      // Captured before the closure: `configuration.store` is optional, and the
      // narrowing from the guard below does not reach inside a callback.
      const store = configuration.store;
      if (!store) throw new WebAccessError("not_found");
      // The token is verified BEFORE any database work, and it names the grant it
      // spends. The review's fifth bug: the grant was found with
      // `WHERE tenant, set, file, project` and `rows[0]`, so a link minted by one
      // session spent ANOTHER session's grant for the same file — the other
      // session's valid link then failed, and the ledger recorded the wrong
      // "who was given this file?". Which row came back depended on the plan.
      // The token now carries the grant id, and the spend names it.
      const claims = verifyToken(key, token, { sessionDigest: sessionDigestOf(identity), projectId,
        setId, fileId }, clock());
      // Same fix as the mint: the set's OWN job id, never a set id passed where
      // a job id is expected.
      const located = await readSetForJob(db, configuration.tenantId, projectId, setId);
      if (!located) throw new WebAccessError("not_found");
      return authority.readScopedResult(identity, projectId, located.job_id, async (scope) => {
        // The spend is ONE conditional statement, and it happens BEFORE any byte
        // is read. It is the single point where "this link may be used once" is
        // decided, so two concurrent downloads of the same link cannot both
        // succeed: the first UPDATE takes the row, the second matches nothing
        // because `spent_at IS NULL` is no longer true, and `RETURNING` hands the
        // row to exactly one of them.
        //
        // The row is also required to be unexpired AT THE DATABASE CLOCK
        // (`now()`), not at this process's clock: 0208's update guard already
        // refuses a `spent_at` outside the grant's own window, so a spend made
        // with a caller-supplied timestamp would be rejected by its own trigger.
        // And the file's own row is re-checked in the same statement, so a file
        // that stopped being 'stored' cannot be downloaded on a live link.
        const spent = (await db.query<{ grant_id: string; content_digest: string; size_bytes: string;
          display_name: string; detected_media_type: string }>(`UPDATE control_result_file_download_grants g
          SET spent_at=pg_catalog.now()
          FROM control_result_files f
          WHERE g.tenant_id=$1 AND g.grant_id=$2 AND g.issued_to_token_digest=$3
            AND g.set_id=$4 AND g.file_id=$5 AND g.project_id=$6
            AND g.spent_at IS NULL AND g.expires_at>pg_catalog.now()
            AND g.content_digest=$7 AND g.size_bytes=$8
            AND f.tenant_id=g.tenant_id AND f.set_id=g.set_id AND f.file_id=g.file_id AND f.state='stored'
            RETURNING g.grant_id, g.content_digest, g.size_bytes, f.display_name, f.detected_media_type`,
        [scope.tenantId, claims.grantId, sessionDigestOf(identity), setId, fileId, scope.projectId,
          claims.contentDigest, claims.sizeBytes])).rows;
        // One row, or a refusal. Every way this can come back empty is a refusal
        // and not a download: a spent grant, an expired one, another session's,
        // a file that is no longer stored, or a catalog row whose digest moved.
        if (spent.length !== 1) throw new WebAccessError("not_found");
        const grant = spent[0]!;
        const bytes = await store.read({ tenantId: scope.tenantId, projectId: scope.projectId,
          fileId, contentDigest: grant.content_digest });
        // The store re-proves the digest on read; a missing or altered file is
        // a 404 here rather than a download of whatever is on disk. The grant is
        // already spent at this point, which is the honest accounting: the link
        // was used and the bytes could not be served, and a retry mints a new one.
        if (!bytes || bytes.byteLength !== Number(grant.size_bytes)) {
          throw new WebAccessError("not_found");
        }
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
