import { z } from "zod";
import {
  COMPLETION_GATE_SCHEMA_VERSION_V1,
  consequentialApprovalDecisionSchemaV1,
  consequentialApprovalRequestSchemaV1,
  type ConsequentialApprovalDecisionV1,
  type ConsequentialApprovalRequestV1,
} from "../../../completion-gate/v1";
import { assertNoSecretMaterial, sha256Digest } from "../../../security";
import { exactProjectWorkspaceJsonV1, ProjectWorkspaceContractErrorV1 } from "../../../project-workspace/v1";
import { absNewsFakeCollectionBatchSchemaV1 } from "./schemas";
import type { AbsNewsFakeCollectionBatchV1 } from "./types";

export const ABS_NEWS_LIVE_READ_CONTRACT_V1 = "control-room-abs-news-live-read/v1" as const;
const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const time = z.string().datetime({ offset: true });

function publicEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname;
    return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash
      && url.href === value && host === host.toLowerCase() && host.includes(".")
      && host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".local") && !host.endsWith(".internal")
      && !/^\d+(?:\.\d+){3}$/.test(host) && !host.includes(":");
  } catch { return false; }
}
const endpointUrl = z.string().min(12).max(2_000).refine(publicEndpoint, "endpoint must be exact public HTTPS");

function parseServer<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    const parsed = schema.parse(exactProjectWorkspaceJsonV1(value));
    assertNoSecretMaterial(parsed, "ABS live-read record");
    return parsed;
  } catch (error) {
    if (error instanceof ProjectWorkspaceContractErrorV1) throw error;
    throw new ProjectWorkspaceContractErrorV1("invalid_input");
  }
}
function without(value: Record<string, unknown>, field: string): Record<string, unknown> { const copy = { ...value }; delete copy[field]; return copy; }
function exactDigest(value: Record<string, unknown>, field: string, expected: string): void { if (sha256Digest(without(value, field)) !== expected) throw new ProjectWorkspaceContractErrorV1("digest_mismatch"); }
function derivedId(prefix: string, value: unknown): string { return `${prefix}:${sha256Digest(value).slice(7, 39)}`; }

export interface AbsNewsLiveReadSourceV1 {
  sourceId: string;
  sourceKind: "rss" | "sitemap";
  sourceLabel: string;
  endpointUrl: string;
  endpointOrigin: string;
  endpointHost: string;
  endpointPath: string;
  publicUnauthenticated: true;
  redirectPolicy: "deny";
  dnsPolicy: "resolve_and_revalidate_public";
  tlsPolicy: "system_trust_exact_host";
  allowsCookies: false;
  allowsAuthorizationHeader: false;
  sourceDigest: string;
}

export interface AbsNewsLiveReadRequestV1 {
  contractVersion: typeof ABS_NEWS_LIVE_READ_CONTRACT_V1;
  requestId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  effectIntentId: string;
  sources: AbsNewsLiveReadSourceV1[];
  sourceSetDigest: string;
  maxSources: number;
  maxItemsPerSource: number;
  maxResponseBytes: number;
  maxTotalBytes: number;
  maxRuntimeSeconds: number;
  maxCostUsd: 0;
  credentialReferenceDigests: [];
  allowedContentTypes: ("application/rss+xml" | "application/atom+xml" | "application/xml" | "text/xml")[];
  requestedAt: string;
  expiresAt: string;
  risk: "medium";
  requiredFactor: "strong";
  operationDigest: string;
  idempotencyKey: string;
  ownerApprovalRequired: true;
  liveReadAuthorized: false;
  retainsRawBody: false;
  allowsRedirects: false;
  allowsCookies: false;
  allowsAuthentication: false;
  allowsProviderCalls: false;
  allowsModelSpend: false;
  allowsPublication: false;
  grantsExecutionAuthority: false;
  requestDigest: string;
}

export interface AbsNewsLiveReadAuthorizationV1 {
  contractVersion: typeof ABS_NEWS_LIVE_READ_CONTRACT_V1;
  authorizationId: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  requestId: string;
  requestDigest: string;
  sourceSetDigest: string;
  operationDigest: string;
  approvalRequestId: string;
  approvalRequestDigest: string;
  approvalDecisionId: string;
  approvalDecisionDigest: string;
  authorizationMode: "simulation" | "owner_live";
  authorizedAt: string;
  expiresAt: string;
  networkReadAuthorized: boolean;
  requiresAuthoritativeApprovalResolution: true;
  requiresDurableClaim: true;
  requiresPreReadMarker: true;
  singleUse: true;
  retryAfterAmbiguityAllowed: false;
  grantsCommandAuthority: false;
  grantsLeaseAuthority: false;
  grantsExecutionAuthority: false;
  grantsPublicationAuthority: false;
  authorizationDigest: string;
}

