import { isIP } from "node:net";
import { z } from "zod";
import {
  COMPLETION_GATE_SCHEMA_VERSION_V1,
  consequentialApprovalDecisionSchemaV1,
  consequentialApprovalRequestSchemaV1,
  type ConsequentialApprovalDecisionV1,
  type ConsequentialApprovalRequestV1,
} from "../../../completion-gate/v1";
import { assertNoSecretMaterial, sha256Digest } from "../../../security";
import {
  exactProjectWorkspaceJsonV1,
  ProjectWorkspaceContractErrorV1,
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../../project-workspace/v1";

export const ABS_NEWS_PUBLICATION_CONTRACT_V1 = "control-room-abs-news-publication/v1" as const;

function parseServer<T>(schema: z.ZodType<T>, value: unknown): T {
  try { return schema.parse(exactProjectWorkspaceJsonV1(value)); }
  catch (error) {
    if (error instanceof ProjectWorkspaceContractErrorV1) throw error;
    throw new ProjectWorkspaceContractErrorV1("invalid_input");
  }
}

function exactDigest(value: Record<string, unknown>, key: string, actual: string): void {
  const material = { ...value };
  delete material[key];
  if (sha256Digest(material) !== actual) throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
}

function derivedId(prefix: string, value: unknown): string {
  return `${prefix}:${sha256Digest(value).slice(7, 31)}`;
}

function isPublicOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && url.origin === value && url.pathname === "/"
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && isIP(host) === 0 && host.includes(".")
      && host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".local")
      && !host.endsWith(".internal") && !host.endsWith(".home") && !host.endsWith(".lan");
  } catch { return false; }
}

const publicOrigin = z.string().min(12).max(300).refine(isPublicOrigin, "destination origin must be exact public HTTPS");
const slug = z.string().min(3).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const safeText = z.string().min(1).max(500);
const sortedDigests = (minimum: number, maximum: number) => z.array(digest).min(minimum).max(maximum).superRefine((values, context) => {
  if (new Set(values).size !== values.length || values.join("|") !== [...values].sort().join("|")) {
    context.addIssue({ code: "custom", message: "digests must be unique and sorted" });
  }
});

export interface AbsNewsPublicationDestinationV1 {
  contractVersion: typeof ABS_NEWS_PUBLICATION_CONTRACT_V1;
  destinationId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  destinationKind: "abs_public_site_article";
  environment: "simulation" | "configured_live";
  publicOrigin: string;
  routePrefix: "/articles/";
  adapterId: string;
  adapterReleaseDigest: string;
  supportsIdempotencyKey: true;
  exactRevisionRequired: true;
  credentialsReferenceDigests: string[];
  networkConfigured: boolean;
  publicationAuthorized: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  destinationIdentityDigest: string;
  destinationDigest: string;
}

export interface AbsNewsPublicationPackageV1 {
  contractVersion: typeof ABS_NEWS_PUBLICATION_CONTRACT_V1;
  packageId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  storyId: string;
  storyDigest: string;
  sourceEvidenceDigests: string[];
  draftArtifactId: string;
  draftArtifactDigest: string;
  contentRevision: number;
  contentDigest: string;
  title: string;
  slug: string;
  excerpt: string;
  completionTargetId: string;
  completionTargetDigest: string;
  acceptedCompletionReviewDigest: string;
  verificationDigests: string[];
  preparedAt: string;
  containsDraftBody: false;
  containsCredentials: false;
  editoriallyAccepted: true;
  requiresAuthoritativeCompletionResolution: true;
  publicationAuthorized: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  packageDigest: string;
}

export interface AbsNewsPublicationRequestV1 {
  contractVersion: typeof ABS_NEWS_PUBLICATION_CONTRACT_V1;
  requestId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  effectIntentId: string;
  packageId: string;
  packageDigest: string;
  contentRevision: number;
  contentDigest: string;
  destinationId: string;
  destinationIdentityDigest: string;
  destinationPath: string;
  operationDigest: string;
  destinationIdempotencyKey: string;
  requestedAt: string;
  expiresAt: string;
  risk: "high";
  requiredFactor: "strong";
  ownerApprovalRequired: true;
  publicationAuthorized: false;
  allowsCredentialResolution: false;
  allowsNetwork: false;
  allowsPublication: false;
  grantsExecutionAuthority: false;
  requestDigest: string;
}

export interface AbsNewsPublicationAuthorizationV1 {
  contractVersion: typeof ABS_NEWS_PUBLICATION_CONTRACT_V1;
  authorizationId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  requestId: string;
  requestDigest: string;
  packageDigest: string;
  destinationIdentityDigest: string;
  operationDigest: string;
  destinationIdempotencyKey: string;
  approvalRequestId: string;
  approvalRequestDigest: string;
  approvalDecisionId: string;
  approvalDecisionDigest: string;
  authorizationMode: "simulation" | "owner_live";
  authorizedAt: string;
  expiresAt: string;
  destinationWriteAuthorized: boolean;
  requiresAuthoritativeApprovalResolution: true;
  requiresDurableClaim: true;
  requiresPreEffectMarker: true;
  requiresDestinationReceipt: true;
  singleUse: true;
  retryAfterAmbiguityAllowed: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  authorizationDigest: string;
}

