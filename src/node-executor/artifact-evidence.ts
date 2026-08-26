import { createHash } from "node:crypto";
import { assertNoSecretMaterial, sha256Digest } from "../security";
import { DOMAIN_CONTRACT_VERSION, type ArtifactManifestRecord } from "../domain/v1/types";

export interface TextArtifactBundleInputV1 {
  artifactId: string;
  claimId: string;
  tenantId: string;
  projectId: string;
  workflowId?: string;
  jobId: string;
  attemptId: string;
  producerId: string;
  logicalRole: string;
  schemaVersion: string;
  storageClass: "local" | "r2" | "repository" | "external";
  retentionClass: string;
  opaqueLocator?: string;
  text: string;
  createdAt: string;
}

export interface ArtifactVerificationClaimV1 {
  schema: "control-room.artifact-verification-claim/v1";
  claimId: string;
  artifactId: string;
  tenantId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  producerId: string;
  claim: "content_hash_matches_exact_bytes";
  contentHash: string;
  manifestDigest: string;
  createdAt: string;
  claimDigest: string;
}

export interface TextArtifactBundleV1 {
  bytes: Uint8Array;
  manifest: ArtifactManifestRecord;
  verificationClaim: ArtifactVerificationClaimV1;
}

export interface ArtifactLineageRecordV1 {
  schema: "control-room.artifact-lineage/v1";
  artifactId: string;
  tenantId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  producerId: string;
  manifest: ArtifactManifestRecord;
  producerClaim: ArtifactVerificationClaimV1;
  independentVerification: { status: "not_run" };
  recordedAt: string;
  lineageDigest: string;
}

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_TEXT_UTF8_BYTES = 65_536;

class ArtifactEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactEvidenceError";
  }
}

function requirePlainObject(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArtifactEvidenceError("input must be a plain object");
  }
}

function validateIdentifier(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new ArtifactEvidenceError(`${name} must be a non-empty string`);
  }
  if (value.length > MAX_IDENTIFIER_LENGTH) {
    throw new ArtifactEvidenceError(`${name} exceeds ${MAX_IDENTIFIER_LENGTH} characters`);
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      throw new ArtifactEvidenceError(`${name} must not contain whitespace or control characters`);
    }
    if (/\s/u.test(character)) {
      throw new ArtifactEvidenceError(`${name} must not contain Unicode whitespace`);
    }
  }
  return value;
}

function validateRequiredText(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new ArtifactEvidenceError(`${name} must be a non-empty string`);
  }
  return value;
}

function validateCreatedAt(value: unknown): string {
  if (typeof value !== "string" || value.length < 1) {
    throw new ArtifactEvidenceError("createdAt must be a non-empty string");
  }
  let parsed: Date;
  try {
    parsed = new Date(value);
  } catch {
    throw new ArtifactEvidenceError("createdAt is not a valid RFC 3339 timestamp");
  }
  if (Number.isNaN(parsed.getTime())) {
    throw new ArtifactEvidenceError("createdAt is not a valid RFC 3339 timestamp");
  }
  let roundTripped: string;
  try {
    roundTripped = parsed.toISOString();
  } catch {
    throw new ArtifactEvidenceError("createdAt is not representable as canonical UTC");
  }
  if (!value.endsWith("Z") || value !== roundTripped) {
    throw new ArtifactEvidenceError("createdAt must be canonical RFC 3339 UTC");
  }
  return value;
}

function validateStorageClass(value: unknown): TextArtifactBundleInputV1["storageClass"] {
  if (value !== "local" && value !== "r2" && value !== "repository" && value !== "external") {
    throw new ArtifactEvidenceError("storageClass is invalid");
  }
  return value;
}

