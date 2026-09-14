import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DOMAIN_CONTRACT_VERSION, artifactManifestRecordSchema, jobRecordSchema, type ArtifactManifestRecord } from "../../domain/v1";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import { appendAuditWith } from "../../audit/audit-store";
import { HarnessRunStoreV1 } from "../../harness/v1/store";
import { nativeTaskProtocolId, nativeTaskSnapshotBodySchema, type NativeTaskSnapshotBody } from "../../harness/v1/native-observation";
import type { ArtifactReadPortV1, ArtifactStoragePortV1 } from "../../node-executor/artifact-storage";
import { commitNativeResultReservationMetadataV1, markNativeResultReservationStorageUncertainV1,
  nativeResultReservationSchemaV1, reserveNativeResultWriteV1, verifyNativeResultReservationBytesV1,
  type NativeResultReservationV1 } from "./native-result-reservation";
import { buildTaskResultManifestV1, durableStorageIo, putAndReadbackResultBytesV1,
  type DurableStorageIoState } from "./durable-result-publication";
import { codexResultReceiptSchemaV1, type CodexResultReceiptV1 } from "./codex-result-receipt";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
export const nativeResultReceiptSchema = z.object({ schema: z.literal("control-room.native-result-receipt/v1"), artifactId: id,
  tenantId: id, projectId: id, jobId: id, attemptId: id, runId: nativeTaskProtocolId, nodeId: id,
  snapshotDigest: digest, snapshotVersion: z.number().int().positive(), contentHash: digest,
  sizeBytes: z.number().int().min(0).max(65_536), manifestDigest: digest, receivedAt: instant,
  byteCheck: z.literal("matched_recorded_claim"), qualityAccepted: z.literal(false) }).strict();
export type NativeResultReceipt = z.infer<typeof nativeResultReceiptSchema>;
export type TaskResultReceipt = NativeResultReceipt | CodexResultReceiptV1;
export interface NativeResultReadConfiguration {
  integrityKey: Uint8Array;
  storageClass: "local" | "r2";
  storage: ArtifactReadPortV1;
  /** Tests may shorten, never extend, the two-second per-operation I/O ceiling. */
  storageIoMs?: number;
}
export interface NativeResultConfiguration extends NativeResultReadConfiguration { storage: ArtifactStoragePortV1 & ArtifactReadPortV1 }
type Row = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; run_id: string; artifact_id: string;
  receipt: unknown; auth_tag: string; manifest: unknown; content_hash: string; state: string; version: number;
  workflow_id: string; created_at: string | Date; updated_at: string | Date };
type ReservationRow = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; run_id: string;
  artifact_id: string; identity_digest: string; state: string; contract_digest: string; reservation: unknown;
  auth_tag: string; created_at: string | Date; updated_at: string | Date };
const selection = `r.tenant_id,r.project_id,r.job_id,r.attempt_id,r.run_id,r.artifact_id,r.receipt,r.auth_tag,
  m.payload AS manifest,m.content_hash,m.state,m.version,m.workflow_id,m.created_at,m.updated_at
  FROM control_native_artifact_receipts r JOIN control_artifact_manifests m
  ON m.tenant_id=r.tenant_id AND m.id=r.artifact_id AND m.project_id=r.project_id
    AND m.job_id=r.job_id AND m.attempt_id=r.attempt_id`;
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });
export const nativeResultId = (tenantId: string, runId: string) => `artifact:native:${sha256Digest({ tenantId, runId }).slice(7)}`;
export const resultBytesHash = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function checkedResultBytes(value: Uint8Array, claim: { contentHash: string; sizeBytes: number }): { bytes: Uint8Array; text: string } {
  if (!(value instanceof Uint8Array) || value.byteLength > 65_536 || value.byteLength !== claim.sizeBytes) throw new Error("result_content_unavailable");
  const bytes = Uint8Array.from(value);
  if (resultBytesHash(bytes) !== claim.contentHash) throw new Error("result_content_unavailable");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (Buffer.from(text, "utf8").compare(Buffer.from(bytes)) !== 0) throw new Error();
    assertNoSecretMaterial(text, "private result");
  } catch { throw new Error("result_content_unavailable"); }
  return { bytes, text };
}