export interface AbsNewsPublicationClaimV1 {
  contractVersion: typeof ABS_NEWS_PUBLICATION_CONTRACT_V1;
  claimId: string;
  claimKey: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  requestId: string;
  requestDigest: string;
  authorizationDigest: string;
  operationDigest: string;
  destinationIdempotencyKey: string;
  state: "claimed" | "executing" | "succeeded" | "definite_failure" | "ambiguous";
  markerDigest?: string;
  outcomeDigest?: string;
  version: number;
  claimedAt: string;
  updatedAt: string;
  effectiveDeadline: string;
  simulationOnly: true;
  externalEffectOccurred: false;
  claimDigest: string;
}

export interface AbsNewsPublicationMarkerV1 {
  contractVersion: typeof ABS_NEWS_PUBLICATION_CONTRACT_V1;
  markerId: string;
  claimKey: string;
  claimDigest: string;
  requestDigest: string;
  authorizationDigest: string;
  operationDigest: string;
  destinationIdempotencyKey: string;
  markedAt: string;
  simulationOnly: true;
  externalEffectOccurred: false;
  markerDigest: string;
}

export interface AbsNewsPublicationDestinationResultV1 {
  contractVersion: typeof ABS_NEWS_PUBLICATION_CONTRACT_V1;
  status: "succeeded" | "definite_failure";
  destinationId: string;
  destinationIdentityDigest: string;
  destinationIdempotencyKey: string;
  packageDigest: string;
  contentRevision: number;
  contentDigest: string;
  destinationPath: string;
  receiptId?: string;
  destinationRevisionDigest?: string;
  safeFailureCode?: "rejected_before_mutation";
  observedAt: string;
  synthetic: true;
  networkUsed: false;
  publicMutationObserved: false;
  credentialsResolved: false;
  rawDraftBodyUsed: false;
  resultDigest: string;
}

export interface AbsNewsPublicationCleanupReceiptV1 {
  contractVersion: typeof ABS_NEWS_PUBLICATION_CONTRACT_V1;
  cleanupId: string;
  claimKey: string;
  requestDigest: string;
  destinationHandlesClosed: true;
  temporaryFilesCreated: false;
  temporaryFilesRemaining: false;
  credentialsResolved: false;
  draftBodyRetained: false;
  cleanedAt: string;
  simulationOnly: true;
  cleanupDigest: string;
}

export interface AbsNewsPublicationOutcomeV1 {
  contractVersion: typeof ABS_NEWS_PUBLICATION_CONTRACT_V1;
  outcomeId: string;
  claimKey: string;
  requestId: string;
  requestDigest: string;
  authorizationDigest: string;
  disposition: "succeeded" | "definite_failure" | "ambiguous";
  destinationResultDigest?: string;
  destinationReceiptDigest?: string;
  safeReasonCode: "synthetic_publication_complete" | "definite_destination_failure" | "post_marker_outcome_unknown" | "restart_after_marker";
  startedAt: string;
  settledAt: string;
  cleanupDigest: string;
  publicMutationObserved: false;
  externalEffectOccurred: false;
  simulationOnly: true;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  outcomeDigest: string;
}

const destinationSchema = z.object({
  contractVersion: z.literal(ABS_NEWS_PUBLICATION_CONTRACT_V1), destinationId: id, tenantId: id, workspaceId: id, projectId: id,
  destinationKind: z.literal("abs_public_site_article"), environment: z.enum(["simulation", "configured_live"]), publicOrigin,
  routePrefix: z.literal("/articles/"), adapterId: id, adapterReleaseDigest: digest, supportsIdempotencyKey: z.literal(true),
  exactRevisionRequired: z.literal(true), credentialsReferenceDigests: sortedDigests(0, 4), networkConfigured: z.boolean(),
  publicationAuthorized: z.literal(false), grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false),
  destinationIdentityDigest: digest, destinationDigest: digest,
}).strict().superRefine((value, context) => {
  if ((value.environment === "simulation" && (value.networkConfigured || value.credentialsReferenceDigests.length > 0))
    || (value.environment === "configured_live" && !value.networkConfigured)) {
    context.addIssue({ code: "custom", message: "destination environment boundary invalid" });
  }
});
const destinationInputSchema = destinationSchema.omit({ contractVersion: true, destinationIdentityDigest: true, destinationDigest: true,
  publicationAuthorized: true, grantsApproval: true, grantsExecutionAuthority: true, supportsIdempotencyKey: true,
  exactRevisionRequired: true, routePrefix: true });

const packageSchema = z.object({
  contractVersion: z.literal(ABS_NEWS_PUBLICATION_CONTRACT_V1), packageId: id, tenantId: id, workspaceId: id, projectId: id,
  storyId: id, storyDigest: digest, sourceEvidenceDigests: sortedDigests(1, 50), draftArtifactId: id, draftArtifactDigest: digest,
  contentRevision: z.number().int().positive().max(1_000_000), contentDigest: digest, title: safeText.max(180), slug, excerpt: safeText,
  completionTargetId: id, completionTargetDigest: digest, acceptedCompletionReviewDigest: digest,
  verificationDigests: sortedDigests(1, 50), preparedAt: time, containsDraftBody: z.literal(false), containsCredentials: z.literal(false),
  editoriallyAccepted: z.literal(true), requiresAuthoritativeCompletionResolution: z.literal(true), publicationAuthorized: z.literal(false), grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false), packageDigest: digest,
}).strict();
const packageInputSchema = packageSchema.omit({ contractVersion: true, containsDraftBody: true, containsCredentials: true,
  editoriallyAccepted: true, requiresAuthoritativeCompletionResolution: true, publicationAuthorized: true, grantsApproval: true,
  grantsExecutionAuthority: true, packageDigest: true });

