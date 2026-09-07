import { z } from "zod";
import { canonicalNetworkDestinationSchema } from "../../security/canonical-network-destination";
export { canonicalNetworkDestinationSchema } from "../../security/canonical-network-destination";
import {
  APPROVAL_ATTESTATION_SCHEMA_V1,
  NODE_CEILING_SCHEMA_V1,
  NODE_POLICY_CONTRACT_V1,
  SERVER_TRUST_BUNDLE_SCHEMA_V1,
  externalEffectPolicies,
  keyAvailabilityStates,
  localDenialDetails,
  nodePrivateKeyModes,
  nodePrivateKeyProviders,
  riskClasses,
  wireDenialCategories,
} from "./types";
import { computeArtifactBodyDigest } from "./crypto";

const safeId = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const isoDate = z.string().datetime({ offset: false });
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const base64url = z.string().min(16).max(16_384).regex(/^[A-Za-z0-9_-]+$/);
const canonicalMoney = z.string().min(1).max(32).regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]{0,5}[1-9])?$/);

function sortedUnique<T extends z.ZodType>(item: T, maximum: number, minimum = 0) {
  return z.array(item).min(minimum).max(maximum).superRefine((values, context) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", message: "items must be unique" });
    const sorted = [...values].sort((left, right) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0);
    if (values.some((value, index) => value !== sorted[index])) context.addIssue({ code: "custom", message: "items must be sorted canonically" });
  });
}

function isCanonicalFilesystemPath(value: string): boolean {
  if ([...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  })) return false;
  const unix = value.startsWith("/") && !value.startsWith("//") && !value.includes("\\");
  const windows = /^[A-Z]:\\/.test(value) && !value.includes("/");
  if (!unix && !windows) return false;
  const separator = windows ? "\\" : "/";
  const segments = value.split(separator).filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return false;
  if (windows && segments.slice(1).some((segment) => {
    const device = segment.split(".", 1)[0].toUpperCase();
    return /[<>:"|?*]/.test(segment) || segment.endsWith(".") || segment.endsWith(" ")
      || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(device);
  })) return false;
  if (value.includes(`${separator}${separator}`)) return false;
  const root = windows ? /^[A-Z]:\\$/.test(value) : value === "/";
  return root || !value.endsWith(separator);
}

export const canonicalFilesystemPathSchema = z.string().min(1).max(1_024).refine(isCanonicalFilesystemPath, "filesystem path must be absolute and canonical");

const signedArtifactShape = {
  signatureAlgorithm: z.literal("Ed25519"),
  signature: base64url,
};

export const nodeAuthorityCeilingBodySchema = z.object({
  schema: z.literal(NODE_CEILING_SCHEMA_V1),
  tenantId: safeId,
  nodeId: safeId,
  version: z.number().int().positive(),
  issuedAt: isoDate,
  issuerKeyId: safeId,
  projectIds: sortedUnique(safeId, 1_000, 1),
  executorIds: sortedUnique(safeId, 500, 1),
  operationIds: sortedUnique(safeId, 2_000, 1),
  credentialRefs: sortedUnique(safeId, 500),
  filesystemRoots: sortedUnique(canonicalFilesystemPathSchema, 500),
  networkDestinations: sortedUnique(canonicalNetworkDestinationSchema, 500),
  maxRisk: z.enum(riskClasses),
  externalEffects: z.enum(externalEffectPolicies),
  maxDurationSeconds: z.number().int().positive().max(31_536_000),
  maxConcurrentEffects: z.number().int().nonnegative().max(10_000),
  maxCostUsd: canonicalMoney.optional(),
  bodyDigest: digest,
}).strict().superRefine((ceiling, context) => {
  if (computeArtifactBodyDigest(ceiling) !== ceiling.bodyDigest) {
    context.addIssue({ code: "custom", path: ["bodyDigest"], message: "ceiling body digest mismatch" });
  }
  if (ceiling.externalEffects === "none" && ceiling.maxConcurrentEffects !== 0) {
    context.addIssue({ code: "custom", path: ["maxConcurrentEffects"], message: "effect policy none requires zero concurrent effects" });
  }
  if (ceiling.externalEffects === "none" && ceiling.networkDestinations.length !== 0) {
    context.addIssue({ code: "custom", path: ["networkDestinations"], message: "effect policy none forbids network destinations" });
  }
  if (ceiling.externalEffects !== "none" && ceiling.maxConcurrentEffects === 0) {
    context.addIssue({ code: "custom", path: ["maxConcurrentEffects"], message: "enabled effects require positive concurrency" });
  }
});

export const signedNodeAuthorityCeilingSchema = z.object({
  body: nodeAuthorityCeilingBodySchema,
  ...signedArtifactShape,
}).strict();

