// RES-007: bounded remote artifact-return transport boundary.
//
// An artifact comes back from an APPROVED upstream transport (SSH or sandbox).
// The transport is a carrier, never an authority: it can hand over bytes, and
// nothing more. This module models transport capability, delivery integrity and
// receipt identity as its own concern, and REUSES the existing artifact rules
// rather than restating them:
//
//   - `resultBytesHash`          the repo's real byte-level sha256
//   - `checkedResultBytes`       the existing size / digest / UTF-8 / secret gate
//
// The boundary is pure and injected. No SSH connection, sandbox, credential,
// network call, file deletion or live transfer happens here. Callers supply an
// already-approved transport descriptor and an already-collected delivery, and
// this module decides whether what arrived may be accepted.
//
// Every acceptance is bounded: the declared size must equal the delivered size
// and agree with the reservation, the bytes must hash to the expected digest,
// and the identity must match the reservation exactly (project, task, run, node,
// lease epoch and source). A stale run is refused rather than accepted late.
//
// Every failure is NAMED and fails safe. Disconnect, truncation, duplicate
// delivery, wrong identity, stale run and cleanup uncertainty each produce a
// distinct outcome. None may produce a receipt, and none may leave a partially
// accepted artifact behind.

import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { digestSchema, localId } from "./native-run-identifiers";
import { resultBytesHash, checkedResultBytes } from "../../artifacts/v1/native-results";
import { terminalResultEvidenceSchemaV1 } from "./terminal-result-evidence";

export const REMOTE_ARTIFACT_RETURN_SCHEMA_V1 = "control-room.remote-artifact-return/v1" as const;
export const REMOTE_ARTIFACT_RETURN_RECEIPT_SCHEMA_V1 =
  "control-room.remote-artifact-return-receipt/v1" as const;
export const REMOTE_ARTIFACT_RETURN_FEATURE_V1 = "harness.remote-artifact-return.v1" as const;

/** Content bound. One artifact, exactly bounded, or it is refused. */
export const REMOTE_ARTIFACT_RETURN_MAX_BYTES_V1 = 65_536;

const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);
const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * Supported transports. A transport outside this list is refused explicitly
 * rather than treated as unknown-but-probably-fine.
 */
export const REMOTE_ARTIFACT_TRANSPORTS_V1 = ["ssh", "sandbox"] as const;
export type RemoteArtifactTransportV1 = (typeof REMOTE_ARTIFACT_TRANSPORTS_V1)[number];

/**
 * Capabilities a transport may declare. A caller that needs a capability the
 * transport does not declare is refused, because proceeding would accept bytes
 * whose delivery guarantee is not the one that was assumed.
 */
export const REMOTE_ARTIFACT_CAPABILITIES_V1 = [
  "stream_digest",
  "exact_length",
  "at_most_once_delivery",
  "remote_cleanup_ack",
] as const;
export type RemoteArtifactCapabilityV1 = (typeof REMOTE_ARTIFACT_CAPABILITIES_V1)[number];

/**
 * An approved transport descriptor. Descriptive only: holding one grants no
 * authority and opens nothing. `sourceIdentityFingerprint` binds the descriptor
 * to the exact source identity it was approved for, so a descriptor approved for
 * one run cannot be used to admit another run's artifact.
 */
export const remoteArtifactTransportDescriptorSchemaV1 = z.object({
  schema: z.literal(REMOTE_ARTIFACT_RETURN_SCHEMA_V1),
  transport: z.enum(REMOTE_ARTIFACT_TRANSPORTS_V1),
  /** Opaque operator-facing endpoint label. Never a credential. */
  endpointLabel: z.string().min(1).max(120),
  /** Explicit capability claims. Empty means "streams bytes and nothing else". */
  capabilities: z.array(z.enum(REMOTE_ARTIFACT_CAPABILITIES_V1)).max(8),
  approvalReferenceId: localId,
  approvalReferenceDigest: digestSchema,
  sourceIdentityFingerprint: digestSchema,
}).strict();

export type RemoteArtifactTransportDescriptorV1 = z.infer<
  typeof remoteArtifactTransportDescriptorSchemaV1
>;

/** Exact project/task/run/source identity. Matched strictly on acceptance. */
export const remoteArtifactIdentitySchemaV1 = z.object({
  tenantId: localId,
  projectId: localId,
  jobId: localId,
  attemptId: localId,
  runId: localId,
  nodeId: localId,
  leaseId: localId,
  leaseEpoch: positiveSafeInteger,
  sourceKind: z.enum(["ssh", "sandbox"]),
  sourceRef: z.string().min(1).max(160),
}).strict();