const requestSchema = z.object({
  contractVersion: z.literal(ABS_NEWS_PUBLICATION_CONTRACT_V1), requestId: id, tenantId: id, workspaceId: id, projectId: id,
  jobId: id, attemptId: id, effectIntentId: id, packageId: id, packageDigest: digest,
  contentRevision: z.number().int().positive().max(1_000_000), contentDigest: digest, destinationId: id,
  destinationIdentityDigest: digest, destinationPath: z.string().min(4).max(200).regex(/^\/articles\/[a-z0-9]+(?:-[a-z0-9]+)*$/),
  operationDigest: digest, destinationIdempotencyKey: digest, requestedAt: time, expiresAt: time, risk: z.literal("high"),
  requiredFactor: z.literal("strong"), ownerApprovalRequired: z.literal(true), publicationAuthorized: z.literal(false),
  allowsCredentialResolution: z.literal(false), allowsNetwork: z.literal(false), allowsPublication: z.literal(false),
  grantsExecutionAuthority: z.literal(false), requestDigest: digest,
}).strict().superRefine((value, context) => {
  const lifetime = Date.parse(value.expiresAt) - Date.parse(value.requestedAt);
  if (lifetime <= 0 || lifetime > 15 * 60_000) context.addIssue({ code: "custom", message: "request lifetime invalid" });
});
const requestInputSchema = z.object({ package: z.unknown(), destination: z.unknown(), requestId: id, jobId: id, attemptId: id,
  effectIntentId: id, requestedAt: time, expiresAt: time }).strict();

const authorizationSchema = z.object({
  contractVersion: z.literal(ABS_NEWS_PUBLICATION_CONTRACT_V1), authorizationId: id, tenantId: id, workspaceId: id, projectId: id,
  requestId: id, requestDigest: digest, packageDigest: digest, destinationIdentityDigest: digest, operationDigest: digest,
  destinationIdempotencyKey: digest, approvalRequestId: id, approvalRequestDigest: digest, approvalDecisionId: id,
  approvalDecisionDigest: digest, authorizationMode: z.enum(["simulation", "owner_live"]), authorizedAt: time, expiresAt: time,
  destinationWriteAuthorized: z.boolean(), requiresAuthoritativeApprovalResolution: z.literal(true), requiresDurableClaim: z.literal(true),
  requiresPreEffectMarker: z.literal(true), requiresDestinationReceipt: z.literal(true), singleUse: z.literal(true),
  retryAfterAmbiguityAllowed: z.literal(false), grantsCommandAuthority: z.literal(false), grantsLeaseAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), authorizationDigest: digest,
}).strict().superRefine((value, context) => {
  if ((value.authorizationMode === "owner_live") !== value.destinationWriteAuthorized) {
    context.addIssue({ code: "custom", message: "only owner-live authorization may grant the bounded destination write" });
  }
});
const authorizationInputSchema = z.object({ request: z.unknown(), approvalRequest: z.unknown(), approvalDecision: z.unknown(),
  authorizationMode: z.enum(["simulation", "owner_live"]) }).strict();

const claimSchema = z.object({
  contractVersion: z.literal(ABS_NEWS_PUBLICATION_CONTRACT_V1), claimId: id, claimKey: digest, tenantId: id, workspaceId: id,
  projectId: id, requestId: id, requestDigest: digest, authorizationDigest: digest, operationDigest: digest,
  destinationIdempotencyKey: digest, state: z.enum(["claimed", "executing", "succeeded", "definite_failure", "ambiguous"]),
  markerDigest: digest.optional(), outcomeDigest: digest.optional(), version: z.number().int().positive(), claimedAt: time,
  updatedAt: time, effectiveDeadline: time, simulationOnly: z.literal(true), externalEffectOccurred: z.literal(false), claimDigest: digest,
}).strict().superRefine((value, context) => {
  const terminal = ["succeeded", "definite_failure", "ambiguous"].includes(value.state);
  if (value.state === "claimed" && (value.markerDigest || value.outcomeDigest)) context.addIssue({ code: "custom", message: "claimed state invalid" });
  if (value.state === "executing" && (!value.markerDigest || value.outcomeDigest)) context.addIssue({ code: "custom", message: "executing state invalid" });
  if (terminal && (!value.markerDigest || !value.outcomeDigest)) context.addIssue({ code: "custom", message: "terminal state invalid" });
  if (Date.parse(value.updatedAt) < Date.parse(value.claimedAt) || Date.parse(value.effectiveDeadline) <= Date.parse(value.claimedAt)) {
    context.addIssue({ code: "custom", message: "claim chronology invalid" });
  }
});