export interface AbsNewsLiveReadTransportResultV1 {
  status: "succeeded" | "definite_failure";
  sourceId: string;
  sourceDigest: string;
  requestedUrl: string;
  finalUrl: string;
  responseStatus?: 200;
  contentType?: "application/rss+xml" | "application/atom+xml" | "application/xml" | "text/xml";
  responseByteCount: number;
  responseBodyDigest?: string;
  batch?: AbsNewsFakeCollectionBatchV1;
  safeFailureCode?: "connection_refused_before_response" | "timeout_before_request" | "invalid_tls_before_request";
  observedAt: string;
  synthetic: true;
  networkUsed: false;
  redirectsFollowed: 0;
  cookiesSent: false;
  authorizationHeaderSent: false;
  credentialsResolved: false;
  rawBodyReturned: false;
  retainsRawBody: false;
  resultDigest: string;
}

export interface AbsNewsLiveReadClaimV1 {
  contractVersion: typeof ABS_NEWS_LIVE_READ_CONTRACT_V1;
  claimId: string;
  claimKey: string;
  tenantId: string;
  workspaceId: string;
  projectId: string;
  requestId: string;
  requestDigest: string;
  authorizationDigest: string;
  operationDigest: string;
  state: "claimed" | "executing" | "succeeded" | "definite_failure" | "ambiguous";
  markerDigest?: string;
  outcomeDigest?: string;
  version: number;
  claimedAt: string;
  updatedAt: string;
  effectiveDeadline: string;
  simulationOnly: true;
  networkUsed: false;
  claimDigest: string;
}

export interface AbsNewsLiveReadMarkerV1 {
  contractVersion: typeof ABS_NEWS_LIVE_READ_CONTRACT_V1;
  markerId: string;
  claimKey: string;
  claimDigest: string;
  requestDigest: string;
  authorizationDigest: string;
  operationDigest: string;
  markedAt: string;
  simulationOnly: true;
  networkUsed: false;
  markerDigest: string;
}

export interface AbsNewsLiveReadCleanupReceiptV1 {
  contractVersion: typeof ABS_NEWS_LIVE_READ_CONTRACT_V1;
  cleanupId: string;
  claimKey: string;
  requestDigest: string;
  transportHandlesClosed: true;
  temporaryFilesCreated: false;
  temporaryFilesRemaining: false;
  credentialsResolved: false;
  rawBodyRetained: false;
  cookiesRetained: false;
  cleanedAt: string;
  simulationOnly: true;
  cleanupDigest: string;
}

export interface AbsNewsLiveReadOutcomeV1 {
  contractVersion: typeof ABS_NEWS_LIVE_READ_CONTRACT_V1;
  outcomeId: string;
  claimKey: string;
  requestId: string;
  requestDigest: string;
  authorizationDigest: string;
  disposition: "succeeded" | "definite_failure" | "ambiguous";
  sourceResultDigests: string[];
  batchDigests: string[];
  itemCount: number;
  totalResponseBytes: number;
  safeReasonCode: "synthetic_read_complete" | "definite_transport_failure" | "post_marker_outcome_unknown" | "restart_after_marker";
  startedAt: string;
  settledAt: string;
  cleanupDigest: string;
  createsWorkItem: false;
  retainsRawBody: false;
  networkUsed: false;
  simulationOnly: true;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  outcomeDigest: string;
}

