import { createHash } from "node:crypto";
import { databaseSqlStateV1, type DatabaseClient, type DatabaseSession } from "../../persistence/database";
import { appendAuditWith } from "../../audit/audit-store";
import { bytesSha256V1, FLEET_DIGEST_PATTERN_V1, FLEET_ENTITY_ID_PATTERN_V1 } from "./identifiers";
import { fleetFail, type FleetErrorCodeV1 } from "./errors";
import type { FleetWorkerPrincipalV1 } from "./gateway-store";
import { containsSecretMaterial } from "../../security/redaction";
import type { ResultFileStoreV1 } from "../../artifacts/v1/result-file-store";
import { ResultUploadStagingError, type ResultUploadStagingV1 } from "../../artifacts/v1/result-upload-staging";

/**
 * The ingress half of "Save to my Mac" for a joined machine (plan v4.3 §2.6,
 * MIG-D). A live approved claim reserves an upload, sends 8 MiB chunks, and
 * finalises; the database decides every one of those steps is allowed and this
 * file's job is to make the honest answer easy to give and the dishonest one
 * impossible to fake.
 *
 * What this file is responsible for:
 *
 *   * Turning the plan's verbs into a small closed API the connector can call
 *     over HTTP without inventing anything: the declared outputs of a claim,
 *     `reserve`, `chunk`, `finalise`, `void`, and the `inputs` read a combine
 *     part needs.
 *   * Refusing, before any byte is stored, what the database would refuse after
 *     it. Every refusal is a fixed code and none carries a path, a name or a
 *     digest, so nothing a worker sends reaches a log.
 *   * The secret scan. §2.6 requires one and the fleet path did not have it: a
 *     text-like file carrying credential-shaped bytes is refused, which is a
 *     Needs-you reason the owner can act on rather than a silent upload.
 *   * The bytes. `staging` receives chunks, `store` writes the finished file,
 *     and this file holds neither a path nor a directory name, so it cannot be
 *     the thing that decides where a file lands.
 *
 * What this file deliberately does NOT do:
 *
 *   * It does not decide whether an upload is allowed. 0209's guards do, and
 *     they re-check the claim on every call, so a stale or forged decision here
 *     buys nothing. Where a guard raises, this file maps the state to a refusal
 *     and the connector hears a code.
 *   * It does not dedupe. Two projects uploading identical bytes get two
 *     different storage keys, and nothing anywhere answers "do you already have
 *     that" — see the note in `result-file-store.ts` and H2 in the plan.
 *   * It does not accept a directory, a glob or a path. One declared output, one
 *     ordinal, one file; the connector's own `workspaceFile` containment check
 *     happens on the machine before the bytes are ever offered here.
 *   * It does not assemble from anything the connector sends twice. The
 *     assembled file is the STAGED chunks, each already proved against the digest
 *     its own database row recorded, so a connector cannot send chunk 1, then a
 *     different chunk 1, and have the second one counted.
 */

export const FLEET_UPLOAD_LIMITS_V1 = Object.freeze({
  /** 8 MiB, the plan's chunk size. Smaller is allowed; larger is not. */
  chunkBytes: 8 * 1024 * 1024,
  /** 256 MiB per file and 32 chunks, the §2.6 per-file ceiling. */
  maximumFileBytes: 268_435_456,
  maximumChunks: 32,
  /** 32 files per result set, §2.6. */
  maximumFilesPerSet: 32,
  /** 512 MiB per set, §2.6. */
  maximumSetBytes: 536_870_912,
  /** 24 hours, the §2.6 abandoned-upload retention. */
  sessionLifetimeMs: 24 * 60 * 60_000,
  /** How many bytes of a text-like file the secret scan reads. */
  secretScanBytes: 1_048_576,
});

/** The media types 0206's catalog accepts, restated so a connector is refused
 * at the edge with a code rather than at the catalog with a constraint. */
export const FLEET_UPLOAD_MEDIA_TYPES_V1 = Object.freeze(["text/plain", "text/markdown", "text/csv",
  "text/html", "application/json", "image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf",
  "application/zip", "application/octet-stream"] as const);

/** The types a secret scan reads. Everything else is opaque bytes that cannot
 * carry a readable key, so a 200 MiB video is not string-scanned on the Mac.
 * A `.json`, `.md` and `.log` — the three extensions §2.6 names — all land here. */
const secretScannableMediaTypes = new Set<string>(["text/plain", "text/markdown", "text/csv", "text/html",
  "application/json"]);

const uploadIdPattern = /^result-upload:[a-f0-9]{32}$/u;
const iso = (value: string | Date) => new Date(value).toISOString();

export interface FleetUploadStoreOptionsV1 {
  tenantId: string;
  clock?: () => number;
  /** The Mac's byte store: where a finished file is written. */
  store: ResultFileStoreV1;
  /** The Mac's upload staging area: where a chunk lands before the file exists. */
  staging: ResultUploadStagingV1;
  /** How many bytes of a text-like file the secret scan reads. */
  secretScanBytes?: number;
}

type UploadRow = {
  upload_id: string; project_id: string; job_id: string; attempt_id: string; set_id: string;
  ordinal: number; worker_id: string; claim_id: string; expected_size_bytes: string;
  expected_content_digest: string; chunk_size_bytes: number; expected_chunks: number; state: string;
  created_at: string | Date; expires_at: string | Date; received_at: string | Date | null;
  file_id: string; display_name: string; declared_media_type: string; detected_media_type: string;
};

export type ClaimIdentityV1 = { claim_id: string; project_id: string; job_id: string; attempt_id: string };

export type FleetUploadReservationV1 = Readonly<{
  uploadId: string; setId: string; fileId: string; ordinal: number; chunkSizeBytes: number;
  expectedChunks: number; expectedSizeBytes: number; expectedContentDigest: string; expiresAt: string;
  replayed: boolean;
}>;