const markerSchema = z.object({
  contractVersion: z.literal(ABS_NEWS_PUBLICATION_CONTRACT_V1), markerId: id, claimKey: digest, claimDigest: digest,
  requestDigest: digest, authorizationDigest: digest, operationDigest: digest, destinationIdempotencyKey: digest,
  markedAt: time, simulationOnly: z.literal(true), externalEffectOccurred: z.literal(false), markerDigest: digest,
}).strict();

export const absNewsPublicationDestinationResultSchemaV1 = z.object({
  contractVersion: z.literal(ABS_NEWS_PUBLICATION_CONTRACT_V1), status: z.enum(["succeeded", "definite_failure"]), destinationId: id,
  destinationIdentityDigest: digest, destinationIdempotencyKey: digest, packageDigest: digest,
  contentRevision: z.number().int().positive().max(1_000_000), contentDigest: digest,
  destinationPath: z.string().min(4).max(200).regex(/^\/articles\/[a-z0-9]+(?:-[a-z0-9]+)*$/), receiptId: id.optional(),
  destinationRevisionDigest: digest.optional(), safeFailureCode: z.literal("rejected_before_mutation").optional(), observedAt: time,
  synthetic: z.literal(true), networkUsed: z.literal(false), publicMutationObserved: z.literal(false), credentialsResolved: z.literal(false),
  rawDraftBodyUsed: z.literal(false), resultDigest: digest,
}).strict().superRefine((value, context) => {
  const success = value.status === "succeeded";
  if (success !== Boolean(value.receiptId && value.destinationRevisionDigest) || success === Boolean(value.safeFailureCode)) {
    context.addIssue({ code: "custom", message: "destination result evidence invalid" });
  }
});

const cleanupSchema = z.object({
  contractVersion: z.literal(ABS_NEWS_PUBLICATION_CONTRACT_V1), cleanupId: id, claimKey: digest, requestDigest: digest,
  destinationHandlesClosed: z.literal(true), temporaryFilesCreated: z.literal(false), temporaryFilesRemaining: z.literal(false),
  credentialsResolved: z.literal(false), draftBodyRetained: z.literal(false), cleanedAt: time, simulationOnly: z.literal(true), cleanupDigest: digest,
}).strict();

const outcomeSchema = z.object({
  contractVersion: z.literal(ABS_NEWS_PUBLICATION_CONTRACT_V1), outcomeId: id, claimKey: digest, requestId: id, requestDigest: digest,
  authorizationDigest: digest, disposition: z.enum(["succeeded", "definite_failure", "ambiguous"]), destinationResultDigest: digest.optional(),
  destinationReceiptDigest: digest.optional(), safeReasonCode: z.enum(["synthetic_publication_complete", "definite_destination_failure",
    "post_marker_outcome_unknown", "restart_after_marker"]), startedAt: time, settledAt: time, cleanupDigest: digest,
  publicMutationObserved: z.literal(false), externalEffectOccurred: z.literal(false), simulationOnly: z.literal(true),
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false), outcomeDigest: digest,
}).strict().superRefine((value, context) => {
  if (Date.parse(value.settledAt) < Date.parse(value.startedAt)) context.addIssue({ code: "custom", message: "outcome chronology invalid" });
  if (value.disposition === "succeeded" && (value.safeReasonCode !== "synthetic_publication_complete"
    || !value.destinationResultDigest || !value.destinationReceiptDigest)) context.addIssue({ code: "custom", message: "success evidence invalid" });
  if (value.disposition === "definite_failure" && (value.safeReasonCode !== "definite_destination_failure"
    || !value.destinationResultDigest || value.destinationReceiptDigest)) context.addIssue({ code: "custom", message: "failure evidence invalid" });
  if (value.disposition === "ambiguous" && (!["post_marker_outcome_unknown", "restart_after_marker"].includes(value.safeReasonCode)
    || value.destinationReceiptDigest)) context.addIssue({ code: "custom", message: "ambiguity evidence invalid" });
});

export function buildAbsNewsPublicationDestinationV1(inputValue: unknown): AbsNewsPublicationDestinationV1 {
  const input = parseServer(destinationInputSchema, inputValue);
  const destinationIdentityDigest = sha256Digest({ destinationId: input.destinationId, tenantId: input.tenantId, workspaceId: input.workspaceId,
    projectId: input.projectId, destinationKind: input.destinationKind, environment: input.environment, publicOrigin: input.publicOrigin,
    routePrefix: "/articles/", adapterId: input.adapterId, adapterReleaseDigest: input.adapterReleaseDigest });
  const material: Omit<AbsNewsPublicationDestinationV1, "destinationDigest"> = { contractVersion: ABS_NEWS_PUBLICATION_CONTRACT_V1,
    ...input, routePrefix: "/articles/", supportsIdempotencyKey: true, exactRevisionRequired: true, publicationAuthorized: false,
    grantsApproval: false, grantsExecutionAuthority: false, destinationIdentityDigest };
  return parseServer(destinationSchema, { ...material, destinationDigest: sha256Digest(material) }) as AbsNewsPublicationDestinationV1;
}

