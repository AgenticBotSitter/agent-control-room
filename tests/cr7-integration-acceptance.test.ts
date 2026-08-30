import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  CODEX_PINNED_MACOS_CDHASH_V1,
  codexAdapterManifestV1,
  codexHarnessAdapterV1,
} from "../src/harness/codex-v1";
import {
  HERMES_REQUIRED_GATEWAY_METHODS_V1,
  hermesAdapterManifestV1,
  hermesHarnessAdapterV1,
} from "../src/harness/hermes-v1";
import { runHarnessAdapterConformanceV1 } from "../src/harness/sdk-v1";
import {
  HARNESS_EVENT_SCHEMA_VERSION_V1,
  HarnessRunStoreV1,
  type HarnessRunEventV1,
  type HarnessRunV1,
} from "../src/harness/v1";
import {
  CONTROL_ROOM_MCP_SERVER_AUDIENCE_V1,
  ControlRoomMcpClientV1,
  ControlRoomMcpServerV1,
  SqliteControlRoomMcpStateV1,
  digestControlRoomMcpBearerTokenV1,
  signControlRoomMcpAccessGrantV1,
  type ControlRoomMcpReadSourceV1,
} from "../src/mcp/v1";
import { runSyntheticExecution } from "../src/node-executor";
import {
  PACKAGE_REGISTRY_SCHEMA_VERSION_V1,
  PackageRegistryStoreV1,
  type PackageHarnessMappingInputV1,
  type PackageReviewV1,
  type ProcedurePackageV1,
} from "../src/package-registry/v1";
import { adaptPglite } from "../src/persistence/database";
import { sha256Digest } from "../src/security";

const tenantId = "tenant:cr7i";
const projectId = "project:cr7i";
const nodeId = "node:cr7i";
const jobId = "job:cr7i";
const attemptId = "attempt:cr7i:1";
const registryIntegrityKey = new Uint8Array(32).fill(0x17);
const harnessIntegrityKey = new Uint8Array(32).fill(0x27);
const mcpIntegrityKey = new Uint8Array(32).fill(0x37);
const bearerToken = "cr7i-local-bearer-0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeySpki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");

async function prepareDatabase(): Promise<PGlite> {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((entry) => entry.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(resolve("db/migrations",file),"utf8"));
  }
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ($1,'CR7I')`,[tenantId]);
  await raw.query(`INSERT INTO workspaces(id,tenant_id,display_name) VALUES ('workspace:cr7i',$1,'CR7I')`,[tenantId]);
  await raw.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,redaction_policy_version,cursor_retention_days)
    VALUES ('adapter:cr7i-source',$1,'fixture','v1','advisory','v1',30)`,[tenantId]);
  await raw.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
    VALUES ($1,$2,'workspace:cr7i','adapter:cr7i-source','source:cr7i','v1','CR7I','ready','ready','healthy','advisory','2026-08-28T12:00:00Z','{}'::jsonb)`,[projectId,tenantId]);
  await raw.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
    VALUES ($1,$2,'active',1,'key:cr7i',$3::jsonb,'2026-08-28T12:00:00Z','2026-08-28T12:00:00Z')`,[
    nodeId,tenantId,JSON.stringify({id:nodeId,tenantId,state:"active",version:1,identityKeyId:"key:cr7i"}),
  ]);
  return raw;
}

