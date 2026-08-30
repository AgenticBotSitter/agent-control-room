import type { ArtifactState, AuthorityEnvelope, JobState, RequestState } from "../../domain/v1";
import type {
  ActionInboxItemV1,
  ActiveWorkProjectionV1,
  FleetWorkerSummaryV1,
  PortfolioProjectProjectionV1,
} from "../../operator-surfaces/v1";

export const CONTROL_ROOM_MCP_PROTOCOL_REVISION_V1 = "2026-07-28" as const;
export const CONTROL_ROOM_MCP_SERVER_AUDIENCE_V1 = "control-room:mcp:v1" as const;

export const controlRoomMcpScopesV1 = [
  "control-room:attention:read",
  "control-room:fleet:read",
  "control-room:portfolio:read",
  "control-room:work:read",
  "control-room:request:read",
  "control-room:job:read",
  "control-room:artifact:read",
  "control-room:job:propose",
  "control-room:delegation:propose",
  "control-room:approval:request",
] as const;
export type ControlRoomMcpScopeV1 = (typeof controlRoomMcpScopesV1)[number];

export interface ControlRoomMcpAccessGrantBodyV1 {
  schema: "control-room.mcp-access-grant/v1";
  grantId: string;
  issuerKeyId: string;
  audience: typeof CONTROL_ROOM_MCP_SERVER_AUDIENCE_V1;
  tenantId: string;
  actorId: string;
  clientId: string;
  scopes: ControlRoomMcpScopeV1[];
  projectIds: string[];
  issuedAt: string;
  expiresAt: string;
  tokenDigest: string;
  bodyDigest: string;
}

export interface ControlRoomMcpAccessGrantV1 {
  body: ControlRoomMcpAccessGrantBodyV1;
  signatureAlgorithm: "Ed25519";
  signature: string;
}

export interface ControlRoomMcpRequestHeadersV1 {
  protocolVersion: typeof CONTROL_ROOM_MCP_PROTOCOL_REVISION_V1;
  method: "server/discover" | "tools/list" | "tools/call";
  toolName?: ControlRoomMcpToolNameV1;
}

export interface ControlRoomMcpJsonRpcRequestV1 {
  jsonrpc: "2.0";
  id: string | number;
  method: "server/discover" | "tools/list" | "tools/call";
  params?: Record<string, unknown>;
}

export type ControlRoomMcpToolNameV1 =
  | "control_room.portfolio.read"
  | "control_room.fleet.read"
  | "control_room.work.read"
  | "control_room.attention.read"
  | "control_room.request.read"
  | "control_room.job.read"
  | "control_room.artifact.read"
  | "control_room.job.propose"
  | "control_room.delegation.propose"
  | "control_room.approval.request";

export interface ControlRoomMcpToolDefinitionV1 {
  name: ControlRoomMcpToolNameV1;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: false;
    idempotentHint: boolean;
    openWorldHint: false;
  };
}

export interface ControlRoomMcpToolResultV1 {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

export type ControlRoomMcpJsonRpcResponseV1 = {
  jsonrpc: "2.0";
  id: string | number;
  result: Record<string, unknown> | ControlRoomMcpToolResultV1;
} | {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: -32600 | -32601 | -32602; message: "Invalid Request" | "Method not found" | "Invalid params" };
};

export interface ControlRoomMcpReadSourceV1 {
  portfolio(input: { tenantId: string; projectIds: string[]; limit: number }): Promise<PortfolioProjectProjectionV1[]>;
  fleet(input: { tenantId: string; limit: number }): Promise<FleetWorkerSummaryV1[]>;
  activeWork(input: { tenantId: string; projectIds: string[]; limit: number }): Promise<ActiveWorkProjectionV1[]>;
  attention(input: { tenantId: string; projectIds: string[]; limit: number }): Promise<ActionInboxItemV1[]>;
  requests(input: { tenantId: string; projectIds: string[]; limit: number }): Promise<ControlRoomMcpRequestProjectionV1[]>;
  jobs(input: { tenantId: string; projectIds: string[]; limit: number }): Promise<ControlRoomMcpJobProjectionV1[]>;
  artifacts(input: { tenantId: string; projectIds: string[]; limit: number }): Promise<ControlRoomMcpArtifactProjectionV1[]>;
}

export interface ControlRoomMcpRequestProjectionV1 {
  requestId: string; projectId: string; state: RequestState; priority: number; updatedAt: string;
}

export interface ControlRoomMcpJobProjectionV1 {
  jobId: string; projectId: string; state: JobState; jobType: string; updatedAt: string;
  resultArtifactIds: string[]; reviewState: "not_ready" | "ready" | "accepted" | "rejected";
}

export interface ControlRoomMcpArtifactProjectionV1 {
  artifactId: string; projectId: string; jobId: string; attemptId: string; state: ArtifactState;
  contentHash: string; sizeBytes: number; mimeType: string; logicalRole: string; createdAt: string;
  verificationStatus: "not_run" | "verified" | "failed";
}

export interface ControlRoomMcpAuthoritySourceV1 {
  resolve(input: { tenantId: string; projectId: string; authorityDigest: string }): Promise<AuthorityEnvelope | undefined>;
}

export interface ControlRoomMcpProposalReceiptV1 {
  receiptId: string;
  requestKind: "job_proposal" | "delegation_proposal" | "approval_request";
  requestDigest: string;
  state: "recorded";
  grantsAuthority: false;
  dispatchCreated: false;
  replayed: boolean;
}

export type ControlRoomMcpProposalRecordV1 = {
  schema: "control-room.mcp-proposal/v1";
  proposalId: string;
  idempotencyKey: string;
  tenantId: string;
  actorId: string;
  clientId: string;
  projectId: string;
  kind: "job_proposal";
  jobType: string;
  inputArtifactId: string;
  inputDigest: string;
  requiredCapability: string;
  priority: number;
  requestedAt: string;
} | {
  schema: "control-room.mcp-proposal/v1";
  proposalId: string;
  idempotencyKey: string;
  tenantId: string;
  actorId: string;
  clientId: string;
  projectId: string;
  kind: "delegation_proposal";
  parentAuthorityDigest: string;
  childAuthority: AuthorityEnvelope;
  requestedAt: string;
} | {
  schema: "control-room.mcp-proposal/v1";
  proposalId: string;
  idempotencyKey: string;
  tenantId: string;
  actorId: string;
  clientId: string;
  projectId: string;
  kind: "approval_request";
  operationDigest: string;
  risk: "low" | "medium" | "high" | "critical";
  reasonCode: string;
  evidenceDigests: string[];
  expiresAt: string;
  requestedAt: string;
};

export interface ControlRoomMcpProposalStoreV1 {
  record(input: ControlRoomMcpProposalRecordV1): ControlRoomMcpProposalReceiptV1;
}

export interface ControlRoomMcpReplayBindingV1 {
  toolName: ControlRoomMcpToolNameV1;
  tenantId: string;
  projectScopeDigest: string;
  grantBodyDigest: string;
}

export interface ControlRoomMcpReplayLedgerV1 {
  claim(input: { replayKey: string; requestDigest: string; binding: ControlRoomMcpReplayBindingV1 }):
    | { disposition: "execute" }
    | { disposition: "in_progress" }
    | { disposition: "replay"; result: ControlRoomMcpToolResultV1 };
  complete(input: { replayKey: string; requestDigest: string; result: ControlRoomMcpToolResultV1 }): void;
  fail(input: { replayKey: string; requestDigest: string }): void;
}
