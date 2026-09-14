import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { DOMAIN_CONTRACT_VERSION, artifactManifestRecordSchema, type ArtifactManifestRecord } from "../../domain/v1";
import { digestSchema, localId } from "../../harness/v1/native-run-identifiers";
import type { ArtifactReadPortV1, ArtifactStoragePortV1 } from "../../node-executor/artifact-storage";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import { appendAuditWith } from "../../audit/audit-store";
import { checkedResultBytes, resultBytesHash } from "./native-results";
import { createResultWriteReservationMachine, resultBytesVerificationDigestV1 } from "./result-write-reservation";
import type { NeutralReservationPort, NeutralReservationRowV1 } from "./neutral-reservation-port";
import { durableResultArtifactIdV1, durableResultReceiptSchemaV1, durableResultReceiptTagV1,
  type DurableResultReceiptV1 } from "./durable-result-receipt";
import { durableResultReviewPlanSchemaV1, durableResultReviewPlanTagV1, durableReviewTargetV1 } from "../../completion-gate/v1/durable-result-review-plan";
import type { CompletionReviewTargetV1 } from "../../completion-gate/v1/types";

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);

function unavailable(): never { throw new Error("durable_result_publication_unavailable"); }
function conflict(): never { throw new Error("durable_result_reservation_conflict"); }

/* ------------------------------------------------------------------ */
/* Shared byte pipeline used by the native, Codex and neutral paths.   */
/* ------------------------------------------------------------------ */

export interface DurableStorageIoState {
  storageUncertain: boolean;
  storageIoMs: number;
}

/**
 * Optional storage-side poisoning contract. The publisher treats any storage
 * port that exposes `isStorageUncertain: true` as terminally poisoned and
 * short-circuits every subsequent operation with the uncertain error. Once
 * poisoned, only a fresh port (after restart) can clear it. The local per-call
 * `DurableStorageIoState` only guards timeouts and concurrent fences inside a
 * single publish; it never overrides the shared port-level state.
 */
export interface StoragePoisoningPortV1 {
  isStorageUncertain?: boolean;
}

/**
 * Bounded storage I/O with a terminal uncertain state. Both publishers
 * delegate their `io()` here. The shared port-level poisoning flag, when
 * present, is checked first so a prior call's failure cannot be reset by a
 * later concurrent success on the same storage adapter.
 */
export async function durableStorageIo<T>(state: DurableStorageIoState,
  port: StoragePoisoningPortV1 | undefined, operation: (signal: AbortSignal) => Promise<T>,
  uncertainError: string): Promise<T> {
  if (port?.isStorageUncertain === true) {
    state.storageUncertain = true; throw new Error(uncertainError);
  }
  if (state.storageUncertain) throw new Error(uncertainError);
  const abort = new AbortController(), started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([Promise.resolve().then(() => operation(abort.signal)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { state.storageUncertain = true; abort.abort(); reject(new Error(uncertainError)); }, state.storageIoMs);
    })]);
    // Re-check the shared port-level poisoning AFTER the await: TS narrowed
    // it at the top of the function, but the underlying flag can change.
    const sharedUncertain = (port as StoragePoisoningPortV1 | undefined)?.isStorageUncertain === true;
    if (state.storageUncertain || performance.now() - started >= state.storageIoMs || sharedUncertain) {
      state.storageUncertain = true; abort.abort(); throw new Error(uncertainError);
    }
    return result;
  } finally { clearTimeout(timer); }
}

export interface ResultBytesPutPort {
  put: (input: { artifactId: string; bytes: Uint8Array; signal?: AbortSignal }) => Promise<{
    artifactId: string; contentHash: string; sizeBytes: number; opaqueLocator: string }>;
  read: (artifactId: string, signal?: AbortSignal) => Promise<Uint8Array | undefined>;
}

/** Stores bytes and reads them back exactly. Any mismatch fails closed before metadata. */
export async function putAndReadbackResultBytesV1(storage: ResultBytesPutPort, artifactId: string,
  bytes: Uint8Array, claim: { contentHash: string; sizeBytes: number },
  io: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>,
  fence: () => void = () => {}): Promise<{ opaqueLocator: string; readback: Uint8Array }> {
  const stored = await io(signal => storage.put({ artifactId, bytes, signal }));
  fence();
  if (stored.artifactId !== artifactId || stored.contentHash !== claim.contentHash || stored.sizeBytes !== bytes.byteLength)
    throw new Error("result_storage_unavailable");
  const readback = await io(signal => storage.read(artifactId, signal));
  fence();
  if (!readback) throw new Error("result_storage_unavailable");
  checkedResultBytes(readback, claim);
  return { opaqueLocator: stored.opaqueLocator, readback };
}