export type FleetUploadFinaliseV1 = Readonly<{
  uploadId: string; setId: string; fileId: string; ordinal: number; state: "received" | "published";
  manifestDigest?: string; fileCount?: number; totalBytes?: number; replayed: boolean;
}>;

/** A statement the server refused, mapped from the SQLSTATE a guard raised.
 * 0209-0211 use fixed states on purpose; this table is the whole translation,
 * and a state that is not listed is an unexpected failure rather than a refusal.
 *
 * The state is read with `databaseSqlStateV1`, never from `error.code`: the
 * production driver sanitizes every failure to `code: "database_unavailable"`
 * and keeps the SQLSTATE on `sqlState`, so reading `code` turned every guard
 * refusal into an outage and a connector retried forever instead of stopping
 * (review files2up B5). */
const refusalByState: Readonly<Record<string, FleetErrorCodeV1>> = Object.freeze({
  "42501": "forbidden",
  "23514": "invalid",
  "23505": "conflict",
  "23503": "invalid",
  "55000": "conflict",
  "2BP01": "conflict",
  "P0001": "conflict",
});

type RefusalOverridesV1 = Readonly<Record<string, FleetErrorCodeV1>>;

/** Runs `work` and maps a guard's SQLSTATE to a fixed refusal code. `overrides`
 * is how one statement says what a shared state MEANS for it: 55000 from the
 * reservation guard is Pause or Drain, and from the chunk guard it is a session
 * that no longer takes bytes. A failure with no state at all is an unexpected
 * failure, not a refusal, and is logged by the caller rather than dressed up as
 * one. */
async function guarded<T>(work: () => Promise<T>, overrides: RefusalOverridesV1 = {}): Promise<T> {
  try { return await work(); }
  catch (error) {
    const state = databaseSqlStateV1(error);
    const code = state === undefined ? undefined : overrides[state] ?? refusalByState[state];
    if (!code) throw error;
    return fleetFail(code);
  }
}

/** The staging area's four codes, as the connector's. A raw staging error used
 * to escape as a 500 (review files2up B6); `staging_ambiguous` is "try again
 * later", because it is what a read racing a writer's link honestly answers. */
const stagingRefusal: Readonly<Record<string, FleetErrorCodeV1>> = Object.freeze({
  staging_invalid: "invalid", staging_missing: "not_found", staging_conflict: "conflict",
  staging_ambiguous: "unavailable",
});
async function staged<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof ResultUploadStagingError) return fleetFail(stagingRefusal[error.code] ?? "unavailable");
    throw error;
  }
}

/** The exact size chunk `ordinal` must have under this session's tiling: full
 * chunks, then one short remainder. The same expression 0209's chunk guard, the
 * session CHECK and its update guard use. */
function chunkSizeFor(session: Pick<UploadRow, "expected_size_bytes" | "chunk_size_bytes" | "expected_chunks">,
  ordinal: number): number {
  const expected = Number(session.expected_size_bytes);
  return ordinal < session.expected_chunks ? session.chunk_size_bytes
    : expected - session.chunk_size_bytes * (session.expected_chunks - 1);
}

export class FleetUploadStoreV1 {
  private readonly tenantId: string;
  private readonly clock: () => number;
  private readonly store: ResultFileStoreV1;
  private readonly staging: ResultUploadStagingV1;
  private readonly secretScanBytes: number;
  constructor(private readonly db: DatabaseClient, options: FleetUploadStoreOptionsV1) {
    if (!options || typeof options.tenantId !== "string" || !options.store
      || typeof options.store.read !== "function" || typeof options.store.put !== "function"
      || !options.staging || typeof options.staging.stage !== "function"
      || typeof options.staging.assemble !== "function") throw new Error("fleet_upload_configuration_invalid");
    this.tenantId = options.tenantId;
    this.clock = options.clock ?? Date.now;
    this.store = options.store;
    this.staging = options.staging;
    this.secretScanBytes = options.secretScanBytes ?? FLEET_UPLOAD_LIMITS_V1.secretScanBytes;
  }

  private now(): string {
    const now = this.clock();
    if (!Number.isSafeInteger(now)) return fleetFail("unavailable");
    return new Date(now).toISOString();
  }

  /**
   * The live claim, with the project, job and attempt every call needs.
   *
   * Liveness is 0140's own predicate, evaluated at the database clock inside
   * this transaction — a revoked worker, an elapsed lease, a released claim or
   * an expired credential all answer `false` here, and so do the 0209 guards,
   * so a caller that got this far with a dead claim has nothing to do next. A
   * claim that is not this worker's is reported as missing, so a probe learns
   * nothing about another machine's work.
   */
  private async claim(tx: DatabaseSession, principal: FleetWorkerPrincipalV1, claimIdValue: unknown): Promise<ClaimIdentityV1> {
    const claimId = typeof claimIdValue === "string" && FLEET_ENTITY_ID_PATTERN_V1.test(claimIdValue)
      && claimIdValue.startsWith("fleet-claim:") ? claimIdValue : fleetFail("not_found");
    const row = (await tx.query<ClaimIdentityV1>(
      `SELECT fc.claim_id,fc.project_id,fc.job_id,fc.attempt_id FROM fleet_claims fc
      WHERE fc.tenant_id=$1 AND fc.claim_id=$2 AND fc.worker_id=$3
        AND fleet_claim_is_live($1,$2,$3)`,
      [this.tenantId, claimId, principal.workerId])).rows[0];
    if (!row) return fleetFail("expired");
    return row;
  }

