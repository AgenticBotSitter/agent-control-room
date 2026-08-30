import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { AuthorityEnvelope } from "../src/domain/v1";
import {
  CONTROL_ROOM_MCP_PROTOCOL_REVISION_V1, CONTROL_ROOM_MCP_SERVER_AUDIENCE_V1,
  ControlRoomMcpClientErrorV1, ControlRoomMcpClientV1, ControlRoomMcpServerV1, ControlRoomMcpTransportErrorV1, InMemoryControlRoomMcpProposalStoreV1,
  InMemoryControlRoomMcpReplayLedgerV1, SqliteControlRoomMcpStateV1, digestControlRoomMcpBearerTokenV1, digestControlRoomMcpProposalRecordV1,
  signControlRoomMcpAccessGrantV1, type ControlRoomMcpAccessGrantV1, type ControlRoomMcpProposalRecordV1,
  type ControlRoomMcpReadSourceV1, type ControlRoomMcpScopeV1, type ControlRoomMcpToolNameV1,
} from "../src/mcp/v1";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import { runSyntheticExecution } from "../src/node-executor";

const initialNow = "2026-08-28T12:00:00.000Z";
const bearerToken = "mcp-local-bearer-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const digestA = sha256Digest("artifact:a");
const mcpIntegrityKey=new Uint8Array(32).fill(13);
const durableReplayBinding={toolName:"control_room.portfolio.read" as const,tenantId:"tenant:one",projectScopeDigest:sha256Digest(["project:one"]),grantBodyDigest:sha256Digest("grant:durable")};
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeySpki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");

function authority(overrides: Partial<AuthorityEnvelope> = {}): AuthorityEnvelope {
  const material = { projectId: "project:one", allowedExecutor: "executor:synthetic", allowedOperations: ["operation:read", "operation:render"],
    credentialRefs: [], filesystemRoots: [], networkPolicy: "none" as const, allowedNetworkDestinations: [], effectPolicy: "none" as const,
    maxRisk: "low" as const, maxDurationSeconds: 300, maxConcurrentEffects: 0, expiresAt: "2026-08-28T13:00:00.000Z", ...overrides };
  const result = { ...material, digest: "" } as AuthorityEnvelope; result.digest = computeAuthorityDigest(result); return result;
}

function grant(scopes: ControlRoomMcpScopeV1[], projectIds = ["project:one"]): ControlRoomMcpAccessGrantV1 {
  return signControlRoomMcpAccessGrantV1({ schema: "control-room.mcp-access-grant/v1", grantId: "grant:test", issuerKeyId: "issuer:test",
    audience: CONTROL_ROOM_MCP_SERVER_AUDIENCE_V1, tenantId: "tenant:one", actorId: "agent:one", clientId: "client:one",
    scopes: [...scopes].sort(), projectIds: [...projectIds].sort(), issuedAt: "2026-08-28T11:59:00.000Z",
    expiresAt: "2026-08-28T12:10:00.000Z", tokenDigest: digestControlRoomMcpBearerTokenV1(bearerToken) },privateKey);
}

function emptyReads(): ControlRoomMcpReadSourceV1 {
  return { portfolio: async () => [], fleet: async () => [], activeWork: async () => [], attention: async () => [],
    requests: async () => [], jobs: async () => [], artifacts: async () => [] };
}

function makeServer(input: { scopes?: ControlRoomMcpScopeV1[]; reads?: ControlRoomMcpReadSourceV1;
  proposals?: InMemoryControlRoomMcpProposalStoreV1;
  replay?: InMemoryControlRoomMcpReplayLedgerV1;
  resolve?: (input: { tenantId: string; projectId: string; authorityDigest: string }) => Promise<AuthorityEnvelope | undefined>;
  clock?: () => string } = {}) {
  const proposals = input.proposals ?? new InMemoryControlRoomMcpProposalStoreV1();
  const replay = input.replay ?? new InMemoryControlRoomMcpReplayLedgerV1();
  const accessGrant = grant(input.scopes ?? ["control-room:portfolio:read"]);
  const server = new ControlRoomMcpServerV1({ issuerKeyId: "issuer:test", issuerPublicKeySpki: publicKeySpki,
    clock: input.clock ?? (() => initialNow), reads: input.reads ?? emptyReads(), authorities: { resolve: input.resolve ?? (async () => undefined) },
    proposals, replay });
  return { server, accessGrant, proposals, replay };
}