/** Canonical task-result manifest shared by every publication path. */
export function buildTaskResultManifestV1(input: { artifactId: string; tenantId: string; projectId: string;
  jobId: string; attemptId: string; workflowId: string; nodeId: string; contentHash: string; sizeBytes: number;
  storageClass: "local" | "r2"; opaqueLocator: string; createdAt: string }): ArtifactManifestRecord {
  return artifactManifestRecordSchema.parse({ contractVersion: DOMAIN_CONTRACT_VERSION,
    id: input.artifactId, tenantId: input.tenantId, projectId: input.projectId, jobId: input.jobId,
    attemptId: input.attemptId, workflowId: input.workflowId, kind: "artifact_manifest", state: "uploaded", version: 0,
    createdAt: input.createdAt, updatedAt: input.createdAt, contentHash: input.contentHash, sizeBytes: input.sizeBytes,
    mimeType: "text/plain; charset=utf-8", logicalRole: "task_result", schemaVersion: "1.0.0",
    producerId: input.nodeId, storageClass: input.storageClass, opaqueLocator: input.opaqueLocator,
    retentionClass: "private_task_result" });
}

/* ------------------------------------------------------------------ */
/* Neutral reservation: same lifecycle, content-derived identity.      */
/* ------------------------------------------------------------------ */

export const DURABLE_RESULT_RESERVATION_SCHEMA_V1 = "control-room.durable-result-write-reservation/v1" as const;

const durableReservationIdentitySchemaV1 = z.object({
  schema: z.literal("control-room.durable-result-write-reservation-identity/v1"),
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, runId: localId, nodeId: localId,
  artifactId: z.string().regex(/^artifact:result:[a-f0-9]{64}$/),
  harness: z.enum(["native", "codex"]),
  workflowId: localId,
  connectorProfileDigest: digestSchema,
  snapshotDigest: digestSchema.nullable(),
  snapshotVersion: z.number().int().positive().nullable(),
  publicationContractDigest: digestSchema.nullable(),
  terminalEvidenceDigest: digestSchema.nullable(),
  threadId: localId.nullable(), turnId: localId.nullable(), itemId: localId.nullable(),
  contentHash: digestSchema, sizeBytes: z.number().int().min(0).max(65_536),
}).strict().superRefine((value, context) => {
  const nativeEvidence = value.snapshotDigest !== null && value.snapshotVersion !== null
    && value.publicationContractDigest === null && value.terminalEvidenceDigest === null
    && value.threadId === null && value.turnId === null && value.itemId === null;
  const codexEvidence = value.publicationContractDigest !== null && value.terminalEvidenceDigest !== null
    && value.threadId !== null && value.turnId !== null && value.itemId !== null
    && value.snapshotDigest === null && value.snapshotVersion === null;
  if ((value.harness === "native") !== nativeEvidence || (value.harness === "codex") !== codexEvidence) {
    context.addIssue({ code: "custom", message: "durable reservation harness evidence mismatch" });
  }
});

const durableReservationMaterialSchemaV1 = z.object({
  schema: z.literal(DURABLE_RESULT_RESERVATION_SCHEMA_V1),
  reservationId: localId,
  identity: durableReservationIdentitySchemaV1,
  identityDigest: digestSchema,
  state: z.enum(["reserved", "bytes_verified", "metadata_committed", "storage_uncertain"]),
  bytesVerificationDigest: digestSchema.nullable(),
  manifestDigest: digestSchema.nullable(),
  receiptDigest: digestSchema.nullable(),
  uncertaintyDigest: digestSchema.nullable(),
  lastCertainState: z.enum(["reserved", "bytes_verified"]).nullable(),
  canonicalPublicationAllowed: z.literal(false),
  completionVerified: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  grantsStorageWriteAuthority: z.literal(false),
  permitsRetry: z.literal(false),
  permitsCleanup: z.literal(false),
  deletesArtifact: z.literal(false),
}).strict();

export const durableResultReservationSchemaV1 = durableReservationMaterialSchemaV1.extend({
  contractDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { contractDigest, ...material } = value;
  const identityDigest = sha256Digest(value.identity);
  const expectedArtifact = durableResultArtifactIdV1(value.identity.contentHash);
  if (value.identity.artifactId !== expectedArtifact
    || value.identityDigest !== identityDigest
    || value.reservationId !== `reservation:durable:${identityDigest.slice(7)}`
    || value.contractDigest !== sha256Digest(material)) {
    context.addIssue({ code: "custom", message: "durable result reservation identity mismatch" });
  }
  const reserved = value.state === "reserved" && value.bytesVerificationDigest === null
    && value.manifestDigest === null && value.receiptDigest === null
    && value.uncertaintyDigest === null && value.lastCertainState === null;
  const bytesVerified = value.state === "bytes_verified"
    && value.bytesVerificationDigest === resultBytesVerificationDigestV1(value.identity)
    && value.manifestDigest === null && value.receiptDigest === null
    && value.uncertaintyDigest === null && value.lastCertainState === null;
  const metadataCommitted = value.state === "metadata_committed"
    && value.bytesVerificationDigest === resultBytesVerificationDigestV1(value.identity)
    && value.manifestDigest !== null && value.receiptDigest !== null
    && value.uncertaintyDigest === null && value.lastCertainState === null;
  const uncertain = value.state === "storage_uncertain" && value.uncertaintyDigest !== null
    && value.lastCertainState !== null && value.manifestDigest === null && value.receiptDigest === null
    && (value.lastCertainState === "bytes_verified")
      === (value.bytesVerificationDigest === resultBytesVerificationDigestV1(value.identity));
  if (!reserved && !bytesVerified && !metadataCommitted && !uncertain) {
    context.addIssue({ code: "custom", message: "durable result reservation state evidence mismatch" });
  }
});