export function parseAbsNewsPublicationDestinationV1(value: unknown): AbsNewsPublicationDestinationV1 {
  const parsed = parseServer(destinationSchema, value) as AbsNewsPublicationDestinationV1;
  exactDigest(parsed as unknown as Record<string, unknown>, "destinationDigest", parsed.destinationDigest);
  const expected = sha256Digest({ destinationId: parsed.destinationId, tenantId: parsed.tenantId, workspaceId: parsed.workspaceId,
    projectId: parsed.projectId, destinationKind: parsed.destinationKind, environment: parsed.environment, publicOrigin: parsed.publicOrigin,
    routePrefix: parsed.routePrefix, adapterId: parsed.adapterId, adapterReleaseDigest: parsed.adapterReleaseDigest });
  if (expected !== parsed.destinationIdentityDigest) throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  return parsed;
}

export function buildAbsNewsPublicationPackageV1(inputValue: unknown): AbsNewsPublicationPackageV1 {
  const input = parseServer(packageInputSchema, inputValue);
  const material: Omit<AbsNewsPublicationPackageV1, "packageDigest"> = { contractVersion: ABS_NEWS_PUBLICATION_CONTRACT_V1,
    ...input, sourceEvidenceDigests: [...input.sourceEvidenceDigests].sort(), verificationDigests: [...input.verificationDigests].sort(),
    containsDraftBody: false, containsCredentials: false, editoriallyAccepted: true, publicationAuthorized: false,
    requiresAuthoritativeCompletionResolution: true, grantsApproval: false, grantsExecutionAuthority: false };
  return parseAbsNewsPublicationPackageV1({ ...material, packageDigest: sha256Digest(material) });
}

export function parseAbsNewsPublicationPackageV1(value: unknown): AbsNewsPublicationPackageV1 {
  const parsed = parseServer(packageSchema, value) as AbsNewsPublicationPackageV1;
  exactDigest(parsed as unknown as Record<string, unknown>, "packageDigest", parsed.packageDigest);
  try { assertNoSecretMaterial(parsed, "ABS publication package"); }
  catch { throw new ProjectWorkspaceContractErrorV1("invalid_input"); }
  return parsed;
}

export function buildAbsNewsPublicationRequestV1(inputValue: unknown): AbsNewsPublicationRequestV1 {
  const input = parseServer(requestInputSchema, inputValue), publicationPackage = parseAbsNewsPublicationPackageV1(input.package),
    destination = parseAbsNewsPublicationDestinationV1(input.destination);
  if (publicationPackage.tenantId !== destination.tenantId || publicationPackage.workspaceId !== destination.workspaceId
    || publicationPackage.projectId !== destination.projectId) throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  const destinationPath = `${destination.routePrefix}${publicationPackage.slug}`;
  const operationDigest = sha256Digest({ operation: "abs.publish_article", tenantId: publicationPackage.tenantId,
    workspaceId: publicationPackage.workspaceId, projectId: publicationPackage.projectId, jobId: input.jobId, attemptId: input.attemptId,
    effectIntentId: input.effectIntentId, packageDigest: publicationPackage.packageDigest, contentRevision: publicationPackage.contentRevision,
    contentDigest: publicationPackage.contentDigest, destinationIdentityDigest: destination.destinationIdentityDigest, destinationPath });
  const destinationIdempotencyKey = sha256Digest({ destinationIdentityDigest: destination.destinationIdentityDigest,
    destinationPath, contentRevision: publicationPackage.contentRevision, contentDigest: publicationPackage.contentDigest });
  const material: Omit<AbsNewsPublicationRequestV1, "requestDigest"> = { contractVersion: ABS_NEWS_PUBLICATION_CONTRACT_V1,
    requestId: input.requestId, tenantId: publicationPackage.tenantId, workspaceId: publicationPackage.workspaceId,
    projectId: publicationPackage.projectId, jobId: input.jobId, attemptId: input.attemptId, effectIntentId: input.effectIntentId,
    packageId: publicationPackage.packageId, packageDigest: publicationPackage.packageDigest, contentRevision: publicationPackage.contentRevision,
    contentDigest: publicationPackage.contentDigest, destinationId: destination.destinationId,
    destinationIdentityDigest: destination.destinationIdentityDigest, destinationPath, operationDigest, destinationIdempotencyKey,
    requestedAt: input.requestedAt, expiresAt: input.expiresAt, risk: "high", requiredFactor: "strong", ownerApprovalRequired: true,
    publicationAuthorized: false, allowsCredentialResolution: false, allowsNetwork: false, allowsPublication: false,
    grantsExecutionAuthority: false };
  return parseServer(requestSchema, { ...material, requestDigest: sha256Digest(material) }) as AbsNewsPublicationRequestV1;
}

