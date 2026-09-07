import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createControlRoomLocalPilotRuntimeV1,LOCAL_PILOT_TENANT_ID_V1,LocalPilotErrorV1 } from "../src/local-pilot/v1/index.ts";
import { ConnectionEnrollmentIntakeErrorV1,
  ConnectionEnrollmentPrivateLoopbackFramingErrorV1 } from "../src/connection-registry/v1/index.ts";
import { ProjectWorkspaceReadServiceV1 } from "../src/project-workspace/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";
import { createLocalPilotSessionStatusHandlerV1 } from "../app/api/v1/local-pilot/session/route.ts";
import { createLocalPilotProjectTaskHandlerV1 } from "../src/local-pilot/v1/project-task-http.ts";
import { createLocalPilotBrowserTransportV1 } from "../src/local-pilot/v1/browser-transport.ts";
import { createProjectBrowserClient } from "../src/web/v1/browser-client.ts";
import { createTaskBrowserClient } from "../src/web/v1/task-browser-client.ts";

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
  assert.equal(runtime.connectionEnrollmentPrivateLoopbackListener.enabled,false);
  await assert.rejects(runtime.connectionEnrollmentPrivateLoopbackListener.start(),(error:unknown)=>
    error instanceof ConnectionEnrollmentPrivateLoopbackFramingErrorV1&&error.safeCode==="disabled");
  await assert.rejects(runtime.connectionEnrollmentIntakeService.ingest({deliveryId:"delivery:local-pilot:disabled",receivedAt:now}),
    (error:unknown)=>error instanceof ConnectionEnrollmentIntakeErrorV1&&error.safeCode==="source_unavailable");
  await assert.rejects(runtime.ownerSession.issue(ownerRequest(undefined,undefined,false),code),(error:unknown)=>error instanceof LocalPilotErrorV1&&error.safeCode==="local_request_required");
  await assert.rejects(runtime.ownerSession.issue(ownerRequest(undefined,undefined,true),`${code}-wrong`),(error:unknown)=>error instanceof LocalPilotErrorV1&&error.safeCode==="invalid_owner_code");
  const issued=await runtime.ownerSession.issue(ownerRequest(undefined,undefined,true),code),cookie=issued.cookie.split(";",1)[0]!;
  const read=()=>ownerRequest("/local-preview",cookie),write=()=>ownerRequest("/local-preview",cookie,true);
  const ordinaryDraft={title:"Synthetic research project",summary:"Disposable project used to exercise the existing task services."};
  await assert.rejects(runtime.projectTasks.listProjects(ownerRequest("/local-preview")),/authentication_required/);
  await assert.rejects(runtime.projectTasks.createProject(read(),ordinaryDraft,"pilot-create-project-0001"),/local_request_required/);
  await assert.rejects(runtime.projectTasks.createProject(new Request(`${origin}/local-preview`,{method:"POST",headers:{cookie}}),ordinaryDraft,"pilot-create-project-0001"),/local_request_required/);
  await assert.rejects(runtime.projectTasks.listProjects(new Request("http://other.invalid/local-preview",{headers:{cookie}})),/local_request_required/);
  const ordinary=await runtime.projectTasks.createProject(write(),ordinaryDraft,"pilot-create-project-0001");
  assert.equal(ordinary.replayed,false);
  assert.equal((await runtime.projectTasks.createProject(write(),ordinaryDraft,"pilot-create-project-0001")).replayed,true);
  const another=await runtime.projectTasks.createProject(write(),{...ordinaryDraft,title:"Separate synthetic project"},"pilot-create-project-0002");
  assert.equal((await runtime.projectTasks.listProjects(read())).projects.length,2);
  const taskDraft={title:"Compare two ideas",instructions:"Prepare a simulated comparison. No agent is to be started."};
  const proposed=await runtime.projectTasks.proposeTask(write(),ordinary.project.projectId,taskDraft,"pilot-propose-task-0001");
  assert.equal(proposed.receipt.startsWork,false);
  assert.equal((await runtime.projectTasks.proposeTask(write(),ordinary.project.projectId,taskDraft,"pilot-propose-task-0001")).replayed,true);
  const endpoint=`${origin}/api/v1/local-pilot/workspace`,handler=createLocalPilotProjectTaskHandlerV1(runtime.projectTasks);
  const pageResponse=await handler(new Request(`${endpoint}?resource=projects`,{headers:{cookie}}));
  assert.equal(pageResponse.status,200);assert.equal((await pageResponse.json()).projects.length,2);
  assert.equal(pageResponse.headers.get("cache-control"),"no-store");
  assert.equal(pageResponse.headers.get("x-control-room-pilot"),"repository-fake");
  assert.equal((await handler(new Request(`${endpoint}?resource=projects`))).status,401);
  assert.equal((await handler(new Request(`${endpoint}?resource=projects&resource=tasks`,{headers:{cookie}}))).status,400);
  assert.equal((await handler(new Request(`${endpoint}?resource=projects&tenantId=other`,{headers:{cookie}}))).status,400);
  const commandBody=JSON.stringify({operation:"propose_task",projectId:ordinary.project.projectId,draft:taskDraft});
  const commandRequest=(body=commandBody,suppliedOrigin:string=origin)=>new Request(endpoint,{method:"POST",
    headers:{cookie,origin:suppliedOrigin,"content-type":"application/json","idempotency-key":"pilot-propose-task-0001"},body});
  const replayResponse=await handler(commandRequest());
  assert.equal(replayResponse.status,200);assert.equal((await replayResponse.json()).receipt.startsWork,false);
  assert.equal((await handler(commandRequest(commandBody,"http://other.invalid"))).status,403);
  assert.equal((await handler(commandRequest("x".repeat(24_577)))).status,400);
  assert.equal((await handler(commandRequest(JSON.stringify({operation:"start_agent",projectId:ordinary.project.projectId})))).status,400);
  assert.equal((await createLocalPilotProjectTaskHandlerV1(undefined)(new Request(`${endpoint}?resource=projects`))).status,503);
  // Exercise the existing browser clients through the actual authenticated handler,
  // without a listener. Cookies/origin below model browser-supplied metadata only.
  let loseResponse=true;
  const browserTransport=createLocalPilotBrowserTransportV1(async(input,init)=>{
    const headers=new Headers(init?.headers);headers.set("cookie",cookie);
    if(init?.method==="POST")headers.set("origin",origin);
    const response=await handler(new Request(`${origin}${String(input)}`,{...init,headers}));
    if(init?.method==="POST"&&loseResponse){loseResponse=false;throw new Error("lost committed response");}
    return response;
  });
  const browserProjects=createProjectBrowserClient(browserTransport,()=>"pilot-create-project-0001");
  assert.equal((await browserProjects.list()).projects.length,2);
  assert.equal((await browserProjects.get(ordinary.project.projectId)).projectId,ordinary.project.projectId);
  await assert.rejects(browserProjects.create(ordinaryDraft),{code:"uncertain"});
  assert.deepEqual(await browserProjects.retryPending(),ordinary.project);
  const browserTasks=createTaskBrowserClient(browserTransport,()=>"pilot-propose-task-0001");
  loseResponse=true;
  await assert.rejects(browserTasks.propose(ordinary.project.projectId,taskDraft),{code:"uncertain"});
  assert.deepEqual(await browserTasks.retrySave(),proposed.receipt);
  assert.equal((await browserTasks.list(ordinary.project.projectId)).tasks.length,1);
  assert.equal((await browserTasks.detail(ordinary.project.projectId,proposed.receipt.jobId)).task.state,"proposed");
  await assert.rejects(browserTasks.detail(another.project.projectId,proposed.receipt.jobId),{code:"not_found"});
  const taskBeforeRestart=await runtime.projectTasks.getTask(read(),ordinary.project.projectId,proposed.receipt.jobId);
  assert.equal(taskBeforeRestart.task.state,"proposed");assert.deepEqual(taskBeforeRestart.attempts,[]);
  assert.equal((await runtime.projectTasks.listTasks(read(),ordinary.project.projectId)).dispatch,"not_connected");
  assert.deepEqual((await runtime.projectTasks.listTasks(read(),another.project.projectId)).tasks,[]);
  await assert.rejects(runtime.projectTasks.getTask(read(),another.project.projectId,proposed.receipt.jobId),/not_found/);
  await assert.rejects(runtime.projectTasks.proposeTask(write(),ordinary.project.projectId,{...taskDraft,title:"Different request"},"pilot-propose-task-0001"),/conflict/);
  await runtime.projectTasks.transitionProject(write(),ordinary.project.projectId,{lifecycle:"archived",expectedVersion:1},"pilot-archive-project-0001");
  assert.equal((await runtime.projectTasks.getProject(read(),ordinary.project.projectId)).lifecycle,"archived");
  await assert.rejects(runtime.projectTasks.proposeTask(write(),ordinary.project.projectId,taskDraft,"pilot-propose-task-0002"),/conflict/);
  await runtime.projectTasks.transitionProject(write(),ordinary.project.projectId,{lifecycle:"active",expectedVersion:2},"pilot-reopen-project-0001");
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
  const taskAfterRestart=await runtime.projectTasks.getTask(read(),ordinary.project.projectId,proposed.receipt.jobId);
  assert.equal(taskAfterRestart.task.jobId,taskBeforeRestart.task.jobId);
  assert.equal(taskAfterRestart.task.state,"proposed");assert.deepEqual(taskAfterRestart.attempts,[]);
  assert.equal((await runtime.projectTasks.getProject(read(),ordinary.project.projectId)).version,3);
  assert.equal((await runtime.projectTasks.listProjects(read())).projects.length,3);
  assert.equal((await runtime.projectTasks.proposeTask(write(),ordinary.project.projectId,taskDraft,"pilot-propose-task-0001")).replayed,true);
  assert.equal((await runtime.connectionRosterSource.read({tenantId:LOCAL_PILOT_TENANT_ID_V1,now})).connectionCount,0);
  const resumedAuth=await runtime.ownerSession.verify(ownerRequest("/ideas",cookie),now),sessions=await runtime.operatorService.list(resumedAuth),project=await runtime.lifecycleService.get("project:local-pilot-idea",resumedAuth);
  assert.equal(sessions.length,1);assert.equal(sessions[0]?.sessionId,created.sessionId);assert.equal(sessions[0]?.state,"decided");assert.equal(project.version,3);assert.equal(project.lifecycleState,"active");
  const scopeAfterRestart=await runtime.scopeAuthority.authorize({credential:ownerRequest("/api/v1/project-workspace/project:local-pilot-idea",cookie),projectId:project.projectId,now});assert.equal(scopeAfterRestart.catalogRevision,1);
  const durableEvents=await runtime.projectEventSource.read({tenantId:scopeAfterRestart.tenantId,workspaceId:scopeAfterRestart.workspaceId,projectId:scopeAfterRestart.projectId,limit:100});
  assert.deepEqual(durableEvents.events.map(event=>event.safeSummary),["Idea promoted to a monitored project","Project lifecycle changed to paused","Project lifecycle changed to active"]);
  await assert.rejects(runtime.ownerSession.verify(new Request(`${origin}/ideas`,{headers:{cookie,"x-forwarded-for":"127.0.0.1"}}),now),(error:unknown)=>error instanceof LocalPilotErrorV1&&error.safeCode==="local_request_required");
  await assert.rejects(runtime.projectTasks.listProjects(new Request(`${origin}/local-preview`,{headers:{cookie,"x-forwarded-for":"127.0.0.1"}})),/local_request_required/);
  now=advance(issued.expiresAt,1);
  await assert.rejects(runtime.projectTasks.listProjects(read()),/authentication_required/);
  await assert.rejects(runtime.projectTasks.proposeTask(write(),ordinary.project.projectId,taskDraft,"pilot-propose-expired-0001"),/authentication_required/);
  await runtime.close();
});

test("CR12B-IDEA-060 rejects pilot data inside the repository",async()=>{await assert.rejects(createControlRoomLocalPilotRuntimeV1({mode:"repository_fake",origin,dataDir:join(process.cwd(),"pilot-data"),repositoryRoot:process.cwd(),
  masterKey:new Uint8Array(32).fill(1),ownerCodeDigest:sha256Digest({code})}),(error:unknown)=>error instanceof LocalPilotErrorV1&&error.safeCode==="invalid_local_pilot_configuration");});