export type DurableResultReservationV1 = z.infer<typeof durableResultReservationSchemaV1>;

const durableMachine = createResultWriteReservationMachine({
  reservationSchema: durableResultReservationSchemaV1,
  materialize: ({ reservationId, identity, identityDigest, state, ...fields }) => ({
    schema: DURABLE_RESULT_RESERVATION_SCHEMA_V1, reservationId, identity, identityDigest, state, ...fields,
    canonicalPublicationAllowed: false, completionVerified: false, grantsExecutionAuthority: false,
    grantsStorageWriteAuthority: false, permitsRetry: false, permitsCleanup: false, deletesArtifact: false,
  }),
  bytesVerificationDigest: resultBytesVerificationDigestV1,
  reservationId: identityDigest => `reservation:durable:${identityDigest.slice(7)}`,
  unavailable, conflict,
  compareReplayDigests: true,
});

const durableReservationTag = (key: Uint8Array, reservation: DurableResultReservationV1): string =>
  hmacSha256Tag(key, { purpose: "durable-result-write-reservation/v1", reservation });

/* ------------------------------------------------------------------ */
/* Neutral capture pipeline.                                           */
/*                                                                     */
/* The caller is a server-side harness adapter that has already        */
/* authenticated the terminal evidence and holds current authority     */
/* (assertAuthority is its synchronous fence). The core never trusts   */
/* lineage, completion, approval or retry claims beyond the digests    */
/* bound here, and it grants no execution, retry or capacity effects.  */
/* ------------------------------------------------------------------ */

export interface DurableResultBindingV1 {
  tenantId: string; projectId: string; jobId: string; attemptId: string; runId: string; nodeId: string;
  workflowId: string;
  harness: "native" | "codex";
  connectorProfileDigest: string;
  snapshotDigest?: string; snapshotVersion?: number;
  publicationContractDigest?: string; terminalEvidenceDigest?: string;
  threadId?: string; turnId?: string; itemId?: string;
  acceptanceProfileId: string; acceptanceProfileDigest: string;
}

export interface DurableResultPublicationConfigurationV1 {
  db: DatabaseClient;
  integrityKey: Uint8Array;
  reviewKey: Uint8Array;
  storage: ArtifactStoragePortV1 & ArtifactReadPortV1;
  storageClass: "local" | "r2";
  storageIoMs?: number;
  /**
   * Reservation persistence. The PostgreSQL adapter for the dedicated
   * neutral sibling table is lead-owned and pending; until it lands,
   * callers inject the in-memory port (tests, local runs). The publisher
   * never touches a reservation table directly.
   */
  reservations: NeutralReservationPort;
}

type NeutralReservationRow = NeutralReservationRowV1;
type NeutralReceiptRow = { tenant_id: string; project_id: string; job_id: string; attempt_id: string; run_id: string;
  artifact_id: string; receipt: unknown; auth_tag: string; manifest: unknown; content_hash: string; state: string;
  version: number; workflow_id: string; created_at: string | Date; updated_at: string | Date };
type NeutralReviewRow = { tenant_id: string; project_id: string; job_id: string; run_id: string;
  plan: unknown; auth_tag: string };

const neutralSelection = `r.tenant_id,r.project_id,r.job_id,r.attempt_id,r.run_id,r.artifact_id,r.receipt,r.auth_tag,
  m.payload AS manifest,m.content_hash,m.state,m.version,m.workflow_id,m.created_at,m.updated_at
  FROM control_native_artifact_receipts r JOIN control_artifact_manifests m
  ON m.tenant_id=r.tenant_id AND m.id=r.artifact_id AND m.project_id=r.project_id
    AND m.job_id=r.job_id AND m.attempt_id=r.attempt_id`;

function checkKeys(integrityKey: unknown, reviewKey: unknown): { integrityKey: Uint8Array; reviewKey: Uint8Array } {
  if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32
    || !(reviewKey instanceof Uint8Array) || reviewKey.length !== 32) unavailable();
  return { integrityKey: Uint8Array.from(integrityKey as Uint8Array), reviewKey: Uint8Array.from(reviewKey as Uint8Array) };
}

/**
 * Identity verification against the recorded database state. The publisher
 * refuses to reserve or write any bytes until every recorded row that this
 * binding claims to belong to actually contains the same tenant, project,
 * job, attempt, run, node, connector profile, and terminal-evidence
 * anchor. Anything else — wrong tenant, wrong job, wrong attempt, wrong
 * node, wrong connector profile, missing row — fails closed with
 * `durable_result_identity_mismatch` before any reservation write or byte
 * I/O. The caller still holds the synchronous `assertAuthority` fence;
 * the recorded state is the persistent half of the same contract.
 */
