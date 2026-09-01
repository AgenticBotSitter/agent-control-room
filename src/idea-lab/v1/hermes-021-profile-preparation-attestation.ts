import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import { IDEA_LAB_HERMES_021_REVISION_V1 } from "./hermes-021-panel-packet";
import {
  IDEA_LAB_HERMES_PROFILE_PREPARATION_METHOD_V1,
  parseIdeaLabHermesProfilePreparationRequestV1,
} from "./hermes-021-profile-preparation-contract";
import { capturedIdeaTimeMillisecondsV1, capturedPatternMatchesV1, ideaDigestSchemaV1, ideaIdSchemaV1,
  ideaTimeSchemaV1 } from "./schemas";

export const IDEA_LAB_HERMES_PROFILE_PREPARATION_ATTESTATION_V1 =
  "control-room-hermes-profile-preparation-attestation/v1" as const;
export const IDEA_LAB_HERMES_PROFILE_PREPARATION_SAFE_RESULT_V1 =
  "control-room-hermes-profile-preparation-safe-result/v1" as const;

const base64url = z.string().min(40).max(256)
  .refine((value) => capturedPatternMatchesV1(/^[A-Za-z0-9_-]+$/, value));
const zeroCounts = z.object({ soul: z.literal(0), memory: z.literal(0), skills: z.literal(0),
  plugins: z.literal(0), mcpConfiguration: z.literal(0), rules: z.literal(0), sessions: z.literal(0) }).strict();

const bodySchema = z.object({
  contractVersion: z.literal(IDEA_LAB_HERMES_PROFILE_PREPARATION_ATTESTATION_V1),
  method: z.literal(IDEA_LAB_HERMES_PROFILE_PREPARATION_METHOD_V1),
  requestDigest: ideaDigestSchemaV1,
  runtimeRevision: z.literal(IDEA_LAB_HERMES_021_REVISION_V1),
  preparedAt: ideaTimeSchemaV1,
  issuedAt: ideaTimeSchemaV1,
  expiresAt: ideaTimeSchemaV1,
  profileIdentityDigest: ideaDigestSchemaV1,
  launchPermitDigest: ideaDigestSchemaV1,
  protectedValueCustodyEvidenceDigest: ideaDigestSchemaV1,
  negativeContextCounts: zeroCounts,
  protectedValueMaterialReturned: z.literal(false),
  nativePathReturned: z.literal(false),
  gatewayStartsMade: z.literal(0),
  providerCallsMade: z.literal(0),
  cleanupMethodPresent: z.literal(true),
  profilePrepared: z.literal(true),
  bodyDigest: ideaDigestSchemaV1,
}).strict();

const envelopeSchema = z.object({
  body: bodySchema,
  attestation: z.object({ algorithm: z.literal("ed25519"), keyId: ideaIdSchemaV1,
    publicKeySpki: base64url, signature: base64url }).strict(),
}).strict();

const contextSchema = z.object({
  request: z.unknown(),
  evaluatedAt: ideaTimeSchemaV1,
  trustedDeviceKeyId: ideaIdSchemaV1,
  trustedDevicePublicKeySpki: base64url,
  inputMode: z.literal("injected_signed_attestation_only"),
}).strict();

const safeResultSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_HERMES_PROFILE_PREPARATION_SAFE_RESULT_V1),
  sourceMode: z.literal("injected_signed_attestation_only"),
  requestDigest: ideaDigestSchemaV1,
  runtimeRevision: z.literal(IDEA_LAB_HERMES_021_REVISION_V1),
  observedAt: ideaTimeSchemaV1,
  evaluatedAt: ideaTimeSchemaV1,
  expiresAt: ideaTimeSchemaV1,
  issuerKeyDigest: ideaDigestSchemaV1,
  profileIdentityDigest: ideaDigestSchemaV1,
  launchPermitDigest: ideaDigestSchemaV1,
  protectedValueCustodyEvidenceDigest: ideaDigestSchemaV1,
  negativeContextCounts: zeroCounts,
  profilePreparedObserved: z.literal(true),
  acceptedRuntimeImplementation: z.literal(false),
  launchEligible: z.literal(false),
  blockerCodes: z.tuple([z.literal("runtime_implementation_not_accepted")]),
  protectedValueMaterialRetained: z.literal(false),
  nativePathRetained: z.literal(false),
  providerCallsMade: z.literal(0),
  gatewayStartsMade: z.literal(0),
  nativeQualified: z.literal(false),
  grantsApproval: z.literal(false),
  grantsCommandAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  resultDigest: ideaDigestSchemaV1,
}).strict();

