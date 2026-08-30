import { z } from "zod";
import { authorityEnvelopeSchema } from "../../domain/v1";
import { CONTROL_ROOM_MCP_SERVER_AUDIENCE_V1, controlRoomMcpScopesV1 } from "./types";

export const mcpSafeIdV1 = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
export const mcpDigestV1 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const mcpInstantV1 = z.string().datetime({ offset: true });
const idempotencyKey = z.string().min(12).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export const controlRoomMcpAccessGrantBodySchemaV1 = z.object({
  schema: z.literal("control-room.mcp-access-grant/v1"),
  grantId: mcpSafeIdV1,
  issuerKeyId: mcpSafeIdV1,
  audience: z.literal(CONTROL_ROOM_MCP_SERVER_AUDIENCE_V1),
  tenantId: mcpSafeIdV1,
  actorId: mcpSafeIdV1,
  clientId: mcpSafeIdV1,
  scopes: z.array(z.enum(controlRoomMcpScopesV1)).min(1).max(controlRoomMcpScopesV1.length),
  projectIds: z.array(mcpSafeIdV1).max(100),
  issuedAt: mcpInstantV1,
  expiresAt: mcpInstantV1,
  tokenDigest: mcpDigestV1,
  bodyDigest: mcpDigestV1,
}).strict().superRefine((value, context) => {
  if (new Set(value.scopes).size !== value.scopes.length || [...value.scopes].sort().some((scope, index) => scope !== value.scopes[index])) {
    context.addIssue({ code: "custom", message: "scopes must be sorted and unique" });
  }
  if (new Set(value.projectIds).size !== value.projectIds.length || [...value.projectIds].sort().some((project, index) => project !== value.projectIds[index])) {
    context.addIssue({ code: "custom", message: "projects must be sorted and unique" });
  }
});