export type RemoteArtifactIdentityV1 = z.infer<typeof remoteArtifactIdentitySchemaV1>;

/** The reservation this return must satisfy. Supplied by the caller. */
export const remoteArtifactReservationSchemaV1 = z.object({
  reservationId: localId,
  identity: remoteArtifactIdentitySchemaV1,
  expectedContentDigest: digestSchema,
  expectedSizeBytes: z.number().int().min(1).max(REMOTE_ARTIFACT_RETURN_MAX_BYTES_V1),
  /** The run's current lease epoch. A lower epoch on the artifact is stale. */
  currentLeaseEpoch: positiveSafeInteger,
  /** A return observed after this instant is refused as stale. */
  reservationExpiresAt: instant,
}).strict();

export type RemoteArtifactReservationV1 = z.infer<typeof remoteArtifactReservationSchemaV1>;

/**
 * The accepted receipt. Deliberately inert: it records that bounded bytes
 * arrived under a known identity. It does not publish, complete, release
 * capacity, or permit retry or resume.
 */
export const remoteArtifactReturnReceiptSchemaV1 = z.object({
  schema: z.literal(REMOTE_ARTIFACT_RETURN_RECEIPT_SCHEMA_V1),
  returnId: localId,
  reservationId: localId,
  identity: remoteArtifactIdentitySchemaV1,
  transport: z.enum(REMOTE_ARTIFACT_TRANSPORTS_V1),
  receiptDigest: digestSchema,
  contentDigest: digestSchema,
  sizeBytes: z.number().int().min(1).max(REMOTE_ARTIFACT_RETURN_MAX_BYTES_V1),
  terminalEvidenceDigest: digestSchema,
  returnedAt: instant,
  /** Whether this receipt already existed and was replayed verbatim. */
  replayed: z.boolean(),
  // Inert by construction: a transport delivery is never authority.
  canonicalPublicationAllowed: z.literal(false),
  completionRecorded: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  releasesCapacity: z.literal(false),
  permitsRetry: z.literal(false),
  permitsResume: z.literal(false),
  startsWork: z.literal(false),
}).strict();

export type RemoteArtifactReturnReceiptV1 = z.infer<typeof remoteArtifactReturnReceiptSchemaV1>;

/** Every refusal is named. A refusal never carries a receipt. */
export const remoteArtifactReturnRefusalSchemaV1 = z.object({
  schema: z.literal(REMOTE_ARTIFACT_RETURN_SCHEMA_V1),
  outcome: z.enum([
    "transport_unsupported",
    "capability_unsupported",
    "transport_descriptor_invalid",
    "reservation_missing",
    "identity_mismatch",
    "run_stale",
    "reservation_expired",
    "disconnected",
    "truncated",
    "content_rejected",
    "content_conflict",
    "cleanup_uncertain",
  ]),
  detail: z.string().min(1).max(240),
  /** True when the remote artifact may still exist and removal is unconfirmed. */
  remoteArtifactMayRemain: z.boolean(),
  receiptProduced: z.literal(false),
}).strict();

export type RemoteArtifactReturnRefusalV1 = z.infer<typeof remoteArtifactReturnRefusalSchemaV1>;

/**
 * The delivery a caller already collected. `chunks` are consumed in order.
 * `disconnectedAfterBytes` models a carrier that drops mid-transfer, which is
 * what makes a disconnect distinguishable from a complete-but-wrong delivery.
 */
export type RemoteArtifactDeliveryV1 = {
  declaredSizeBytes: number;
  declaredContentDigest: string;
  chunks: readonly Uint8Array[];
  /** When set, only this many bytes arrive before the carrier drops. */
  disconnectedAfterBytes?: number;
  /** When set, the transport could not confirm remote cleanup. */
  cleanupUncertain?: boolean;
  observedAt: string;
  /** Terminal evidence observed for the returning run. */
  terminalEvidence: unknown;
};

/** Receipt store. Injected, so no storage or authority is assumed here. */
export type RemoteArtifactReceiptStoreV1 = {
  find(reservationId: string): RemoteArtifactReturnReceiptV1 | undefined;
  record(receipt: RemoteArtifactReturnReceiptV1): void;
};

export function inMemoryRemoteArtifactReceiptStoreV1(): RemoteArtifactReceiptStoreV1 {
  const receipts = new Map<string, RemoteArtifactReturnReceiptV1>();
  return {
    find: reservationId => receipts.get(reservationId),
    record: receipt => { receipts.set(receipt.reservationId, receipt); },
  };
}

