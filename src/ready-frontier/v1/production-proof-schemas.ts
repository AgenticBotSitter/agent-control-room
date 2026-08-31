import { z } from "zod";
import { READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1 } from "./no-relay";
import {
  readyFrontierProductionEvidenceClassesV1,
  readyFrontierProductionProofAuthoritiesV1,
} from "./production-boundary-types";
import {
  READY_FRONTIER_PRODUCTION_INDEPENDENT_VERIFICATION_V1,
  READY_FRONTIER_PRODUCTION_PROOF_ENVELOPE_V1,
  READY_FRONTIER_PRODUCTION_PROOF_OBSERVATION_V1,
  READY_FRONTIER_PRODUCTION_TRUST_BUNDLE_V1,
  READY_FRONTIER_PRODUCTION_TRUST_MODE_V1,
} from "./production-proof-types";
import {
  readyFrontierDigestSchemaV1,
  readyFrontierIdSchemaV1,
  readyFrontierSafeCodeSchemaV1,
  readyFrontierTimeSchemaV1,
} from "./schemas";

const base64urlSchemaV1 = z.string().min(16).max(16_384).regex(/^[A-Za-z0-9_-]+$/);
const signatureSchemaV1 = z.string().length(86).regex(/^[A-Za-z0-9_-]+$/);
const gateCodeSchemaV1 = z.enum(READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1);

export const readyFrontierProductionTrustIdentitySchemaV1 = z.object({
  identityId: readyFrontierIdSchemaV1,
  keyId: readyFrontierIdSchemaV1,
  publicKeySpki: base64urlSchemaV1,
  keyDigest: readyFrontierDigestSchemaV1,
  independenceDomainDigest: readyFrontierDigestSchemaV1,
  proofAuthorities: z.array(z.enum(readyFrontierProductionProofAuthoritiesV1)).min(1).max(9),
  authorizedGateCodes: z.array(gateCodeSchemaV1).min(1).max(9),
  canIndependentlyVerify: z.boolean(),
  state: z.enum(["active", "revoked"]),
  revokedAt: readyFrontierTimeSchemaV1.nullable(),
}).strict();

export const readyFrontierProductionTrustBundleBodySchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PRODUCTION_TRUST_BUNDLE_V1),
  bundleId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1,
  workspaceId: readyFrontierIdSchemaV1,
  trustMode: z.literal(READY_FRONTIER_PRODUCTION_TRUST_MODE_V1),
  revision: z.number().int().min(1).max(2_147_483_647),
  previousBundleDigest: readyFrontierDigestSchemaV1.nullable(),
  ownerRootKeyId: readyFrontierIdSchemaV1,
  issuedAt: readyFrontierTimeSchemaV1,
  expiresAt: readyFrontierTimeSchemaV1,
  identities: z.array(readyFrontierProductionTrustIdentitySchemaV1).min(1).max(64),
  bodyDigest: readyFrontierDigestSchemaV1,
}).strict();

export const readyFrontierProductionTrustBundleSchemaV1 = z.object({
  body: readyFrontierProductionTrustBundleBodySchemaV1,
  signatureAlgorithm: z.literal("Ed25519"),
  ownerSignature: signatureSchemaV1,
}).strict();

export const readyFrontierProductionTrustAnchorSchemaV1 = z.object({
  trustMode: z.literal(READY_FRONTIER_PRODUCTION_TRUST_MODE_V1),
  tenantId: readyFrontierIdSchemaV1,
  workspaceId: readyFrontierIdSchemaV1,
  ownerRootKeyId: readyFrontierIdSchemaV1,
  ownerRootPublicKeySpki: base64urlSchemaV1,
  ownerRootKeyDigest: readyFrontierDigestSchemaV1,
}).strict();

export const readyFrontierProductionProofBindingSchemaV1 = z.object({
  code: readyFrontierSafeCodeSchemaV1,
  digest: readyFrontierDigestSchemaV1,
}).strict();

export const readyFrontierProductionProofBodySchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PRODUCTION_PROOF_ENVELOPE_V1),
  proofId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1,
  workspaceId: readyFrontierIdSchemaV1,
  planId: readyFrontierIdSchemaV1,
  planDigest: readyFrontierDigestSchemaV1,
  assessmentId: readyFrontierIdSchemaV1,
  assessmentDigest: readyFrontierDigestSchemaV1,
  gateCode: gateCodeSchemaV1,
  requirementDigest: readyFrontierDigestSchemaV1,
  evidenceClass: z.enum(readyFrontierProductionEvidenceClassesV1),
  proofAuthority: z.enum(readyFrontierProductionProofAuthoritiesV1),
  evidenceDigest: readyFrontierDigestSchemaV1,
  bindings: z.array(readyFrontierProductionProofBindingSchemaV1).min(4).max(12),
  issuerIdentityId: readyFrontierIdSchemaV1,
  issuerKeyId: readyFrontierIdSchemaV1,
  trustBundleId: readyFrontierIdSchemaV1,
  trustBundleRevision: z.number().int().min(1).max(2_147_483_647),
  trustBundleDigest: readyFrontierDigestSchemaV1,
  observedAt: readyFrontierTimeSchemaV1,
  issuedAt: readyFrontierTimeSchemaV1,
  expiresAt: readyFrontierTimeSchemaV1,
  bodyDigest: readyFrontierDigestSchemaV1,
}).strict();

export const readyFrontierProductionIndependentVerificationSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PRODUCTION_INDEPENDENT_VERIFICATION_V1),
  verifierIdentityId: readyFrontierIdSchemaV1,
  verifierKeyId: readyFrontierIdSchemaV1,
  proofBodyDigest: readyFrontierDigestSchemaV1,
  trustBundleDigest: readyFrontierDigestSchemaV1,
  verifiedAt: readyFrontierTimeSchemaV1,
  signatureAlgorithm: z.literal("Ed25519"),
  signature: signatureSchemaV1,
}).strict();

export const readyFrontierProductionProofEnvelopeSchemaV1 = z.object({
  body: readyFrontierProductionProofBodySchemaV1,
  signatureAlgorithm: z.literal("Ed25519"),
  issuerSignature: signatureSchemaV1,
  independentVerification: readyFrontierProductionIndependentVerificationSchemaV1.nullable(),
}).strict();

export const readyFrontierProductionProofObservationSchemaV1 = z.object({
  schema: z.literal(READY_FRONTIER_PRODUCTION_PROOF_OBSERVATION_V1),
  observationId: readyFrontierIdSchemaV1,
  proofId: readyFrontierIdSchemaV1,
  tenantId: readyFrontierIdSchemaV1,
  workspaceId: readyFrontierIdSchemaV1,
  planId: readyFrontierIdSchemaV1,
  planDigest: readyFrontierDigestSchemaV1,
  assessmentId: readyFrontierIdSchemaV1,
  assessmentDigest: readyFrontierDigestSchemaV1,
  gateCode: gateCodeSchemaV1,
  requirementDigest: readyFrontierDigestSchemaV1,
  evidenceDigest: readyFrontierDigestSchemaV1,
  proofBodyDigest: readyFrontierDigestSchemaV1,
  envelopeDigest: readyFrontierDigestSchemaV1,
  trustBundleId: readyFrontierIdSchemaV1,
  trustBundleRevision: z.number().int().min(1).max(2_147_483_647),
  trustBundleDigest: readyFrontierDigestSchemaV1,
  issuerIdentityId: readyFrontierIdSchemaV1,
  issuerKeyId: readyFrontierIdSchemaV1,
  verifierIdentityId: readyFrontierIdSchemaV1.nullable(),
  verifierKeyId: readyFrontierIdSchemaV1.nullable(),
  observedAt: readyFrontierTimeSchemaV1,
  issuedAt: readyFrontierTimeSchemaV1,
  expiresAt: readyFrontierTimeSchemaV1,
  receivedAt: readyFrontierTimeSchemaV1,
  trustMode: z.literal(READY_FRONTIER_PRODUCTION_TRUST_MODE_V1),
  status: z.literal("observed_unqualified"),
  repositoryCanQualify: z.literal(false),
  grantsApproval: z.literal(false),
  grantsActivationAuthority: z.literal(false),
  grantsClaimOrLease: z.literal(false),
  grantsDispatchOrExecution: z.literal(false),
  grantsExternalEffects: z.literal(false),
  observationDigest: readyFrontierDigestSchemaV1,
}).strict();

export const readyFrontierProductionProofVerificationInputSchemaV1 = z.object({
  envelope: z.unknown(), assessment: z.unknown(), trustBundle: z.unknown(),
  receivedAt: readyFrontierTimeSchemaV1,
}).strict();