export const controlRoomMcpAccessGrantSchemaV1 = z.object({
  body: controlRoomMcpAccessGrantBodySchemaV1,
  signatureAlgorithm: z.literal("Ed25519"),
  signature: z.string().min(40).max(180).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

const pagination = { limit: z.number().int().min(1).max(100) };
export const portfolioReadInputSchemaV1 = z.object({ ...pagination }).strict();
export const fleetReadInputSchemaV1 = z.object({ ...pagination }).strict();
export const workReadInputSchemaV1 = z.object({ ...pagination, projectId: mcpSafeIdV1.optional() }).strict();
export const attentionReadInputSchemaV1 = z.object({ ...pagination, projectId: mcpSafeIdV1.optional() }).strict();
export const requestReadInputSchemaV1 = z.object({ ...pagination, projectId: mcpSafeIdV1.optional() }).strict();
export const jobReadInputSchemaV1 = z.object({ ...pagination, projectId: mcpSafeIdV1.optional(), jobId: mcpSafeIdV1.optional() }).strict();
export const artifactReadInputSchemaV1 = z.object({ ...pagination, projectId: mcpSafeIdV1, jobId: mcpSafeIdV1.optional() }).strict();

export const mcpRequestProjectionSchemaV1 = z.object({ requestId: mcpSafeIdV1, projectId: mcpSafeIdV1,
  state: z.enum(["draft","submitted","accepted","fulfilled","rejected","cancelled"]), priority: z.number().int().min(0).max(100),
  updatedAt: mcpInstantV1 }).strict();
export const mcpJobProjectionSchemaV1 = z.object({ jobId: mcpSafeIdV1, projectId: mcpSafeIdV1,
  state: z.enum(["proposed","ready","leased","running","waiting_approval","succeeded","failed","cancelled","orphaned","rejected"]),
  jobType: mcpSafeIdV1, updatedAt: mcpInstantV1, resultArtifactIds: z.array(mcpSafeIdV1).max(100),
  reviewState: z.enum(["not_ready","ready","accepted","rejected"]) }).strict();
export const mcpArtifactProjectionSchemaV1 = z.object({ artifactId: mcpSafeIdV1, projectId: mcpSafeIdV1, jobId: mcpSafeIdV1,
  attemptId: mcpSafeIdV1, state: z.enum(["declared","uploaded","verified","quarantined","rejected","deleted"]), contentHash: mcpDigestV1,
  sizeBytes: z.number().int().nonnegative(), mimeType: z.string().min(1).max(180), logicalRole: mcpSafeIdV1, createdAt: mcpInstantV1,
  verificationStatus: z.enum(["not_run","verified","failed"]) }).strict();

export const jobProposalInputSchemaV1 = z.object({
  proposalId: mcpSafeIdV1,
  idempotencyKey,
  projectId: mcpSafeIdV1,
  jobType: mcpSafeIdV1,
  inputArtifactId: mcpSafeIdV1,
  inputDigest: mcpDigestV1,
  requiredCapability: mcpSafeIdV1,
  priority: z.number().int().min(0).max(100),
}).strict();

export const delegationProposalInputSchemaV1 = z.object({
  proposalId: mcpSafeIdV1,
  idempotencyKey,
  projectId: mcpSafeIdV1,
  parentAuthorityDigest: mcpDigestV1,
  childAuthority: authorityEnvelopeSchema,
}).strict();

export const approvalRequestInputSchemaV1 = z.object({
  proposalId: mcpSafeIdV1,
  idempotencyKey,
  projectId: mcpSafeIdV1,
  operationDigest: mcpDigestV1,
  risk: z.enum(["low", "medium", "high", "critical"]),
  reasonCode: mcpSafeIdV1,
  evidenceDigests: z.array(mcpDigestV1).max(50),
  expiresAt: mcpInstantV1,
}).strict().refine((value) => new Set(value.evidenceDigests).size === value.evidenceDigests.length, "evidence digests must be unique");

const proposalRecordBase = {
  schema: z.literal("control-room.mcp-proposal/v1"), proposalId: mcpSafeIdV1, idempotencyKey, tenantId: mcpSafeIdV1,
  actorId: mcpSafeIdV1, clientId: mcpSafeIdV1, projectId: mcpSafeIdV1, requestedAt: mcpInstantV1,
};
export const controlRoomMcpProposalRecordSchemaV1 = z.discriminatedUnion("kind",[
  z.object({ ...proposalRecordBase,kind:z.literal("job_proposal"),jobType:mcpSafeIdV1,inputArtifactId:mcpSafeIdV1,inputDigest:mcpDigestV1,requiredCapability:mcpSafeIdV1,priority:z.number().int().min(0).max(100) }).strict(),
  z.object({ ...proposalRecordBase,kind:z.literal("delegation_proposal"),parentAuthorityDigest:mcpDigestV1,childAuthority:authorityEnvelopeSchema }).strict(),
  z.object({ ...proposalRecordBase,kind:z.literal("approval_request"),operationDigest:mcpDigestV1,risk:z.enum(["low","medium","high","critical"]),reasonCode:mcpSafeIdV1,evidenceDigests:z.array(mcpDigestV1).max(50),expiresAt:mcpInstantV1 }).strict(),
]).superRefine((value,context)=>{
  if (value.kind==="approval_request" && (new Set(value.evidenceDigests).size!==value.evidenceDigests.length || Date.parse(value.expiresAt)<=Date.parse(value.requestedAt))) context.addIssue({code:"custom",message:"approval request evidence and expiry invalid"});
});

export const controlRoomMcpToolCallParamsSchemaV1 = z.object({
  name: z.enum([
    "control_room.portfolio.read", "control_room.fleet.read", "control_room.work.read", "control_room.attention.read",
    "control_room.request.read", "control_room.job.read", "control_room.artifact.read",
    "control_room.job.propose", "control_room.delegation.propose", "control_room.approval.request",
  ]),
  arguments: z.record(z.string(), z.unknown()),
  _meta: z.object({ "com.control-room/requestId": mcpSafeIdV1 }).strict(),
}).strict();
