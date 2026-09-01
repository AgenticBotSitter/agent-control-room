import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createControlRoomLocalPilotRuntimeV1,LOCAL_PILOT_TENANT_ID_V1,LocalPilotErrorV1 } from "../src/local-pilot/v1/index.ts";
import { ProjectWorkspaceReadServiceV1 } from "../src/project-workspace/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";
import { createLocalPilotSessionStatusHandlerV1 } from "../app/api/v1/local-pilot/session/route.ts";

const origin="http://127.0.0.1:3000"as const,code="owner-code-local-pilot-0123456789abcdef";
function ownerRequest(path="/api/v1/local-pilot/session",cookie?:string,post=false){return new Request(`${origin}${path}`,{method:post?"POST":"GET",headers:{...(cookie?{cookie}:{}),...(post?{origin}:{}),"sec-fetch-site":"same-origin"}});}
function advance(value:string,seconds:number){return new Date(Date.parse(value)+seconds*1000).toISOString();}

test("CR12B-IDEA-060 performs one restart-safe loopback repository-fake owner flow",async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),"control-room-idea-pilot-")),masterKey=new Uint8Array(32).fill(71);let now="2026-08-31T20:00:00.000Z";
  const config={mode:"repository_fake"as const,origin,dataDir,repositoryRoot:process.cwd(),masterKey,
    ownerCodeDigest:sha256Digest({code}),clock:()=>now};
  let runtime=await createControlRoomLocalPilotRuntimeV1(config);
  assert.equal((await stat(dataDir)).mode&0o777,0o700);
  assert.equal((await runtime.connectionRosterSource.read({tenantId:LOCAL_PILOT_TENANT_ID_V1,now})).connectionCount,0);
  await assert.rejects(runtime.ownerSession.issue(ownerRequest(undefined,undefined,false),code),(error:unknown)=>error instanceof LocalPilotErrorV1&&error.safeCode==="local_request_required");
  await assert.rejects(runtime.ownerSession.issue(ownerRequest(undefined,undefined,true),`${code}-wrong`),(error:unknown)=>error instanceof LocalPilotErrorV1&&error.safeCode==="invalid_owner_code");
  const issued=await runtime.ownerSession.issue(ownerRequest(undefined,undefined,true),code),cookie=issued.cookie.split(";",1)[0]!;
  const statusResponse=await createLocalPilotSessionStatusHandlerV1(runtime.ownerSession,()=>now)(ownerRequest("/api/v1/local-pilot/session",cookie));
  assert.equal(statusResponse.status,200);assert.deepEqual(await statusResponse.json(),{authenticated:true,expiresAt:issued.expiresAt});
  await assert.rejects(runtime.ownerSession.issue(ownerRequest(undefined,undefined,true),code),(error:unknown)=>error instanceof LocalPilotErrorV1&&error.safeCode==="owner_code_consumed");
  const auth=await runtime.ownerSession.verify(ownerRequest("/ideas",cookie),now);
  const created=await runtime.operatorService.create({commandId:"command.idea.pilot.create",title:"Pilot idea",ideaSummary:"A bounded local business idea used only for the repository-fake pilot.",
    targetCustomer:"The local owner",maxRounds:1,maxDurationSeconds:300,maxCostUsd:2,requestedAt:now},auth);
  now=advance(now,1);const completed=await runtime.operatorService.start({commandId:"command.idea.pilot.start",sessionId:created.sessionId,requestedAt:now},auth);
  assert.equal(completed.state,"panel_complete");assert.equal(completed.providerContacted,false);assert.equal(completed.liveProviderConfigured,false);
  now=advance(now,1);const synthesized=await runtime.operatorService.synthesize({commandId:"command.idea.pilot.synthesize",sessionId:created.sessionId,requestedAt:now},auth);assert.equal(synthesized.state,"synthesized");
  now=advance(now,1);const decision=await runtime.ownerDecisionService.apply({sessionId:created.sessionId,authentication:auth,now,intent:{decision:"create_project",safeReasonCode:"owner_promoted_for_validation",
    project:{projectId:"project:local-pilot-idea",workspaceName:"Local Pilot Idea",title:"Validate local pilot idea",summary:"Repository-fake monitored project.",projectKind:"business_validation",priority:60}}});
  assert.equal(decision.project?.lifecycleState,"active");await runtime.syncCatalog(now);
  const scope=await runtime.scopeAuthority.authorize({credential:ownerRequest("/api/v1/project-workspace/project:local-pilot-idea",cookie),projectId:"project:local-pilot-idea",now});
  const protectedRead=await new ProjectWorkspaceReadServiceV1(runtime.readSource,[{tenantId:scope.tenantId,workspaceId:scope.workspaceId,projectId:scope.projectId}]).read({scope,now});
  assert.equal(protectedRead.state,"available");if(protectedRead.state==="available")assert.equal(protectedRead.model.portfolio.projectId,"project:local-pilot-idea");
  const promotedEvents=await runtime.projectEventSource.read({tenantId:scope.tenantId,workspaceId:scope.workspaceId,projectId:scope.projectId,limit:100});
  assert.deepEqual(promotedEvents.events.map(event=>event.safeSummary),["Idea promoted to a monitored project"]);
  now=advance(now,1);const paused=await runtime.lifecycleService.transition({commandId:"command.idea.pilot.pause",projectId:"project:local-pilot-idea",expectedVersion:1,action:"pause",requestedAt:now},auth);assert.equal(paused.lifecycleState,"paused");
  now=advance(now,1);const resumed=await runtime.lifecycleService.transition({commandId:"command.idea.pilot.resume",projectId:"project:local-pilot-idea",expectedVersion:2,action:"resume",requestedAt:now},auth);assert.equal(resumed.lifecycleState,"active");
  await runtime.close();now=advance(now,2);runtime=await createControlRoomLocalPilotRuntimeV1(config);
  assert.equal((await runtime.connectionRosterSource.read({tenantId:LOCAL_PILOT_TENANT_ID_V1,now})).connectionCount,0);
  const resumedAuth=await runtime.ownerSession.verify(ownerRequest("/ideas",cookie),now),sessions=await runtime.operatorService.list(resumedAuth),project=await runtime.lifecycleService.get("project:local-pilot-idea",resumedAuth);
  assert.equal(sessions.length,1);assert.equal(sessions[0]?.sessionId,created.sessionId);assert.equal(sessions[0]?.state,"decided");assert.equal(project.version,3);assert.equal(project.lifecycleState,"active");
  const scopeAfterRestart=await runtime.scopeAuthority.authorize({credential:ownerRequest("/api/v1/project-workspace/project:local-pilot-idea",cookie),projectId:project.projectId,now});assert.equal(scopeAfterRestart.catalogRevision,1);
  const durableEvents=await runtime.projectEventSource.read({tenantId:scopeAfterRestart.tenantId,workspaceId:scopeAfterRestart.workspaceId,projectId:scopeAfterRestart.projectId,limit:100});
  assert.deepEqual(durableEvents.events.map(event=>event.safeSummary),["Idea promoted to a monitored project","Project lifecycle changed to paused","Project lifecycle changed to active"]);
  await assert.rejects(runtime.ownerSession.verify(new Request(`${origin}/ideas`,{headers:{cookie,"x-forwarded-for":"127.0.0.1"}}),now),(error:unknown)=>error instanceof LocalPilotErrorV1&&error.safeCode==="local_request_required");
  await runtime.close();
});

test("CR12B-IDEA-060 rejects pilot data inside the repository",async()=>{await assert.rejects(createControlRoomLocalPilotRuntimeV1({mode:"repository_fake",origin,dataDir:join(process.cwd(),"pilot-data"),repositoryRoot:process.cwd(),
  masterKey:new Uint8Array(32).fill(1),ownerCodeDigest:sha256Digest({code})}),(error:unknown)=>error instanceof LocalPilotErrorV1&&error.safeCode==="invalid_local_pilot_configuration");});