  /** One upload session, proved to be THIS claim's. The catalog file it names
   * is read here too, because the store's key is derived from the file id and
   * the finalise needs the display name for the secret scan. */
  private async session(tx: DatabaseSession, claim: ClaimIdentityV1, principal: FleetWorkerPrincipalV1,
    uploadIdValue: unknown): Promise<UploadRow> {
    const uploadId = typeof uploadIdValue === "string" && uploadIdPattern.test(uploadIdValue)
      ? uploadIdValue : fleetFail("not_found");
    const row = (await tx.query<UploadRow>(
      `SELECT u.upload_id,u.project_id,u.job_id,u.attempt_id,u.set_id,u.ordinal,u.worker_id,u.claim_id,
        u.expected_size_bytes,u.expected_content_digest,u.chunk_size_bytes,u.expected_chunks,u.state,
        u.created_at,u.expires_at,u.received_at,f.file_id,f.display_name,f.declared_media_type,
        f.detected_media_type
      FROM control_result_upload_sessions u
      JOIN control_result_files f ON f.tenant_id=u.tenant_id AND f.set_id=u.set_id AND f.ordinal=u.ordinal
      WHERE u.tenant_id=$1 AND u.upload_id=$2`,
      [this.tenantId, uploadId])).rows[0];
    if (!row || row.worker_id !== principal.workerId || row.claim_id !== claim.claim_id
      || row.project_id !== claim.project_id || row.job_id !== claim.job_id
      || row.attempt_id !== claim.attempt_id) return fleetFail("not_found");
    return row;
  }

  /**
   * What this claim may send: the owner's declared outputs, each with the
   * promise the catalog already carries, and whether an upload exists for it
   * yet. This is the whole of what a connector needs to begin, and it is a read
   * of the declaration plus the session — never of the byte store, never of
   * another project's files, and never a path.
   */
  async declaredOutputs(principal: FleetWorkerPrincipalV1, claimId: unknown) {
    return this.db.transaction(async tx => {
      const claim = await this.claim(tx, principal, claimId);
      const outputs = (await tx.query<{ ordinal: number; display_name: string; declared_media_type: string;
        size_bytes: string; content_digest: string; file_id: string; set_id: string; upload_id: string | null;
        upload_state: string | null; expires_at: string | Date | null }>(
        `SELECT d.ordinal,d.display_name,d.declared_media_type,f.size_bytes,f.content_digest,f.file_id,
          f.set_id,u.upload_id,u.state AS upload_state,u.expires_at
        FROM control_task_declared_outputs d
        JOIN control_result_file_sets s ON s.tenant_id=$1 AND s.job_id=d.job_id AND s.attempt_id=$2
          AND s.producer_id=$3 AND s.producer_kind='fleet' AND s.source_kind='file-store' AND s.state='declared'
        JOIN control_result_files f ON f.tenant_id=s.tenant_id AND f.set_id=s.set_id AND f.ordinal=d.ordinal
        LEFT JOIN control_result_upload_sessions u ON u.tenant_id=$1 AND u.set_id=f.set_id AND u.ordinal=f.ordinal
        WHERE d.tenant_id=$1 AND d.job_id=$4 ORDER BY d.ordinal`,
        [this.tenantId, claim.attempt_id, principal.workerId, claim.job_id])).rows;
      return Object.freeze({
        claimId: claim.claim_id, projectId: claim.project_id, jobId: claim.job_id,
        chunkSizeBytes: FLEET_UPLOAD_LIMITS_V1.chunkBytes,
        maximumFileBytes: FLEET_UPLOAD_LIMITS_V1.maximumFileBytes,
        files: Object.freeze(outputs.map(row => Object.freeze({
          ordinal: row.ordinal, displayName: row.display_name, mediaType: row.declared_media_type,
          sizeBytes: Number(row.size_bytes), contentDigest: row.content_digest, fileId: row.file_id,
          setId: row.set_id, uploadId: row.upload_id, uploadState: row.upload_state,
          expiresAt: row.expires_at ? iso(row.expires_at) : null,
        }))),
      });
    });
  }