export type IdeaLabHermesProfilePreparationEnvelopeV1 = z.infer<typeof envelopeSchema>;
export type IdeaLabHermesProfilePreparationAttestationContextV1 = z.infer<typeof contextSchema>;
export type IdeaLabHermesProfilePreparationSafeResultV1 = z.infer<typeof safeResultSchema>;

function canonicalEd25519Key(spki: string): { key: KeyObject; digest: string } {
  try {
    const supplied = Buffer.from(spki, "base64url");
    const key = createPublicKey({ key: supplied, format: "der", type: "spki" });
    const canonical = key.export({ format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519" || !Buffer.isBuffer(canonical) || !supplied.equals(canonical)
      || spki !== canonical.toString("base64url")) throw new Error("invalid");
    return { key, digest: `sha256:${createHash("sha256").update(canonical).digest("hex")}` };
  } catch { throw new IdeaLabErrorV1("integrity_failed"); }
}

function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"), b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function unsigned<T extends Record<string, unknown>>(value: T, key: string): Record<string, unknown> {
  const result = { ...value }; delete result[key]; return result;
}

export function sanitizeIdeaLabHermesProfilePreparationAttestationV1(
  envelopeValue: unknown,
  contextValue: unknown,
): IdeaLabHermesProfilePreparationSafeResultV1 {
  const envelope = parseExactIdeaLabV1(envelopeSchema, envelopeValue);
  const context = parseExactIdeaLabV1(contextSchema, contextValue);
  const request = parseIdeaLabHermesProfilePreparationRequestV1(context.request);
  if (!sameText(envelope.attestation.keyId, context.trustedDeviceKeyId)
    || !sameText(envelope.attestation.publicKeySpki, context.trustedDevicePublicKeySpki)) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  const issuer = canonicalEd25519Key(envelope.attestation.publicKeySpki);
  let signatureValid = false;
  try { signatureValid = verify(null, Buffer.from(canonicalJson(envelope.body)), issuer.key,
    Buffer.from(envelope.attestation.signature, "base64url")); } catch { signatureValid = false; }
  if (!signatureValid || sha256Digest(unsigned(envelope.body, "bodyDigest")) !== envelope.body.bodyDigest) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  if (envelope.body.requestDigest !== request.requestDigest
    || envelope.body.runtimeRevision !== request.runtimeRevision) throw new IdeaLabErrorV1("scope_mismatch");
  const prepared = capturedIdeaTimeMillisecondsV1(envelope.body.preparedAt)!;
  const issued = capturedIdeaTimeMillisecondsV1(envelope.body.issuedAt)!;
  const expires = capturedIdeaTimeMillisecondsV1(envelope.body.expiresAt)!;
  const evaluated = capturedIdeaTimeMillisecondsV1(context.evaluatedAt)!;
  if (prepared > issued || issued > evaluated
    || expires <= evaluated || expires <= issued || expires - issued > 60_000
    || issued < capturedIdeaTimeMillisecondsV1(request.issuedAt)!
    || expires > capturedIdeaTimeMillisecondsV1(request.expiresAt)!) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  const material = {
    contractVersion: IDEA_LAB_HERMES_PROFILE_PREPARATION_SAFE_RESULT_V1,
    sourceMode: "injected_signed_attestation_only" as const,
    requestDigest: request.requestDigest,
    runtimeRevision: envelope.body.runtimeRevision,
    observedAt: envelope.body.preparedAt,
    evaluatedAt: context.evaluatedAt,
    expiresAt: envelope.body.expiresAt,
    issuerKeyDigest: issuer.digest,
    profileIdentityDigest: envelope.body.profileIdentityDigest,
    launchPermitDigest: envelope.body.launchPermitDigest,
    protectedValueCustodyEvidenceDigest: envelope.body.protectedValueCustodyEvidenceDigest,
    negativeContextCounts: envelope.body.negativeContextCounts,
    profilePreparedObserved: true as const,
    acceptedRuntimeImplementation: false as const,
    launchEligible: false as const,
    blockerCodes: ["runtime_implementation_not_accepted"] as const,
    protectedValueMaterialRetained: false as const,
    nativePathRetained: false as const,
    providerCallsMade: 0 as const,
    gatewayStartsMade: 0 as const,
    nativeQualified: false as const,
    grantsApproval: false as const,
    grantsCommandAuthority: false as const,
    grantsExecutionAuthority: false as const,
  };
  return Object.freeze(safeResultSchema.parse({ ...material, resultDigest: sha256Digest(material) }));
}

export function parseIdeaLabHermesProfilePreparationSafeResultV1(value: unknown):
  IdeaLabHermesProfilePreparationSafeResultV1 {
  const parsed = parseExactIdeaLabV1(safeResultSchema, value);
  if (sha256Digest(unsigned(parsed, "resultDigest")) !== parsed.resultDigest) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
  return parsed;
}