const sourceSchema = z.object({
  sourceId: id, sourceKind: z.enum(["rss", "sitemap"]), sourceLabel: z.string().min(1).max(120), endpointUrl,
  endpointOrigin: z.string().url(), endpointHost: z.string().min(3).max(253), endpointPath: z.string().min(1).max(1_024),
  publicUnauthenticated: z.literal(true), redirectPolicy: z.literal("deny"), dnsPolicy: z.literal("resolve_and_revalidate_public"),
  tlsPolicy: z.literal("system_trust_exact_host"), allowsCookies: z.literal(false), allowsAuthorizationHeader: z.literal(false), sourceDigest: digest,
}).strict().superRefine((value, context) => {
  const url = new URL(value.endpointUrl);
  if (url.origin !== value.endpointOrigin || url.hostname !== value.endpointHost || url.pathname !== value.endpointPath) context.addIssue({ code: "custom", message: "endpoint identity fields must match URL" });
});
const sourceInputSchema = sourceSchema.omit({ endpointOrigin: true, endpointHost: true, endpointPath: true, publicUnauthenticated: true, redirectPolicy: true, dnsPolicy: true, tlsPolicy: true, allowsCookies: true, allowsAuthorizationHeader: true, sourceDigest: true });
const contentType = z.enum(["application/rss+xml", "application/atom+xml", "application/xml", "text/xml"]);
const requestSchema = z.object({
  contractVersion: z.literal(ABS_NEWS_LIVE_READ_CONTRACT_V1), requestId: id, tenantId: id, workspaceId: id, projectId: id,
  jobId: id, attemptId: id, effectIntentId: id, sources: z.array(sourceSchema).min(1).max(5), sourceSetDigest: digest,
  maxSources: z.number().int().min(1).max(5), maxItemsPerSource: z.number().int().min(1).max(100),
  maxResponseBytes: z.number().int().min(1_024).max(2_000_000), maxTotalBytes: z.number().int().min(1_024).max(5_000_000),
  maxRuntimeSeconds: z.number().int().min(1).max(60), maxCostUsd: z.literal(0), credentialReferenceDigests: z.tuple([]),
  allowedContentTypes: z.array(contentType).min(1).max(4), requestedAt: time, expiresAt: time, risk: z.literal("medium"),
  requiredFactor: z.literal("strong"), operationDigest: digest, idempotencyKey: digest, ownerApprovalRequired: z.literal(true),
  liveReadAuthorized: z.literal(false), retainsRawBody: z.literal(false), allowsRedirects: z.literal(false), allowsCookies: z.literal(false),
  allowsAuthentication: z.literal(false), allowsProviderCalls: z.literal(false), allowsModelSpend: z.literal(false), allowsPublication: z.literal(false),
  grantsExecutionAuthority: z.literal(false), requestDigest: digest,
}).strict().superRefine((value, context) => {
  if (value.sources.length > value.maxSources || value.maxTotalBytes < value.maxResponseBytes || new Set(value.sources.map((source) => source.sourceId)).size !== value.sources.length || new Set(value.sources.map((source) => source.endpointUrl)).size !== value.sources.length) context.addIssue({ code: "custom", message: "source and byte limits invalid" });
  if (value.sources.map((source)=>source.sourceId).join("|") !== [...value.sources].sort((left,right)=>left.sourceId.localeCompare(right.sourceId)).map((source)=>source.sourceId).join("|")) context.addIssue({ code:"custom", message:"sources must be in canonical identifier order" });
  if (value.allowedContentTypes.join("|") !== [...value.allowedContentTypes].sort().join("|") || new Set(value.allowedContentTypes).size !== value.allowedContentTypes.length) context.addIssue({ code: "custom", message: "content types must be unique and sorted" });
});
const requestInputSchema = z.object({
  requestId: id, tenantId: id, workspaceId: id, projectId: id, jobId: id, attemptId: id, effectIntentId: id,
  sources: z.array(sourceInputSchema).min(1).max(5), maxItemsPerSource: z.number().int().min(1).max(100),
  maxResponseBytes: z.number().int().min(1_024).max(2_000_000), maxTotalBytes: z.number().int().min(1_024).max(5_000_000),
  maxRuntimeSeconds: z.number().int().min(1).max(60), allowedContentTypes: z.array(contentType).min(1).max(4), requestedAt: time, expiresAt: time,
}).strict();
const authorizationSchema = z.object({
  contractVersion: z.literal(ABS_NEWS_LIVE_READ_CONTRACT_V1), authorizationId: id, tenantId: id, workspaceId: id, projectId: id,
  requestId: id, requestDigest: digest, sourceSetDigest: digest, operationDigest: digest, approvalRequestId: id, approvalRequestDigest: digest,
  approvalDecisionId: id, approvalDecisionDigest: digest, authorizationMode: z.enum(["simulation", "owner_live"]), authorizedAt: time,
  expiresAt: time, networkReadAuthorized: z.boolean(), requiresAuthoritativeApprovalResolution: z.literal(true), requiresDurableClaim: z.literal(true),
  requiresPreReadMarker: z.literal(true), singleUse: z.literal(true), retryAfterAmbiguityAllowed: z.literal(false), grantsCommandAuthority: z.literal(false),
  grantsLeaseAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), grantsPublicationAuthority: z.literal(false), authorizationDigest: digest,
}).strict().superRefine((value, context) => { if ((value.authorizationMode === "owner_live") !== value.networkReadAuthorized) context.addIssue({ code: "custom", message: "only owner-live authorization may grant the bounded read" }); });
const authorizationInputSchema = z.object({ request: z.unknown(), approvalRequest: z.unknown(), approvalDecision: z.unknown(), authorizationMode: z.enum(["simulation", "owner_live"]) }).strict();
export const absNewsLiveReadTransportResultSchemaV1 = z.object({
  status: z.enum(["succeeded", "definite_failure"]), sourceId: id, sourceDigest: digest, requestedUrl: endpointUrl, finalUrl: endpointUrl,
  responseStatus: z.literal(200).optional(), contentType: contentType.optional(), responseByteCount: z.number().int().min(0).max(5_000_000),
  responseBodyDigest: digest.optional(), batch: absNewsFakeCollectionBatchSchemaV1.optional(), safeFailureCode: z.enum(["connection_refused_before_response", "timeout_before_request", "invalid_tls_before_request"]).optional(),
  observedAt: time, synthetic: z.literal(true), networkUsed: z.literal(false), redirectsFollowed: z.literal(0), cookiesSent: z.literal(false),
  authorizationHeaderSent: z.literal(false), credentialsResolved: z.literal(false), rawBodyReturned: z.literal(false), retainsRawBody: z.literal(false), resultDigest: digest,
}).strict().superRefine((value, context) => {
  const success = value.status === "succeeded";
  if (success && (!value.responseStatus || !value.contentType || !value.responseBodyDigest || !value.batch || value.safeFailureCode)) context.addIssue({ code: "custom", message: "successful result evidence incomplete" });
  if (!success && (value.responseStatus || value.contentType || value.responseBodyDigest || value.batch || !value.safeFailureCode || value.responseByteCount !== 0)) context.addIssue({ code: "custom", message: "definite failure cannot claim a response" });
});
const claimSchema = z.object({ contractVersion:z.literal(ABS_NEWS_LIVE_READ_CONTRACT_V1),claimId:id,claimKey:digest,tenantId:id,workspaceId:id,projectId:id,requestId:id,requestDigest:digest,authorizationDigest:digest,operationDigest:digest,state:z.enum(["claimed","executing","succeeded","definite_failure","ambiguous"]),markerDigest:digest.optional(),outcomeDigest:digest.optional(),version:z.number().int().positive(),claimedAt:time,updatedAt:time,effectiveDeadline:time,simulationOnly:z.literal(true),networkUsed:z.literal(false),claimDigest:digest }).strict().superRefine((value,context)=>{const terminal=["succeeded","definite_failure","ambiguous"].includes(value.state);if(value.state==="claimed"&&(value.markerDigest||value.outcomeDigest))context.addIssue({code:"custom",message:"claimed state forbids marker and outcome"});if(value.state==="executing"&&(!value.markerDigest||value.outcomeDigest))context.addIssue({code:"custom",message:"executing state requires marker only"});if(terminal&&(!value.markerDigest||!value.outcomeDigest))context.addIssue({code:"custom",message:"terminal state requires marker and outcome"});if(Date.parse(value.updatedAt)<Date.parse(value.claimedAt)||Date.parse(value.effectiveDeadline)<=Date.parse(value.claimedAt))context.addIssue({code:"custom",message:"claim chronology invalid"});});
const markerSchema = z.object({ contractVersion:z.literal(ABS_NEWS_LIVE_READ_CONTRACT_V1),markerId:id,claimKey:digest,claimDigest:digest,requestDigest:digest,authorizationDigest:digest,operationDigest:digest,markedAt:time,simulationOnly:z.literal(true),networkUsed:z.literal(false),markerDigest:digest }).strict();
const cleanupSchema = z.object({ contractVersion:z.literal(ABS_NEWS_LIVE_READ_CONTRACT_V1),cleanupId:id,claimKey:digest,requestDigest:digest,transportHandlesClosed:z.literal(true),temporaryFilesCreated:z.literal(false),temporaryFilesRemaining:z.literal(false),credentialsResolved:z.literal(false),rawBodyRetained:z.literal(false),cookiesRetained:z.literal(false),cleanedAt:time,simulationOnly:z.literal(true),cleanupDigest:digest }).strict();
const outcomeSchema = z.object({ contractVersion:z.literal(ABS_NEWS_LIVE_READ_CONTRACT_V1),outcomeId:id,claimKey:digest,requestId:id,requestDigest:digest,authorizationDigest:digest,disposition:z.enum(["succeeded","definite_failure","ambiguous"]),sourceResultDigests:z.array(digest).max(5),batchDigests:z.array(digest).max(5),itemCount:z.number().int().min(0).max(500),totalResponseBytes:z.number().int().min(0).max(5_000_000),safeReasonCode:z.enum(["synthetic_read_complete","definite_transport_failure","post_marker_outcome_unknown","restart_after_marker"]),startedAt:time,settledAt:time,cleanupDigest:digest,createsWorkItem:z.literal(false),retainsRawBody:z.literal(false),networkUsed:z.literal(false),simulationOnly:z.literal(true),grantsApproval:z.literal(false),grantsExecutionAuthority:z.literal(false),outcomeDigest:digest }).strict().superRefine((value,context)=>{if(Date.parse(value.settledAt)<Date.parse(value.startedAt))context.addIssue({code:"custom",message:"outcome chronology invalid"});if(new Set(value.sourceResultDigests).size!==value.sourceResultDigests.length||value.sourceResultDigests.join("|")!==[...value.sourceResultDigests].sort().join("|")||new Set(value.batchDigests).size!==value.batchDigests.length||value.batchDigests.join("|")!==[...value.batchDigests].sort().join("|"))context.addIssue({code:"custom",message:"outcome digests must be unique and sorted"});if(value.disposition==="succeeded"&&(value.safeReasonCode!=="synthetic_read_complete"||value.sourceResultDigests.length===0||value.batchDigests.length===0))context.addIssue({code:"custom",message:"success evidence invalid"});if(value.disposition==="definite_failure"&&(value.safeReasonCode!=="definite_transport_failure"||value.sourceResultDigests.length===0))context.addIssue({code:"custom",message:"failure evidence invalid"});if(value.disposition==="ambiguous"&&!(["post_marker_outcome_unknown","restart_after_marker"] as string[]).includes(value.safeReasonCode))context.addIssue({code:"custom",message:"ambiguity reason invalid"});});