  /**
   * Reserves one declared output's upload. Idempotent on the promise: reserving
   * an ordinal that already has a session returns THAT session, and the session
   * id is derived from the claim, the set and the ordinal so a retried
   * reservation is the same row even across processes.
   *
   * The set, the file and the promise are the DATABASE's: the caller names an
   * ordinal and restates the size and digest it means to send, and both 0209's
   * guard and the check here compare those to the owner-approved row. A caller
   * that lies is refused before a session exists.
   */
  async reserve(principal: FleetWorkerPrincipalV1, input: Readonly<{ claimId: unknown; ordinal: unknown;
    sizeBytes: unknown; contentDigest: unknown; mediaType?: unknown }>): Promise<FleetUploadReservationV1> {
    const ordinal = Number.isSafeInteger(input.ordinal) && (input.ordinal as number) >= 1
      && (input.ordinal as number) <= FLEET_UPLOAD_LIMITS_V1.maximumFilesPerSet ? input.ordinal as number
      : fleetFail("invalid");
    if (!Number.isSafeInteger(input.sizeBytes) || (input.sizeBytes as number) < 1
      || (input.sizeBytes as number) > FLEET_UPLOAD_LIMITS_V1.maximumFileBytes) return fleetFail("invalid");
    if (typeof input.contentDigest !== "string" || !FLEET_DIGEST_PATTERN_V1.test(input.contentDigest))
      return fleetFail("invalid");
    if (input.mediaType !== undefined
      && !(FLEET_UPLOAD_MEDIA_TYPES_V1 as readonly string[]).includes(input.mediaType as string))
      return fleetFail("invalid");
    const digest = input.contentDigest as string;
    const sizeBytes = input.sizeBytes as number;
    const now = this.now();
    return this.db.transaction(async tx => {
      const claim = await this.claim(tx, principal, input.claimId);
      const target = (await tx.query<{ set_id: string; file_id: string; size_bytes: string;
        content_digest: string; state: string; upload_id: string | null; chunk_size_bytes: number | null;
        expected_chunks: number | null; expires_at: string | Date | null }>(
        `SELECT f.set_id,f.file_id,f.size_bytes,f.content_digest,f.state,
          u.upload_id,u.chunk_size_bytes,u.expected_chunks,u.expires_at
        FROM control_task_declared_outputs d
        JOIN control_result_file_sets s ON s.tenant_id=$1 AND s.job_id=d.job_id AND s.attempt_id=$2
          AND s.producer_id=$3 AND s.producer_kind='fleet' AND s.source_kind='file-store'
          AND s.project_id=$4 AND s.state='declared'
        JOIN control_result_files f ON f.tenant_id=s.tenant_id AND f.set_id=s.set_id AND f.ordinal=d.ordinal
        LEFT JOIN control_result_upload_sessions u ON u.tenant_id=$1 AND u.set_id=f.set_id AND u.ordinal=f.ordinal
        WHERE d.tenant_id=$1 AND d.job_id=$5 AND d.ordinal=$6`,
        [this.tenantId, claim.attempt_id, principal.workerId, claim.project_id, claim.job_id, ordinal])).rows[0];
      if (!target) return fleetFail("not_found");
      // The promise is compared HERE as well as in 0209's guard, so an honest
      // caller is told what it got wrong. The guard is the proof; this is the
      // message.
      if (target.size_bytes !== String(sizeBytes) || target.content_digest !== digest) return fleetFail("invalid");
      if (target.state !== "declared") return fleetFail("conflict");
      const expiresAt = target.expires_at
        ? iso(target.expires_at) : iso(new Date(Date.parse(now) + FLEET_UPLOAD_LIMITS_V1.sessionLifetimeMs));
      if (target.upload_id) return Object.freeze({ uploadId: target.upload_id, setId: target.set_id,
        fileId: target.file_id, ordinal, chunkSizeBytes: target.chunk_size_bytes ?? FLEET_UPLOAD_LIMITS_V1.chunkBytes,
        expectedChunks: target.expected_chunks ?? 1, expectedSizeBytes: sizeBytes,
        expectedContentDigest: digest, expiresAt, replayed: true });
      const uploadId = `result-upload:${createHash("sha256")
        .update(JSON.stringify(["fleet-upload/v1", this.tenantId, claim.claim_id, target.set_id, ordinal]), "utf8")
        .digest("hex").slice(0, 32)}`;
      const chunkSizeBytes = FLEET_UPLOAD_LIMITS_V1.chunkBytes;
      const expectedChunks = Math.ceil(sizeBytes / chunkSizeBytes);
      if (expectedChunks > FLEET_UPLOAD_LIMITS_V1.maximumChunks) return fleetFail("too_large");
      // 55000 here is 0209's operations-mode refusal: a paused or draining
      // installation takes no new reservation, and the connector must hear
      // `paused` (and wait) rather than `conflict` (and give up) or an outage.
      await guarded(() => tx.query(
        `INSERT INTO control_result_upload_sessions(tenant_id,upload_id,project_id,job_id,attempt_id,set_id,
          ordinal,worker_id,claim_id,expected_size_bytes,expected_content_digest,chunk_size_bytes,
          expected_chunks,state,created_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'reserved',$14,$15)`,
        [this.tenantId, uploadId, claim.project_id, claim.job_id, claim.attempt_id, target.set_id, ordinal,
          principal.workerId, claim.claim_id, sizeBytes, digest, chunkSizeBytes, expectedChunks, now, expiresAt]),
        { "55000": "paused" });
      return Object.freeze({ uploadId, setId: target.set_id, fileId: target.file_id, ordinal, chunkSizeBytes,
        expectedChunks, expectedSizeBytes: sizeBytes, expectedContentDigest: digest, expiresAt, replayed: false });
    });
  }

