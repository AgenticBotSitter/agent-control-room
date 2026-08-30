import { assertSafeProjection } from "../../contracts/v1/validators";
import { assertDelegatedAuthority } from "../../domain/v1";
import { assertAuthorityDigest, assertNoSecretMaterial, canonicalJson, sha256Digest } from "../../security";
import {
  actionInboxItemSchemaV1,
  activeWorkProjectionSchemaV1,
  fleetWorkerSummarySchemaV1,
  portfolioProjectProjectionSchemaV1,
} from "../../operator-surfaces/v1";
import {
  approvalRequestInputSchemaV1,
  artifactReadInputSchemaV1,
  attentionReadInputSchemaV1,
  controlRoomMcpToolCallParamsSchemaV1,
  delegationProposalInputSchemaV1,
  fleetReadInputSchemaV1,
  jobProposalInputSchemaV1,
  jobReadInputSchemaV1,
  mcpArtifactProjectionSchemaV1,
  mcpJobProjectionSchemaV1,
  mcpRequestProjectionSchemaV1,
  portfolioReadInputSchemaV1,
  requestReadInputSchemaV1,
  workReadInputSchemaV1,
  mcpSafeIdV1,
} from "./schemas";
import { verifyControlRoomMcpAccessGrantV1 } from "./security";
import {
  CONTROL_ROOM_MCP_PROTOCOL_REVISION_V1,
  type ControlRoomMcpAccessGrantV1,
  type ControlRoomMcpAccessGrantBodyV1,
  type ControlRoomMcpAuthoritySourceV1,
  type ControlRoomMcpJsonRpcRequestV1,
  type ControlRoomMcpJsonRpcResponseV1,
  type ControlRoomMcpProposalRecordV1,
  type ControlRoomMcpProposalStoreV1,
  type ControlRoomMcpReadSourceV1,
  type ControlRoomMcpReplayLedgerV1,
  type ControlRoomMcpScopeV1,
  type ControlRoomMcpToolDefinitionV1,
  type ControlRoomMcpToolNameV1,
  type ControlRoomMcpToolResultV1,
} from "./types";

const JSON_SCHEMA = "https://json-schema.org/draft/2020-12/schema";
const receiptOutputSchema = {
  $schema: JSON_SCHEMA, type: "object", additionalProperties: false,
  properties: {
    receiptId: { type: "string" }, requestKind: { enum: ["job_proposal", "delegation_proposal", "approval_request"] },
    requestDigest: { type: "string" }, state: { const: "recorded" }, grantsAuthority: { const: false },
    dispatchCreated: { const: false }, replayed: { type: "boolean" },
  },
  required: ["receiptId", "requestKind", "requestDigest", "state", "grantsAuthority", "dispatchCreated", "replayed"],
};
const readOutputSchema = {
  $schema: JSON_SCHEMA, type: "object", additionalProperties: false,
  properties: { items: { type: "array" }, count: { type: "integer", minimum: 0 }, truncated: { type: "boolean" } },
  required: ["items", "count", "truncated"],
};

function objectInput(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { $schema: JSON_SCHEMA, type: "object", additionalProperties: false, properties, required };
}