export function parseAbsNewsPublicationRequestV1(value: unknown): AbsNewsPublicationRequestV1 {
  const parsed = parseServer(requestSchema, value) as AbsNewsPublicationRequestV1;
  exactDigest(parsed as unknown as Record<string, unknown>, "requestDigest", parsed.requestDigest);
  const expectedOperation = sha256Digest({ operation: "abs.publish_article", tenantId: parsed.tenantId,
    workspaceId: parsed.workspaceId, projectId: parsed.projectId, jobId: parsed.jobId, attemptId: parsed.attemptId,
    effectIntentId: parsed.effectIntentId, packageDigest: parsed.packageDigest, contentRevision: parsed.contentRevision,
    contentDigest: parsed.contentDigest, destinationIdentityDigest: parsed.destinationIdentityDigest, destinationPath: parsed.destinationPath });
  if (parsed.operationDigest !== expectedOperation) throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  if (parsed.destinationIdempotencyKey !== sha256Digest({ destinationIdentityDigest: parsed.destinationIdentityDigest,
    destinationPath: parsed.destinationPath, contentRevision: parsed.contentRevision, contentDigest: parsed.contentDigest })) {
    throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  }
  return parsed;
}

export function buildAbsNewsPublicationApprovalRequestV1(requestValue: unknown): ConsequentialApprovalRequestV1 {
  const request = parseAbsNewsPublicationRequestV1(requestValue);
  return consequentialApprovalRequestSchemaV1.parse({ schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1,
    id: derivedId("approval-request:abs-publish", request.requestDigest), tenantId: request.tenantId, projectId: request.projectId,
    jobId: request.jobId, attemptId: request.attemptId, effectIntentId: request.effectIntentId, operationDigest: request.operationDigest,
    risk: "high", requestedBy: { actorId: "service:abs-publication", actorType: "service" }, requiredFactor: "strong",
    requestedAt: request.requestedAt, expiresAt: request.expiresAt, grantsExecutionAuthority: false }) as ConsequentialApprovalRequestV1;
}

export function buildAbsNewsPublicationAuthorizationV1(inputValue: unknown): AbsNewsPublicationAuthorizationV1 {
  const input = parseServer(authorizationInputSchema, inputValue), request = parseAbsNewsPublicationRequestV1(input.request);
  let approvalRequest: ConsequentialApprovalRequestV1, approvalDecision: ConsequentialApprovalDecisionV1;
  try {
    approvalRequest = consequentialApprovalRequestSchemaV1.parse(input.approvalRequest) as ConsequentialApprovalRequestV1;
    approvalDecision = consequentialApprovalDecisionSchemaV1.parse(input.approvalDecision) as ConsequentialApprovalDecisionV1;
  } catch { throw new ProjectWorkspaceContractErrorV1("invalid_input"); }
  if (approvalDecision.requestDigest !== sha256Digest(approvalRequest) || approvalDecision.requestId !== approvalRequest.id
    || approvalRequest.operationDigest !== request.operationDigest || approvalDecision.operationDigest !== request.operationDigest
    || approvalRequest.risk !== "high" || approvalDecision.decision !== "approved" || approvalDecision.factor !== "strong"
    || Date.parse(approvalDecision.decidedAt) < Date.parse(request.requestedAt)
    || Date.parse(approvalDecision.expiresAt) > Date.parse(request.expiresAt)
    || approvalRequest.tenantId !== request.tenantId || approvalRequest.projectId !== request.projectId
    || approvalRequest.jobId !== request.jobId || approvalRequest.attemptId !== request.attemptId
    || approvalRequest.effectIntentId !== request.effectIntentId) throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  if (input.authorizationMode === "simulation" && !approvalDecision.policyDecisionId.startsWith("policy:synthetic:")) {
    throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  }
  if (input.authorizationMode === "owner_live" && approvalDecision.policyDecisionId.startsWith("policy:synthetic:")) {
    throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  }
  const material: Omit<AbsNewsPublicationAuthorizationV1, "authorizationDigest"> = {
    contractVersion: ABS_NEWS_PUBLICATION_CONTRACT_V1,
    authorizationId: derivedId("authorization:abs-publish", { requestDigest: request.requestDigest, decision: sha256Digest(approvalDecision),
      authorizationMode: input.authorizationMode }), tenantId: request.tenantId, workspaceId: request.workspaceId, projectId: request.projectId,
    requestId: request.requestId, requestDigest: request.requestDigest, packageDigest: request.packageDigest,
    destinationIdentityDigest: request.destinationIdentityDigest, operationDigest: request.operationDigest,
    destinationIdempotencyKey: request.destinationIdempotencyKey, approvalRequestId: approvalRequest.id,
    approvalRequestDigest: sha256Digest(approvalRequest), approvalDecisionId: approvalDecision.id,
    approvalDecisionDigest: sha256Digest(approvalDecision), authorizationMode: input.authorizationMode,
    authorizedAt: approvalDecision.decidedAt, expiresAt: approvalDecision.expiresAt,
    destinationWriteAuthorized: input.authorizationMode === "owner_live", requiresAuthoritativeApprovalResolution: true,
    requiresDurableClaim: true, requiresPreEffectMarker: true, requiresDestinationReceipt: true, singleUse: true,
    retryAfterAmbiguityAllowed: false, grantsCommandAuthority: false, grantsLeaseAuthority: false, grantsExecutionAuthority: false,
  };
  return parseServer(authorizationSchema, { ...material, authorizationDigest: sha256Digest(material) }) as AbsNewsPublicationAuthorizationV1;
}