export function buildTextArtifactBundle(rawInput: TextArtifactBundleInputV1): TextArtifactBundleV1 {
  requirePlainObject(rawInput);
  // Input immutability: read every field once before any mutation-free validation work.
  const input = { ...rawInput };

  validateIdentifier("artifactId", input.artifactId);
  validateIdentifier("claimId", input.claimId);
  validateIdentifier("tenantId", input.tenantId);
  validateIdentifier("projectId", input.projectId);
  if (input.workflowId !== undefined) validateIdentifier("workflowId", input.workflowId);
  validateIdentifier("jobId", input.jobId);
  validateIdentifier("attemptId", input.attemptId);
  validateIdentifier("producerId", input.producerId);
  validateRequiredText("logicalRole", input.logicalRole);
  validateRequiredText("schemaVersion", input.schemaVersion);
  const storageClass = validateStorageClass(input.storageClass);
  validateRequiredText("retentionClass", input.retentionClass);
  if (input.opaqueLocator !== undefined) {
    if (typeof input.opaqueLocator !== "string" || input.opaqueLocator.length < 1) {
      throw new ArtifactEvidenceError("opaqueLocator must be a non-empty string when supplied");
    }
    assertNoSecretMaterial(input.opaqueLocator, "opaqueLocator");
  }
  const createdAt = validateCreatedAt(input.createdAt);

  if (typeof input.text !== "string") {
    throw new ArtifactEvidenceError("text must be a string");
  }
  const bytes = new TextEncoder().encode(input.text);
  if (bytes.byteLength > MAX_TEXT_UTF8_BYTES) {
    throw new ArtifactEvidenceError(`text exceeds ${MAX_TEXT_UTF8_BYTES} UTF-8 bytes`);
  }

  const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

  const manifest: ArtifactManifestRecord = {
    contractVersion: DOMAIN_CONTRACT_VERSION,
    id: input.artifactId,
    tenantId: input.tenantId,
    version: 0,
    kind: "artifact_manifest",
    createdAt,
    updatedAt: createdAt,
    projectId: input.projectId,
    ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
    jobId: input.jobId,
    attemptId: input.attemptId,
    state: "declared",
    contentHash,
    sizeBytes: bytes.byteLength,
    mimeType: "text/plain; charset=utf-8",
    logicalRole: input.logicalRole,
    schemaVersion: input.schemaVersion,
    producerId: input.producerId,
    storageClass,
    ...(input.opaqueLocator !== undefined ? { opaqueLocator: input.opaqueLocator } : {}),
    retentionClass: input.retentionClass,
  };
  assertNoSecretMaterial(manifest, "artifact manifest");

  const manifestDigest = sha256Digest(manifest);

  // Unsigned claim: every field except claimDigest, which is computed over exactly these fields.
  const verificationClaim: Omit<ArtifactVerificationClaimV1, "claimDigest"> = {
    schema: "control-room.artifact-verification-claim/v1",
    claimId: input.claimId,
    artifactId: input.artifactId,
    tenantId: input.tenantId,
    projectId: input.projectId,
    jobId: input.jobId,
    attemptId: input.attemptId,
    producerId: input.producerId,
    claim: "content_hash_matches_exact_bytes",
    contentHash,
    manifestDigest,
    createdAt,
  };
  const claimDigest = sha256Digest(verificationClaim);
  const sealedClaim: ArtifactVerificationClaimV1 = { ...verificationClaim, claimDigest };
  assertNoSecretMaterial(sealedClaim, "artifact verification claim");

  return { bytes, manifest, verificationClaim: sealedClaim };
}

export function buildArtifactLineageRecord(bundle: TextArtifactBundleV1): ArtifactLineageRecordV1 {
  const { manifest, verificationClaim: producerClaim } = bundle;
  if (
    producerClaim.artifactId !== manifest.id ||
    producerClaim.tenantId !== manifest.tenantId ||
    producerClaim.projectId !== manifest.projectId ||
    producerClaim.jobId !== manifest.jobId ||
    producerClaim.attemptId !== manifest.attemptId ||
    producerClaim.producerId !== manifest.producerId ||
    producerClaim.contentHash !== manifest.contentHash ||
    producerClaim.manifestDigest !== sha256Digest(manifest)
  ) {
    throw new ArtifactEvidenceError("artifact lineage does not match its manifest and producer claim");
  }
  const { claimDigest, ...unsignedClaim } = producerClaim;
  if (claimDigest !== sha256Digest(unsignedClaim)) throw new ArtifactEvidenceError("producer claim digest is invalid");
  const unsigned: Omit<ArtifactLineageRecordV1, "lineageDigest"> = {
    schema: "control-room.artifact-lineage/v1",
    artifactId: manifest.id,
    tenantId: manifest.tenantId,
    projectId: manifest.projectId,
    jobId: manifest.jobId,
    attemptId: manifest.attemptId,
    producerId: manifest.producerId,
    manifest,
    producerClaim,
    independentVerification: { status: "not_run" },
    recordedAt: manifest.createdAt,
  };
  assertNoSecretMaterial(unsigned, "artifact lineage");
  return { ...unsigned, lineageDigest: sha256Digest(unsigned) };
}