export function buildAbsNewsLiveReadSourceV1(inputValue: unknown): AbsNewsLiveReadSourceV1 {
  const input = parseServer(sourceInputSchema, inputValue), url = new URL(input.endpointUrl);
  const material: Omit<AbsNewsLiveReadSourceV1,"sourceDigest"> = { ...input, endpointOrigin:url.origin, endpointHost:url.hostname, endpointPath:url.pathname, publicUnauthenticated:true, redirectPolicy:"deny", dnsPolicy:"resolve_and_revalidate_public", tlsPolicy:"system_trust_exact_host", allowsCookies:false, allowsAuthorizationHeader:false };
  return parseServer(sourceSchema,{...material,sourceDigest:sha256Digest(material)}) as AbsNewsLiveReadSourceV1;
}
export function parseAbsNewsLiveReadSourceV1(value: unknown): AbsNewsLiveReadSourceV1 { const parsed=parseServer(sourceSchema,value) as AbsNewsLiveReadSourceV1; exactDigest(parsed as unknown as Record<string,unknown>,"sourceDigest",parsed.sourceDigest); return parsed; }

export function buildAbsNewsLiveReadRequestV1(inputValue: unknown): AbsNewsLiveReadRequestV1 {
  const input=parseServer(requestInputSchema,inputValue), sources=input.sources.map(buildAbsNewsLiveReadSourceV1).sort((a,b)=>a.sourceId.localeCompare(b.sourceId));
  if (Date.parse(input.expiresAt)<=Date.parse(input.requestedAt)||Date.parse(input.expiresAt)-Date.parse(input.requestedAt)>15*60_000) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  const sourceSetDigest=sha256Digest(sources.map((source)=>source.sourceDigest));
  const core={tenantId:input.tenantId,workspaceId:input.workspaceId,projectId:input.projectId,jobId:input.jobId,attemptId:input.attemptId,effectIntentId:input.effectIntentId,sourceSetDigest,maxSources:sources.length,maxItemsPerSource:input.maxItemsPerSource,maxResponseBytes:input.maxResponseBytes,maxTotalBytes:input.maxTotalBytes,maxRuntimeSeconds:input.maxRuntimeSeconds,maxCostUsd:0 as const,credentialReferenceDigests:[] as [],allowedContentTypes:[...input.allowedContentTypes].sort(),requestedAt:input.requestedAt,expiresAt:input.expiresAt,risk:"medium" as const,requiredFactor:"strong" as const};
  const operationDigest=sha256Digest({operation:"abs.live_read",...core}), idempotencyKey=sha256Digest({operationDigest});
  const material:Omit<AbsNewsLiveReadRequestV1,"requestDigest">={contractVersion:ABS_NEWS_LIVE_READ_CONTRACT_V1,requestId:input.requestId,...core,sources,operationDigest,idempotencyKey,ownerApprovalRequired:true,liveReadAuthorized:false,retainsRawBody:false,allowsRedirects:false,allowsCookies:false,allowsAuthentication:false,allowsProviderCalls:false,allowsModelSpend:false,allowsPublication:false,grantsExecutionAuthority:false};
  return parseServer(requestSchema,{...material,requestDigest:sha256Digest(material)}) as AbsNewsLiveReadRequestV1;
}
export function parseAbsNewsLiveReadRequestV1(value:unknown):AbsNewsLiveReadRequestV1{const parsed=parseServer(requestSchema,value) as AbsNewsLiveReadRequestV1;exactDigest(parsed as unknown as Record<string,unknown>,"requestDigest",parsed.requestDigest);if(parsed.sourceSetDigest!==sha256Digest(parsed.sources.map((source)=>parseAbsNewsLiveReadSourceV1(source).sourceDigest))||parsed.operationDigest!==sha256Digest({operation:"abs.live_read",tenantId:parsed.tenantId,workspaceId:parsed.workspaceId,projectId:parsed.projectId,jobId:parsed.jobId,attemptId:parsed.attemptId,effectIntentId:parsed.effectIntentId,sourceSetDigest:parsed.sourceSetDigest,maxSources:parsed.maxSources,maxItemsPerSource:parsed.maxItemsPerSource,maxResponseBytes:parsed.maxResponseBytes,maxTotalBytes:parsed.maxTotalBytes,maxRuntimeSeconds:parsed.maxRuntimeSeconds,maxCostUsd:0,credentialReferenceDigests:[],allowedContentTypes:parsed.allowedContentTypes,requestedAt:parsed.requestedAt,expiresAt:parsed.expiresAt,risk:"medium",requiredFactor:"strong"})||parsed.idempotencyKey!==sha256Digest({operationDigest:parsed.operationDigest}))throw new ProjectWorkspaceContractErrorV1("digest_mismatch");return parsed;}