export function parseAbsNewsPublicationAuthorizationV1(value: unknown): AbsNewsPublicationAuthorizationV1 {
  const parsed = parseServer(authorizationSchema, value) as AbsNewsPublicationAuthorizationV1;
  exactDigest(parsed as unknown as Record<string, unknown>, "authorizationDigest", parsed.authorizationDigest);
  return parsed;
}

export function buildAbsNewsPublicationClaimV1(input: { request: unknown; authorization: unknown; claimedAt: string }): AbsNewsPublicationClaimV1 {
  const request = parseAbsNewsPublicationRequestV1(input.request), authorization = parseAbsNewsPublicationAuthorizationV1(input.authorization);
  if (authorization.requestDigest !== request.requestDigest || authorization.authorizationMode !== "simulation"
    || authorization.destinationWriteAuthorized || Date.parse(input.claimedAt) < Date.parse(authorization.authorizedAt)
    || Date.parse(input.claimedAt) >= Date.parse(authorization.expiresAt)) throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  const claimKey = sha256Digest({ operationDigest: request.operationDigest, destinationIdempotencyKey: request.destinationIdempotencyKey });
  const material: Omit<AbsNewsPublicationClaimV1, "claimDigest"> = { contractVersion: ABS_NEWS_PUBLICATION_CONTRACT_V1,
    claimId: derivedId("claim:abs-publish", claimKey), claimKey, tenantId: request.tenantId, workspaceId: request.workspaceId,
    projectId: request.projectId, requestId: request.requestId, requestDigest: request.requestDigest,
    authorizationDigest: authorization.authorizationDigest, operationDigest: request.operationDigest,
    destinationIdempotencyKey: request.destinationIdempotencyKey, state: "claimed", version: 1, claimedAt: input.claimedAt,
    updatedAt: input.claimedAt, effectiveDeadline: authorization.expiresAt, simulationOnly: true, externalEffectOccurred: false };
  return parseServer(claimSchema, { ...material, claimDigest: sha256Digest(material) }) as AbsNewsPublicationClaimV1;
}

export function parseAbsNewsPublicationClaimV1(value: unknown): AbsNewsPublicationClaimV1 {
  const parsed = parseServer(claimSchema, value) as AbsNewsPublicationClaimV1;
  exactDigest(parsed as unknown as Record<string, unknown>, "claimDigest", parsed.claimDigest);
  return parsed;
}

export function transitionAbsNewsPublicationClaimV1(input: { claim: unknown; toState: "executing" | "succeeded" | "definite_failure" | "ambiguous";
  updatedAt: string; markerDigest?: string; outcomeDigest?: string }): AbsNewsPublicationClaimV1 {
  const claim = parseAbsNewsPublicationClaimV1(input.claim);
  const allowed = (claim.state === "claimed" && input.toState === "executing")
    || (claim.state === "executing" && ["succeeded", "definite_failure", "ambiguous"].includes(input.toState));
  if (!allowed || Date.parse(input.updatedAt) < Date.parse(claim.updatedAt)
    || (input.toState === "executing" && Date.parse(input.updatedAt) >= Date.parse(claim.effectiveDeadline))
    || (input.toState === "executing" && !input.markerDigest) || (input.toState !== "executing" && !input.outcomeDigest)) {
    throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  }
  const { claimDigest: _digest, ...base } = claim;
  void _digest;
  const material: Omit<AbsNewsPublicationClaimV1, "claimDigest"> = { ...base, state: input.toState, version: claim.version + 1,
    updatedAt: input.updatedAt, ...(input.markerDigest ? { markerDigest: input.markerDigest } : {}),
    ...(input.outcomeDigest ? { outcomeDigest: input.outcomeDigest } : {}) };
  return parseServer(claimSchema, { ...material, claimDigest: sha256Digest(material) }) as AbsNewsPublicationClaimV1;
}

export function buildAbsNewsPublicationMarkerV1(input: { claim: unknown; markedAt: string }): AbsNewsPublicationMarkerV1 {
  const claim = parseAbsNewsPublicationClaimV1(input.claim);
  if (claim.state !== "claimed" || Date.parse(input.markedAt) < Date.parse(claim.claimedAt)
    || Date.parse(input.markedAt) >= Date.parse(claim.effectiveDeadline)) throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  const material: Omit<AbsNewsPublicationMarkerV1, "markerDigest"> = { contractVersion: ABS_NEWS_PUBLICATION_CONTRACT_V1,
    markerId: derivedId("marker:abs-publish", claim.claimKey), claimKey: claim.claimKey, claimDigest: claim.claimDigest,
    requestDigest: claim.requestDigest, authorizationDigest: claim.authorizationDigest, operationDigest: claim.operationDigest,
    destinationIdempotencyKey: claim.destinationIdempotencyKey, markedAt: input.markedAt, simulationOnly: true, externalEffectOccurred: false };
  return parseServer(markerSchema, { ...material, markerDigest: sha256Digest(material) }) as AbsNewsPublicationMarkerV1;
}

export function parseAbsNewsPublicationMarkerV1(value: unknown): AbsNewsPublicationMarkerV1 {
  const parsed = parseServer(markerSchema, value) as AbsNewsPublicationMarkerV1;
  exactDigest(parsed as unknown as Record<string, unknown>, "markerDigest", parsed.markerDigest);
  return parsed;
}