/** Canonical metadata + explicitly supplied local/R2 artifact bytes. Never provisions storage or runs an agent. */
export class NativeResultStore {
  private readonly integrityKey: Uint8Array;
  private readonly harnessKey: Uint8Array;
  private readonly put?: ArtifactStoragePortV1["put"];
  private readonly readBytes: ArtifactReadPortV1["read"];
  private readonly storageClass: "local" | "r2";
  private readonly storageIoMs: number;
  private storageUncertain = false;
  constructor(private readonly db: DatabaseClient, harnessKey: Uint8Array, config: NativeResultReadConfiguration | NativeResultConfiguration) {
    if (!(harnessKey instanceof Uint8Array) || harnessKey.length !== 32 || !(config.integrityKey instanceof Uint8Array)
      || config.integrityKey.length !== 32 || !["local", "r2"].includes(config.storageClass)) throw new Error("result_configuration_invalid");
    this.integrityKey = Uint8Array.from(config.integrityKey); this.harnessKey = Uint8Array.from(harnessKey);
    const writer = config.storage as Partial<ArtifactStoragePortV1>;
    this.put = typeof writer.put === "function" ? writer.put.bind(config.storage) : undefined;
    this.readBytes = config.storage.read.bind(config.storage);
    this.storageClass = config.storageClass;
    this.storageIoMs = config.storageIoMs ?? 2000;
    if (!Number.isSafeInteger(this.storageIoMs) || this.storageIoMs < 1 || this.storageIoMs > 2000) throw new Error("result_configuration_invalid");
  }
  private async io<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const state: DurableStorageIoState = { storageUncertain: this.storageUncertain, storageIoMs: this.storageIoMs };
    try {
      return await durableStorageIo(state, operation, "result_storage_uncertain");
    } finally {
      this.storageUncertain = state.storageUncertain;
    }
  }
  private verify(row: Row): { receipt: TaskResultReceipt; manifest: ArtifactManifestRecord } {
    const parsed = nativeResultReceiptSchema.safeParse(row.receipt);
    const receipt = parsed.success ? parsed.data : codexResultReceiptSchemaV1.parse(row.receipt);
    const manifest = artifactManifestRecordSchema.parse(row.manifest);
    const purpose = receipt.schema === "control-room.native-result-receipt/v1"
      ? "native-result-receipt/v1" : "codex-result-receipt/v1";
    const expected = Buffer.from(hmacSha256Tag(this.integrityKey, { purpose, receipt }));
    const actual = Buffer.from(row.auth_tag);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || sha256Digest(manifest) !== receipt.manifestDigest
      || receipt.artifactId !== row.artifact_id || receipt.tenantId !== row.tenant_id || receipt.projectId !== row.project_id
      || receipt.jobId !== row.job_id || receipt.attemptId !== row.attempt_id || receipt.runId !== row.run_id
      || manifest.id !== receipt.artifactId || manifest.tenantId !== receipt.tenantId || manifest.projectId !== receipt.projectId
      || manifest.jobId !== receipt.jobId || manifest.attemptId !== receipt.attemptId || manifest.producerId !== receipt.nodeId
      || manifest.contentHash !== receipt.contentHash || manifest.sizeBytes !== receipt.sizeBytes || manifest.contentHash !== row.content_hash
      || manifest.state !== "uploaded" || row.state !== manifest.state || Number(row.version) !== manifest.version
      || row.workflow_id !== manifest.workflowId || new Date(row.created_at).toISOString() !== manifest.createdAt
      || new Date(row.updated_at).toISOString() !== manifest.updatedAt
      || manifest.storageClass !== this.storageClass || manifest.mimeType !== "text/plain; charset=utf-8") throw new Error("result_integrity_failed");
    return { receipt, manifest };
  }
  private reservationAuthTag(reservation: NativeResultReservationV1): string {
    return hmacSha256Tag(this.integrityKey, { purpose: "native-result-write-reservation/v1", reservation });
  }
  private verifyReservation(row: ReservationRow): NativeResultReservationV1 {
    const reservation = nativeResultReservationSchemaV1.parse(row.reservation);
    const expected = Buffer.from(this.reservationAuthTag(reservation)), actual = Buffer.from(row.auth_tag);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)
      || row.tenant_id !== reservation.identity.tenantId || row.project_id !== reservation.identity.projectId
      || row.job_id !== reservation.identity.jobId || row.attempt_id !== reservation.identity.attemptId
      || row.run_id !== reservation.identity.runId || row.artifact_id !== reservation.identity.artifactId
      || row.identity_digest !== reservation.identityDigest || row.state !== reservation.state
      || row.contract_digest !== reservation.contractDigest
      || new Date(row.updated_at).getTime() < new Date(row.created_at).getTime()) throw new Error("result_reservation_integrity_failed");
    return reservation;
  }
  private async reservationRow(tx: DatabaseSession, tenantId: string, runId: string): Promise<ReservationRow | undefined> {
    return (await tx.query<ReservationRow>(`SELECT tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,
      identity_digest,state,contract_digest,reservation,auth_tag,created_at,updated_at
      FROM control_native_result_write_reservations WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
    [tenantId, runId])).rows[0];
  }
  private async updateReservation(tx: DatabaseSession, prior: NativeResultReservationV1,
    next: NativeResultReservationV1, updatedAt: string): Promise<void> {
    const rows = (await tx.query<{ state: string }>(`UPDATE control_native_result_write_reservations
      SET state=$1,contract_digest=$2,reservation=$3::jsonb,auth_tag=$4,updated_at=$5
      WHERE tenant_id=$6 AND run_id=$7 AND state=$8 AND contract_digest=$9 RETURNING state`,
    [next.state, next.contractDigest, JSON.stringify(next), this.reservationAuthTag(next), updatedAt,
      next.identity.tenantId, next.identity.runId, prior.state, prior.contractDigest])).rows;
    if (rows.length !== 1 || rows[0].state !== next.state) throw new Error("result_reservation_update_failed");
  }
  private async markStorageUncertain(tenantId: string, runId: string, stage: string, updatedAt: string): Promise<void> {
    try {
      await this.db.transaction(async tx => {
        await tx.query("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, runId]);
        const row = await this.reservationRow(tx, tenantId, runId);
        if (!row) return;
        const reservation = this.verifyReservation(row);
        if (reservation.state === "metadata_committed" || reservation.state === "storage_uncertain") return;
        const uncertain = markNativeResultReservationStorageUncertainV1({ reservation,
          uncertaintyDigest: sha256Digest({ purpose: "native-result-storage-uncertainty/v1",
            reservationId: reservation.reservationId, reservationContractDigest: reservation.contractDigest, stage }) });
        await this.updateReservation(tx, reservation, uncertain, updatedAt);
      });
    } catch { /* The original operation still fails closed; a database outage may prevent the durable marker. */ }
  }
  private async bound(tx: DatabaseSession, tenantId: string, nodeId: string, body: NativeTaskSnapshotBody) {
    const inspected = await new HarnessRunStoreV1(joined(tx), this.harnessKey).inspect(tenantId, body.runId);
    const recorded = inspected?.events.find(event => event.payload.category === "native_snapshot"
      && event.payload.snapshot.snapshotVersion === body.snapshotVersion);
    if (!inspected || inspected.run.nodeId !== nodeId || inspected.run.projectId !== body.projectId
      || inspected.run.jobId !== body.jobId || inspected.run.attemptId !== body.attemptId || !recorded
      || recorded.payload.category !== "native_snapshot" || sha256Digest(recorded.payload.snapshot) !== sha256Digest(body))
      throw new Error("result_binding_unavailable");
    const row = (await tx.query<{ payload: unknown; workflow_id: string }>(`SELECT payload,workflow_id FROM control_jobs
      WHERE tenant_id=$1 AND project_id=$2 AND id=$3`, [tenantId, body.projectId, body.jobId])).rows[0];
    const job = jobRecordSchema.parse(row?.payload);
    if (job.tenantId !== tenantId || job.projectId !== body.projectId || job.id !== body.jobId || job.workflowId !== row.workflow_id)
      throw new Error("result_binding_unavailable");
    return job;
  }
  /** Caller has authenticated this exact signed observation; this method also requires durable canonical evidence. */
  async capture(tenantId: string, nodeId: string, observation: NativeTaskSnapshotBody, input: Uint8Array, receivedAt: string,
    assertCurrent: () => void = () => {}) {
    assertCurrent();
    if (!this.put) throw new Error("result_write_unavailable");
    id.parse(tenantId); id.parse(nodeId); instant.parse(receivedAt);
    const body = nativeTaskSnapshotBodySchema.parse(observation);
    if (body.state !== "completed" || !body.result || Date.parse(receivedAt) < Date.parse(body.observedAt)) throw new Error("result_not_completed");
    const { bytes } = checkedResultBytes(input, body.result), artifactId = nativeResultId(tenantId, body.runId);
    const acquisition = await this.db.transactionWithPreCommitCheck(async tx => {
      // The harness run is the single serialization point for reservation, replay and metadata publication.
      const locked = await tx.query("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, body.runId]);
      if (locked.rows.length !== 1) throw new Error("result_binding_unavailable");
      await this.bound(tx, tenantId, nodeId, body);
      const row = await this.reservationRow(tx, tenantId, body.runId);
      if (row) {
        const reservation = this.verifyReservation(row);
        reserveNativeResultWriteV1({ tenantId, nodeId, snapshot: body, existing: reservation });
        if (reservation.state !== "metadata_committed") throw new Error("result_manual_reconciliation_required");
        const prior = (await tx.query<Row>(`SELECT ${selection} WHERE r.tenant_id=$1 AND r.run_id=$2`,
          [tenantId, body.runId])).rows[0];
        if (!prior) throw new Error("result_reservation_integrity_failed");
        const { receipt } = this.verify(prior);
        if (receipt.schema !== "control-room.native-result-receipt/v1"
          || receipt.snapshotDigest !== reservation.identity.snapshotDigest || receipt.nodeId !== nodeId
          || reservation.manifestDigest !== receipt.manifestDigest
          || reservation.receiptDigest !== sha256Digest(receipt)) throw new Error("result_reservation_integrity_failed");
        return { kind: "replay" as const, receipt };
      }
      // A receipt created before this reservation table existed cannot be upgraded in place:
      // the migration has no integrity key with which to authenticate a reconstructed state.
      const unreservedReceipt = (await tx.query<Row>(`SELECT ${selection} WHERE r.tenant_id=$1 AND r.run_id=$2`,
        [tenantId, body.runId])).rows[0];
      if (unreservedReceipt) {
        this.verify(unreservedReceipt);
        throw new Error("result_manual_reconciliation_required");
      }
      const reservation = reserveNativeResultWriteV1({ tenantId, nodeId, snapshot: body });
      await tx.query(`INSERT INTO control_native_result_write_reservations
        (tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,identity_digest,state,contract_digest,reservation,auth_tag,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$12)`,
      [tenantId, body.projectId, body.jobId, body.attemptId, body.runId, artifactId, reservation.identityDigest,
        reservation.state, reservation.contractDigest, JSON.stringify(reservation), this.reservationAuthTag(reservation), receivedAt]);
      return { kind: "fresh" as const, reservation };
    }, assertCurrent);
    if (acquisition.kind === "replay") { assertCurrent(); return { receipt: acquisition.receipt, replayed: true }; }
    if (this.storageUncertain) {
      await this.markStorageUncertain(tenantId, body.runId, "storage_port_previously_uncertain", receivedAt);
      throw new Error("result_storage_uncertain");
    }

    let stored: Awaited<ReturnType<ArtifactStoragePortV1["put"]>>;
    try {
      assertCurrent();
      const placed = await putAndReadbackResultBytesV1(
        { put: input => this.put!(input), read: (artifactId, signal) => this.readBytes(artifactId, signal) },
        artifactId, bytes, body.result, operation => this.io(operation), assertCurrent);
      stored = { artifactId, contentHash: body.result.contentHash, sizeBytes: bytes.byteLength,
        opaqueLocator: placed.opaqueLocator };
      assertCurrent();
      await this.db.transactionWithPreCommitCheck(async tx => {
        await tx.query("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, body.runId]);
        const row = await this.reservationRow(tx, tenantId, body.runId);
        if (!row) throw new Error("result_reservation_integrity_failed");
        const reserved = this.verifyReservation(row);
        if (reserved.contractDigest !== acquisition.reservation.contractDigest || reserved.state !== "reserved")
          throw new Error("result_manual_reconciliation_required");
        const verified = verifyNativeResultReservationBytesV1(reserved, placed.readback);
        await this.updateReservation(tx, reserved, verified, receivedAt);
      }, assertCurrent);
    } catch {
      await this.markStorageUncertain(tenantId, body.runId, "put_or_exact_readback", receivedAt);
      throw new Error("result_storage_uncertain");
    }

    const captured = await this.db.transactionWithPreCommitCheck(async tx => {
      await tx.query("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, body.runId]);
      const row = await this.reservationRow(tx, tenantId, body.runId);
      if (!row) throw new Error("result_reservation_integrity_failed");
      const verifiedReservation = this.verifyReservation(row);
      reserveNativeResultWriteV1({ tenantId, nodeId, snapshot: body, existing: verifiedReservation });
      if (verifiedReservation.state !== "bytes_verified") throw new Error("result_manual_reconciliation_required");
      const job = await this.bound(tx, tenantId, nodeId, body);
      const manifest = buildTaskResultManifestV1({ artifactId, tenantId, projectId: body.projectId,
        jobId: body.jobId, attemptId: body.attemptId, workflowId: job.workflowId, nodeId,
        contentHash: body.result!.contentHash, sizeBytes: bytes.byteLength, storageClass: this.storageClass,
        opaqueLocator: stored.opaqueLocator, createdAt: receivedAt });
      assertNoSecretMaterial(manifest);
      const receipt = nativeResultReceiptSchema.parse({ schema: "control-room.native-result-receipt/v1", artifactId, tenantId,
        projectId: body.projectId, jobId: body.jobId, attemptId: body.attemptId, runId: body.runId, nodeId,
        snapshotDigest: sha256Digest(body), snapshotVersion: body.snapshotVersion, ...body.result,
        manifestDigest: sha256Digest(manifest), receivedAt, byteCheck: "matched_recorded_claim", qualityAccepted: false });
      const committedReservation = commitNativeResultReservationMetadataV1({ reservation: verifiedReservation,
        manifestDigest: receipt.manifestDigest, receiptDigest: sha256Digest(receipt) });
      await tx.query(`INSERT INTO control_artifact_manifests(id,tenant_id,project_id,workflow_id,job_id,attempt_id,
        content_hash,state,version,payload,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'uploaded',0,$8::jsonb,$9,$9)`,
      [artifactId, tenantId, body.projectId, job.workflowId, body.jobId, body.attemptId, receipt.contentHash, JSON.stringify(manifest), receivedAt]);
      await tx.query(`INSERT INTO control_native_artifact_receipts(tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,receipt,auth_tag)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [tenantId, body.projectId, body.jobId, body.attemptId, body.runId, artifactId,
      JSON.stringify(receipt), hmacSha256Tag(this.integrityKey, { purpose: "native-result-receipt/v1", receipt })]);
      await appendAuditWith(tx, { id: `audit:result:${sha256Digest({ tenantId, artifactId }).slice(7)}`, tenantId, projectId: body.projectId,
        actorId: nodeId, actorType: "worker", action: "task.result.received", targetType: "artifact", targetId: artifactId,
        occurredAt: receivedAt, idempotencyKey: receipt.snapshotDigest,
        safeMetadata: { contentHash: receipt.contentHash, sizeBytes: receipt.sizeBytes, byteCheck: receipt.byteCheck } });
      await this.updateReservation(tx, verifiedReservation, committedReservation, receivedAt);
      return { receipt, replayed: false };
    }, assertCurrent);
    assertCurrent(); return captured;
  }
  async list(tx: DatabaseSession, tenantId: string, projectId: string, jobId: string) {
    const rows = (await tx.query<Row>(`SELECT ${selection} WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.job_id=$3
      ORDER BY r.artifact_id COLLATE "C" LIMIT 51`, [tenantId, projectId, jobId])).rows;
    return { receipts: rows.slice(0, 50).map(row => this.verify(row).receipt), additionalResultsOmitted: rows.length > 50 };
  }
  /** Exact signed metadata read for bounded summary surfaces. It does not acquire
   * artifact bytes and cannot be used as a quality or completion decision. */
  async readReceipt(tx: DatabaseSession, tenantId: string, projectId: string, jobId: string, artifactId: string) {
    const row = (await tx.query<Row>(`SELECT ${selection} WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.job_id=$3 AND r.artifact_id=$4`,
      [tenantId, projectId, jobId, artifactId])).rows[0];
    return row ? this.verify(row).receipt : undefined;
  }
  async read(tx: DatabaseSession, tenantId: string, projectId: string, jobId: string, artifactId: string) {
    const row = (await tx.query<Row>(`SELECT ${selection} WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.job_id=$3 AND r.artifact_id=$4`,
      [tenantId, projectId, jobId, artifactId])).rows[0];
    if (!row) return undefined;
    const { receipt } = this.verify(row), bytes = await this.io(signal => this.readBytes(artifactId, signal));
    if (!bytes) throw new Error("result_content_unavailable");
    return { receipt, text: checkedResultBytes(bytes, receipt).text };
  }
}