function request(method: string, params?: Record<string, unknown>, id: string | number = "rpc:1") {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}
function call(name: ControlRoomMcpToolNameV1, args: Record<string, unknown>, requestId = "request:one") {
  return request("tools/call", { name, arguments: args, _meta: { "com.control-room/requestId": requestId } });
}
async function handle(server: ControlRoomMcpServerV1, accessGrant: ControlRoomMcpAccessGrantV1, rawRequest: unknown,
  method: string, toolName?: ControlRoomMcpToolNameV1, token = bearerToken) {
  return server.handle({ headers: { protocolVersion: CONTROL_ROOM_MCP_PROTOCOL_REVISION_V1, method, ...(toolName ? { toolName } : {}) },
    request: rawRequest, accessGrant, bearerToken: token });
}
function structured(response: Awaited<ReturnType<ControlRoomMcpServerV1["handle"]>>): Record<string, unknown> {
  assert.ok("result" in response && typeof response.result === "object" && response.result !== null && "structuredContent" in response.result);
  return (response.result as { structuredContent: Record<string, unknown> }).structuredContent;
}

test("CR7C stateless discovery authenticates every request and advertises no session authority", async () => {
  const { server, accessGrant } = makeServer();
  await assert.rejects(() => server.handle({ headers: {}, request: request("server/discover") }),
    (error: unknown) => error instanceof ControlRoomMcpTransportErrorV1 && error.httpStatus === 401);
  const response = await handle(server,accessGrant,request("server/discover"),"server/discover");
  assert.deepEqual(response,{ jsonrpc: "2.0", id: "rpc:1", result: { protocolVersion: "2026-07-28",
    capabilities: { tools: { listChanged: false } }, authorityModel: "per_request_scoped" } });
  assert.equal(JSON.stringify(response).includes("session"),false);
});

test("CR7C rejects a wrong or forged bearer-bound access grant", async () => {
  const { server, accessGrant } = makeServer();
  await assert.rejects(() => handle(server,accessGrant,request("server/discover"),"server/discover",undefined,"wrong-bearer-token-012345678901234567890"),
    (error: unknown) => error instanceof ControlRoomMcpTransportErrorV1 && error.httpStatus === 403);
  const forged = structuredClone(accessGrant); forged.body.actorId = "agent:attacker";
  await assert.rejects(() => handle(server,forged,request("server/discover"),"server/discover"),
    (error: unknown) => error instanceof ControlRoomMcpTransportErrorV1 && error.httpStatus === 403);
});

test("CR7C tool discovery is deterministic, scope-filtered, and exposes no authority operation", async () => {
  const { server, accessGrant } = makeServer({ scopes: ["control-room:job:propose","control-room:portfolio:read","control-room:approval:request"] });
  const response = await handle(server,accessGrant,request("tools/list",{}),"tools/list");
  assert.ok("result" in response && "tools" in response.result);
  const names = (response.result.tools as Array<{ name: string }>).map((tool) => tool.name);
  assert.deepEqual(names,["control_room.portfolio.read","control_room.job.propose","control_room.approval.request"]);
  assert.equal(names.some((name) => /approve|execute|dispatch|credential/.test(name)),false);
});