async function verifyRecordedIdentity(tx: DatabaseSession, binding: DurableResultBindingV1): Promise<void> {
  const runRow = (await tx.query<{ project_id: string; job_id: string; attempt_id: string; node_id: string;
    adapter_id: string; harness: string }>(
    "SELECT project_id,job_id,attempt_id,node_id,adapter_id,harness FROM control_harness_runs " +
    "WHERE tenant_id=$1 AND id=$2", [binding.tenantId, binding.runId])).rows[0];
  if (!runRow) throw new Error("durable_result_identity_mismatch");
  if (runRow.project_id !== binding.projectId || runRow.job_id !== binding.jobId
    || runRow.attempt_id !== binding.attemptId || runRow.node_id !== binding.nodeId)
    throw new Error("durable_result_identity_mismatch");

  const jobRow = (await tx.query<{ workflow_id: string; authority_digest: string }>(
    "SELECT workflow_id,authority_digest FROM control_jobs WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, binding.jobId])).rows[0];
  if (!jobRow || jobRow.workflow_id !== binding.workflowId) throw new Error("durable_result_identity_mismatch");

  const attemptRow = (await tx.query<{ job_id: string; node_id: string }>(
    "SELECT job_id,node_id FROM control_attempts WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, binding.attemptId])).rows[0];
  if (!attemptRow || attemptRow.job_id !== binding.jobId || attemptRow.node_id !== binding.nodeId)
    throw new Error("durable_result_identity_mismatch");

  // Current authority is bound to the recorded authority_digest of the job
  // and the recorded authority mode of the adapter. The caller has already
  // executed `assertAuthority()` synchronously; this query is the durable
  // half. If the recorded digest diverges from the harness/adapter that
  // produced this evidence, the publisher must refuse before any write.
  const adapterRow = (await tx.query<{ authority_mode: string; contract_version: string }>(
    "SELECT authority_mode,contract_version FROM adapter_registry WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, runRow.adapter_id])).rows[0];
  if (!adapterRow) throw new Error("durable_result_identity_mismatch");
  // The connector profile digest is the recorded digest of the
  // connector profile the adapter was loaded with at the moment the run
  // was admitted. We store it on the harness-run payload so the
  // publisher does not need to join a separate registry.
  const payloadRow = (await tx.query<{ payload: { connectorProfileDigest?: string; authorityDigest?: string } }>(
    "SELECT payload FROM control_harness_runs WHERE tenant_id=$1 AND id=$2",
    [binding.tenantId, binding.runId])).rows[0];
  const payload = payloadRow?.payload as { connectorProfileDigest?: string; authorityDigest?: string } | undefined;
  if (!payload || payload.connectorProfileDigest !== binding.connectorProfileDigest)
    throw new Error("durable_result_identity_mismatch");
  // Terminal evidence anchor: native binds the snapshot digest; codex
  // binds the publication contract + terminal evidence digest. If the
  // binding carries any of these, at least one must match the recorded
  // payload's authority digest (the recorded digest is the digest the
  // connector profile / harness attested at admission time).
  const evidenceAnchors: string[] = [];
  if (binding.snapshotDigest !== undefined) evidenceAnchors.push(binding.snapshotDigest);
  if (binding.publicationContractDigest !== undefined) evidenceAnchors.push(binding.publicationContractDigest);
  if (binding.terminalEvidenceDigest !== undefined) evidenceAnchors.push(binding.terminalEvidenceDigest);
  const recordedAuthority = payload?.authorityDigest;
  if (evidenceAnchors.length > 0 && (recordedAuthority === undefined
    || !evidenceAnchors.includes(recordedAuthority)))
    throw new Error("durable_result_identity_mismatch");
}

function verifyNeutralReservationRow(row: NeutralReservationRow, key: Uint8Array): DurableResultReservationV1 {
  const reservation = durableResultReservationSchemaV1.parse(row.reservation);
  const expected = Buffer.from(durableReservationTag(key, reservation)), actual = Buffer.from(row.auth_tag);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)
    || row.tenant_id !== reservation.identity.tenantId || row.project_id !== reservation.identity.projectId
    || row.job_id !== reservation.identity.jobId || row.attempt_id !== reservation.identity.attemptId
    || row.run_id !== reservation.identity.runId || row.artifact_id !== reservation.identity.artifactId
    || row.identity_digest !== reservation.identityDigest || row.state !== reservation.state
    || row.contract_digest !== reservation.contractDigest
    || new Date(row.updated_at).getTime() < new Date(row.created_at).getTime()) unavailable();
  return reservation;
}

function verifyNeutralReceiptRow(row: NeutralReceiptRow, key: Uint8Array, storageClass: "local" | "r2") {
  const receipt = durableResultReceiptSchemaV1.parse(row.receipt);
  const expected = Buffer.from(durableResultReceiptTagV1(key, receipt)), actual = Buffer.from(row.auth_tag);
  const manifest = artifactManifestRecordSchema.parse(row.manifest);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)
    || sha256Digest(manifest) !== receipt.manifestDigest || receipt.artifactId !== row.artifact_id
    || receipt.tenantId !== row.tenant_id || receipt.projectId !== row.project_id || receipt.jobId !== row.job_id
    || receipt.attemptId !== row.attempt_id || receipt.runId !== row.run_id
    || manifest.id !== receipt.artifactId || manifest.tenantId !== receipt.tenantId
    || manifest.projectId !== receipt.projectId || manifest.jobId !== receipt.jobId
    || manifest.attemptId !== receipt.attemptId || manifest.producerId !== receipt.nodeId
    || manifest.contentHash !== receipt.contentHash || manifest.sizeBytes !== receipt.sizeBytes
    || manifest.contentHash !== row.content_hash || manifest.state !== "uploaded" || row.state !== manifest.state
    || Number(row.version) !== manifest.version || row.workflow_id !== manifest.workflowId
    || new Date(row.created_at).toISOString() !== manifest.createdAt
    || new Date(row.updated_at).toISOString() !== manifest.updatedAt
    || manifest.storageClass !== storageClass || manifest.mimeType !== "text/plain; charset=utf-8") unavailable();
  return { receipt, manifest };
}

function reservationRowFor(reservation: DurableResultReservationV1, key: Uint8Array,
  at: string): NeutralReservationRowV1 {
  return {
    tenant_id: reservation.identity.tenantId, project_id: reservation.identity.projectId,
    job_id: reservation.identity.jobId, attempt_id: reservation.identity.attemptId,
    run_id: reservation.identity.runId, artifact_id: reservation.identity.artifactId,
    identity_digest: reservation.identityDigest, state: reservation.state,
    contract_digest: reservation.contractDigest, reservation,
    auth_tag: durableReservationTag(key, reservation), created_at: at, updated_at: at,
  };
}

async function neutralReservationRowForUpdate(port: NeutralReservationPort, tx: DatabaseSession,
  tenantId: string, runId: string) {
  return port.findForUpdate(tx, tenantId, runId);
}

async function updateNeutralReservation(port: NeutralReservationPort, tx: DatabaseSession,
  key: Uint8Array, prior: DurableResultReservationV1,
  next: DurableResultReservationV1, updatedAt: string): Promise<void> {
  // compareAndSwap preserves the stored created_at (as the previous
  // conditional UPDATE did by never setting that column).
  const swapped = await port.compareAndSwap(tx,
    { tenantId: prior.identity.tenantId, runId: prior.identity.runId,
      state: prior.state, contractDigest: prior.contractDigest },
    reservationRowFor(next, key, updatedAt));
  if (!swapped) throw new Error("durable_result_reservation_update_failed");
}

function neutralIdentityParts(binding: DurableResultBindingV1) {
  const parsed = z.object({ tenantId: localId, projectId: localId, jobId: localId, attemptId: localId,
    runId: localId, nodeId: localId, workflowId: localId, harness: z.enum(["native", "codex"]),
    connectorProfileDigest: digestSchema, acceptanceProfileId: localId, acceptanceProfileDigest: digestSchema })
    .strict().parse({ tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId,
      attemptId: binding.attemptId, runId: binding.runId, nodeId: binding.nodeId, workflowId: binding.workflowId,
      harness: binding.harness, connectorProfileDigest: binding.connectorProfileDigest,
      acceptanceProfileId: binding.acceptanceProfileId, acceptanceProfileDigest: binding.acceptanceProfileDigest });
  const evidence = z.object({ snapshotDigest: digestSchema.nullable(), snapshotVersion: z.number().int().positive().nullable(),
    publicationContractDigest: digestSchema.nullable(), terminalEvidenceDigest: digestSchema.nullable(),
    threadId: localId.nullable(), turnId: localId.nullable(), itemId: localId.nullable() }).strict().parse({
    snapshotDigest: binding.snapshotDigest ?? null, snapshotVersion: binding.snapshotVersion ?? null,
    publicationContractDigest: binding.publicationContractDigest ?? null,
    terminalEvidenceDigest: binding.terminalEvidenceDigest ?? null,
    threadId: binding.threadId ?? null, turnId: binding.turnId ?? null, itemId: binding.itemId ?? null });
  return { parsed, evidence };
}

function buildNeutralIdentity(binding: DurableResultBindingV1, artifactId: string, contentHash: string, sizeBytes: number) {
  const { parsed, evidence } = neutralIdentityParts(binding);
  return durableReservationIdentitySchemaV1.parse({ schema: "control-room.durable-result-write-reservation-identity/v1",
    tenantId: parsed.tenantId, projectId: parsed.projectId, jobId: parsed.jobId, attemptId: parsed.attemptId,
    runId: parsed.runId, nodeId: parsed.nodeId, artifactId, harness: parsed.harness, workflowId: parsed.workflowId,
    connectorProfileDigest: parsed.connectorProfileDigest, ...evidence, contentHash, sizeBytes });
}

function issueNeutralReceipt(binding: DurableResultBindingV1, artifactId: string, manifest: ArtifactManifestRecord,
  contentHash: string, sizeBytes: number, receivedAt: string): DurableResultReceiptV1 {
  const { evidence } = neutralIdentityParts(binding);
  return durableResultReceiptSchemaV1.parse({ schema: "control-room.durable-result-receipt/v1", artifactId,
    tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId, attemptId: binding.attemptId,
    runId: binding.runId, nodeId: binding.nodeId, harness: binding.harness, ...evidence,
    contentHash, sizeBytes, manifestDigest: sha256Digest(manifest), receivedAt,
    byteCheck: "matched_recorded_claim", qualityAccepted: false, canonicalPublicationAllowed: false,
    completionVerified: false, releasesCapacity: false, grantsExecutionAuthority: false });
}

function planNeutralReview(binding: DurableResultBindingV1, receipt: DurableResultReceiptV1, receivedAt: string) {
  const { evidence } = neutralIdentityParts(binding);
  return durableResultReviewPlanSchemaV1.parse({ schema: "control-room.durable-result-review-plan/v1",
    tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId, attemptId: binding.attemptId,
    runId: binding.runId, nodeId: binding.nodeId, harness: binding.harness,
    receiptDigest: sha256Digest(receipt),
    snapshotDigest: evidence.snapshotDigest,
    publicationContractDigest: evidence.publicationContractDigest,
    terminalEvidenceDigest: evidence.terminalEvidenceDigest,
    acceptanceProfileId: binding.acceptanceProfileId, acceptanceProfileDigest: binding.acceptanceProfileDigest,
    plannedAt: receivedAt,
    targetId: `target:durable:${sha256Digest({ tenantId: binding.tenantId, jobId: binding.jobId }).slice(7)}`,
    qualityAccepted: false, completionVerified: false, releasesCapacity: false, grantsExecutionAuthority: false });
}

async function ensureNeutralReviewPlan(tx: DatabaseSession, reviewKey: Uint8Array,
  binding: DurableResultBindingV1, receipt: DurableResultReceiptV1, receivedAt: string) {
  const expected = planNeutralReview(binding, receipt, receivedAt);
  const row = (await tx.query<NeutralReviewRow>(`SELECT tenant_id,project_id,job_id,run_id,plan,auth_tag
    FROM control_native_review_plans WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE`,
  [binding.tenantId, binding.runId])).rows[0];
  if (row) {
    const plan = durableResultReviewPlanSchemaV1.parse(row.plan);
    const expectedTag = Buffer.from(durableResultReviewPlanTagV1(reviewKey, plan)), actual = Buffer.from(row.auth_tag);
    if (expectedTag.length !== actual.length || !timingSafeEqual(expectedTag, actual)
      || sha256Digest(plan) !== sha256Digest(expected)) unavailable();
    return plan;
  }
  await tx.query(`INSERT INTO control_native_review_plans(tenant_id,project_id,job_id,run_id,plan,auth_tag)
    VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [binding.tenantId, binding.projectId, binding.jobId, binding.runId,
    JSON.stringify(expected), durableResultReviewPlanTagV1(reviewKey, expected)]);
  return expected;
}

/**
 * Harness-neutral durable text-result publication. Reserves the exact result
 * before writing bytes, verifies stored bytes, records one protected receipt
 * plus one pending owner-review target, and returns the same receipt on
 * identical replay after restart. Registration into the completion gate
 * stays harness-side: the persisted neutral plan row is the pending review
 * state, and the returned target records no decision of any kind.
 */
export async function publishDurableResultV1(config: DurableResultPublicationConfigurationV1, input: {
  binding: DurableResultBindingV1; bytes: Uint8Array; receivedAt: string; assertAuthority: () => void;
}): Promise<{ receipt: DurableResultReceiptV1; target: CompletionReviewTargetV1; replayed: boolean }> {
  const { integrityKey, reviewKey } = checkKeys(config.integrityKey, config.reviewKey);
  const key = integrityKey;
  if (typeof input.assertAuthority !== "function") unavailable();
  const assertAuthority = input.assertAuthority;
  assertAuthority();
  if (!["local", "r2"].includes(config.storageClass)) unavailable();
  const storageIoMs = config.storageIoMs ?? 2000;
  if (!Number.isSafeInteger(storageIoMs) || storageIoMs < 1 || storageIoMs > 2000) unavailable();
  const ioState: DurableStorageIoState = { storageUncertain: false, storageIoMs };
  const poisoningPort: StoragePoisoningPortV1 = { isStorageUncertain: (config.storage as Partial<StoragePoisoningPortV1>).isStorageUncertain };
  // Poisoned storage fails closed before any reservation lookup, write
  // attempt, or authority fence. Once the port reports itself uncertain,
  // every subsequent publish on this process must refuse; only restart
  // with a fresh storage port can clear it.
  if (poisoningPort.isStorageUncertain === true) {
    ioState.storageUncertain = true;
    throw new Error("durable_result_storage_uncertain");
  }
  const io = <T>(operation: (signal: AbortSignal) => Promise<T>) =>
    durableStorageIo(ioState, poisoningPort, operation, "durable_result_storage_uncertain");

  const receivedAt = instant.parse(input.receivedAt);
  const bytes = input.bytes instanceof Uint8Array ? Uint8Array.from(input.bytes) : unavailable();
  if (bytes.byteLength > 65_536) unavailable();
  const contentHash = resultBytesHash(bytes);
  checkedResultBytes(bytes, { contentHash, sizeBytes: bytes.byteLength });
  const artifactId = durableResultArtifactIdV1(contentHash);
  const identity = buildNeutralIdentity(input.binding, artifactId, contentHash, bytes.byteLength);
  const binding = input.binding;

  const markUncertain = async (stage: string): Promise<void> => {
    try {
      await config.db.transaction(async tx => {
        const row = await neutralReservationRowForUpdate(config.reservations, tx, identity.tenantId, identity.runId);
        if (!row) return;
        const reservation = verifyNeutralReservationRow(row, key);
        if (reservation.state === "metadata_committed" || reservation.state === "storage_uncertain") return;
        const uncertain = durableMachine.markStorageUncertain(reservation, sha256Digest({
          purpose: "durable-result-storage-uncertainty/v1", reservationId: reservation.reservationId,
          reservationContractDigest: reservation.contractDigest, stage })) as DurableResultReservationV1;
        await updateNeutralReservation(config.reservations, tx, key, reservation, uncertain, receivedAt);
      });
    } catch { /* The original operation still fails closed; a database outage may prevent the durable marker. */ }
  };

  const acquired = await config.db.transactionWithPreCommitCheck(async tx => {
    assertAuthority();
    await verifyRecordedIdentity(tx, binding);
    let row = await neutralReservationRowForUpdate(config.reservations, tx, identity.tenantId, identity.runId);
    if (!row) {
      const reservation = durableMachine.buildReserved(identity) as DurableResultReservationV1;
      const outcome = await config.reservations.insertFresh(tx,
        reservationRowFor(reservation, key, receivedAt));
      if (outcome === "inserted") return { kind: "fresh" as const, reservation };
      // A concurrent publisher won the reservation race only when the port
      // reports a uniqueness conflict; any other failure is real and surfaces.
      row = await neutralReservationRowForUpdate(config.reservations, tx, identity.tenantId, identity.runId);
      if (!row) unavailable();
    }
    const reservation = verifyNeutralReservationRow(row!, key);
    if (reservation.identityDigest !== sha256Digest(identity)) conflict();
    if (reservation.state !== "metadata_committed") throw new Error("durable_result_manual_reconciliation_required");
    const resultRow = (await tx.query<NeutralReceiptRow>(`SELECT ${neutralSelection}
      WHERE r.tenant_id=$1 AND r.run_id=$2`, [identity.tenantId, identity.runId])).rows[0];
    if (!resultRow) unavailable();
    const { receipt } = verifyNeutralReceiptRow(resultRow, key, config.storageClass);
    if (reservation.manifestDigest !== receipt.manifestDigest
      || reservation.receiptDigest !== sha256Digest(receipt)) unavailable();
    const plan = await ensureNeutralReviewPlan(tx, reviewKey, binding, receipt, receivedAt);
    return { kind: "replay" as const, receipt, target: durableReviewTargetV1(plan, receipt) };
  }, assertAuthority);

  if (acquired.kind === "replay") { assertAuthority(); return { receipt: acquired.receipt, target: acquired.target, replayed: true }; }
  if (ioState.storageUncertain) {
    await markUncertain("storage_port_previously_uncertain");
    throw new Error("durable_result_storage_uncertain");
  }

  let opaqueLocator: string;
  try {
    assertAuthority();
    const stored = await putAndReadbackResultBytesV1(config.storage, artifactId, bytes,
      { contentHash, sizeBytes: bytes.byteLength }, io, assertAuthority);
    opaqueLocator = stored.opaqueLocator;
    assertAuthority();
    await config.db.transactionWithPreCommitCheck(async tx => {
      const row = await neutralReservationRowForUpdate(config.reservations, tx, identity.tenantId, identity.runId);
      if (!row) unavailable();
      const reserved = verifyNeutralReservationRow(row!, key);
      if (reserved.contractDigest !== acquired.reservation.contractDigest || reserved.state !== "reserved")
        throw new Error("durable_result_manual_reconciliation_required");
      const verified = durableMachine.verifyBytes(reserved, stored.readback, checkedResultBytes) as DurableResultReservationV1;
      await updateNeutralReservation(config.reservations, tx, key, reserved, verified, receivedAt);
    }, assertAuthority);
  } catch (error) {
    if (error instanceof Error && error.message === "durable_result_manual_reconciliation_required") throw error;
    await markUncertain("put_or_exact_readback");
    throw new Error("durable_result_storage_uncertain");
  }

  const captured = await config.db.transactionWithPreCommitCheck(async tx => {
    const row = await neutralReservationRowForUpdate(config.reservations, tx, identity.tenantId, identity.runId);
    if (!row) unavailable();
    const verifiedReservation = verifyNeutralReservationRow(row!, key);
    if (verifiedReservation.state !== "bytes_verified") throw new Error("durable_result_manual_reconciliation_required");
    const manifest = buildTaskResultManifestV1({ artifactId, tenantId: identity.tenantId,
      projectId: identity.projectId, jobId: identity.jobId, attemptId: identity.attemptId,
      workflowId: identity.workflowId, nodeId: identity.nodeId, contentHash, sizeBytes: bytes.byteLength,
      storageClass: config.storageClass, opaqueLocator: opaqueLocator!, createdAt: receivedAt });
    assertNoSecretMaterial(manifest);
    const receipt = issueNeutralReceipt(binding, artifactId, manifest, contentHash, bytes.byteLength, receivedAt);
    const committed = durableMachine.commitMetadata(verifiedReservation,
      sha256Digest(manifest), sha256Digest(receipt)) as DurableResultReservationV1;
    await tx.query(`INSERT INTO control_artifact_manifests(id,tenant_id,project_id,workflow_id,job_id,attempt_id,
      content_hash,state,version,payload,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'uploaded',0,$8::jsonb,$9,$9)`,
    [artifactId, identity.tenantId, identity.projectId, identity.workflowId, identity.jobId, identity.attemptId,
      receipt.contentHash, JSON.stringify(manifest), receivedAt]);
    await tx.query(`INSERT INTO control_native_artifact_receipts
      (tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,receipt,auth_tag)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [identity.tenantId, identity.projectId, identity.jobId,
      identity.attemptId, identity.runId, artifactId, JSON.stringify(receipt),
      durableResultReceiptTagV1(key, receipt)]);
    const plan = await ensureNeutralReviewPlan(tx, reviewKey, binding, receipt, receivedAt);
    await appendAuditWith(tx, { id: `audit:durable-result:${sha256Digest({ tenantId: identity.tenantId, artifactId }).slice(7)}`,
      tenantId: identity.tenantId, projectId: identity.projectId, actorId: identity.nodeId, actorType: "worker",
      action: "task.result.received", targetType: "artifact", targetId: artifactId, occurredAt: receivedAt,
      idempotencyKey: sha256Digest(receipt),
      safeMetadata: { contentHash: receipt.contentHash, sizeBytes: receipt.sizeBytes, byteCheck: receipt.byteCheck } });
    await updateNeutralReservation(config.reservations, tx, key, verifiedReservation, committed, receivedAt);
    return { receipt, target: durableReviewTargetV1(plan, receipt) };
  }, assertAuthority);
  assertAuthority();
  return { receipt: captured.receipt, target: captured.target, replayed: false };
}