const pagination = { limit: { type: "integer", minimum: 1, maximum: 100 } };
const toolDefinitions: readonly ControlRoomMcpToolDefinitionV1[] = [
  { name: "control_room.portfolio.read", title: "Read portfolio", description: "Returns redacted portfolio facts for the authenticated tenant and granted projects. It cannot schedule or mutate work.",
    inputSchema: objectInput(pagination, ["limit"]), outputSchema: readOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "control_room.fleet.read", title: "Read fleet", description: "Returns redacted fleet observations for the authenticated tenant. It grants no node or execution authority.",
    inputSchema: objectInput(pagination, ["limit"]), outputSchema: readOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "control_room.work.read", title: "Read active work", description: "Returns redacted active-work facts within the caller's granted projects. It cannot claim, lease, or dispatch work.",
    inputSchema: objectInput({ ...pagination, projectId: { type: "string" } }, ["limit"]), outputSchema: readOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "control_room.attention.read", title: "Read attention queue", description: "Returns redacted Action Inbox facts within granted projects. Legal-response descriptions are not approval attestations.",
    inputSchema: objectInput({ ...pagination, projectId: { type: "string" } }, ["limit"]), outputSchema: readOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "control_room.request.read", title: "Read requests", description: "Returns redacted request lifecycle facts within granted projects. It cannot accept, reject, or schedule a request.",
    inputSchema: objectInput({ ...pagination, projectId: { type: "string" } }, ["limit"]), outputSchema: readOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "control_room.job.read", title: "Read jobs", description: "Returns redacted job and review-readiness facts within granted projects, including terminal jobs. It cannot claim or dispatch work.",
    inputSchema: objectInput({ ...pagination, projectId: { type: "string" }, jobId: { type: "string" } }, ["limit"]), outputSchema: readOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "control_room.artifact.read", title: "Read artifact evidence", description: "Returns redacted artifact manifests and verification status. It never returns bytes, filesystem paths, locators, or signed URLs.",
    inputSchema: objectInput({ ...pagination, projectId: { type: "string" }, jobId: { type: "string" } }, ["limit","projectId"]), outputSchema: readOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "control_room.job.propose", title: "Propose a job", description: "Records a bounded job proposal. It does not create a canonical job, lease, reservation, dispatch, or effect.",
    inputSchema: objectInput({ proposalId: { type: "string" }, idempotencyKey: { type: "string" }, projectId: { type: "string" },
      jobType: { type: "string" }, inputArtifactId: { type: "string" }, inputDigest: { type: "string" },
      requiredCapability: { type: "string" }, priority: { type: "integer", minimum: 0, maximum: 100 } },
    ["proposalId", "idempotencyKey", "projectId", "jobType", "inputArtifactId", "inputDigest", "requiredCapability", "priority"]),
    outputSchema: receiptOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "control_room.delegation.propose", title: "Propose a delegation", description: "Records a child-authority proposal only after proving it narrows an authoritative parent. It grants no authority.",
    inputSchema: objectInput({ proposalId: { type: "string" }, idempotencyKey: { type: "string" }, projectId: { type: "string" },
      parentAuthorityDigest: { type: "string" }, childAuthority: { type: "object" } },
    ["proposalId", "idempotencyKey", "projectId", "parentAuthorityDigest", "childAuthority"]),
    outputSchema: receiptOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "control_room.approval.request", title: "Request approval", description: "Records an approval request for owner review. It cannot approve an operation or mint an owner attestation.",
    inputSchema: objectInput({ proposalId: { type: "string" }, idempotencyKey: { type: "string" }, projectId: { type: "string" },
      operationDigest: { type: "string" }, risk: { enum: ["low", "medium", "high", "critical"] }, reasonCode: { type: "string" },
      evidenceDigests: { type: "array", items: { type: "string" }, maxItems: 50 }, expiresAt: { type: "string", format: "date-time" } },
    ["proposalId", "idempotencyKey", "projectId", "operationDigest", "risk", "reasonCode", "evidenceDigests", "expiresAt"]),
    outputSchema: receiptOutputSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
] as const;

const toolScope: Readonly<Record<ControlRoomMcpToolNameV1, ControlRoomMcpScopeV1>> = {
  "control_room.portfolio.read": "control-room:portfolio:read",
  "control_room.fleet.read": "control-room:fleet:read",
  "control_room.work.read": "control-room:work:read",
  "control_room.attention.read": "control-room:attention:read",
  "control_room.request.read": "control-room:request:read",
  "control_room.job.read": "control-room:job:read",
  "control_room.artifact.read": "control-room:artifact:read",
  "control_room.job.propose": "control-room:job:propose",
  "control_room.delegation.propose": "control-room:delegation:propose",
  "control_room.approval.request": "control-room:approval:request",
};

export class ControlRoomMcpTransportErrorV1 extends Error {
  constructor(public readonly safeCode: "authentication_required" | "authentication_invalid", public readonly httpStatus: 401 | 403) {
    super(safeCode); this.name = "ControlRoomMcpTransportErrorV1";
  }
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function toolResult(structuredContent: Record<string, unknown>, isError = false): ControlRoomMcpToolResultV1 {
  assertSafeProjection(structuredContent); assertNoSecretMaterial(structuredContent, "MCP result");
  return { content: [{ type: "text", text: canonicalJson(structuredContent) }], structuredContent, ...(isError ? { isError: true } : {}) };
}

function denied(safeCode: "invalid_tool_input" | "scope_denied" | "project_denied" | "replay_conflict" | "request_in_progress" | "request_failed") {
  const result = { status: "denied", safeCode };
  return toolResult(result, true);
}

export class ControlRoomMcpServerV1 {
  private lastObservedTimeMs = 0;

  constructor(private readonly options: {
    issuerKeyId: string;
    issuerPublicKeySpki: string;
    clock: () => string;
    reads: ControlRoomMcpReadSourceV1;
    authorities: ControlRoomMcpAuthoritySourceV1;
    proposals: ControlRoomMcpProposalStoreV1;
    replay: ControlRoomMcpReplayLedgerV1;
  }) {}

  async handle(input: { headers: unknown; request: unknown; accessGrant?: ControlRoomMcpAccessGrantV1; bearerToken?: string }): Promise<ControlRoomMcpJsonRpcResponseV1> {
    if (!input.accessGrant || !input.bearerToken) throw new ControlRoomMcpTransportErrorV1("authentication_required", 401);
    let grant: ControlRoomMcpAccessGrantBodyV1;
    const now = this.trustedNow();
    try { grant = verifyControlRoomMcpAccessGrantV1({ grant: input.accessGrant, expectedIssuerKeyId: this.options.issuerKeyId,
      issuerPublicKeySpki: this.options.issuerPublicKeySpki, bearerToken: input.bearerToken, now }); }
    catch { throw new ControlRoomMcpTransportErrorV1("authentication_invalid", 403); }
    if (!input.headers || typeof input.headers !== "object" || Array.isArray(input.headers)) return this.protocolError(null, -32600, "Invalid Request");
    const rawHeaders = input.headers as Record<string, unknown>;
    if (!exactKeys(rawHeaders, rawHeaders.toolName === undefined ? ["protocolVersion", "method"] : ["protocolVersion", "method", "toolName"])
      || rawHeaders.protocolVersion !== CONTROL_ROOM_MCP_PROTOCOL_REVISION_V1 || typeof rawHeaders.method !== "string") {
      return this.protocolError(null, -32600, "Invalid Request");
    }
    if (!input.request || typeof input.request !== "object" || Array.isArray(input.request)) return this.protocolError(null, -32600, "Invalid Request");
    const rawRequest = input.request as Record<string, unknown>;
    if (!exactKeys(rawRequest, rawRequest.params === undefined ? ["jsonrpc", "id", "method"] : ["jsonrpc", "id", "method", "params"])) {
      return this.protocolError(null, -32600, "Invalid Request");
    }
    const request = rawRequest as unknown as ControlRoomMcpJsonRpcRequestV1;
    if (request.jsonrpc !== "2.0" || (typeof request.id !== "string" && typeof request.id !== "number")
      || (typeof request.id==="string" ? !mcpSafeIdV1.safeParse(request.id).success : !Number.isSafeInteger(request.id)) || typeof request.method !== "string" || request.method !== rawHeaders.method) {
      return this.protocolError(null, -32600, "Invalid Request");
    }
    if (request.method === "server/discover") {
      if (rawHeaders.toolName !== undefined || (request.params !== undefined && !exactKeys(request.params, []))) {
        return this.protocolError(request.id, -32602, "Invalid params");
      }
      return { jsonrpc: "2.0", id: request.id, result: {
        protocolVersion: CONTROL_ROOM_MCP_PROTOCOL_REVISION_V1,
        capabilities: { tools: { listChanged: false } },
        authorityModel: "per_request_scoped",
      } };
    }
    if (request.method === "tools/list") {
      if (rawHeaders.toolName !== undefined || (request.params !== undefined && !exactKeys(request.params, []))) {
        return this.protocolError(request.id, -32602, "Invalid params");
      }
      const scopes = new Set(grant.scopes);
      return { jsonrpc: "2.0", id: request.id, result: { tools: toolDefinitions.filter((tool) => scopes.has(toolScope[tool.name])) } };
    }
    if (request.method !== "tools/call") return this.protocolError(request.id, -32601, "Method not found");
    const parsedCall = controlRoomMcpToolCallParamsSchemaV1.safeParse(request.params);
    if (!parsedCall.success || rawHeaders.toolName !== parsedCall.data.name) return this.protocolError(request.id, -32602, "Invalid params");
    const result = await this.callTool(grant, parsedCall.data.name, parsedCall.data.arguments,
      parsedCall.data._meta["com.control-room/requestId"], now);
    return { jsonrpc: "2.0", id: request.id, result };
  }

  private async callTool(grant: ControlRoomMcpAccessGrantBodyV1, name: ControlRoomMcpToolNameV1,
    args: Record<string, unknown>, requestId: string, now: string): Promise<ControlRoomMcpToolResultV1> {
    if (!grant.scopes.includes(toolScope[name])) return denied("scope_denied");
    const requestDigest = sha256Digest({ name, args, grantBodyDigest: grant.bodyDigest });
    const replayKey = sha256Digest({ grantId: grant.grantId, clientId: grant.clientId, requestId });
    const binding={toolName:name,tenantId:grant.tenantId,projectScopeDigest:sha256Digest([...grant.projectIds].sort()),grantBodyDigest:grant.bodyDigest};
    let claim: ReturnType<ControlRoomMcpReplayLedgerV1["claim"]>;
    try { claim = this.options.replay.claim({ replayKey, requestDigest,binding }); }
    catch { return denied("replay_conflict"); }
    if (claim.disposition === "replay") {
      try { this.assertGrantCurrent(grant); this.assertReplayResult(grant,name,args,claim.result); return claim.result; }
      catch { return denied("request_failed"); }
    }
    if (claim.disposition === "in_progress") return denied("request_in_progress");
    try {
      this.assertGrantCurrent(grant);
      const result = await this.executeTool(grant, name, args, now);
      this.assertGrantCurrent(grant);
      this.options.replay.complete({ replayKey, requestDigest, result });
      return result;
    } catch {
      try { this.options.replay.fail({ replayKey, requestDigest }); } catch { /* safe failure */ }
      return denied("request_failed");
    }
  }

  private async executeTool(grant: ControlRoomMcpAccessGrantBodyV1, name: ControlRoomMcpToolNameV1,
    args: Record<string, unknown>, now: string): Promise<ControlRoomMcpToolResultV1> {
    assertNoSecretMaterial(args, "MCP tool input");
    const grantedProjects = new Set(grant.projectIds);
    if (name === "control_room.portfolio.read") {
      const parsed = portfolioReadInputSchemaV1.safeParse(args); if (!parsed.success) return denied("invalid_tool_input");
      const source = await this.options.reads.portfolio({ tenantId: grant.tenantId, projectIds: grant.projectIds, limit: parsed.data.limit });
      const authorized = source.filter((item) => grantedProjects.has(item.projectId));
      const items = authorized.slice(0, parsed.data.limit).map((item) => portfolioProjectProjectionSchemaV1.parse(item));
      return toolResult({ items, count: items.length, truncated: authorized.length > items.length });
    }
    if (name === "control_room.fleet.read") {
      const parsed = fleetReadInputSchemaV1.safeParse(args); if (!parsed.success) return denied("invalid_tool_input");
      const source = await this.options.reads.fleet({ tenantId: grant.tenantId, limit: parsed.data.limit });
      const items = source.slice(0, parsed.data.limit).map((item) => fleetWorkerSummarySchemaV1.parse(item));
      return toolResult({ items, count: items.length, truncated: source.length > items.length });
    }
    if (name === "control_room.work.read" || name === "control_room.attention.read") {
      const schema = name === "control_room.work.read" ? workReadInputSchemaV1 : attentionReadInputSchemaV1;
      const parsed = schema.safeParse(args); if (!parsed.success) return denied("invalid_tool_input");
      if (parsed.data.projectId && !grantedProjects.has(parsed.data.projectId)) return denied("project_denied");
      const projectIds = parsed.data.projectId ? [parsed.data.projectId] : grant.projectIds;
      if (name === "control_room.work.read") {
        const source = await this.options.reads.activeWork({ tenantId: grant.tenantId, projectIds, limit: parsed.data.limit });
        const authorized = source.filter((item) => projectIds.includes(item.projectId));
        const items = authorized.slice(0, parsed.data.limit).map((item) => activeWorkProjectionSchemaV1.parse(item));
        return toolResult({ items, count: items.length, truncated: authorized.length > items.length });
      }
      const source = await this.options.reads.attention({ tenantId: grant.tenantId, projectIds, limit: parsed.data.limit });
      const authorized = source.filter((item) => item.tenantId === grant.tenantId && !!item.projectId && projectIds.includes(item.projectId));
      const items = authorized.slice(0, parsed.data.limit).map((item) => actionInboxItemSchemaV1.parse(item));
      return toolResult({ items, count: items.length, truncated: authorized.length > items.length });
    }
    if (name === "control_room.request.read" || name === "control_room.job.read" || name === "control_room.artifact.read") {
      const parsed = name === "control_room.request.read" ? requestReadInputSchemaV1.safeParse(args)
        : name === "control_room.job.read" ? jobReadInputSchemaV1.safeParse(args) : artifactReadInputSchemaV1.safeParse(args);
      if (!parsed.success) return denied("invalid_tool_input");
      const requestedProject = parsed.data.projectId;
      if (requestedProject && !grantedProjects.has(requestedProject)) return denied("project_denied");
      const projectIds = requestedProject ? [requestedProject] : grant.projectIds;
      if (name === "control_room.request.read") {
        const source = await this.options.reads.requests({ tenantId: grant.tenantId,projectIds,limit: parsed.data.limit });
        const authorized = source.filter((item) => projectIds.includes(item.projectId));
        const items = authorized.slice(0,parsed.data.limit).map((item) => mcpRequestProjectionSchemaV1.parse(item));
        return toolResult({ items,count: items.length,truncated: authorized.length > items.length });
      }
      if (name === "control_room.job.read") {
        const source = await this.options.reads.jobs({ tenantId: grant.tenantId,projectIds,limit: parsed.data.limit });
        const jobId = "jobId" in parsed.data ? parsed.data.jobId : undefined;
        const authorized = source.filter((item) => projectIds.includes(item.projectId) && (!jobId || item.jobId === jobId));
        const items = authorized.slice(0,parsed.data.limit).map((item) => mcpJobProjectionSchemaV1.parse(item));
        return toolResult({ items,count: items.length,truncated: authorized.length > items.length });
      }
      const source = await this.options.reads.artifacts({ tenantId: grant.tenantId,projectIds,limit: parsed.data.limit });
      const jobId = "jobId" in parsed.data ? parsed.data.jobId : undefined;
      const authorized = source.filter((item) => projectIds.includes(item.projectId) && (!jobId || item.jobId === jobId));
      const items = authorized.slice(0,parsed.data.limit).map((item) => mcpArtifactProjectionSchemaV1.parse(item));
      return toolResult({ items,count: items.length,truncated: authorized.length > items.length });
    }
    let record: ControlRoomMcpProposalRecordV1;
    if (name === "control_room.job.propose") {
      const parsed = jobProposalInputSchemaV1.safeParse(args); if (!parsed.success) return denied("invalid_tool_input");
      if (!grantedProjects.has(parsed.data.projectId)) return denied("project_denied");
      record = { schema: "control-room.mcp-proposal/v1", ...parsed.data, tenantId: grant.tenantId, actorId: grant.actorId,
        clientId: grant.clientId, kind: "job_proposal", requestedAt: now };
    } else if (name === "control_room.delegation.propose") {
      const parsed = delegationProposalInputSchemaV1.safeParse(args); if (!parsed.success) return denied("invalid_tool_input");
      if (!grantedProjects.has(parsed.data.projectId) || parsed.data.childAuthority.projectId !== parsed.data.projectId) return denied("project_denied");
      assertAuthorityDigest(parsed.data.childAuthority);
      const parent = await this.options.authorities.resolve({ tenantId: grant.tenantId, projectId: parsed.data.projectId,
        authorityDigest: parsed.data.parentAuthorityDigest });
      if (!parent || parent.digest !== parsed.data.parentAuthorityDigest) return denied("scope_denied");
      assertAuthorityDigest(parent); assertDelegatedAuthority(parent, parsed.data.childAuthority);
      record = { schema: "control-room.mcp-proposal/v1", ...parsed.data, tenantId: grant.tenantId, actorId: grant.actorId,
        clientId: grant.clientId, kind: "delegation_proposal", requestedAt: now };
    } else {
      const parsed = approvalRequestInputSchemaV1.safeParse(args); if (!parsed.success) return denied("invalid_tool_input");
      if (!grantedProjects.has(parsed.data.projectId)) return denied("project_denied");
      if (Date.parse(parsed.data.expiresAt) <= Date.parse(now) || Date.parse(parsed.data.expiresAt) > Date.parse(grant.expiresAt)) return denied("invalid_tool_input");
      record = { schema: "control-room.mcp-proposal/v1", ...parsed.data, tenantId: grant.tenantId, actorId: grant.actorId,
        clientId: grant.clientId, kind: "approval_request", requestedAt: now };
    }
    this.assertGrantCurrent(grant);
    const receipt = this.options.proposals.record(record);
    return toolResult(receipt as unknown as Record<string, unknown>);
  }

  private assertReplayResult(grant:ControlRoomMcpAccessGrantBodyV1,name:ControlRoomMcpToolNameV1,args:Record<string,unknown>,result:ControlRoomMcpToolResultV1):void {
    if (!exactKeys(result,result.isError===undefined?["content","structuredContent"]:["content","isError","structuredContent"])
      || !Array.isArray(result.content) || result.content.length!==1 || !exactKeys(result.content[0],["type","text"])
      || result.content[0].type!=="text" || !result.structuredContent || typeof result.structuredContent!=="object"
      || Array.isArray(result.structuredContent) || result.content[0].text!==canonicalJson(result.structuredContent)) throw new Error("replay invalid");
    assertSafeProjection(result.structuredContent); assertNoSecretMaterial(result,"MCP replay release");
    if (result.isError===true) {
      if (!exactKeys(result.structuredContent,["status","safeCode"]) || result.structuredContent.status!=="denied"
        || typeof result.structuredContent.safeCode!=="string" || !["invalid_tool_input","scope_denied","project_denied","replay_conflict","request_in_progress","request_failed"].includes(result.structuredContent.safeCode)) throw new Error("replay error invalid");
      return;
    }
    if (result.isError!==undefined) throw new Error("replay error flag invalid");
    const proposalKind=name==="control_room.job.propose"?"job_proposal":name==="control_room.delegation.propose"?"delegation_proposal":name==="control_room.approval.request"?"approval_request":undefined;
    if (proposalKind) {
      const value=result.structuredContent;
      if (!exactKeys(value,["receiptId","requestKind","requestDigest","state","grantsAuthority","dispatchCreated","replayed"])
        || value.requestKind!==proposalKind || value.state!=="recorded" || value.grantsAuthority!==false || value.dispatchCreated!==false
        || typeof value.replayed!=="boolean" || typeof value.receiptId!=="string" || typeof value.requestDigest!=="string") throw new Error("replay receipt invalid");
      return;
    }
    const value=result.structuredContent;
    if (!exactKeys(value,["items","count","truncated"]) || !Array.isArray(value.items) || value.count!==value.items.length
      || typeof value.truncated!=="boolean" || !Number.isSafeInteger(value.count)) throw new Error("replay read invalid");
    const requestedProject=typeof args.projectId==="string"?args.projectId:undefined;
    const projectIds=requestedProject?[requestedProject]:grant.projectIds;
    for (const item of value.items) {
      const parsed=name==="control_room.portfolio.read"?portfolioProjectProjectionSchemaV1.parse(item)
        : name==="control_room.fleet.read"?fleetWorkerSummarySchemaV1.parse(item)
        : name==="control_room.work.read"?activeWorkProjectionSchemaV1.parse(item)
        : name==="control_room.attention.read"?actionInboxItemSchemaV1.parse(item)
        : name==="control_room.request.read"?mcpRequestProjectionSchemaV1.parse(item)
        : name==="control_room.job.read"?mcpJobProjectionSchemaV1.parse(item):mcpArtifactProjectionSchemaV1.parse(item);
      if ("tenantId" in parsed && parsed.tenantId!==grant.tenantId) throw new Error("replay tenant invalid");
      if ("projectId" in parsed && (!parsed.projectId || !projectIds.includes(parsed.projectId))) throw new Error("replay project invalid");
      if (name==="control_room.job.read" && typeof args.jobId==="string" && "jobId" in parsed && parsed.jobId!==args.jobId) throw new Error("replay job invalid");
      if (name==="control_room.artifact.read" && typeof args.jobId==="string" && "jobId" in parsed && parsed.jobId!==args.jobId) throw new Error("replay job invalid");
    }
  }

  private trustedNow(): string {
    const value = this.options.clock(); const observed = Date.parse(value);
    if (!Number.isFinite(observed) || observed < this.lastObservedTimeMs || new Date(observed).toISOString() !== value) {
      throw new ControlRoomMcpTransportErrorV1("authentication_invalid", 403);
    }
    this.lastObservedTimeMs = observed;
    return value;
  }

  private assertGrantCurrent(grant:ControlRoomMcpAccessGrantBodyV1):void {
    if (Date.parse(this.trustedNow())>=Date.parse(grant.expiresAt)) throw new Error("MCP authentication expired");
  }

  private protocolError(id: string | number | null, code: -32600 | -32601 | -32602,
    message: "Invalid Request" | "Method not found" | "Invalid params"): ControlRoomMcpJsonRpcResponseV1 {
    return { jsonrpc: "2.0", id, error: { code, message } };
  }
}