export function buildAbsNewsLiveReadApprovalRequestV1(requestValue:unknown):ConsequentialApprovalRequestV1{const request=parseAbsNewsLiveReadRequestV1(requestValue);return consequentialApprovalRequestSchemaV1.parse({schemaVersion:COMPLETION_GATE_SCHEMA_VERSION_V1,id:derivedId("approval-request:abs",request.requestDigest),tenantId:request.tenantId,projectId:request.projectId,jobId:request.jobId,attemptId:request.attemptId,effectIntentId:request.effectIntentId,operationDigest:request.operationDigest,risk:"medium",requestedBy:{actorId:"service:abs-live-read",actorType:"service"},requiredFactor:"strong",requestedAt:request.requestedAt,expiresAt:request.expiresAt,grantsExecutionAuthority:false}) as ConsequentialApprovalRequestV1;}

export function buildAbsNewsLiveReadAuthorizationV1(inputValue:unknown):AbsNewsLiveReadAuthorizationV1{const input=parseServer(authorizationInputSchema,inputValue),request=parseAbsNewsLiveReadRequestV1(input.request);let approvalRequest:ConsequentialApprovalRequestV1,approvalDecision:ConsequentialApprovalDecisionV1;try{approvalRequest=consequentialApprovalRequestSchemaV1.parse(input.approvalRequest) as ConsequentialApprovalRequestV1;approvalDecision=consequentialApprovalDecisionSchemaV1.parse(input.approvalDecision) as ConsequentialApprovalDecisionV1;}catch{throw new ProjectWorkspaceContractErrorV1("invalid_input");}if(sha256Digest(approvalRequest)!==approvalDecision.requestDigest||approvalRequest.id!==approvalDecision.requestId||approvalRequest.operationDigest!==request.operationDigest||approvalDecision.operationDigest!==request.operationDigest||approvalDecision.decision!=="approved"||approvalDecision.factor!=="strong"||Date.parse(approvalDecision.expiresAt)>Date.parse(request.expiresAt)||Date.parse(approvalDecision.decidedAt)<Date.parse(request.requestedAt)||approvalRequest.tenantId!==request.tenantId||approvalRequest.projectId!==request.projectId||approvalRequest.jobId!==request.jobId||approvalRequest.attemptId!==request.attemptId||approvalRequest.effectIntentId!==request.effectIntentId)throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  if(input.authorizationMode==="simulation"&&!approvalDecision.policyDecisionId.startsWith("policy:synthetic:"))throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  if(input.authorizationMode==="owner_live"&&approvalDecision.policyDecisionId.startsWith("policy:synthetic:"))throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  const authorizationMode=input.authorizationMode,material:Omit<AbsNewsLiveReadAuthorizationV1,"authorizationDigest">={contractVersion:ABS_NEWS_LIVE_READ_CONTRACT_V1,authorizationId:derivedId("authorization:abs",{requestDigest:request.requestDigest,decisionDigest:sha256Digest(approvalDecision),authorizationMode}),tenantId:request.tenantId,workspaceId:request.workspaceId,projectId:request.projectId,requestId:request.requestId,requestDigest:request.requestDigest,sourceSetDigest:request.sourceSetDigest,operationDigest:request.operationDigest,approvalRequestId:approvalRequest.id,approvalRequestDigest:sha256Digest(approvalRequest),approvalDecisionId:approvalDecision.id,approvalDecisionDigest:sha256Digest(approvalDecision),authorizationMode,authorizedAt:approvalDecision.decidedAt,expiresAt:approvalDecision.expiresAt,networkReadAuthorized:authorizationMode==="owner_live",requiresAuthoritativeApprovalResolution:true,requiresDurableClaim:true,requiresPreReadMarker:true,singleUse:true,retryAfterAmbiguityAllowed:false,grantsCommandAuthority:false,grantsLeaseAuthority:false,grantsExecutionAuthority:false,grantsPublicationAuthority:false};return parseServer(authorizationSchema,{...material,authorizationDigest:sha256Digest(material)}) as AbsNewsLiveReadAuthorizationV1;}
export function parseAbsNewsLiveReadAuthorizationV1(value:unknown):AbsNewsLiveReadAuthorizationV1{const parsed=parseServer(authorizationSchema,value) as AbsNewsLiveReadAuthorizationV1;exactDigest(parsed as unknown as Record<string,unknown>,"authorizationDigest",parsed.authorizationDigest);return parsed;}

