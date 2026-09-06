import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DOMAIN_CONTRACT_VERSION, artifactManifestRecordSchema, jobRecordSchema, type ArtifactManifestRecord } from "../../domain/v1";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import { appendAuditWith } from "../../audit/audit-store";
import { HarnessRunStoreV1 } from "../../harness/v1/store";
import { nativeTaskProtocolId, nativeTaskSnapshotBodySchema, type NativeTaskSnapshotBody } from "../../harness/v1/native-observation";
import type { ArtifactReadPortV1, ArtifactStoragePortV1 } from "../../node-executor/artifact-storage";

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const receiptSchema = z.object({ schema: z.literal("control-room.native-result-receipt/v1"), artifactId: id,
  tenantId: id, projectId: id, jobId: id, attemptId: id, runId: nativeTaskProtocolId, nodeId: id,
  snapshotDigest: digest, snapshotVersion: z.number().int().positive(), contentHash: digest,
  sizeBytes: z.number().int().min(0).max(65_536), manifestDigest: digest, receivedAt: instant,
  byteCheck: z.literal("matched_recorded_claim"), qualityAccepted: z.literal(false) }).strict();
export type NativeResultReceipt = z.infer<typeof receiptSchema>;
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
    if (this.storageUncertain) throw new Error("result_storage_uncertain");
    const abort = new AbortController(), started = performance.now(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([Promise.resolve().then(() => operation(abort.signal)), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.storageUncertain = true; abort.abort(); reject(new Error("result_storage_uncertain")); }, this.storageIoMs);
      })]);
      if (this.storageUncertain || performance.now() - started >= this.storageIoMs) {
        this.storageUncertain = true; abort.abort(); throw new Error("result_storage_uncertain");
      }
      return result;
    } finally { clearTimeout(timer); }
  }
  private verify(row: Row): { receipt: NativeResultReceipt; manifest: ArtifactManifestRecord } {
    const receipt = receiptSchema.parse(row.receipt), manifest = artifactManifestRecordSchema.parse(row.manifest);
    const expected = Buffer.from(hmacSha256Tag(this.integrityKey, { purpose: "native-result-receipt/v1", receipt }));
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
    if (!this.put || this.storageUncertain) throw new Error("result_write_unavailable");
    id.parse(tenantId); id.parse(nodeId); instant.parse(receivedAt);
    const body = nativeTaskSnapshotBodySchema.parse(observation);
    if (body.state !== "completed" || !body.result || Date.parse(receivedAt) < Date.parse(body.observedAt)) throw new Error("result_not_completed");
    const { bytes } = checkedResultBytes(input, body.result), artifactId = nativeResultId(tenantId, body.runId);
    await this.db.transactionWithPreCommitCheck(tx => this.bound(tx, tenantId, nodeId, body), assertCurrent);
    assertCurrent();
    const stored = await this.io(signal => this.put!({ artifactId, bytes, signal }));
    assertCurrent();
    if (stored.artifactId !== artifactId || stored.contentHash !== body.result.contentHash || stored.sizeBytes !== bytes.byteLength)
      throw new Error("result_storage_unavailable");
    const readback = await this.io(signal => this.readBytes(artifactId, signal));
    assertCurrent();
    if (!readback) throw new Error("result_storage_unavailable");
    checkedResultBytes(readback, body.result);
    const captured = await this.db.transactionWithPreCommitCheck(async tx => {
      const job = await this.bound(tx, tenantId, nodeId, body);
      // Serialize on the existing run; duplicate deliveries cannot race a second metadata receipt.
      await tx.query("SELECT id FROM control_harness_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, body.runId]);
      const prior = (await tx.query<Row>(`SELECT ${selection} WHERE r.tenant_id=$1 AND r.run_id=$2`, [tenantId, body.runId])).rows[0];
      if (prior) {
        const { receipt } = this.verify(prior);
        if (receipt.snapshotDigest !== sha256Digest(body) || receipt.nodeId !== nodeId) throw new Error("result_receipt_conflict");
        return { receipt, replayed: true };
      }
      const manifest: ArtifactManifestRecord = artifactManifestRecordSchema.parse({ contractVersion: DOMAIN_CONTRACT_VERSION,
        id: artifactId, tenantId, projectId: body.projectId, jobId: body.jobId, attemptId: body.attemptId, workflowId: job.workflowId,
        kind: "artifact_manifest", state: "uploaded", version: 0, createdAt: receivedAt, updatedAt: receivedAt,
        contentHash: body.result!.contentHash, sizeBytes: bytes.byteLength, mimeType: "text/plain; charset=utf-8",
        logicalRole: "task_result", schemaVersion: "1.0.0", producerId: nodeId, storageClass: this.storageClass,
        opaqueLocator: stored.opaqueLocator, retentionClass: "private_task_result" });
      assertNoSecretMaterial(manifest);
      const receipt = receiptSchema.parse({ schema: "control-room.native-result-receipt/v1", artifactId, tenantId,
        projectId: body.projectId, jobId: body.jobId, attemptId: body.attemptId, runId: body.runId, nodeId,
        snapshotDigest: sha256Digest(body), snapshotVersion: body.snapshotVersion, ...body.result,
        manifestDigest: sha256Digest(manifest), receivedAt, byteCheck: "matched_recorded_claim", qualityAccepted: false });
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
      return { receipt, replayed: false };
    }, assertCurrent);
    assertCurrent(); return captured;
  }
  async list(tx: DatabaseSession, tenantId: string, projectId: string, jobId: string) {
    const rows = (await tx.query<Row>(`SELECT ${selection} WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.job_id=$3
      ORDER BY r.artifact_id COLLATE "C" LIMIT 51`, [tenantId, projectId, jobId])).rows;
    return { receipts: rows.slice(0, 50).map(row => this.verify(row).receipt), additionalResultsOmitted: rows.length > 50 };
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