export const serverTrustKeySchema = z.object({
  keyId: safeId,
  algorithm: z.literal("ed25519"),
  spki: base64url,
  state: z.enum(["active", "retired", "revoked"]),
}).strict();

export const trustBundleShrinkAuthorizationSchema = z.object({
  keyId: safeId,
  bundleBodyDigest: digest,
  signatureAlgorithm: z.literal("Ed25519"),
  signature: base64url,
}).strict();

export const serverTrustBundleBodySchema = z.object({
  schema: z.literal(SERVER_TRUST_BUNDLE_SCHEMA_V1),
  tenantId: safeId,
  nodeClass: safeId,
  epoch: z.number().int().positive(),
  issuedAt: isoDate,
  ownerRootKeyId: safeId,
  keys: z.array(serverTrustKeySchema).min(1).max(64),
  bodyDigest: digest,
}).strict().superRefine((bundle, context) => {
  if (computeArtifactBodyDigest(bundle) !== bundle.bodyDigest) context.addIssue({ code: "custom", path: ["bodyDigest"], message: "trust bundle body digest mismatch" });
  const keyIds = bundle.keys.map((key) => key.keyId);
  const publicKeys = bundle.keys.map((key) => key.spki);
  if (new Set(keyIds).size !== keyIds.length) context.addIssue({ code: "custom", path: ["keys"], message: "trust key IDs must be unique" });
  if (new Set(publicKeys).size !== publicKeys.length) context.addIssue({ code: "custom", path: ["keys"], message: "trust public keys must be unique" });
  if (bundle.keys.every((key) => key.state !== "active")) context.addIssue({ code: "custom", path: ["keys"], message: "trust bundle requires an active key" });
  if (keyIds.some((keyId, index) => index > 0 && keyIds[index - 1] > keyId)) context.addIssue({ code: "custom", path: ["keys"], message: "trust keys must be sorted by keyId" });
});

export const ownerSignedTrustBundleSchema = z.object({
  body: serverTrustBundleBodySchema,
  ...signedArtifactShape,
  shrinkAuthorization: trustBundleShrinkAuthorizationSchema.optional(),
}).strict().superRefine((bundle, context) => {
  if (bundle.shrinkAuthorization && bundle.shrinkAuthorization.bundleBodyDigest !== bundle.body.bodyDigest) {
    context.addIssue({ code: "custom", path: ["shrinkAuthorization", "bundleBodyDigest"], message: "shrink authorization must bind this bundle body" });
  }
});

export const ownerApprovalAttestationBodySchema = z.object({
  schema: z.literal(APPROVAL_ATTESTATION_SCHEMA_V1),
  tenantId: safeId,
  nodeId: safeId.optional(),
  nodeClass: safeId.optional(),
  projectId: safeId,
  jobId: safeId,
  attemptId: safeId,
  operationDigest: digest,
  risk: z.enum(riskClasses),
  decision: z.literal("approved"),
  issuedAt: isoDate,
  expiresAt: isoDate,
  nonce: base64url,
  approvalKeyId: safeId,
  bodyDigest: digest,
}).strict().superRefine((approval, context) => {
  if (computeArtifactBodyDigest(approval) !== approval.bodyDigest) context.addIssue({ code: "custom", path: ["bodyDigest"], message: "approval body digest mismatch" });
  if (Boolean(approval.nodeId) === Boolean(approval.nodeClass)) context.addIssue({ code: "custom", path: ["nodeId"], message: "approval must target exactly one nodeId or nodeClass" });
  if (Date.parse(approval.expiresAt) <= Date.parse(approval.issuedAt)) context.addIssue({ code: "custom", path: ["expiresAt"], message: "approval must expire after issue" });
});

export const ownerApprovalAttestationSchema = z.object({
  body: ownerApprovalAttestationBodySchema,
  ...signedArtifactShape,
}).strict();

export const normalizedTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("filesystem"), canonicalPath: canonicalFilesystemPathSchema }).strict(),
  z.object({ kind: z.literal("network"), canonicalDestination: canonicalNetworkDestinationSchema }).strict(),
]);

export const normalizedLocalPolicyRequestSchema = z.object({
  contractVersion: z.literal(NODE_POLICY_CONTRACT_V1),
  requestId: safeId,
  tenantId: safeId,
  nodeId: safeId,
  nodeClass: safeId,
  projectId: safeId,
  jobId: safeId,
  attemptId: safeId,
  leaseId: safeId,
  leaseEpoch: z.number().int().positive(),
  executorId: safeId,
  operationId: safeId,
  operationDigest: digest,
  authorityDigest: digest,
  payloadDigest: digest.optional(),
  credentialRefs: sortedUnique(safeId, 500),
  target: normalizedTargetSchema,
  risk: z.enum(riskClasses),
  externalEffect: z.boolean(),
  estimatedDurationSeconds: z.number().int().nonnegative().max(31_536_000),
  estimatedCostUsd: canonicalMoney.optional(),
  occurredAt: isoDate,
  approval: ownerApprovalAttestationSchema.optional(),
}).strict().superRefine((request, context) => {
  if (!request.externalEffect && request.target.kind === "network") context.addIssue({ code: "custom", path: ["externalEffect"], message: "network targets are external effects" });
  if (request.operationId === "harness.hermes.native.start" && request.payloadDigest === undefined)
    context.addIssue({ code: "custom", path: ["payloadDigest"], message: "native task requires exact payload commitment" });
});