function procedurePackage(): ProcedurePackageV1 {
  return {
    schemaVersion:PACKAGE_REGISTRY_SCHEMA_VERSION_V1,id:"package:cr7i:procedure:1",tenantId,projectId,kind:"procedure",
    name:"disposable-build",version:"1.0.0",
    provenance:{sourceType:"owner",sourceId:"source:cr7i:procedure",sourceDigest:sha256Digest("cr7i procedure source"),
      producerId:"worker:cr7i-producer",producedAt:"2026-08-28T12:00:00.000Z"},
    compatibility:[
      {adapterId:hermesAdapterManifestV1.adapterId,adapterVersion:hermesAdapterManifestV1.adapterVersion,harness:"hermes",
        harnessVersion:hermesAdapterManifestV1.harnessVersion,requiredVerbs:["start","stream"],supportedPlatforms:["macos"]},
      {adapterId:codexAdapterManifestV1.adapterId,adapterVersion:codexAdapterManifestV1.adapterVersion,harness:"codex",
        harnessVersion:codexAdapterManifestV1.harnessVersion,requiredVerbs:["start","stream"],supportedPlatforms:["macos"]},
    ],
    separation:{grantsAuthority:false,suppliesPolicy:false,containsCredentials:false},createdAt:"2026-08-28T12:00:00.000Z",
    content:{objective:"Produce one disposable synthetic artifact with bounded evidence.",
      steps:[{id:"step:synthetic",instruction:"Run only the deterministic synthetic executor."}],
      acceptanceSteps:[{id:"check:evidence",check:"Verify scoped job and artifact evidence without native effects."}],
      inputRoles:["reviewed procedure"],outputRoles:["synthetic artifact","verification evidence"]},
  };
}

function mapping(
  item: ProcedurePackageV1,
  packageDigest: string,
  kind: "hermes" | "codex",
): PackageHarnessMappingInputV1 {
  const manifest = kind === "hermes" ? hermesAdapterManifestV1 : codexAdapterManifestV1;
  return {
    schemaVersion:PACKAGE_REGISTRY_SCHEMA_VERSION_V1,id:`mapping:cr7i:${kind}`,tenantId,projectId,packageId:item.id,packageDigest,
    adapterId:manifest.adapterId,adapterVersion:manifest.adapterVersion,harness:kind,harnessVersion:manifest.harnessVersion,
    platform:"macos",verifiedVerbs:["start","stream"],decision:"verified",verifierId:`worker:cr7i-${kind}-verifier`,
    evidenceDigests:[sha256Digest(`cr7i ${kind} mapping evidence`)],verifiedAt:"2026-08-28T12:00:02.000Z",
  };
}