export type RemoteArtifactReturnResultV1 =
  | { accepted: true; receipt: RemoteArtifactReturnReceiptV1 }
  | { accepted: false; refusal: RemoteArtifactReturnRefusalV1 };

function refuse(
  outcome: RemoteArtifactReturnRefusalV1["outcome"],
  detail: string,
  remoteArtifactMayRemain = false,
): RemoteArtifactReturnResultV1 {
  return {
    accepted: false,
    refusal: remoteArtifactReturnRefusalSchemaV1.parse({
      schema: REMOTE_ARTIFACT_RETURN_SCHEMA_V1,
      outcome,
      detail,
      remoteArtifactMayRemain,
      receiptProduced: false,
    }),
  };
}

/** Canonical return identity: stable for the same accepted delivery. */
export function remoteArtifactReturnIdV1(
  value: Pick<RemoteArtifactReturnReceiptV1, "identity" | "contentDigest" | "sizeBytes">,
): string {
  return `remote-artifact-return:${sha256Digest({
    identity: value.identity,
    contentDigest: value.contentDigest,
    sizeBytes: value.sizeBytes,
  }).slice(7)}`;
}

/** The exact bytes a delivery actually produced, honouring a mid-transfer drop. */
export function deliveredBytesV1(delivery: RemoteArtifactDeliveryV1): Uint8Array {
  const joined = new Uint8Array(delivery.chunks.reduce((n, chunk) => n + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of delivery.chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const limit = delivery.disconnectedAfterBytes ?? joined.byteLength;
  return joined.slice(0, Math.min(limit, joined.byteLength));
}

/**
 * Accept or refuse one bounded artifact return.
 *
 * The check order is deliberate. Transport and capabilities first, so an
 * unsupported carrier is refused before its bytes are inspected. Reservation
 * next, so a foreign or stale run is refused before its content is judged.
 * Content last, through the existing `checkedResultBytes` gate. A duplicate
 * delivery is resolved against the recorded receipt, which is what makes an
 * exact replay return the same identity while changed content conflicts.
 */
export function acceptRemoteArtifactReturnV1(input: {
  transport: unknown;
  reservation: unknown;
  delivery: RemoteArtifactDeliveryV1;
  store: RemoteArtifactReceiptStoreV1;
  requiredCapabilities?: readonly RemoteArtifactCapabilityV1[];
}): RemoteArtifactReturnResultV1 {
  const transportParsed = remoteArtifactTransportDescriptorSchemaV1.safeParse(input.transport);
  if (!transportParsed.success) {
    return refuse("transport_descriptor_invalid", "transport descriptor failed validation");
  }
  const transport = transportParsed.data;

  const reservationParsed = remoteArtifactReservationSchemaV1.safeParse(input.reservation);
  if (!reservationParsed.success) {
    return refuse("reservation_missing", "reservation failed validation");
  }
  const reservation = reservationParsed.data;

  // Unsupported transport: named, never treated as unknown-but-ok.
  if (transport.transport !== reservation.identity.sourceKind) {
    return refuse(
      "transport_unsupported",
      `transport ${transport.transport} cannot carry a ${reservation.identity.sourceKind} source`,
    );
  }

  const missingCapabilities = (input.requiredCapabilities ?? [])
    .filter(capability => !transport.capabilities.includes(capability));
  if (missingCapabilities.length > 0) {
    return refuse(
      "capability_unsupported",
      `transport does not declare: ${missingCapabilities.join(",")}`,
    );
  }

  // Identity: the descriptor is bound to one exact source identity.
  if (transport.sourceIdentityFingerprint !== sha256Digest(reservation.identity)) {
    return refuse("identity_mismatch", "delivered identity does not match the reservation");
  }

  // Stale run: an artifact from an older lease epoch may not be accepted late.
  if (reservation.identity.leaseEpoch < reservation.currentLeaseEpoch) {
    return refuse(
      "run_stale",
      `lease epoch ${reservation.identity.leaseEpoch} is behind ${reservation.currentLeaseEpoch}`,
      true,
    );
  }

  const observed = new Date(input.delivery.observedAt).getTime();
  const expires = new Date(reservation.reservationExpiresAt).getTime();
  if (!Number.isFinite(observed) || observed > expires) {
    return refuse("reservation_expired", "return observed after the reservation expired", true);
  }

  // A carrier that dropped mid-transfer is a disconnect, distinct from a
  // delivery that arrived complete but wrong.
  const bytes = deliveredBytesV1(input.delivery);
  if (input.delivery.disconnectedAfterBytes !== undefined
    && input.delivery.disconnectedAfterBytes < input.delivery.declaredSizeBytes) {
    return refuse(
      "disconnected",
      `carrier dropped after ${bytes.byteLength} of ${input.delivery.declaredSizeBytes} bytes`,
      true,
    );
  }

  // Truncation: fewer bytes than declared, with the carrier intact.
  if (bytes.byteLength !== input.delivery.declaredSizeBytes) {
    return refuse(
      "truncated",
      `received ${bytes.byteLength} bytes, declared ${input.delivery.declaredSizeBytes}`,
    );
  }

  // The delivery's own digest claim, before the reservation is consulted.
  if (resultBytesHash(bytes) !== input.delivery.declaredContentDigest) {
    return refuse("content_rejected", "delivered bytes do not match the digest the transport declared");
  }

  // The existing gate: size bound, exact size, real byte digest, UTF-8 validity
  // and secret material. Reused rather than restated.
  try {
    checkedResultBytes(bytes, {
      contentHash: reservation.expectedContentDigest,
      sizeBytes: reservation.expectedSizeBytes,
    });
  } catch {
    const existingConflict = input.store.find(reservation.reservationId);
    if (existingConflict) {
      return refuse(
        "content_conflict",
        "content differs from the recorded receipt for this reservation",
        true,
      );
    }
    return refuse(
      "content_rejected",
      `bytes failed the artifact gate (expected ${reservation.expectedSizeBytes} bytes at ${reservation.expectedContentDigest.slice(0, 14)}…)`,
    );
  }

  const contentDigest = resultBytesHash(bytes);

  // Duplicate delivery. An exact replay returns the recorded receipt unchanged;
  // changed content under the same identity is a conflict, because accepting it
  // would silently replace already-accepted work.
  const existing = input.store.find(reservation.reservationId);
  if (existing) {
    if (existing.contentDigest === contentDigest && existing.sizeBytes === bytes.byteLength) {
      return {
        accepted: true,
        receipt: remoteArtifactReturnReceiptSchemaV1.parse({ ...existing, replayed: true }),
      };
    }
    return refuse(
      "content_conflict",
      "content differs from the recorded receipt for this reservation",
      true,
    );
  }

  // Terminal evidence must be valid for the returning run, so a delivery cannot
  // arrive without the evidence that justifies it.
  const evidenceParsed = terminalResultEvidenceSchemaV1.safeParse(input.delivery.terminalEvidence);
  if (!evidenceParsed.success) {
    return refuse("content_rejected", "terminal evidence failed validation");
  }
  if (sha256Digest(evidenceParsed.data.lineage) !== sha256Digest({
    tenantId: reservation.identity.tenantId,
    projectId: reservation.identity.projectId,
    jobId: reservation.identity.jobId,
    attemptId: reservation.identity.attemptId,
    runId: reservation.identity.runId,
    nodeId: reservation.identity.nodeId,
  })) {
    return refuse("identity_mismatch", "terminal evidence belongs to a different run");
  }

  // Cleanup uncertainty: the bytes are good, but the transport could not confirm
  // the remote copy was removed. Refuse rather than leave an unaccounted remote
  // artifact behind an accepted receipt.
  if (input.delivery.cleanupUncertain === true) {
    return refuse("cleanup_uncertain", "transport could not confirm remote cleanup", true);
  }

  const returnId = remoteArtifactReturnIdV1({
    identity: reservation.identity,
    contentDigest,
    sizeBytes: bytes.byteLength,
  });
  const receipt = remoteArtifactReturnReceiptSchemaV1.parse({
    schema: REMOTE_ARTIFACT_RETURN_RECEIPT_SCHEMA_V1,
    returnId,
    reservationId: reservation.reservationId,
    identity: reservation.identity,
    transport: transport.transport,
    receiptDigest: sha256Digest({
      returnId,
      reservationId: reservation.reservationId,
      contentDigest,
      sizeBytes: bytes.byteLength,
      terminalEvidenceDigest: evidenceParsed.data.evidenceDigest,
      returnedAt: input.delivery.observedAt,
    }),
    contentDigest,
    sizeBytes: bytes.byteLength,
    terminalEvidenceDigest: evidenceParsed.data.evidenceDigest,
    returnedAt: input.delivery.observedAt,
    replayed: false,
    canonicalPublicationAllowed: false,
    completionRecorded: false,
    grantsExecutionAuthority: false,
    releasesCapacity: false,
    permitsRetry: false,
    permitsResume: false,
    startsWork: false,
  });
  input.store.record(receipt);
  return { accepted: true, receipt };
}