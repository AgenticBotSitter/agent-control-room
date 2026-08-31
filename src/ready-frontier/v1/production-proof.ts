import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { canonicalJson, sha256Digest } from "../../security";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import { parseReadyFrontierProductionBoundaryAssessmentV1 } from "./production-boundary";
import {
  readyFrontierProductionProofEnvelopeSchemaV1,
  readyFrontierProductionProofObservationSchemaV1,
  readyFrontierProductionProofVerificationInputSchemaV1,
  readyFrontierProductionTrustAnchorSchemaV1,
  readyFrontierProductionTrustBundleSchemaV1,
} from "./production-proof-schemas";
import {
  READY_FRONTIER_PRODUCTION_INDEPENDENT_VERIFICATION_V1,
  READY_FRONTIER_PRODUCTION_PROOF_MAX_LIFETIME_SECONDS_V1,
  READY_FRONTIER_PRODUCTION_PROOF_OBSERVATION_V1,
  READY_FRONTIER_PRODUCTION_TRUST_MODE_V1,
  type ReadyFrontierProductionIndependentVerificationV1,
  type ReadyFrontierProductionProofBindingV1,
  type ReadyFrontierProductionProofBodyV1,
  type ReadyFrontierProductionProofEnvelopeV1,
  type ReadyFrontierProductionProofObservationV1,
  type ReadyFrontierProductionTrustAnchorV1,
  type ReadyFrontierProductionTrustBundleBodyV1,
  type ReadyFrontierProductionTrustBundleV1,
  type ReadyFrontierProductionTrustIdentityV1,
} from "./production-proof-types";

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never {
  throw new ReadyFrontierContractErrorV1(code);
}
function sameText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"), b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function canonicalEd25519Key(spki: string): { key: KeyObject; digest: string } {
  try {
    const supplied = Buffer.from(spki, "base64url");
    const key = createPublicKey({ key: supplied, format: "der", type: "spki" });
    const canonical = key.export({ format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519" || !Buffer.isBuffer(canonical)
      || !supplied.equals(canonical) || spki !== canonical.toString("base64url")) throw new Error("invalid");
    return { key, digest: `sha256:${createHash("sha256").update(canonical).digest("hex")}` };
  } catch { fail("integrity_failed"); }
}
function canonicalEd25519Signature(signature: string): Buffer {
  try {
    const decoded = Buffer.from(signature, "base64url");
    if (decoded.byteLength !== 64 || decoded.toString("base64url") !== signature) throw new Error("invalid");
    return decoded;
  } catch { fail("integrity_failed"); }
}
function validSignature(material: unknown, signature: string, key: KeyObject): boolean {
  const canonical = canonicalEd25519Signature(signature);
  try { return verify(null, Buffer.from(canonicalJson(material)), key, canonical); }
  catch { return false; }
}
function without<T extends Record<string, unknown>>(value: T, field: keyof T): Record<string, unknown> {
  const copy = { ...value }; delete copy[field]; return copy;
}

export function readyFrontierProductionTrustBundleBodyDigestV1(
  body: Omit<ReadyFrontierProductionTrustBundleBodyV1, "bodyDigest"> | ReadyFrontierProductionTrustBundleBodyV1,
): string {
  return sha256Digest(without(body as unknown as Record<string, unknown>, "bodyDigest"));
}

export function readyFrontierProductionProofBodyDigestV1(
  body: Omit<ReadyFrontierProductionProofBodyV1, "bodyDigest"> | ReadyFrontierProductionProofBodyV1,
): string {
  return sha256Digest(without(body as unknown as Record<string, unknown>, "bodyDigest"));
}

export function readyFrontierProductionEvidenceDigestV1(
  gateCode: ReadyFrontierProductionProofBodyV1["gateCode"], bindings: ReadyFrontierProductionProofBindingV1[],
): string {
  return sha256Digest({ gateCode, bindings });
}