export const executorCapabilitySchema = z.object({
  contractVersion: z.literal(NODE_POLICY_CONTRACT_V1),
  executorId: safeId,
  operationIds: sortedUnique(safeId, 2_000, 1),
  externalEffectOperationIds: sortedUnique(safeId, 2_000),
  targetKinds: sortedUnique(z.enum(["none", "filesystem", "network"]), 3, 1),
  supportsCancellation: z.boolean(),
  supportsNetworkIdentityEnforcement: z.boolean(),
  costMeter: z.enum(["none", "monotonic_reservable"]),
}).strict().superRefine((capability, context) => {
  if (capability.externalEffectOperationIds.some((operationId) => !capability.operationIds.includes(operationId))) {
    context.addIssue({ code: "custom", path: ["externalEffectOperationIds"], message: "external-effect operations must be executor operations" });
  }
  if (capability.targetKinds.includes("network") && !capability.supportsNetworkIdentityEnforcement) {
    context.addIssue({ code: "custom", path: ["supportsNetworkIdentityEnforcement"], message: "network executors must enforce network identity" });
  }
});

const decisionBase = {
  contractVersion: z.literal(NODE_POLICY_CONTRACT_V1),
  requestId: safeId,
  requestDigest: digest,
  ceilingDigest: digest,
  authorityDigest: digest,
  decidedAt: isoDate,
};

export const localPolicyDecisionSchema = z.discriminatedUnion("accepted", [
  z.object({ ...decisionBase, accepted: z.literal(true) }).strict(),
  z.object({ ...decisionBase, accepted: z.literal(false), detail: z.enum(localDenialDetails), wireCategory: z.enum(wireDenialCategories) }).strict(),
]);

export const wireDenialReceiptSchema = z.object({
  contractVersion: z.literal(NODE_POLICY_CONTRACT_V1),
  receiptId: safeId,
  relatedMessageId: safeId,
  jobId: safeId,
  attemptId: safeId,
  category: z.enum(wireDenialCategories),
  occurredAt: isoDate,
}).strict();

export const keyAvailabilitySchema = z.object({
  state: z.enum(keyAvailabilityStates),
  keyReferenceId: safeId,
  observedAt: isoDate,
}).strict();

export const keyReferenceSchema = z.object({
  contractVersion: z.literal(NODE_POLICY_CONTRACT_V1),
  keyId: safeId,
  referenceId: safeId,
  provider: z.enum(nodePrivateKeyProviders),
  mode: z.enum(nodePrivateKeyModes),
  algorithm: z.literal("Ed25519"),
}).strict().superRefine((reference, context) => {
  const expectedMode = reference.provider === "encrypted_file" ? "encrypted_file" : reference.provider === "memory_test" ? "test" : "native";
  if (reference.mode !== expectedMode) context.addIssue({ code: "custom", path: ["mode"], message: "provider and mode must agree" });
});

export const pinnedOwnerKeySchema = z.object({
  keyId: safeId,
  algorithm: z.literal("ed25519"),
  spki: base64url,
  fingerprint: digest,
}).strict();

export const ownerPinSetSchema = z.object({
  ceilingProvisioningKey: pinnedOwnerKeySchema,
  serverTrustRootKey: pinnedOwnerKeySchema,
  trustShrinkKeys: z.array(pinnedOwnerKeySchema).min(1).max(16),
}).strict().superRefine((pins, context) => {
  const keyIds = pins.trustShrinkKeys.map((key) => key.keyId);
  if (new Set(keyIds).size !== keyIds.length) context.addIssue({ code: "custom", path: ["trustShrinkKeys"], message: "trust shrink key IDs must be unique" });
  if (keyIds.some((keyId, index) => index > 0 && keyIds[index - 1] > keyId)) context.addIssue({ code: "custom", path: ["trustShrinkKeys"], message: "trust shrink keys must be sorted by keyId" });
});

export const signedNodePolicyArtifactSchema = z.union([
  signedNodeAuthorityCeilingSchema,
  ownerSignedTrustBundleSchema,
  ownerApprovalAttestationSchema,
]);