async function materializeAcceptedSyntheticFixture(raw: PGlite, packageDigest: string, proposalDigest: string): Promise<string> {
  const materializationDigest = sha256Digest({packageDigest,proposalDigest,kind:"test-only-explicit-materialization"});
  await raw.query(`INSERT INTO control_requests(id,tenant_id,state,version,idempotency_key,payload,created_at,updated_at)
    VALUES ('request:cr7i',$1,'draft',0,'request-cr7i-key',$2::jsonb,'2026-08-28T12:00:12Z','2026-08-28T12:00:12Z')`,[
    tenantId,JSON.stringify({id:"request:cr7i",tenantId,state:"draft",version:0,idempotencyKey:"request-cr7i-key",proposalDigest,packageDigest}),
  ]);
  await raw.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
    VALUES ('workflow:cr7i',$1,'request:cr7i',$2,$3,'proposed',0,$4::jsonb,'2026-08-28T12:00:12Z','2026-08-28T12:00:12Z')`,[
    tenantId,projectId,materializationDigest,JSON.stringify({id:"workflow:cr7i",tenantId,requestId:"request:cr7i",projectId,definitionDigest:materializationDigest,state:"proposed",version:0}),
  ]);
  await raw.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,created_at,updated_at)
    VALUES ($1,$2,'workflow:cr7i',$3,'running',1,80,'capability:synthetic',$4,$5::jsonb,'2026-08-28T12:00:12Z','2026-08-28T12:00:12Z')`,[
    jobId,tenantId,projectId,materializationDigest,JSON.stringify({id:jobId,tenantId,workflowId:"workflow:cr7i",projectId,state:"running",version:1,
      priority:80,requiredCapability:"capability:synthetic",authority:{digest:materializationDigest},packageDigest,proposalDigest}),
  ]);
  await raw.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,node_id,lease_epoch,payload,created_at,updated_at)
    VALUES ($1,$2,$3,1,'running',1,$4,1,$5::jsonb,'2026-08-28T12:00:12Z','2026-08-28T12:00:12Z')`,[
    attemptId,tenantId,jobId,nodeId,JSON.stringify({id:attemptId,tenantId,jobId,attemptNumber:1,state:"running",version:1,nodeId,leaseEpoch:1}),
  ]);
  return materializationDigest;
}

function controlEvent(runId: string, sequence: number, occurredAt: string, state: "starting" | "running"): HarnessRunEventV1 {
  return {
    schemaVersion:HARNESS_EVENT_SCHEMA_VERSION_V1,tenantId,runId,sequence,occurredAt,source:"control_room",
    sourceEventKeyDigest:sha256Digest({runId,sequence,occurredAt,state,source:"control_room"}),payload:{category:"lifecycle",state},
  };
}

async function persistHermesObservation(store: HarnessRunStoreV1): Promise<HarnessRunV1> {
  const runId="run:cr7i:hermes"; const nativeSessionId="native:cr7i-hermes-private";
  const ready=hermesHarnessAdapterV1.normalizeEvent({jsonrpc:"2.0",method:"event",params:{type:"gateway.ready",session_id:nativeSessionId}},
    {tenantId,nodeId,runId,sequence:2,occurredAt:"2026-08-28T12:00:15.000Z",nativeSessionId});
  assert.ok(ready.nativeSessionKeyDigest);
  const run:HarnessRunV1={schemaVersion:"control-room-harness/v1",id:runId,tenantId,projectId,jobId,attemptId,nodeId,
    adapterId:hermesAdapterManifestV1.adapterId,adapterVersion:hermesAdapterManifestV1.adapterVersion,harness:"hermes",
    harnessVersion:hermesAdapterManifestV1.harnessVersion,nativeSessionKeyDigest:ready.nativeSessionKeyDigest,state:"discovered",resumable:true,
    cancelState:"not_requested",createdAt:"2026-08-28T12:00:13.000Z",updatedAt:"2026-08-28T12:00:13.000Z",lastObservedAt:"2026-08-28T12:00:13.000Z"};
  await store.create(run); await store.append(controlEvent(runId,1,"2026-08-28T12:00:14.000Z","starting"));
  for (const event of ready.events) await store.append(event);
  await store.append(controlEvent(runId,3,"2026-08-28T12:00:16.000Z","running"));
  for (const [sequence,occurredAt,type,payload] of [
    [4,"2026-08-28T12:00:17.000Z","tool.progress",undefined],
    [5,"2026-08-28T12:00:18.000Z","session.usage",{input_tokens:3,output_tokens:2}],
    [6,"2026-08-28T12:00:19.000Z","message.complete",undefined],
  ] as const) {
    const normalized=hermesHarnessAdapterV1.normalizeEvent({jsonrpc:"2.0",method:"event",params:{type,session_id:nativeSessionId,...(payload?{payload}:{})}},
      {tenantId,nodeId,runId,sequence,occurredAt,nativeSessionId});
    for (const event of normalized.events) await store.append(event);
  }
  return (await store.get(tenantId,runId))!;
}

async function persistCodexObservation(store: HarnessRunStoreV1): Promise<HarnessRunV1> {
  const runId="run:cr7i:codex"; const nativeThreadId="123e4567-e89b-12d3-a456-426614174000";
  const started=codexHarnessAdapterV1.normalizeEvent(JSON.stringify({type:"thread.started",thread_id:nativeThreadId}),
    {tenantId,nodeId,runId,sequence:2,occurredAt:"2026-08-28T12:00:22.000Z"});
  assert.ok(started.nativeSessionKeyDigest);
  const run:HarnessRunV1={schemaVersion:"control-room-harness/v1",id:runId,tenantId,projectId,jobId,attemptId,nodeId,
    adapterId:codexAdapterManifestV1.adapterId,adapterVersion:codexAdapterManifestV1.adapterVersion,harness:"codex",
    harnessVersion:codexAdapterManifestV1.harnessVersion,nativeSessionKeyDigest:started.nativeSessionKeyDigest,state:"discovered",resumable:true,
    cancelState:"not_requested",createdAt:"2026-08-28T12:00:20.000Z",updatedAt:"2026-08-28T12:00:20.000Z",lastObservedAt:"2026-08-28T12:00:20.000Z"};
  await store.create(run); await store.append(controlEvent(runId,1,"2026-08-28T12:00:21.000Z","starting"));
  for (const event of started.events) await store.append(event);
  const turnStarted=codexHarnessAdapterV1.normalizeEvent(JSON.stringify({type:"turn.started"}),
    {tenantId,nodeId,runId,sequence:3,occurredAt:"2026-08-28T12:00:23.000Z"});
  for (const event of turnStarted.events) await store.append(event);
  const completed=codexHarnessAdapterV1.normalizeEvent(JSON.stringify({type:"turn.completed",usage:{input_tokens:5,output_tokens:3}}),
    {tenantId,nodeId,runId,sequence:4,occurredAt:"2026-08-28T12:00:24.000Z"});
  for (const event of completed.events) await store.append(event);
  return (await store.get(tenantId,runId))!;
}

function emptyReads(): ControlRoomMcpReadSourceV1 {
  return {portfolio:async()=>[],fleet:async()=>[],activeWork:async()=>[],attention:async()=>[],requests:async()=>[],jobs:async()=>[],artifacts:async()=>[]};
}

test("CR7I reviewed package composes through safe adapters, authenticated history, proposal review, synthetic execution, and scoped evidence",async()=>{
  const raw=await prepareDatabase(); const directory=await mkdtemp(join(tmpdir(),"cr7i-acceptance-")); await chmod(directory,0o700);
  const statePath=join(directory,"mcp.sqlite");
  try {
    const registry=new PackageRegistryStoreV1(adaptPglite(raw),registryIntegrityKey); const item=procedurePackage();
    const registered=await registry.register(item); const review:PackageReviewV1={schemaVersion:PACKAGE_REGISTRY_SCHEMA_VERSION_V1,
      id:"review:cr7i:accepted",tenantId,projectId,packageId:item.id,packageDigest:registered.stored.packageDigest,
      producerId:item.provenance.producerId,reviewerId:"worker:cr7i-reviewer",decision:"accepted",reasonCode:"contract_verified",
      evidenceDigests:[sha256Digest("cr7i review evidence")],reviewedAt:"2026-08-28T12:00:01.000Z"};
    await registry.review(review);
    const hermesMapping=mapping(item,registered.stored.packageDigest,"hermes");
    const codexMapping=mapping(item,registered.stored.packageDigest,"codex");
    await registry.recordMapping(hermesMapping,hermesAdapterManifestV1); await registry.recordMapping(codexMapping,codexAdapterManifestV1);
    await registry.activate({schemaVersion:PACKAGE_REGISTRY_SCHEMA_VERSION_V1,id:"activation:cr7i",tenantId,projectId,
      packageId:item.id,packageDigest:registered.stored.packageDigest,reviewId:review.id,mappingId:hermesMapping.id,
      actorId:"actor:cr7i-registry",expectedActiveDigest:null,action:"promote",reasonCode:"review_gate_passed",activatedAt:"2026-08-28T12:00:03.000Z"});
    const active=await registry.resolveActive(tenantId,projectId,"procedure",item.name); assert.ok(active);
    assert.deepEqual({trust:active.trust,grantsAuthority:active.grantsAuthority,suppliesPolicy:active.suppliesPolicy,canApprove:active.canApprove,
      canDispatch:active.canDispatch,canExecute:active.canExecute,requiresSeparateAuthority:active.requiresSeparateAuthority},
      {trust:"reviewed_and_active",grantsAuthority:false,suppliesPolicy:false,canApprove:false,canDispatch:false,canExecute:false,requiresSeparateAuthority:true});

    assert.equal(runHarnessAdapterConformanceV1({adapter:hermesHarnessAdapterV1,compatibilityEvidence:{harnessVersion:"0.20.6",
      harnessRevision:hermesAdapterManifestV1.harnessRevision,gatewayMethods:[...HERMES_REQUIRED_GATEWAY_METHODS_V1]},fixtures:[]}).compatible,true);
    assert.equal(runHarnessAdapterConformanceV1({adapter:codexHarnessAdapterV1,compatibilityEvidence:{version:"0.150.0-alpha.8",
      macosCodeDirectoryHash:CODEX_PINNED_MACOS_CDHASH_V1,execJson:true,execResume:true,ignoreUserConfig:true,ignoreRules:true,
      credentialIsolation:"blocked",sandboxModes:["read-only","workspace-write"]},fixtures:[]}).compatible,true);
    for (const adapter of [hermesHarnessAdapterV1,codexHarnessAdapterV1]) {
      assert.equal("execute" in adapter,false); assert.equal("dispatch" in adapter,false); assert.equal("approve" in adapter,false);
    }

    const jobs:Awaited<ReturnType<ControlRoomMcpReadSourceV1["jobs"]>>=[];
    const artifacts:Awaited<ReturnType<ControlRoomMcpReadSourceV1["artifacts"]>>=[];
    const state=new SqliteControlRoomMcpStateV1(statePath,10_000,{integrityKey:mcpIntegrityKey});
    const accessGrant=signControlRoomMcpAccessGrantV1({schema:"control-room.mcp-access-grant/v1",grantId:"grant:cr7i",issuerKeyId:"issuer:cr7i",
      audience:CONTROL_ROOM_MCP_SERVER_AUDIENCE_V1,tenantId,actorId:"agent:cr7i",clientId:"client:cr7i",
      scopes:["control-room:artifact:read","control-room:job:propose","control-room:job:read"],projectIds:[projectId],
      issuedAt:"2026-08-28T11:59:00.000Z",expiresAt:"2026-08-28T12:10:00.000Z",tokenDigest:digestControlRoomMcpBearerTokenV1(bearerToken)},privateKey);
    const reads:ControlRoomMcpReadSourceV1={...emptyReads(),jobs:async()=>jobs,artifacts:async()=>artifacts};
    const server=new ControlRoomMcpServerV1({issuerKeyId:"issuer:cr7i",issuerPublicKeySpki:publicKeySpki,clock:()=>"2026-08-28T12:00:10.000Z",
      reads,authorities:{resolve:async()=>undefined},proposals:state,replay:state});
    const client=new ControlRoomMcpClientV1({send:async(input)=>server.handle({headers:{protocolVersion:input.headers["MCP-Protocol-Version"],
      method:input.headers["Mcp-Method"],...(input.headers["Mcp-Name"]?{toolName:input.headers["Mcp-Name"]}:{})},request:input.request,
      accessGrant:input.accessGrant,bearerToken:input.bearerToken})},{accessGrant,bearerToken});

    const proposal=await client.callTool("control_room.job.propose",{proposalId:"proposal:cr7i",idempotencyKey:"idempotency:cr7i:0001",
      projectId,jobType:"synthetic:cr7i",inputArtifactId:item.id,inputDigest:active.packageDigest,requiredCapability:"capability:synthetic",priority:80},
      "request:cr7i:propose");
    assert.deepEqual({grantsAuthority:proposal.structuredContent.grantsAuthority,dispatchCreated:proposal.structuredContent.dispatchCreated},
      {grantsAuthority:false,dispatchCreated:false});
    const beforeMaterialization=await client.callTool("control_room.job.read",{limit:10,projectId,jobId},"request:cr7i:before");
    assert.deepEqual(beforeMaterialization.structuredContent,{items:[],count:0,truncated:false});
    const pending=state.listPending({tenantId,limit:10}); assert.equal(pending.length,1); assert.equal(pending[0]?.kind,"job_proposal");
    if (pending[0]?.kind!=="job_proposal") throw new Error("CR7I proposal kind invalid");
    assert.equal(pending[0].inputDigest,active.packageDigest);
    const proposalDigest=proposal.structuredContent.requestDigest as string;
    state.decide({tenantId,proposalId:"proposal:cr7i",requestDigest:proposalDigest,decision:"accepted",decisionCode:"synthetic_policy_passed",
      decidedAt:"2026-08-28T12:00:11.000Z"});
    const materializationDigest=await materializeAcceptedSyntheticFixture(raw,active.packageDigest,proposalDigest);
    assert.notEqual(materializationDigest,active.packageDigest);

    const executionEvents:string[]=[]; const execution=await runSyntheticExecution({schema:"control-room.synthetic-execution/v1",jobId,attemptId,
      steps:2,checkpointEverySteps:1,stepDelayMilliseconds:0,artifactText:"CR7I synthetic result\n"},{signal:new AbortController().signal,
      now:()=>"2026-08-28T12:00:30.000Z",sleep:async()=>{},emit:(event)=>{executionEvents.push(event.event);}});
    assert.equal(execution.state,"succeeded"); if (execution.state!=="succeeded") throw new Error("CR7I synthetic execution failed");
    const contentHash=`sha256:${createHash("sha256").update(execution.artifactBytes).digest("hex")}`;

    const harnessStore=new HarnessRunStoreV1(adaptPglite(raw),harnessIntegrityKey);
    const hermesRun=await persistHermesObservation(harnessStore); const codexRun=await persistCodexObservation(harnessStore);
    assert.equal(hermesRun.state,"succeeded"); assert.equal(codexRun.state,"succeeded");
    assert.deepEqual((await harnessStore.events(tenantId,hermesRun.id)).map((event)=>event.sequence),[1,2,3,4,5,6]);
    assert.deepEqual((await harnessStore.events(tenantId,codexRun.id)).map((event)=>event.sequence),[1,2,3,4,5]);
    const watch=await harnessStore.watch(tenantId); assert.deepEqual(new Set(watch.map((run)=>run.harness)),new Set(["hermes","codex"]));
    const publicObservation=JSON.stringify({active,watch,hermesEvents:await harnessStore.events(tenantId,hermesRun.id),
      codexEvents:await harnessStore.events(tenantId,codexRun.id)});
    assert.equal(publicObservation.includes("native:cr7i-hermes-private"),false);
    assert.equal(publicObservation.includes("123e4567-e89b-12d3-a456-426614174000"),false);

    jobs.push({jobId,projectId,state:"succeeded",jobType:"synthetic:cr7i",updatedAt:"2026-08-28T12:00:31.000Z",
      resultArtifactIds:["artifact:cr7i:result"],reviewState:"ready"});
    artifacts.push({artifactId:"artifact:cr7i:result",projectId,jobId,attemptId,state:"verified",contentHash,
      sizeBytes:execution.artifactBytes.byteLength,mimeType:"text/plain",logicalRole:"synthetic-result",createdAt:"2026-08-28T12:00:31.000Z",
      verificationStatus:"verified"});
    const jobRead=await client.callTool("control_room.job.read",{limit:10,projectId,jobId},"request:cr7i:job");
    const artifactRead=await client.callTool("control_room.artifact.read",{limit:10,projectId,jobId},"request:cr7i:artifact");
    assert.deepEqual((jobRead.structuredContent.items as Array<{jobId:string;state:string;reviewState:string}>).map((value)=>[value.jobId,value.state,value.reviewState]),
      [[jobId,"succeeded","ready"]]);
    assert.deepEqual((artifactRead.structuredContent.items as Array<{contentHash:string;verificationStatus:string}>).map((value)=>[value.contentHash,value.verificationStatus]),
      [[contentHash,"verified"]]);
    assert.equal(executionEvents.at(-1),"completed");
    assert.deepEqual(state.evidence(),{replayEntries:4,pendingProposals:0,acceptedProposals:1,rejectedProposals:0,authorityGrants:0,dispatches:0});
    assert.equal(JSON.stringify({jobRead,artifactRead}).includes(bearerToken),false); state.close();
  } finally { await raw.close(); await rm(directory,{recursive:true,force:true}); }
});