export function buildAbsNewsPublicationDestinationResultV1(inputValue: unknown): AbsNewsPublicationDestinationResultV1 {
  const snapshot = parseServer(absNewsPublicationDestinationResultSchemaV1.omit({ contractVersion: true, resultDigest: true }), inputValue);
  const material = { contractVersion: ABS_NEWS_PUBLICATION_CONTRACT_V1, ...snapshot };
  return parseServer(absNewsPublicationDestinationResultSchemaV1, { ...material, resultDigest: sha256Digest(material) }) as AbsNewsPublicationDestinationResultV1;
}

export function parseAbsNewsPublicationDestinationResultV1(value: unknown): AbsNewsPublicationDestinationResultV1 {
  const parsed = parseServer(absNewsPublicationDestinationResultSchemaV1, value) as AbsNewsPublicationDestinationResultV1;
  exactDigest(parsed as unknown as Record<string, unknown>, "resultDigest", parsed.resultDigest);
  return parsed;
}

export function buildAbsNewsPublicationCleanupReceiptV1(input: { claimKey: string; requestDigest: string; cleanedAt: string }): AbsNewsPublicationCleanupReceiptV1 {
  const material: Omit<AbsNewsPublicationCleanupReceiptV1, "cleanupDigest"> = { contractVersion: ABS_NEWS_PUBLICATION_CONTRACT_V1,
    cleanupId: derivedId("cleanup:abs-publish", { claimKey: input.claimKey, requestDigest: input.requestDigest }), claimKey: input.claimKey,
    requestDigest: input.requestDigest, destinationHandlesClosed: true, temporaryFilesCreated: false, temporaryFilesRemaining: false,
    credentialsResolved: false, draftBodyRetained: false, cleanedAt: input.cleanedAt, simulationOnly: true };
  return parseServer(cleanupSchema, { ...material, cleanupDigest: sha256Digest(material) }) as AbsNewsPublicationCleanupReceiptV1;
}

export function parseAbsNewsPublicationCleanupReceiptV1(value: unknown): AbsNewsPublicationCleanupReceiptV1 {
  const parsed = parseServer(cleanupSchema, value) as AbsNewsPublicationCleanupReceiptV1;
  exactDigest(parsed as unknown as Record<string, unknown>, "cleanupDigest", parsed.cleanupDigest);
  return parsed;
}

export function buildAbsNewsPublicationOutcomeV1(input: { claim: unknown; authorization: unknown;
  disposition: AbsNewsPublicationOutcomeV1["disposition"]; destinationResultDigest?: string; destinationReceiptDigest?: string;
  safeReasonCode: AbsNewsPublicationOutcomeV1["safeReasonCode"]; startedAt: string; settledAt: string; cleanup: unknown }): AbsNewsPublicationOutcomeV1 {
  const claim = parseAbsNewsPublicationClaimV1(input.claim), authorization = parseAbsNewsPublicationAuthorizationV1(input.authorization),
    cleanup = parseAbsNewsPublicationCleanupReceiptV1(input.cleanup);
  if (claim.authorizationDigest !== authorization.authorizationDigest || cleanup.claimKey !== claim.claimKey
    || cleanup.requestDigest !== claim.requestDigest || Date.parse(input.settledAt) < Date.parse(input.startedAt)
    || Date.parse(cleanup.cleanedAt) < Date.parse(input.startedAt)) throw new ProjectWorkspaceContractErrorV1("replay_drift");
  const material: Omit<AbsNewsPublicationOutcomeV1, "outcomeDigest"> = { contractVersion: ABS_NEWS_PUBLICATION_CONTRACT_V1,
    outcomeId: derivedId("outcome:abs-publish", claim.claimKey), claimKey: claim.claimKey, requestId: claim.requestId,
    requestDigest: claim.requestDigest, authorizationDigest: claim.authorizationDigest, disposition: input.disposition,
    ...(input.destinationResultDigest ? { destinationResultDigest: input.destinationResultDigest } : {}),
    ...(input.destinationReceiptDigest ? { destinationReceiptDigest: input.destinationReceiptDigest } : {}),
    safeReasonCode: input.safeReasonCode, startedAt: input.startedAt, settledAt: input.settledAt, cleanupDigest: cleanup.cleanupDigest,
    publicMutationObserved: false, externalEffectOccurred: false, simulationOnly: true, grantsApproval: false, grantsExecutionAuthority: false };
  return parseServer(outcomeSchema, { ...material, outcomeDigest: sha256Digest(material) }) as AbsNewsPublicationOutcomeV1;
}

export function parseAbsNewsPublicationOutcomeV1(value: unknown): AbsNewsPublicationOutcomeV1 {
  const parsed = parseServer(outcomeSchema, value) as AbsNewsPublicationOutcomeV1;
  exactDigest(parsed as unknown as Record<string, unknown>, "outcomeDigest", parsed.outcomeDigest);
  return parsed;
}

export const absNewsPublicationSchemasV1 = { destination: destinationSchema, package: packageSchema, request: requestSchema,
  authorization: authorizationSchema, claim: claimSchema, marker: markerSchema, cleanup: cleanupSchema, outcome: outcomeSchema } as const;