export function buildAbsNewsLiveReadTransportResultV1(inputValue:unknown):AbsNewsLiveReadTransportResultV1{const snapshot=parseServer(absNewsLiveReadTransportResultSchemaV1.omit({resultDigest:true}),inputValue);return parseServer(absNewsLiveReadTransportResultSchemaV1,{...snapshot,resultDigest:sha256Digest(snapshot)}) as AbsNewsLiveReadTransportResultV1;}
export function parseAbsNewsLiveReadTransportResultV1(value:unknown):AbsNewsLiveReadTransportResultV1{const parsed=parseServer(absNewsLiveReadTransportResultSchemaV1,value) as AbsNewsLiveReadTransportResultV1;exactDigest(parsed as unknown as Record<string,unknown>,"resultDigest",parsed.resultDigest);return parsed;}

export function buildAbsNewsLiveReadClaimV1(input:{request:unknown;authorization:unknown;claimedAt:string}):AbsNewsLiveReadClaimV1{const request=parseAbsNewsLiveReadRequestV1(input.request),authorization=parseAbsNewsLiveReadAuthorizationV1(input.authorization);if(authorization.requestDigest!==request.requestDigest||authorization.authorizationMode!=="simulation"||authorization.networkReadAuthorized||Date.parse(input.claimedAt)<Date.parse(authorization.authorizedAt)||Date.parse(input.claimedAt)>=Date.parse(authorization.expiresAt))throw new ProjectWorkspaceContractErrorV1("unsupported_action");const claimKey=sha256Digest({requestDigest:request.requestDigest,authorizationDigest:authorization.authorizationDigest,idempotencyKey:request.idempotencyKey}),material:Omit<AbsNewsLiveReadClaimV1,"claimDigest">={contractVersion:ABS_NEWS_LIVE_READ_CONTRACT_V1,claimId:derivedId("claim:abs",claimKey),claimKey,tenantId:request.tenantId,workspaceId:request.workspaceId,projectId:request.projectId,requestId:request.requestId,requestDigest:request.requestDigest,authorizationDigest:authorization.authorizationDigest,operationDigest:request.operationDigest,state:"claimed",version:1,claimedAt:input.claimedAt,updatedAt:input.claimedAt,effectiveDeadline:authorization.expiresAt,simulationOnly:true,networkUsed:false};return parseServer(claimSchema,{...material,claimDigest:sha256Digest(material)}) as AbsNewsLiveReadClaimV1;}
export function parseAbsNewsLiveReadClaimV1(value:unknown):AbsNewsLiveReadClaimV1{const parsed=parseServer(claimSchema,value) as AbsNewsLiveReadClaimV1;exactDigest(parsed as unknown as Record<string,unknown>,"claimDigest",parsed.claimDigest);return parsed;}
export function transitionAbsNewsLiveReadClaimV1(input:{claim:unknown;toState:"executing"|"succeeded"|"definite_failure"|"ambiguous";updatedAt:string;markerDigest?:string;outcomeDigest?:string}):AbsNewsLiveReadClaimV1{const claim=parseAbsNewsLiveReadClaimV1(input.claim),allowed=claim.state==="claimed"&&input.toState==="executing"||claim.state==="executing"&&["succeeded","definite_failure","ambiguous"].includes(input.toState);if(!allowed||input.updatedAt<claim.updatedAt||(input.toState==="executing"&&input.updatedAt>=claim.effectiveDeadline)||(input.toState==="executing"&&!input.markerDigest)||(input.toState!=="executing"&&!input.outcomeDigest))throw new ProjectWorkspaceContractErrorV1("unsupported_action");const {claimDigest:_digest,...base}=claim;void _digest;const material:Omit<AbsNewsLiveReadClaimV1,"claimDigest">={...base,state:input.toState,version:claim.version+1,updatedAt:input.updatedAt,...(input.markerDigest?{markerDigest:input.markerDigest}:{}),...(input.outcomeDigest?{outcomeDigest:input.outcomeDigest}:{})};return parseServer(claimSchema,{...material,claimDigest:sha256Digest(material)}) as AbsNewsLiveReadClaimV1;}
export function buildAbsNewsLiveReadMarkerV1(input:{claim:unknown;markedAt:string}):AbsNewsLiveReadMarkerV1{const claim=parseAbsNewsLiveReadClaimV1(input.claim);if(claim.state!=="claimed"||Date.parse(input.markedAt)<Date.parse(claim.claimedAt)||Date.parse(input.markedAt)>=Date.parse(claim.effectiveDeadline))throw new ProjectWorkspaceContractErrorV1("unsupported_action");const material:Omit<AbsNewsLiveReadMarkerV1,"markerDigest">={contractVersion:ABS_NEWS_LIVE_READ_CONTRACT_V1,markerId:derivedId("marker:abs",claim.claimKey),claimKey:claim.claimKey,claimDigest:claim.claimDigest,requestDigest:claim.requestDigest,authorizationDigest:claim.authorizationDigest,operationDigest:claim.operationDigest,markedAt:input.markedAt,simulationOnly:true,networkUsed:false};return parseServer(markerSchema,{...material,markerDigest:sha256Digest(material)}) as AbsNewsLiveReadMarkerV1;}
export function parseAbsNewsLiveReadMarkerV1(value:unknown):AbsNewsLiveReadMarkerV1{const parsed=parseServer(markerSchema,value) as AbsNewsLiveReadMarkerV1;exactDigest(parsed as unknown as Record<string,unknown>,"markerDigest",parsed.markerDigest);return parsed;}
export function buildAbsNewsLiveReadCleanupReceiptV1(input:{claimKey:string;requestDigest:string;cleanedAt:string}):AbsNewsLiveReadCleanupReceiptV1{const material:Omit<AbsNewsLiveReadCleanupReceiptV1,"cleanupDigest">={contractVersion:ABS_NEWS_LIVE_READ_CONTRACT_V1,cleanupId:derivedId("cleanup:abs",{claimKey:input.claimKey,requestDigest:input.requestDigest}),claimKey:input.claimKey,requestDigest:input.requestDigest,transportHandlesClosed:true,temporaryFilesCreated:false,temporaryFilesRemaining:false,credentialsResolved:false,rawBodyRetained:false,cookiesRetained:false,cleanedAt:input.cleanedAt,simulationOnly:true};return parseServer(cleanupSchema,{...material,cleanupDigest:sha256Digest(material)}) as AbsNewsLiveReadCleanupReceiptV1;}
export function parseAbsNewsLiveReadCleanupReceiptV1(value:unknown):AbsNewsLiveReadCleanupReceiptV1{const parsed=parseServer(cleanupSchema,value) as AbsNewsLiveReadCleanupReceiptV1;exactDigest(parsed as unknown as Record<string,unknown>,"cleanupDigest",parsed.cleanupDigest);return parsed;}
export function buildAbsNewsLiveReadOutcomeV1(input:{claim:unknown;authorization:unknown;disposition:AbsNewsLiveReadOutcomeV1["disposition"];sourceResultDigests:string[];batchDigests:string[];itemCount:number;totalResponseBytes:number;safeReasonCode:AbsNewsLiveReadOutcomeV1["safeReasonCode"];startedAt:string;settledAt:string;cleanup:unknown}):AbsNewsLiveReadOutcomeV1{const claim=parseAbsNewsLiveReadClaimV1(input.claim),authorization=parseAbsNewsLiveReadAuthorizationV1(input.authorization),cleanup=parseAbsNewsLiveReadCleanupReceiptV1(input.cleanup);if(claim.authorizationDigest!==authorization.authorizationDigest||cleanup.claimKey!==claim.claimKey||cleanup.requestDigest!==claim.requestDigest||Date.parse(input.settledAt)<Date.parse(input.startedAt)||Date.parse(cleanup.cleanedAt)<Date.parse(input.startedAt))throw new ProjectWorkspaceContractErrorV1("replay_drift");const material:Omit<AbsNewsLiveReadOutcomeV1,"outcomeDigest">={contractVersion:ABS_NEWS_LIVE_READ_CONTRACT_V1,outcomeId:derivedId("outcome:abs",claim.claimKey),claimKey:claim.claimKey,requestId:claim.requestId,requestDigest:claim.requestDigest,authorizationDigest:claim.authorizationDigest,disposition:input.disposition,sourceResultDigests:[...input.sourceResultDigests].sort(),batchDigests:[...input.batchDigests].sort(),itemCount:input.itemCount,totalResponseBytes:input.totalResponseBytes,safeReasonCode:input.safeReasonCode,startedAt:input.startedAt,settledAt:input.settledAt,cleanupDigest:cleanup.cleanupDigest,createsWorkItem:false,retainsRawBody:false,networkUsed:false,simulationOnly:true,grantsApproval:false,grantsExecutionAuthority:false};return parseServer(outcomeSchema,{...material,outcomeDigest:sha256Digest(material)}) as AbsNewsLiveReadOutcomeV1;}
export function parseAbsNewsLiveReadOutcomeV1(value:unknown):AbsNewsLiveReadOutcomeV1{const parsed=parseServer(outcomeSchema,value) as AbsNewsLiveReadOutcomeV1;exactDigest(parsed as unknown as Record<string,unknown>,"outcomeDigest",parsed.outcomeDigest);return parsed;}

export const absNewsLiveReadSchemasV1={source:sourceSchema,request:requestSchema,authorization:authorizationSchema,claim:claimSchema,marker:markerSchema,cleanup:cleanupSchema,outcome:outcomeSchema} as const;
