import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { canonicalJson, sha256Digest } from "../../security";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import { READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1 } from "./no-relay";
import { parseReadyFrontierProductionBoundaryAssessmentV1 } from "./production-boundary";
import {
  readyFrontierProductionProofAssessmentSchemaV1,
  readyFrontierProductionProofEnvelopeSchemaV1,
  readyFrontierProductionProofObservationSchemaV1,
  readyFrontierProductionProofProjectionSchemaV1,
  readyFrontierProductionProofVerificationInputSchemaV1,
  readyFrontierProductionTrustAnchorSchemaV1,
  readyFrontierProductionTrustBundleSchemaV1,
} from "./production-proof-schemas";
import {
  READY_FRONTIER_PRODUCTION_INDEPENDENT_VERIFICATION_V1,
  READY_FRONTIER_PRODUCTION_PROOF_ASSESSMENT_V1,
  READY_FRONTIER_PRODUCTION_PROOF_MAX_LIFETIME_SECONDS_V1,
  READY_FRONTIER_PRODUCTION_PROOF_OBSERVATION_V1,
  READY_FRONTIER_PRODUCTION_PROOF_PROJECTION_V1,
  READY_FRONTIER_PRODUCTION_TRUST_MODE_V1,
  type ReadyFrontierProductionGateObservationStatusV1,
  type ReadyFrontierProductionIndependentVerificationV1,
  type ReadyFrontierProductionProofAssessmentV1,
  type ReadyFrontierProductionProofBindingV1,
  type ReadyFrontierProductionProofBodyV1,
  type ReadyFrontierProductionProofEnvelopeV1,
  type ReadyFrontierProductionProofObservationV1,
  type ReadyFrontierProductionProofProjectionV1,
  type ReadyFrontierProductionTrustAnchorV1,
  type ReadyFrontierProductionTrustBundleBodyV1,
  type ReadyFrontierProductionTrustBundleV1,
  type ReadyFrontierProductionTrustIdentityV1,
} from "./production-proof-types";
import type { ReadyFrontierProductionBoundaryAssessmentV1 } from "./production-boundary-types";

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
function validSignature(material: unknown, signature: string, key: KeyObject): boolean {
  try { return verify(null, Buffer.from(canonicalJson(material)), key, Buffer.from(signature, "base64url")); }
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

export function parseReadyFrontierProductionProofObservationV1(value: unknown):
  ReadyFrontierProductionProofObservationV1 {
  const observation = parseExactReadyFrontierV1(readyFrontierProductionProofObservationSchemaV1,
    value) as ReadyFrontierProductionProofObservationV1;
  if (observation.observationId !== `frontier.production-proof-observation.${observation.proofBodyDigest.slice(7, 31)}`
    || observation.observationDigest !== sha256Digest(without(
      observation as unknown as Record<string, unknown>, "observationDigest"))) fail("digest_mismatch");
  return observation;
}

export interface ReadyFrontierProductionProofAssessmentInputV1 {
  proofAssessmentId: string;
  assessment: ReadyFrontierProductionBoundaryAssessmentV1;
  currentTrustBundle: ReadyFrontierProductionTrustBundleV1;
  observations: ReadyFrontierProductionProofObservationV1[];
  evaluatedAt: string;
}

export function assessReadyFrontierProductionProofsV1(inputValue: unknown,
  activationPacketIntegrityKey: unknown, anchorValue: unknown): ReadyFrontierProductionProofAssessmentV1 {
  const input = parseExactReadyFrontierV1({ parse(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
    const item = value as Record<string, unknown>;
    const keys = Object.keys(item).sort();
    if (!sameList(keys, ["assessment", "currentTrustBundle", "evaluatedAt", "observations", "proofAssessmentId"])) throw new Error("invalid");
    if (typeof item.proofAssessmentId !== "string" || !Array.isArray(item.observations)
      || typeof item.evaluatedAt !== "string") throw new Error("invalid");
    return item;
  } }, inputValue) as unknown as ReadyFrontierProductionProofAssessmentInputV1;
  const assessment = parseReadyFrontierProductionBoundaryAssessmentV1(input.assessment,
    activationPacketIntegrityKey);
  const anchor = parseReadyFrontierProductionTrustAnchorV1(anchorValue);
  const bundle = verifyReadyFrontierProductionTrustBundleV1(input.currentTrustBundle, anchor);
  const evaluated = Date.parse(input.evaluatedAt);
  if (!Number.isFinite(evaluated) || bundle.body.tenantId !== assessment.tenantId
    || bundle.body.workspaceId !== assessment.workspaceId || evaluated < Date.parse(bundle.body.issuedAt)) fail("scope_mismatch");
  const observations = input.observations.map(parseReadyFrontierProductionProofObservationV1);
  for (const observation of observations) {
    if (observation.tenantId !== assessment.tenantId || observation.workspaceId !== assessment.workspaceId
      || observation.planId !== assessment.planId || observation.planDigest !== assessment.planDigest
      || observation.assessmentId !== assessment.assessmentId
      || observation.assessmentDigest !== assessment.assessmentDigest) fail("scope_mismatch");
  }
  const gateStatuses: ReadyFrontierProductionGateObservationStatusV1[] =
    READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1.map((gateCode) => {
      const matching = observations.filter((item) => item.gateCode === gateCode)
        .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
      const latest = matching.at(-1);
      if (!latest) return { gateCode, status: "unobserved", proofId: null, observationId: null,
        observedAt: null, expiresAt: null };
      let status: ReadyFrontierProductionGateObservationStatusV1["status"] = "observed_unqualified";
      const currentIdentity = bundle.body.identities.find((identity) => identity.identityId === latest.issuerIdentityId);
      const currentVerifier = latest.verifierIdentityId === null ? undefined
        : bundle.body.identities.find((identity) => identity.identityId === latest.verifierIdentityId);
      if (!currentIdentity || currentIdentity.state !== "active" || currentIdentity.keyId !== latest.issuerKeyId
        || (latest.verifierIdentityId !== null && (!currentVerifier || currentVerifier.state !== "active"
          || currentVerifier.keyId !== latest.verifierKeyId))) status = "revoked";
      else if (latest.trustBundleRevision !== bundle.body.revision
        || latest.trustBundleDigest !== bundle.body.bodyDigest) status = "superseded";
      else if (evaluated >= Date.parse(latest.expiresAt) || evaluated >= Date.parse(bundle.body.expiresAt)) status = "expired";
      return { gateCode, status, proofId: latest.proofId, observationId: latest.observationId,
        observedAt: latest.observedAt, expiresAt: latest.expiresAt };
    });
  const observedUnqualifiedCount = gateStatuses.filter((item) => item.status === "observed_unqualified").length;
  const material: Omit<ReadyFrontierProductionProofAssessmentV1, "proofAssessmentDigest"> = {
    schema: READY_FRONTIER_PRODUCTION_PROOF_ASSESSMENT_V1,
    proofAssessmentId: input.proofAssessmentId, tenantId: assessment.tenantId,
    workspaceId: assessment.workspaceId, planId: assessment.planId, planDigest: assessment.planDigest,
    assessmentId: assessment.assessmentId, assessmentDigest: assessment.assessmentDigest,
    trustBundleId: bundle.body.bundleId, trustBundleRevision: bundle.body.revision,
    trustBundleDigest: bundle.body.bodyDigest, trustMode: READY_FRONTIER_PRODUCTION_TRUST_MODE_V1,
    gateStatuses, blockingGateCodes: [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1],
    observedUnqualifiedCount, qualifiedProofCount: 0, remainingQualifiedProofCount: 9,
    state: "blocked_fixture_proof_only", safeReason: "protected_production_custody_unavailable",
    evaluatedAt: input.evaluatedAt, eligibleForOwnerApproval: false, eligibleForActivation: false,
    requiresProtectedProductionReassessment: true, requiresFreshStrongOwnerApproval: true,
    requiresIndependentSecurityReview: true, activationAuthorized: false, grantsApproval: false,
    grantsActivationAuthority: false, grantsClaimOrLease: false,
    grantsDispatchOrExecution: false, grantsExternalEffects: false,
  };
  return parseReadyFrontierProductionProofAssessmentV1({ ...material,
    proofAssessmentDigest: sha256Digest(material) });
}

export function parseReadyFrontierProductionProofAssessmentV1(value: unknown):
  ReadyFrontierProductionProofAssessmentV1 {
  const assessment = parseExactReadyFrontierV1(readyFrontierProductionProofAssessmentSchemaV1,
    value) as ReadyFrontierProductionProofAssessmentV1;
  if (!sameList(assessment.gateStatuses.map((item) => item.gateCode), READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1)
    || !sameList(assessment.blockingGateCodes, READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1)
    || assessment.observedUnqualifiedCount !== assessment.gateStatuses.filter(
      (item) => item.status === "observed_unqualified").length
    || assessment.proofAssessmentDigest !== sha256Digest(without(
      assessment as unknown as Record<string, unknown>, "proofAssessmentDigest"))) fail("digest_mismatch");
  return assessment;
}

export function projectReadyFrontierProductionProofAssessmentV1(value: unknown):
  ReadyFrontierProductionProofProjectionV1 {
  const assessment = parseReadyFrontierProductionProofAssessmentV1(value);
  const material: Omit<ReadyFrontierProductionProofProjectionV1, "projectionDigest"> = {
    schema: READY_FRONTIER_PRODUCTION_PROOF_PROJECTION_V1,
    tenantId: assessment.tenantId, workspaceId: assessment.workspaceId,
    planId: assessment.planId, assessmentId: assessment.assessmentId,
    proofAssessmentId: assessment.proofAssessmentId, status: assessment.state,
    safeReason: assessment.safeReason,
    gateStatuses: assessment.gateStatuses.map(({ gateCode, status }) => ({ gateCode, status })),
    blockingGateCodes: [...assessment.blockingGateCodes],
    observedUnqualifiedCount: assessment.observedUnqualifiedCount,
    qualifiedProofCount: 0, remainingQualifiedProofCount: 9,
    canActivateProduction: false, canConstructConsumer: false,
    canResolveProtectedReferences: false, canContactNetwork: false,
    canClaimOrLease: false, canDispatchOrExecute: false,
  };
  return parseReadyFrontierProductionProofProjectionV1({ ...material,
    projectionDigest: sha256Digest(material) });
}

export function parseReadyFrontierProductionProofProjectionV1(value: unknown):
  ReadyFrontierProductionProofProjectionV1 {
  const projection = parseExactReadyFrontierV1(readyFrontierProductionProofProjectionSchemaV1,
    value) as ReadyFrontierProductionProofProjectionV1;
  if (!sameList(projection.gateStatuses.map((item) => item.gateCode), READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1)
    || !sameList(projection.blockingGateCodes, READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1)
    || projection.observedUnqualifiedCount !== projection.gateStatuses.filter(
      (item) => item.status === "observed_unqualified").length
    || projection.projectionDigest !== sha256Digest(without(
      projection as unknown as Record<string, unknown>, "projectionDigest"))) fail("digest_mismatch");
  return projection;
}