export function readyFrontierProductionIndependentVerificationMaterialV1(
  value: Omit<ReadyFrontierProductionIndependentVerificationV1, "signature" | "signatureAlgorithm" >,
): Record<string, unknown> {
  return { schema: READY_FRONTIER_PRODUCTION_INDEPENDENT_VERIFICATION_V1,
    verifierIdentityId: value.verifierIdentityId, verifierKeyId: value.verifierKeyId,
    proofBodyDigest: value.proofBodyDigest, trustBundleDigest: value.trustBundleDigest,
    verifiedAt: value.verifiedAt };
}

export function parseReadyFrontierProductionTrustAnchorV1(value: unknown): ReadyFrontierProductionTrustAnchorV1 {
  const anchor = parseExactReadyFrontierV1(readyFrontierProductionTrustAnchorSchemaV1,
    value) as ReadyFrontierProductionTrustAnchorV1;
  const root = canonicalEd25519Key(anchor.ownerRootPublicKeySpki);
  if (!sameText(root.digest, anchor.ownerRootKeyDigest)) fail("digest_mismatch");
  return anchor;
}

function validateIdentity(identity: ReadyFrontierProductionTrustIdentityV1,
  bundle: ReadyFrontierProductionTrustBundleBodyV1): void {
  const key = canonicalEd25519Key(identity.publicKeySpki);
  if (!sameText(key.digest, identity.keyDigest)
    || new Set(identity.proofAuthorities).size !== identity.proofAuthorities.length
    || new Set(identity.authorizedGateCodes).size !== identity.authorizedGateCodes.length
    || !sameList(identity.proofAuthorities, [...identity.proofAuthorities].sort())
    || !sameList(identity.authorizedGateCodes, [...identity.authorizedGateCodes].sort())) fail("digest_mismatch");
  if ((identity.state === "active" && identity.revokedAt !== null)
    || (identity.state === "revoked" && (identity.revokedAt === null
      || Date.parse(identity.revokedAt) > Date.parse(bundle.issuedAt)))) fail("policy_denied");
}

export function verifyReadyFrontierProductionTrustBundleV1(value: unknown, anchorValue: unknown):
  ReadyFrontierProductionTrustBundleV1 {
  const anchor = parseReadyFrontierProductionTrustAnchorV1(anchorValue);
  const bundle = parseExactReadyFrontierV1(readyFrontierProductionTrustBundleSchemaV1,
    value) as ReadyFrontierProductionTrustBundleV1;
  const { body } = bundle;
  if (body.tenantId !== anchor.tenantId || body.workspaceId !== anchor.workspaceId
    || body.ownerRootKeyId !== anchor.ownerRootKeyId || body.trustMode !== READY_FRONTIER_PRODUCTION_TRUST_MODE_V1
    || (body.revision === 1) !== (body.previousBundleDigest === null)
    || Date.parse(body.expiresAt) <= Date.parse(body.issuedAt)
    || body.bodyDigest !== readyFrontierProductionTrustBundleBodyDigestV1(body)) fail("scope_mismatch");
  if (!sameList(body.identities.map((identity) => identity.identityId),
    body.identities.map((identity) => identity.identityId).sort())) fail("digest_mismatch");
  const identityIds = body.identities.map((identity) => identity.identityId);
  const keyIds = body.identities.map((identity) => identity.keyId);
  const spkis = body.identities.map((identity) => identity.publicKeySpki);
  if (new Set(identityIds).size !== identityIds.length || new Set(keyIds).size !== keyIds.length
    || new Set(spkis).size !== spkis.length) fail("digest_mismatch");
  body.identities.forEach((identity) => validateIdentity(identity, body));
  const root = canonicalEd25519Key(anchor.ownerRootPublicKeySpki);
  if (!validSignature(body, bundle.ownerSignature, root.key)) fail("integrity_failed");
  return bundle;
}