/** Crash/readback decision only. It never retries, deletes, writes metadata, or grants cleanup. */
export function reconcileDurableResultReservationCrashV1(value: unknown) {
  try {
    const reservation = durableResultReservationSchemaV1.parse(value);
    const material = z.object({ schema: z.literal("control-room.durable-result-write-reconciliation/v1"),
      reservationId: localId, artifactId: z.string().regex(/^artifact:result:[a-f0-9]{64}$/),
      reservationContractDigest: digestSchema, observedState: z.enum(["reserved", "bytes_verified",
        "metadata_committed", "storage_uncertain"]),
      disposition: z.enum(["metadata_already_committed", "manual_reconciliation_required"]),
      autoRetriesWrite: z.literal(false), autoDeletesBytes: z.literal(false), autoCommitsMetadata: z.literal(false),
      grantsStorageWriteAuthority: z.literal(false), canonicalPublicationAllowed: z.literal(false),
      completionVerified: z.literal(false), grantsExecutionAuthority: z.literal(false),
      permitsRetry: z.literal(false), permitsCleanup: z.literal(false) }).strict().parse({
      schema: "control-room.durable-result-write-reconciliation/v1",
      reservationId: reservation.reservationId, artifactId: reservation.identity.artifactId,
      reservationContractDigest: reservation.contractDigest, observedState: reservation.state,
      disposition: reservation.state === "metadata_committed"
        ? "metadata_already_committed" : "manual_reconciliation_required",
      autoRetriesWrite: false, autoDeletesBytes: false, autoCommitsMetadata: false,
      grantsStorageWriteAuthority: false, canonicalPublicationAllowed: false, completionVerified: false,
      grantsExecutionAuthority: false, permitsRetry: false, permitsCleanup: false });
    return Object.freeze({ ...material, reconciliationDigest: sha256Digest(material) });
  } catch { return unavailable(); }
}

/** Exact verified read of one neutral result. It acquires no bytes beyond the stored record. */
export async function readDurableResultV1(tx: DatabaseSession, key: Uint8Array, storageClass: "local" | "r2",
  readBytes: (artifactId: string, signal?: AbortSignal) => Promise<Uint8Array | undefined>,
  tenantId: string, projectId: string, jobId: string, artifactId: string) {
  const row = (await tx.query<NeutralReceiptRow>(`SELECT ${neutralSelection}
    WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.job_id=$3 AND r.artifact_id=$4`,
  [tenantId, projectId, jobId, artifactId])).rows[0];
  if (!row) return undefined;
  const { receipt } = verifyNeutralReceiptRow(row, key, storageClass);
  const bytes = await readBytes(artifactId);
  if (!bytes) throw new Error("durable_result_content_unavailable");
  return { receipt, text: checkedResultBytes(bytes, receipt).text };
}