  /**
   * One chunk, in three steps, and only the first and last touch the database.
   *
   *   1. A short transaction reads the claim, the session and any row already
   *      recorded for this ordinal. The ordinal and the exact byte length are
   *      checked against the session HERE, before a byte reaches the disk: a
   *      chunk past the promise, or of the wrong size for its position, used to
   *      be staged first and refused afterwards, and its bytes stayed on the Mac
   *      forever and wedged the correct retry (review files2up B6).
   *   2. The bytes are staged with NO transaction open. Staging queues behind
   *      the process-wide write queue and fsyncs up to 8 MiB, and holding a pool
   *      connection across that starved heartbeats and claims under parallel
   *      uploads (review files2up S3).
   *   3. A short transaction records the row. If the database refuses it, the
   *      staged bytes are removed again -- unless the refusal was a concurrent,
   *      identical request recording the very same chunk first, which is a
   *      replay and keeps them.
   *
   * A crash between 2 and 3 leaves staged bytes with no row, never a row with
   * no bytes; the next exact retry finds the bytes and records them.
   *
   * An exact retry replays, and it says so by NAME: the caller gets back the
   * digest the server recorded, so a connector that is out of sync learns WHICH
   * chunk differs rather than only that a request failed.
   */
  async chunk(principal: FleetWorkerPrincipalV1, input: Readonly<{ claimId: unknown; uploadId: unknown;
    ordinal: unknown; bytes: unknown }>) {
    if (!Number.isSafeInteger(input.ordinal) || (input.ordinal as number) < 1
      || (input.ordinal as number) > FLEET_UPLOAD_LIMITS_V1.maximumChunks) return fleetFail("invalid");
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1
      || input.bytes.byteLength > FLEET_UPLOAD_LIMITS_V1.chunkBytes) return fleetFail("invalid");
    const ordinal = input.ordinal as number;
    const bytes = Uint8Array.from(input.bytes);
    const chunkDigest = bytesSha256V1(bytes);
    const now = this.now();
    const read = await this.db.transaction(async tx => {
      const claim = await this.claim(tx, principal, input.claimId);
      const session = await this.session(tx, claim, principal, input.uploadId);
      return { session, prior: await this.recordedChunk(tx, session.upload_id, ordinal) };
    });
    const { session } = read;
    const identity = { tenantId: this.tenantId, projectId: session.project_id, uploadId: session.upload_id, ordinal };
    if (read.prior) return this.replayChunk(read.prior, identity, bytes, chunkDigest, session.state);
    if (session.state !== "reserved") return fleetFail("conflict");
    if (Date.parse(iso(session.expires_at)) <= Date.parse(now)) return fleetFail("expired");
    if (ordinal > session.expected_chunks || bytes.byteLength !== chunkSizeFor(session, ordinal))
      return fleetFail("invalid");
    const stagedChunk = await this.stageChunk(session, ordinal, bytes);
    try {
      await this.db.transaction(async tx => {
        await this.claim(tx, principal, input.claimId);
        await guarded(() => tx.query(
          `INSERT INTO control_result_upload_chunks(tenant_id,upload_id,ordinal,size_bytes,chunk_digest,received_at)
          VALUES($1,$2,$3,$4,$5,$6)`,
          [this.tenantId, session.upload_id, ordinal, bytes.byteLength, chunkDigest, now]));
      });
    } catch (error) {
      const recorded = await this.recordedChunk(this.db, session.upload_id, ordinal).catch(() => undefined);
      if (recorded && recorded.chunk_digest === chunkDigest && recorded.size_bytes === String(bytes.byteLength))
        return Object.freeze({ uploadId: session.upload_id, ordinal, chunkDigest, sizeBytes: bytes.byteLength,
          replayed: true });
      // Nothing recorded this ordinal, so the staged bytes are no chunk of any
      // upload. They go now rather than waiting for a sweeper that does not
      // exist yet; a failed removal is left to that sweeper, and the refusal
      // itself is still the answer.
      if (!recorded) await this.staging.discardChunk(identity).catch(() => {});
      throw error;
    }
    return Object.freeze({ uploadId: session.upload_id, ordinal, chunkDigest,
      sizeBytes: bytes.byteLength, replayed: false, ...(stagedChunk.replayed ? { stagedReplay: true } : {}) });
  }

  private async recordedChunk(session: DatabaseSession, uploadId: string, ordinal: number) {
    return (await session.query<{ chunk_digest: string; size_bytes: string }>(
      `SELECT chunk_digest,size_bytes FROM control_result_upload_chunks
      WHERE tenant_id=$1 AND upload_id=$2 AND ordinal=$3`,
      [this.tenantId, uploadId, ordinal])).rows[0];
  }

  /** A chunk whose row already exists. The bytes must be the recorded ones, and
   * they are proved present again rather than assumed, because a staging area
   * that lost a file is exactly the case finalise must not discover for itself.
   * A row whose bytes are gone from disk is healed from THIS request -- its
   * digest is the row's, so they are provably the same bytes -- rather than
   * wedging the upload on a chunk nobody can resend. */
  private async replayChunk(prior: { chunk_digest: string; size_bytes: string },
    identity: { tenantId: string; projectId: string; uploadId: string; ordinal: number },
    bytes: Uint8Array, chunkDigest: string, sessionState: string) {
    if (prior.chunk_digest !== chunkDigest || prior.size_bytes !== String(bytes.byteLength))
      return fleetFail("conflict");
    if (sessionState === "reserved") {
      const onDisk = await staged(() => this.staging.read(identity));
      if (!onDisk) await staged(() => this.staging.stage(identity, bytes));
      else if (bytesSha256V1(onDisk) !== chunkDigest) return fleetFail("conflict");
    }
    return Object.freeze({ uploadId: identity.uploadId, ordinal: identity.ordinal, chunkDigest,
      sizeBytes: bytes.byteLength, replayed: true });
  }

  /** Stages one chunk and scans it when it is text-like. The scan happens
   * HERE, on the way in, rather than at finalise: §2.6's requirement is that a
   * credential-shaped file is refused with a Needs-you reason, and a connector
   * that is told at the chunk that carried the credential stops sending rather
   * than sending 32 chunks of it first. */
  private async stageChunk(session: UploadRow, ordinal: number, bytes: Uint8Array) {
    if (this.carriesSecretMaterial(session, bytes)) return fleetFail("refused_secret_material");
    return staged(() => this.staging.stage({ tenantId: this.tenantId, projectId: session.project_id,
      uploadId: session.upload_id, ordinal }, bytes));
  }

  private carriesSecretMaterial(session: UploadRow, bytes: Uint8Array): boolean {
    return scanForSecretsV1(bytes, session.detected_media_type || session.declared_media_type,
      this.secretScanBytes);
  }

  /**
   * Finalise. This is where the promise is proved, and the proof is the
   * STORE'S: the staged chunks are assembled in ordinal order, the whole-file
   * digest is recomputed and compared to what the OWNER approved, the secret
   * scan is run over the assembled bytes, and the store writes them create-once
   * and reads them back. Only then does the session become 'received', and only
   * a received session can be published into the set.
   *
   * The assembly happens OUTSIDE any write transaction: holding one open across
   * a 256 MiB write would hold this claim's connection for the length of the
   * transfer, and the transition is re-checked inside the transaction that makes
   * it, so nothing about the proof depends on the read being fresh.
   */
  async finalise(principal: FleetWorkerPrincipalV1, input: Readonly<{ claimId: unknown; uploadId: unknown;
    publish?: unknown }>): Promise<FleetUploadFinaliseV1> {
    if (input.publish !== undefined && typeof input.publish !== "boolean") return fleetFail("invalid");
    const now = this.now();
    const read = await this.db.transaction(async tx => {
      const claim = await this.claim(tx, principal, input.claimId);
      return await this.session(tx, claim, principal, input.uploadId);
    });
    if (read.state === "published" || read.state === "received")
      return await this.publish(read, input.publish === true, true);
    if (read.state !== "reserved") return fleetFail("conflict");
    const expectedSize = Number(read.expected_size_bytes);
    const expectedChunks = read.expected_chunks;
    const chunks = (await this.db.query<{ ordinal: number; size_bytes: string; chunk_digest: string }>(
      `SELECT ordinal,size_bytes,chunk_digest FROM control_result_upload_chunks
      WHERE tenant_id=$1 AND upload_id=$2 ORDER BY ordinal`, [this.tenantId, read.upload_id])).rows;
    // The tiling, checked here as well as in 0209's guard: a connector at fault
    // gets told, and 0209 still refuses the transition regardless.
    if (chunks.length !== expectedChunks
      || chunks.reduce((sum, chunk) => sum + Number(chunk.size_bytes), 0) !== expectedSize
      || chunks.some((chunk, index) => chunk.ordinal !== index + 1
        || Number(chunk.size_bytes) !== (chunk.ordinal < expectedChunks
          ? read.chunk_size_bytes : expectedSize - read.chunk_size_bytes * (expectedChunks - 1)))) {
      return fleetFail("invalid");
    }
    if (expectedSize < 1) return fleetFail("invalid");
    const bytes = await staged(() => this.staging.assemble({ tenantId: this.tenantId,
      projectId: read.project_id, uploadId: read.upload_id }, expectedChunks));
    // The whole-file proof, over the assembled bytes and before anything is
    // stored. §2.6's "unreviewed bytes are never combined" and 0209's promise
    // are the same statement: these are the bytes the owner approved.
    if (bytes.byteLength !== expectedSize || bytesSha256V1(bytes) !== read.expected_content_digest)
      return fleetFail("invalid");
    if (this.carriesSecretMaterial(read, bytes)) return fleetFail("refused_secret_material");
    // The store writes create-once and re-proves the digest on the way in and
    // on the way out, so a file that is visible is a file that hashes to what
    // the catalog says.
    await this.store.put({ tenantId: this.tenantId, projectId: read.project_id,
      fileId: read.file_id, contentDigest: read.expected_content_digest, bytes,
      setBytes: expectedSize, setFiles: 1 });
    const received = await this.db.transaction(async tx => {
      // Re-read the session under this transaction and lock it: another caller
      // may have finalised it while the bytes were being assembled. The lock is
      // what makes the transition single-writer, so two concurrent finalises of
      // the same upload produce one 'received' row and one replay, never two
      // publications of the same bytes.
      const current = (await tx.query<UploadRow>(
        `SELECT u.upload_id,u.project_id,u.job_id,u.attempt_id,u.set_id,u.ordinal,u.worker_id,u.claim_id,
          u.expected_size_bytes,u.expected_content_digest,u.chunk_size_bytes,u.expected_chunks,u.state,
          u.created_at,u.expires_at,u.received_at,f.file_id,f.display_name,f.declared_media_type,
          f.detected_media_type
        FROM control_result_upload_sessions u
        JOIN control_result_files f ON f.tenant_id=u.tenant_id AND f.set_id=u.set_id AND f.ordinal=u.ordinal
        WHERE u.tenant_id=$1 AND u.upload_id=$2 AND u.claim_id=$3 AND u.worker_id=$4 FOR UPDATE OF u`,
        [this.tenantId, read.upload_id, read.claim_id, principal.workerId])).rows[0];
      if (!current) return fleetFail("not_found");
      if (current.state === "received" || current.state === "published") return { ...current, replayed: true };
      if (current.state !== "reserved") return fleetFail("conflict");
      await guarded(() => tx.query(
        `UPDATE control_result_upload_sessions SET state='received',received_at=$3
        WHERE tenant_id=$1 AND upload_id=$2 AND state='reserved'`,
        [this.tenantId, read.upload_id, now]));
      return { ...current, state: "received", received_at: now, replayed: false };
    });
    // The staged chunks are no longer needed the moment the file exists in the
    // store; their removal is a cleanup, so a failure here is not a failure of
    // the finalise and is left to the sweeper.
    void this.staging.discardSession({ tenantId: this.tenantId, projectId: read.project_id,
      uploadId: read.upload_id }).catch(() => {});
    return await this.publish(received, input.publish === true, received.replayed);
  }

  /**
   * Publishes every received session of the set into the catalog, and records
   * the set's publication receipt. This is the §2.6 rule "a manifest can only
   * publish when every promised file is present and verified": 0210's guard
   * refuses a receipt whose set is missing a file, and 0206's own deferred
   * trigger refuses the stored transition without exactly the declared files.
   *
   * The ORDER here is the order the guards require: files stored first (each
   * needs its own published session — so the sessions are published first), then
   * the receipt, then the set. All in one transaction, so a failure at any point
   * leaves the set 'declared' and the owner seeing an incomplete result rather
   * than a complete one with a missing file.
   */
  private async publish(session: UploadRow, requested: boolean, replayed: boolean): Promise<FleetUploadFinaliseV1> {
    const view = { uploadId: session.upload_id, setId: session.set_id, fileId: session.file_id,
      ordinal: session.ordinal, state: session.state as "received" | "published", replayed };
    if (session.state === "published") return view;
    if (!requested) return view;
    const now = this.now();
    return this.db.transaction(async tx => {
      const set = (await tx.query<{ project_id: string; job_id: string; attempt_id: string; state: string;
        file_count: number; total_bytes: string }>(
        `SELECT project_id,job_id,attempt_id,state,file_count,total_bytes FROM control_result_file_sets
        WHERE tenant_id=$1 AND set_id=$2 FOR UPDATE`, [this.tenantId, session.set_id])).rows[0];
      if (!set) return fleetFail("not_found");
      if (set.state === "stored") {
        // Already published by a concurrent caller or a previous attempt: the
        // session state is the answer, and it is idempotent.
        return { ...view, state: "published" as const };
      }
      // Every promised file has arrived through its own upload: RECEIVED (its
      // bytes are in the store, ready to publish in the loop below) or already
      // PUBLISHED. A set with one file still 'reserved' is a result the owner
      // must be told is incomplete, not one that goes 'stored' with a hole.
      //
      // This asked for 'published' only in its first version -- but a session
      // becomes 'published' INSIDE the loop that follows, so the check refused
      // every complete, verified upload and no remote file could ever reach the
      // owner (review files2up B4).
      const pending = (await tx.query<{ ordinal: number }>(
        `SELECT f.ordinal FROM control_result_files f
        WHERE f.tenant_id=$1 AND f.set_id=$2 AND NOT EXISTS (
          SELECT 1 FROM control_result_upload_sessions u WHERE u.tenant_id=f.tenant_id
            AND u.set_id=f.set_id AND u.ordinal=f.ordinal AND u.state IN ('received','published')
              AND u.expected_size_bytes=f.size_bytes AND u.expected_content_digest=f.content_digest)
        ORDER BY f.ordinal`, [this.tenantId, session.set_id])).rows;
      if (pending.length) return fleetFail("conflict");
      for (const file of (await tx.query<{ ordinal: number }>(
        `SELECT ordinal FROM control_result_files WHERE tenant_id=$1 AND set_id=$2 AND state<>'stored'
        ORDER BY ordinal`, [this.tenantId, session.set_id])).rows) {
        await guarded(() => tx.query(
          `UPDATE control_result_upload_sessions SET state='published',published_at=$3
          WHERE tenant_id=$1 AND set_id=$2 AND ordinal=$4 AND state='received'`,
          [this.tenantId, session.set_id, now, file.ordinal]));
        await guarded(() => tx.query(
          `UPDATE control_result_files SET state='stored',stored_at=$3
          WHERE tenant_id=$1 AND set_id=$2 AND ordinal=$4 AND state='declared'`,
          [this.tenantId, session.set_id, now, file.ordinal]));
      }
      // The manifest digest 0206 recomputes over the ordered rows, computed here
      // the same way so the value written is the one the guard will demand.
      const manifest = (await tx.query<{ digest: string }>(
        `SELECT 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          string_agg(ordinal::text || ':' || storage_key || ':' || content_digest || ':' || size_bytes::text,
          E'\\n' ORDER BY ordinal), 'UTF8')), 'hex') AS digest
        FROM control_result_files WHERE tenant_id=$1 AND set_id=$2 AND state='stored'`,
        [this.tenantId, session.set_id])).rows[0]?.digest;
      if (!manifest) return fleetFail("conflict");
      // The receipt, which 0210's guard checks against the set, and the set's
      // own transition, which 0206's trigger checks against the files. Both are
      // in this transaction, and the deferred triggers fire at its commit.
      await guarded(() => tx.query(
        `INSERT INTO control_result_publications(tenant_id,set_id,project_id,job_id,attempt_id,
          manifest_digest,file_count,total_bytes,published_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id,set_id) DO NOTHING`,
        [this.tenantId, session.set_id, set.project_id, set.job_id, set.attempt_id, manifest,
          set.file_count, set.total_bytes, now]));
      await guarded(() => tx.query(
        `UPDATE control_result_file_sets SET state='stored',stored_at=$3,manifest_digest=$4
        WHERE tenant_id=$1 AND set_id=$2 AND state='declared'`,
        [this.tenantId, session.set_id, now, manifest]));
      await appendAuditWith(tx, { id: `audit:fleet-upload-published:${session.upload_id.slice(14)}`,
        tenantId: this.tenantId, projectId: set.project_id, actorId: "service:fleet-gateway",
        actorType: "service", action: "fleet.result.published", targetType: "result_file_set",
        targetId: session.set_id, occurredAt: now,
        safeMetadata: { claimId: session.claim_id, fileCount: set.file_count, manifestDigest: manifest } });
      return { ...view, state: "published" as const, manifestDigest: manifest, fileCount: set.file_count,
        totalBytes: Number(set.total_bytes), replayed: false };
    });
  }

  /**
   * A worker's own abandoned upload, or the owner's Stop voiding one. 0209's
   * guard is what makes this safe: a worker's void needs a live claim over the
   * session, and only `stopped` — the one void with no claim left to check —
   * is allowed when the installation is not running.
   */
  async voidUpload(principal: FleetWorkerPrincipalV1, input: Readonly<{ claimId: unknown; uploadId: unknown;
    reason?: unknown }>) {
    const reason = input.reason === undefined ? "abandoned" : input.reason;
    if (!["abandoned", "content_mismatch", "stopped"].includes(reason as string)) return fleetFail("invalid");
    const now = this.now();
    return this.db.transaction(async tx => {
      const claim = await this.claim(tx, principal, input.claimId);
      const session = await this.session(tx, claim, principal, input.uploadId);
      if (session.state === "voided") return Object.freeze({ uploadId: session.upload_id, state: "voided",
        replayed: true });
      if (session.state === "published") return fleetFail("conflict");
      await guarded(() => tx.query(
        `UPDATE control_result_upload_sessions SET state='voided',void_reason=$3,voided_at=$4
        WHERE tenant_id=$1 AND upload_id=$2 AND state<>'voided'`,
        [this.tenantId, session.upload_id, reason as string, now]));
      await appendAuditWith(tx, { id: `audit:fleet-upload-void:${session.upload_id.slice(14)}`,
        tenantId: this.tenantId, projectId: session.project_id, actorId: principal.identityId,
        actorType: "worker", action: "fleet.upload.voided", targetType: "result_upload",
        targetId: session.upload_id, occurredAt: now,
        safeMetadata: { claimId: session.claim_id, ordinal: session.ordinal, reason: reason as string } });
      // The bytes go too. A voided upload's staged chunks are exactly the ones
      // this session's own ordinals name, so nothing else can be removed.
      void this.staging.discardSession({ tenantId: this.tenantId, projectId: session.project_id,
        uploadId: session.upload_id }).catch(() => {});
      return Object.freeze({ uploadId: session.upload_id, state: "voided", replayed: false });
    });
  }

  /**
   * The combine part's inputs, for the claim that will consume them (§2.3).
   *
   * Every row comes from `control_job_artifact_inputs`, whose columns were
   * DERIVED by 0211's binding guard from the accepted catalog row. The gateway
   * does hold SELECT on the catalog (0209's SECURITY INVOKER reservation guard
   * reads it; review files2up S6 asks whether a narrower read should replace
   * that), but THIS read cannot be widened into "any file of this project": it
   * names only what the owner declared as this claim's inputs, and only what
   * the owner already accepted. The project
   * scope is the CLAIM's, not the caller's, and a mismatch is a refusal rather
   * than a filter, so there is no way to observe that another project's binding
   * exists.
   */
  async inputs(principal: FleetWorkerPrincipalV1, claimId: unknown) {
    return this.db.transaction(async tx => {
      const claim = await this.claim(tx, principal, claimId);
      const rows = (await tx.query<{ ordinal: number; display_name: string; size_bytes: string;
        content_digest: string; file_id: string; source_set_id: string; producer_job_id: string;
        detected_media_type: string }>(
        `SELECT a.ordinal,a.display_name,a.size_bytes,a.content_digest,a.file_id,a.source_set_id,
          a.producer_job_id,f.detected_media_type
        FROM control_job_artifact_inputs a
        JOIN control_result_files f ON f.tenant_id=$1 AND f.file_id=a.file_id AND f.state='stored'
        WHERE a.tenant_id=$1 AND a.consumer_job_id=$2 AND a.project_id=$3
          AND EXISTS (SELECT 1 FROM control_task_declared_inputs d WHERE d.tenant_id=$1
            AND d.job_id=a.consumer_job_id AND d.ordinal=a.ordinal)
        ORDER BY a.ordinal`,
        [this.tenantId, claim.job_id, claim.project_id])).rows;
      return Object.freeze({ claimId: claim.claim_id, jobId: claim.job_id,
        inputs: Object.freeze(rows.map(row => Object.freeze({
          ordinal: row.ordinal, displayName: row.display_name, sizeBytes: Number(row.size_bytes),
          contentDigest: row.content_digest, fileId: row.file_id, setId: row.source_set_id,
          producerJobId: row.producer_job_id, mediaType: row.detected_media_type,
        }))) });
    });
  }

  /** Downloads one declared input's bytes for a live claim, re-proving the
   * digest on the way out. The store refuses a file that is not there, and the
   * byte-length comparison is what refuses one that is there but is not this. */
  async inputBytes(principal: FleetWorkerPrincipalV1, input: Readonly<{ claimId: unknown; ordinal: unknown }>) {
    if (!Number.isSafeInteger(input.ordinal) || (input.ordinal as number) < 1
      || (input.ordinal as number) > FLEET_UPLOAD_LIMITS_V1.maximumFilesPerSet) return fleetFail("invalid");
    const read = await this.db.transaction(async tx => {
      const claim = await this.claim(tx, principal, input.claimId);
      const row = (await tx.query<{ ordinal: number; display_name: string; size_bytes: string;
        content_digest: string; file_id: string }>(
        `SELECT a.ordinal,a.display_name,a.size_bytes,a.content_digest,a.file_id
        FROM control_job_artifact_inputs a
        WHERE a.tenant_id=$1 AND a.consumer_job_id=$2 AND a.project_id=$3 AND a.ordinal=$4`,
        [this.tenantId, claim.job_id, claim.project_id, input.ordinal as number])).rows[0];
      if (!row) return fleetFail("not_found");
      return { projectId: claim.project_id, row };
    });
    const bytes = await this.store.read({ tenantId: this.tenantId, projectId: read.projectId,
      fileId: read.row.file_id, contentDigest: read.row.content_digest });
    if (!bytes || bytes.byteLength !== Number(read.row.size_bytes)) return fleetFail("not_found");
    return Object.freeze({ ordinal: read.row.ordinal, displayName: read.row.display_name,
      contentDigest: read.row.content_digest, sizeBytes: bytes.byteLength, bytes });
  }
}

/**
 * §2.6's secret scan, and the refusal it produces. A text-like file carrying
 * credential-shaped bytes is refused BEFORE it is stored, and the reason is a
 * fixed code rather than a path or a match, because a worker's Needs-you reason
 * is shown to the owner and a log line here reaches the gateway's stderr.
 *
 * Only text-like types are scanned, and only the first `limit` bytes: a `.json`,
 * `.md` and `.log` — the three extensions §2.6 names — all land here, and a
 * video is not turned into a memory event. The patterns are the ones the native
 * artifact path already uses, so a file that would be refused locally is
 * refused here too rather than on only one path.
 */
export function scanForSecretsV1(bytes: Uint8Array, mediaType: string, limit = 1_048_576): boolean {
  if (!secretScannableMediaTypes.has(mediaType)) return false;
  let text: string;
  // Decoded leniently: a truncated multi-byte sequence at the limit is not a
  // secret, and a decode failure must not be a crash on the upload path. A
  // decode failure is still treated as a refusal, because "we could not read
  // this" is not "this is clean".
  try { text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, limit)); }
  catch { return true; }
  return containsSecretMaterial(text).length > 0;
}