export function parseReadyFrontierProductionProofEnvelopeV1(value: unknown): ReadyFrontierProductionProofEnvelopeV1 {
  const envelope = parseExactReadyFrontierV1(readyFrontierProductionProofEnvelopeSchemaV1,
    value) as ReadyFrontierProductionProofEnvelopeV1;
  if (envelope.body.bodyDigest !== readyFrontierProductionProofBodyDigestV1(envelope.body)) fail("digest_mismatch");
  return envelope;
}

function activeIdentity(bundle: ReadyFrontierProductionTrustBundleV1, identityId: string,
  keyId: string): ReadyFrontierProductionTrustIdentityV1 {
  const identity = bundle.body.identities.find((candidate) => candidate.identityId === identityId);
  if (!identity || identity.keyId !== keyId || identity.state !== "active") fail("policy_denied");
  return identity;
}

export function verifyReadyFrontierProductionProofEnvelopeV1(inputValue: unknown,
  activationPacketIntegrityKey: unknown, anchorValue: unknown): ReadyFrontierProductionProofObservationV1 {
  const input = parseExactReadyFrontierV1(readyFrontierProductionProofVerificationInputSchemaV1, inputValue);
  const assessment = parseReadyFrontierProductionBoundaryAssessmentV1(input.assessment,
    activationPacketIntegrityKey);
  const anchor = parseReadyFrontierProductionTrustAnchorV1(anchorValue);
  const bundle = verifyReadyFrontierProductionTrustBundleV1(input.trustBundle, anchor);
  const envelope = parseReadyFrontierProductionProofEnvelopeV1(input.envelope);
  const { body } = envelope, received = Date.parse(input.receivedAt);
  const requirement = assessment.requirements.find((candidate) => candidate.gateCode === body.gateCode);
  if (!requirement) fail("scope_mismatch");
  if (bundle.body.tenantId !== assessment.tenantId || bundle.body.workspaceId !== assessment.workspaceId
    || body.tenantId !== assessment.tenantId || body.workspaceId !== assessment.workspaceId
    || body.planId !== assessment.planId || body.planDigest !== assessment.planDigest
    || body.assessmentId !== assessment.assessmentId || body.assessmentDigest !== assessment.assessmentDigest
    || body.requirementDigest !== requirement.requirementDigest
    || body.evidenceClass !== requirement.evidenceClass || body.proofAuthority !== requirement.proofAuthority
    || body.trustBundleId !== bundle.body.bundleId || body.trustBundleRevision !== bundle.body.revision
    || body.trustBundleDigest !== bundle.body.bodyDigest) fail("scope_mismatch");
  const bindingCodes = body.bindings.map((binding) => binding.code);
  if (!sameList(bindingCodes, requirement.requiredBindings)
    || new Set(bindingCodes).size !== bindingCodes.length
    || body.evidenceDigest !== readyFrontierProductionEvidenceDigestV1(body.gateCode, body.bindings)) {
    fail("digest_mismatch");
  }
  const observed = Date.parse(body.observedAt), issued = Date.parse(body.issuedAt), expires = Date.parse(body.expiresAt);
  if (![received, observed, issued, expires].every(Number.isFinite)
    || Date.parse(bundle.body.issuedAt) > issued || received >= Date.parse(bundle.body.expiresAt)
    || observed < Date.parse(assessment.assessedAt) || observed > issued || issued > received
    || received >= expires || expires > Date.parse(assessment.planExpiresAt)
    || expires - issued > READY_FRONTIER_PRODUCTION_PROOF_MAX_LIFETIME_SECONDS_V1 * 1_000) fail("policy_denied");
  const issuer = activeIdentity(bundle, body.issuerIdentityId, body.issuerKeyId);
  if (!issuer.authorizedGateCodes.includes(body.gateCode)
    || !issuer.proofAuthorities.includes(body.proofAuthority)) fail("policy_denied");
  const issuerKey = canonicalEd25519Key(issuer.publicKeySpki);
  if (!validSignature(body, envelope.issuerSignature, issuerKey.key)) fail("integrity_failed");
  let verifierIdentityId: string | null = null, verifierKeyId: string | null = null;
  if (requirement.independentVerifierRequired) {
    const verification = envelope.independentVerification;
    if (!verification || verification.proofBodyDigest !== body.bodyDigest
      || verification.trustBundleDigest !== bundle.body.bodyDigest) fail("policy_denied");
    const verifierIdentity = activeIdentity(bundle, verification.verifierIdentityId, verification.verifierKeyId);
    if (!verifierIdentity.canIndependentlyVerify || !verifierIdentity.authorizedGateCodes.includes(body.gateCode)
      || verifierIdentity.identityId === issuer.identityId || verifierIdentity.keyId === issuer.keyId
      || verifierIdentity.keyDigest === issuer.keyDigest
      || verifierIdentity.independenceDomainDigest === issuer.independenceDomainDigest
      || Date.parse(verification.verifiedAt) < issued || Date.parse(verification.verifiedAt) > received
      || Date.parse(verification.verifiedAt) >= expires) fail("policy_denied");
    const verifierKey = canonicalEd25519Key(verifierIdentity.publicKeySpki);
    const material = readyFrontierProductionIndependentVerificationMaterialV1(verification);
    if (!validSignature(material, verification.signature, verifierKey.key)) fail("integrity_failed");
    verifierIdentityId = verification.verifierIdentityId; verifierKeyId = verification.verifierKeyId;
  } else if (envelope.independentVerification !== null) fail("policy_denied");
  const envelopeDigest = sha256Digest(envelope);
  const material: Omit<ReadyFrontierProductionProofObservationV1, "observationDigest"> = {
    schema: READY_FRONTIER_PRODUCTION_PROOF_OBSERVATION_V1,
    observationId: `frontier.production-proof-observation.${body.bodyDigest.slice(7, 31)}`,
    proofId: body.proofId, tenantId: body.tenantId, workspaceId: body.workspaceId,
    planId: body.planId, planDigest: body.planDigest, assessmentId: body.assessmentId,
    assessmentDigest: body.assessmentDigest, gateCode: body.gateCode,
    requirementDigest: body.requirementDigest, evidenceDigest: body.evidenceDigest,
    proofBodyDigest: body.bodyDigest, envelopeDigest,
    trustBundleId: body.trustBundleId, trustBundleRevision: body.trustBundleRevision,
    trustBundleDigest: body.trustBundleDigest, issuerIdentityId: body.issuerIdentityId,
    issuerKeyId: body.issuerKeyId, verifierIdentityId, verifierKeyId,
    observedAt: body.observedAt, issuedAt: body.issuedAt, expiresAt: body.expiresAt,
    receivedAt: input.receivedAt, trustMode: READY_FRONTIER_PRODUCTION_TRUST_MODE_V1,
    status: "observed_unqualified", repositoryCanQualify: false, grantsApproval: false,
    grantsActivationAuthority: false, grantsClaimOrLease: false,
    grantsDispatchOrExecution: false, grantsExternalEffects: false,
  };
  return parseReadyFrontierProductionProofObservationV1({ ...material,
    observationDigest: sha256Digest(material) });
}

function parseReadyFrontierProductionProofObservationV1(value: unknown):
  ReadyFrontierProductionProofObservationV1 {
  const observation = parseExactReadyFrontierV1(readyFrontierProductionProofObservationSchemaV1,
    value) as ReadyFrontierProductionProofObservationV1;
  if (observation.observationId !== `frontier.production-proof-observation.${observation.proofBodyDigest.slice(7, 31)}`
    || observation.observationDigest !== sha256Digest(without(
      observation as unknown as Record<string, unknown>, "observationDigest"))) fail("digest_mismatch");
  return observation;
}