test("CR7C rejects malformed envelopes and mismatched headers without executing", async () => {
  const { server, accessGrant, proposals } = makeServer({ scopes: ["control-room:job:propose"] });
  assert.deepEqual(await handle(server,accessGrant,null,"tools/call"),{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  const malformed = await server.handle({ headers: { protocolVersion: CONTROL_ROOM_MCP_PROTOCOL_REVISION_V1, method: "tools/list", extra: true },
    request: request("tools/list",{}), accessGrant, bearerToken });
  assert.deepEqual(malformed,{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  const mismatch = await handle(server,accessGrant,call("control_room.job.propose",{}),"tools/call","control_room.portfolio.read");
  assert.ok("error" in mismatch && mismatch.error.code === -32602);
  const hostileId=await handle(server,accessGrant,request("tools/list",{},"Bearer secret-canary-0123456789"),"tools/list");
  assert.equal(JSON.stringify(hostileId).includes("secret-canary"),false); assert.deepEqual(hostileId,{jsonrpc:"2.0",id:null,error:{code:-32600,message:"Invalid Request"}});
  assert.deepEqual(proposals.evidence(),{ records: 0, authorityGrants: 0, dispatches: 0 });
});

test("CR7C portfolio reads filter project scope without leaking hidden-row truncation", async () => {
  const reads = { ...emptyReads(), portfolio: async () => [
    { projectId: "project:hidden", workflowCount: 9, activeJobCount: 9, waitingApprovalJobCount: 9, failedJobCount: 9, lastActivityAt: initialNow },
    { projectId: "project:one", workflowCount: 1, activeJobCount: 0, waitingApprovalJobCount: 0, failedJobCount: 0, lastActivityAt: initialNow }] };
  const { server, accessGrant } = makeServer({ scopes: ["control-room:portfolio:read"], reads });
  assert.deepEqual(structured(await handle(server,accessGrant,call("control_room.portfolio.read",{ limit: 1 }),"tools/call","control_room.portfolio.read")),
    { items: [{ projectId: "project:one", workflowCount: 1, activeJobCount: 0, waitingApprovalJobCount: 0, failedJobCount: 0, lastActivityAt: initialNow }], count: 1, truncated: false });
});

test("CR7C cross-project reads and proposals are denied", async () => {
  const { server, accessGrant, proposals } = makeServer({ scopes: ["control-room:work:read","control-room:job:propose"] });
  assert.deepEqual(structured(await handle(server,accessGrant,call("control_room.work.read",{ limit: 10, projectId: "project:other" }),"tools/call","control_room.work.read")),
    { status: "denied", safeCode: "project_denied" });
  const proposal = { proposalId: "proposal:one", idempotencyKey: "idempotency:job:0001", projectId: "project:other", jobType: "job:render",
    inputArtifactId: "artifact:one", inputDigest: digestA, requiredCapability: "capability:render", priority: 50 };
  assert.deepEqual(structured(await handle(server,accessGrant,call("control_room.job.propose",proposal,"request:proposal"),"tools/call","control_room.job.propose")),
    { status: "denied", safeCode: "project_denied" });
  assert.equal(proposals.evidence().records,0);
});

test("CR7C job proposal records intent only and transport replay is stable", async () => {
  const { server, accessGrant, proposals } = makeServer({ scopes: ["control-room:job:propose"] });
  const proposal = { proposalId: "proposal:one", idempotencyKey: "idempotency:job:0001", projectId: "project:one", jobType: "job:render",
    inputArtifactId: "artifact:one", inputDigest: digestA, requiredCapability: "capability:render", priority: 50 };
  const first = structured(await handle(server,accessGrant,call("control_room.job.propose",proposal),"tools/call","control_room.job.propose"));
  const replay = structured(await handle(server,accessGrant,call("control_room.job.propose",proposal),"tools/call","control_room.job.propose"));
  assert.deepEqual(replay,first); assert.equal(first.grantsAuthority,false); assert.equal(first.dispatchCreated,false);
  assert.deepEqual(proposals.evidence(),{ records: 1, authorityGrants: 0, dispatches: 0 });
});

test("CR7C changed arguments under a reused request ID are a replay conflict", async () => {
  const { server, accessGrant } = makeServer({ scopes: ["control-room:portfolio:read"] });
  await handle(server,accessGrant,call("control_room.portfolio.read",{ limit: 1 },"request:same"),"tools/call","control_room.portfolio.read");
  assert.deepEqual(structured(await handle(server,accessGrant,call("control_room.portfolio.read",{ limit: 2 },"request:same"),"tools/call","control_room.portfolio.read")),
    { status: "denied", safeCode: "replay_conflict" });
});

test("CR7C proposal idempotency survives a new request and later server time", async () => {
  let observed = initialNow; const setup = makeServer({ scopes: ["control-room:job:propose"], clock: () => observed });
  const proposal = { proposalId: "proposal:one", idempotencyKey: "idempotency:job:0001", projectId: "project:one", jobType: "job:render",
    inputArtifactId: "artifact:one", inputDigest: digestA, requiredCapability: "capability:render", priority: 50 };
  const first = structured(await handle(setup.server,setup.accessGrant,call("control_room.job.propose",proposal,"request:first"),"tools/call","control_room.job.propose"));
  observed = "2026-08-28T12:01:00.000Z";
  const second = structured(await handle(setup.server,setup.accessGrant,call("control_room.job.propose",proposal,"request:second"),"tools/call","control_room.job.propose"));
  assert.equal(first.replayed,false); assert.equal(second.replayed,true); assert.equal(first.requestDigest,second.requestDigest);
});

test("CR7C delegation accepts only a digest-valid narrowing of an authoritative parent", async () => {
  const parent = authority(); const child = authority({ allowedOperations: ["operation:read"], maxDurationSeconds: 120, parentDigest: parent.digest });
  const setup = makeServer({ scopes: ["control-room:delegation:propose"], resolve: async (input) => input.authorityDigest === parent.digest ? parent : undefined });
  const proposal = { proposalId: "proposal:delegation", idempotencyKey: "idempotency:delegation:0001", projectId: "project:one",
    parentAuthorityDigest: parent.digest, childAuthority: child };
  const accepted = structured(await handle(setup.server,setup.accessGrant,call("control_room.delegation.propose",proposal),"tools/call","control_room.delegation.propose"));
  assert.equal(accepted.grantsAuthority,false); assert.equal(setup.proposals.evidence().records,1);
  const expanded = authority({ allowedOperations: ["operation:read","operation:render","operation:publish"], parentDigest: parent.digest });
  assert.deepEqual(structured(await handle(setup.server,setup.accessGrant,call("control_room.delegation.propose",{ ...proposal,
    proposalId: "proposal:expanded", idempotencyKey: "idempotency:delegation:0002", childAuthority: expanded },"request:expanded"),"tools/call","control_room.delegation.propose")),
    { status: "denied", safeCode: "request_failed" });
  assert.equal(setup.proposals.evidence().records,1);
});

test("CR7C approval requests remain requests and expire within the grant", async () => {
  const setup = makeServer({ scopes: ["control-room:approval:request"] });
  const proposal = { proposalId: "proposal:approval", idempotencyKey: "idempotency:approval:0001", projectId: "project:one",
    operationDigest: digestA, risk: "high", reasonCode: "owner_review_required", evidenceDigests: [sha256Digest("evidence")],
    expiresAt: "2026-08-28T12:05:00.000Z" };
  const receipt = structured(await handle(setup.server,setup.accessGrant,call("control_room.approval.request",proposal),"tools/call","control_room.approval.request"));
  assert.equal(receipt.requestKind,"approval_request"); assert.equal(receipt.grantsAuthority,false); assert.equal(receipt.dispatchCreated,false);
  assert.deepEqual(structured(await handle(setup.server,setup.accessGrant,call("control_room.approval.request",{ ...proposal, proposalId: "proposal:late",
    idempotencyKey: "idempotency:approval:0002", expiresAt: "2026-08-28T12:11:00.000Z" },"request:late"),"tools/call","control_room.approval.request")),
    { status: "denied", safeCode: "invalid_tool_input" });
});

test("CR7C secret inputs fail closed and never echo the canary", async () => {
  const setup = makeServer({ scopes: ["control-room:approval:request"] }); const canary = "Bearer secret-canary-0123456789";
  const response = await handle(setup.server,setup.accessGrant,call("control_room.approval.request",{ proposalId: "proposal:secret",
    idempotencyKey: "idempotency:approval:0001", projectId: "project:one", operationDigest: digestA, risk: "high", reasonCode: canary,
    evidenceDigests: [], expiresAt: "2026-08-28T12:05:00.000Z" }),"tools/call","control_room.approval.request");
  assert.equal(JSON.stringify(response).includes(canary),false); assert.deepEqual(structured(response),{ status: "denied", safeCode: "request_failed" });
});

test("CR7C rechecks expiry before mutation and rejects clock rollback", async () => {
  let calls = 0; const times = [initialNow,"2026-08-28T12:10:00.000Z"];
  const setup = makeServer({ scopes: ["control-room:job:propose"], clock: () => times[Math.min(calls++,times.length - 1)]! });
  const proposal = { proposalId: "proposal:expiry", idempotencyKey: "idempotency:job:expiry", projectId: "project:one", jobType: "job:render",
    inputArtifactId: "artifact:one", inputDigest: digestA, requiredCapability: "capability:render", priority: 50 };
  assert.deepEqual(structured(await handle(setup.server,setup.accessGrant,call("control_room.job.propose",proposal),"tools/call","control_room.job.propose")),
    { status: "denied", safeCode: "request_failed" }); assert.equal(setup.proposals.evidence().records,0);
  let observed = initialNow; const rollback = makeServer({ clock: () => observed });
  await handle(rollback.server,rollback.accessGrant,request("server/discover"),"server/discover"); observed = "2026-08-28T11:59:59.000Z";
  await assert.rejects(() => handle(rollback.server,rollback.accessGrant,request("server/discover",undefined,"rpc:2"),"server/discover"),
    (error: unknown) => error instanceof ControlRoomMcpTransportErrorV1 && error.httpStatus === 403);
});

test("CR7Q an access grant that expires during a read cannot release the result",async()=>{
  let calls=0; let reads=0; const times=[initialNow,initialNow,"2026-08-28T12:10:00.000Z"];
  const setup=makeServer({scopes:["control-room:portfolio:read"],clock:()=>times[Math.min(calls++,times.length-1)]!,reads:{...emptyReads(),portfolio:async()=>{reads++; return [{projectId:"project:one",workflowCount:1,activeJobCount:0,waitingApprovalJobCount:0,failedJobCount:0,lastActivityAt:initialNow}];}}});
  const response=await handle(setup.server,setup.accessGrant,call("control_room.portfolio.read",{limit:1}),"tools/call","control_room.portfolio.read");
  assert.equal(reads,1); assert.deepEqual(structured(response),{status:"denied",safeCode:"request_failed"});
});

test("CR7Q independent remediation rechecks expiry before replay release and proposal commit",async()=>{
  let replayClockCalls=0; const replayTimes=[initialNow,initialNow,initialNow,initialNow,"2026-08-28T12:10:00.000Z"];
  const replay=makeServer({scopes:["control-room:portfolio:read"],clock:()=>replayTimes[Math.min(replayClockCalls++,replayTimes.length-1)]!});
  const replayCall=call("control_room.portfolio.read",{limit:1},"request:expiring-replay");
  assert.deepEqual(structured(await handle(replay.server,replay.accessGrant,replayCall,"tools/call","control_room.portfolio.read")),{items:[],count:0,truncated:false});
  assert.deepEqual(structured(await handle(replay.server,replay.accessGrant,replayCall,"tools/call","control_room.portfolio.read")),{status:"denied",safeCode:"request_failed"});

  let mutationClockCalls=0; const mutationTimes=[initialNow,initialNow,"2026-08-28T12:10:00.000Z"];
  const parent=authority(); const child=authority({allowedOperations:["operation:read"],maxDurationSeconds:120,parentDigest:parent.digest});
  const mutation=makeServer({scopes:["control-room:delegation:propose"],clock:()=>mutationTimes[Math.min(mutationClockCalls++,mutationTimes.length-1)]!,resolve:async()=>parent});
  const response=await handle(mutation.server,mutation.accessGrant,call("control_room.delegation.propose",{proposalId:"proposal:expiry-after-resolve",idempotencyKey:"idempotency:expiry:resolve",projectId:"project:one",parentAuthorityDigest:parent.digest,childAuthority:child}),"tools/call","control_room.delegation.propose");
  assert.deepEqual(structured(response),{status:"denied",safeCode:"request_failed"}); assert.equal(mutation.proposals.evidence().records,0);
});

test("CR7C durable state survives restart and review still cannot dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(),"cr7c-mcp-state-")); await chmod(directory,0o700); const path = join(directory,"state.sqlite");
  try {
    let state = new SqliteControlRoomMcpStateV1(path,100_000,{integrityKey:mcpIntegrityKey});
    const record: ControlRoomMcpProposalRecordV1 = { schema: "control-room.mcp-proposal/v1", proposalId: "proposal:durable",
      idempotencyKey: "idempotency:durable:0001", tenantId: "tenant:one", actorId: "agent:one", clientId: "client:one",
      projectId: "project:one", kind: "job_proposal", jobType: "job:render", inputArtifactId: "artifact:one", inputDigest: digestA,
      requiredCapability: "capability:render", priority: 50, requestedAt: initialNow };
    const first = await state.record(record); state.claim({ replayKey: sha256Digest("replay:abandoned"), requestDigest: sha256Digest("request:one"),binding:durableReplayBinding }); state.close();
    state = new SqliteControlRoomMcpStateV1(path,100_000,{integrityKey:mcpIntegrityKey});
    const second = await state.record({ ...record, requestedAt: "2026-08-28T12:01:00.000Z" });
    assert.equal(second.replayed,true); assert.equal(second.requestDigest,first.requestDigest);
    assert.deepEqual(state.listPending({ tenantId: "tenant:one", limit: 10 }).map((item) => item.proposalId),["proposal:durable"]);
    assert.deepEqual(state.decide({ tenantId: "tenant:one", proposalId: "proposal:durable", requestDigest: first.requestDigest,
      decision: "accepted", decisionCode: "policy_review_passed", decidedAt: "2026-08-28T12:02:00.000Z" }),{ replayed: false });
    assert.deepEqual(state.evidence(),{ replayEntries: 0, pendingProposals: 0, acceptedProposals: 1, rejectedProposals: 0, authorityGrants: 0, dispatches: 0 }); state.close();
  } finally { await rm(directory,{ recursive: true, force: true }); }
});

test("CR7C durable state rejects added triggers", async () => {
  const directory = await mkdtemp(join(tmpdir(),"cr7c-mcp-schema-")); await chmod(directory,0o700); const path = join(directory,"state.sqlite");
  try {
    const state = new SqliteControlRoomMcpStateV1(path,100_000,{integrityKey:mcpIntegrityKey}); state.close();
    const db = new DatabaseSync(path); db.exec("CREATE TRIGGER hostile AFTER INSERT ON mcp_proposals BEGIN DELETE FROM mcp_proposals; END"); db.close();
    assert.throws(() => new SqliteControlRoomMcpStateV1(path,100_000,{integrityKey:mcpIntegrityKey}),/schema invalid/);
  } finally { await rm(directory,{ recursive: true, force: true }); }
});

test("CR7C typed client uses current headers and never exposes its bearer secret", async () => {
  const setup = makeServer({ scopes: ["control-room:portfolio:read"] });
  const observedHeaders: Array<Record<string,string>> = [];
  const client = new ControlRoomMcpClientV1({ send: async (input) => {
    observedHeaders.push(input.headers);
    return setup.server.handle({ headers: { protocolVersion: input.headers["MCP-Protocol-Version"], method: input.headers["Mcp-Method"],
      ...(input.headers["Mcp-Name"] ? { toolName: input.headers["Mcp-Name"] } : {}) }, request: input.request,
      accessGrant: input.accessGrant, bearerToken: input.bearerToken });
  } },{ accessGrant: setup.accessGrant, bearerToken });
  assert.deepEqual(await client.discover("request:discover"),{ protocolVersion: "2026-07-28", authorityModel: "per_request_scoped" });
  assert.deepEqual((await client.listTools("request:list")).map((tool) => tool.name),["control_room.portfolio.read"]);
  const result = await client.callTool("control_room.portfolio.read",{ limit: 10 },"request:read");
  assert.deepEqual(result.structuredContent,{ items: [], count: 0, truncated: false });
  assert.deepEqual(observedHeaders[2],{ "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/call", "Mcp-Name": "control_room.portfolio.read" });
  assert.equal(JSON.stringify(client.evidence()).includes(bearerToken),false); assert.equal(client.evidence().authenticationIncluded,false);
});

test("CR7C typed client rejects malformed or secret-bearing server output", async () => {
  const accessGrant = grant(["control-room:portfolio:read"]);
  const malformed = new ControlRoomMcpClientV1({ send: async () => ({ jsonrpc: "2.0", id: "request:read", result: {
    content: [{ type: "text", text: "not canonical" }], structuredContent: { password: "secret-value" } } }) },{ accessGrant,bearerToken });
  await assert.rejects(() => malformed.callTool("control_room.portfolio.read",{ limit: 1 },"request:read"),
    (error: unknown) => error instanceof ControlRoomMcpClientErrorV1 && error.safeCode === "protocol_invalid");
});

test("CR7C durable state detects altered replay and proposal rows on read", async () => {
  const directory = await mkdtemp(join(tmpdir(),"cr7c-mcp-rows-")); await chmod(directory,0o700); const path = join(directory,"state.sqlite");
  try {
    const replayKey = sha256Digest("replay:complete"); const requestDigest = sha256Digest("request:complete");
    let state = new SqliteControlRoomMcpStateV1(path,100_000,{integrityKey:mcpIntegrityKey}); state.claim({ replayKey,requestDigest,binding:durableReplayBinding });
    state.complete({ replayKey,requestDigest,result: { content: [{ type: "text", text: "{}" }], structuredContent: {} } });
    await state.record({ schema: "control-room.mcp-proposal/v1", proposalId: "proposal:tamper", idempotencyKey: "idempotency:tamper:0001",
      tenantId: "tenant:one", actorId: "agent:one", clientId: "client:one", projectId: "project:one", kind: "job_proposal",
      jobType: "job:render", inputArtifactId: "artifact:one", inputDigest: digestA, requiredCapability: "capability:render", priority: 50,
      requestedAt: initialNow }); state.close();
    let db = new DatabaseSync(path); const original=(db.prepare("SELECT result_json FROM mcp_replay WHERE replay_key=?").get(replayKey) as {result_json:string}).result_json;
    db.prepare("UPDATE mcp_replay SET result_json=? WHERE replay_key=?").run("{}",replayKey); db.close();
    assert.throws(() => new SqliteControlRoomMcpStateV1(path,100_000,{integrityKey:mcpIntegrityKey}),/integrity invalid/);
    db = new DatabaseSync(path); db.prepare("UPDATE mcp_replay SET result_json=? WHERE replay_key=?").run(original,replayKey); db.close();
    state = new SqliteControlRoomMcpStateV1(path,100_000,{integrityKey:mcpIntegrityKey}); state.close();
    db = new DatabaseSync(path); db.prepare("UPDATE mcp_proposals SET record_json=? WHERE proposal_id='proposal:tamper'").run("{}"); db.close();
    assert.throws(() => new SqliteControlRoomMcpStateV1(path,100_000,{integrityKey:mcpIntegrityKey}),/integrity invalid/);
  } finally { await rm(directory,{ recursive: true, force: true }); }
});

test("CR7Q durable state rejects recomputed secret replay data and schema-valid-looking proposal expansion",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"cr7q-mcp-tamper-")); await chmod(directory,0o700); const path=join(directory,"state.sqlite");
  try {
    const replayKey=sha256Digest("replay:hostile"); const requestDigest=sha256Digest("request:hostile");
    const record:ControlRoomMcpProposalRecordV1={schema:"control-room.mcp-proposal/v1",proposalId:"proposal:hostile",idempotencyKey:"idempotency:hostile:0001",tenantId:"tenant:one",actorId:"agent:one",clientId:"client:one",projectId:"project:one",kind:"job_proposal",jobType:"job:render",inputArtifactId:"artifact:one",inputDigest:digestA,requiredCapability:"capability:render",priority:50,requestedAt:initialNow};
    const state=new SqliteControlRoomMcpStateV1(path,100_000,{integrityKey:mcpIntegrityKey}); state.claim({replayKey,requestDigest,binding:durableReplayBinding}); state.complete({replayKey,requestDigest,result:{content:[{type:"text",text:"{}"}],structuredContent:{}}}); await state.record(record); state.close();
    const hostileResult={content:[{type:"text",text:JSON.stringify({message:"Bearer secret-canary-0123456789"})}],structuredContent:{message:"Bearer secret-canary-0123456789"}};
    const expanded={...record,authority:{allowedOperations:["operation:publish"]}}; const expandedDigest=digestControlRoomMcpProposalRecordV1(expanded as ControlRoomMcpProposalRecordV1);
    const hostileReceipt={receiptId:`receipt:${expandedDigest.slice(7,39)}`,requestKind:"job_proposal",requestDigest:expandedDigest,state:"recorded",grantsAuthority:false,dispatchCreated:false,replayed:false};
    const db=new DatabaseSync(path); db.prepare("UPDATE mcp_replay SET result_json=?,result_digest=? WHERE replay_key=?").run(JSON.stringify(hostileResult),sha256Digest(hostileResult),replayKey);
    db.prepare("UPDATE mcp_proposals SET request_digest=?,record_json=?,receipt_json=? WHERE proposal_id='proposal:hostile'").run(expandedDigest,JSON.stringify(expanded),JSON.stringify(hostileReceipt)); db.close();
    assert.throws(()=>new SqliteControlRoomMcpStateV1(path,100_000,{integrityKey:mcpIntegrityKey}),/integrity invalid/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test("CR7C synthetic end-to-end proposes, policy-reviews, executes, and returns scoped job and artifact evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(),"cr7c-mcp-e2e-")); await chmod(directory,0o700); const path = join(directory,"state.sqlite");
  const jobs: Awaited<ReturnType<ControlRoomMcpReadSourceV1["jobs"]>> = [];
  const artifacts: Awaited<ReturnType<ControlRoomMcpReadSourceV1["artifacts"]>> = [];
  try {
    const state = new SqliteControlRoomMcpStateV1(path,100_000,{integrityKey:mcpIntegrityKey});
    const accessGrant = grant(["control-room:job:propose","control-room:job:read","control-room:artifact:read"]);
    const reads: ControlRoomMcpReadSourceV1 = { ...emptyReads(), jobs: async () => jobs, artifacts: async () => artifacts };
    const server = new ControlRoomMcpServerV1({ issuerKeyId: "issuer:test", issuerPublicKeySpki: publicKeySpki, clock: () => initialNow,
      reads, authorities: { resolve: async () => undefined }, proposals: state, replay: state });
    const client = new ControlRoomMcpClientV1({ send: async (input) => server.handle({ headers: {
      protocolVersion: input.headers["MCP-Protocol-Version"], method: input.headers["Mcp-Method"],
      ...(input.headers["Mcp-Name"] ? { toolName: input.headers["Mcp-Name"] } : {}) }, request: input.request,
      accessGrant: input.accessGrant, bearerToken: input.bearerToken }) },{ accessGrant,bearerToken });

    const proposalResult = await client.callTool("control_room.job.propose",{ proposalId: "proposal:e2e",
      idempotencyKey: "idempotency:e2e:0001", projectId: "project:one", jobType: "synthetic:render",
      inputArtifactId: "artifact:input", inputDigest: digestA, requiredCapability: "capability:synthetic", priority: 80 },"request:e2e:propose");
    assert.equal(proposalResult.structuredContent.grantsAuthority,false);
    const pending = state.listPending({ tenantId: "tenant:one", limit: 10 }); assert.equal(pending.length,1);
    const receiptDigest = proposalResult.structuredContent.requestDigest as string;
    state.decide({ tenantId: "tenant:one", proposalId: "proposal:e2e", requestDigest: receiptDigest,
      decision: "accepted", decisionCode: "synthetic_policy_passed", decidedAt: "2026-08-28T12:00:01.000Z" });

    const events: string[] = [];
    const execution = await runSyntheticExecution({ schema: "control-room.synthetic-execution/v1", jobId: "job:e2e", attemptId: "attempt:e2e:1",
      steps: 2, checkpointEverySteps: 1, stepDelayMilliseconds: 0, artifactText: "synthetic MCP result\n" },{
      signal: new AbortController().signal, now: () => "2026-08-28T12:00:02.000Z", sleep: async () => {},
      emit: (event) => { events.push(event.event); },
    });
    assert.equal(execution.state,"succeeded"); if (execution.state !== "succeeded") throw new Error("synthetic execution failed");
    const contentHash = `sha256:${createHash("sha256").update(execution.artifactBytes).digest("hex")}`;
    jobs.push({ jobId: "job:e2e", projectId: "project:one", state: "succeeded", jobType: "synthetic:render",
      updatedAt: "2026-08-28T12:00:02.000Z", resultArtifactIds: ["artifact:e2e:result"], reviewState: "ready" });
    artifacts.push({ artifactId: "artifact:e2e:result", projectId: "project:one", jobId: "job:e2e", attemptId: "attempt:e2e:1",
      state: "verified", contentHash, sizeBytes: execution.artifactBytes.byteLength, mimeType: "text/plain", logicalRole: "synthetic-result",
      createdAt: "2026-08-28T12:00:02.000Z", verificationStatus: "verified" });

    const jobResult = await client.callTool("control_room.job.read",{ limit: 10, projectId: "project:one", jobId: "job:e2e" },"request:e2e:job");
    const artifactResult = await client.callTool("control_room.artifact.read",{ limit: 10, projectId: "project:one", jobId: "job:e2e" },"request:e2e:artifact");
    assert.deepEqual((jobResult.structuredContent.items as Array<{ state: string; reviewState: string }>).map((item) => [item.state,item.reviewState]),
      [["succeeded","ready"]]);
    assert.deepEqual((artifactResult.structuredContent.items as Array<{ contentHash: string; verificationStatus: string }>).map((item) => [item.contentHash,item.verificationStatus]),
      [[contentHash,"verified"]]);
    assert.equal(events.at(-1),"completed"); assert.deepEqual(state.evidence(),{ replayEntries: 3, pendingProposals: 0,
      acceptedProposals: 1, rejectedProposals: 0, authorityGrants: 0, dispatches: 0 }); state.close();
  } finally { await rm(directory,{ recursive: true, force: true }); }
});
