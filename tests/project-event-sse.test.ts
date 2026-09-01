import assert from "node:assert/strict";
import test from "node:test";
import { createProjectEventStreamHandlerV1,GET } from "../app/api/v1/projects/[projectId]/events/route.ts";
import type { ProjectEventStreamRuntimeV1 } from "../app/project-event-stream-runtime.ts";
import { buildProjectEventPageV1,buildProjectEventV1,formatProjectEventSseV1,PROJECT_EVENT_INPUT_V1 } from "../src/project-events/v1/index.ts";
import { ProjectWorkspaceContractErrorV1,type AuthorizedProjectWorkspaceReadScopeV1 } from "../src/project-workspace/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";

const scope={tenantId:"tenant:events",workspaceId:"workspace:events",projectId:"project:events"};
const digest=`sha256:${"a".repeat(64)}`,now="2026-09-01T18:00:00.000Z";
const context=(projectId=scope.projectId)=>({params:Promise.resolve({projectId})});
function authorized():AuthorizedProjectWorkspaceReadScopeV1{return{...scope,actorId:"identity:owner",grantedAt:now,
  expiresAt:"2026-09-01T18:05:00.000Z",sessionDigest:digest,catalogId:"catalog:owner",catalogRevision:1,
  catalogDigest:digest,catalogCheckpointDigest:digest};}
const event=buildProjectEventV1({schemaVersion:PROJECT_EVENT_INPUT_V1,...scope,eventId:"event:project:1",eventKind:"project",
  source:{kind:"control_room",sourceId:"source:project:1",sourceVersion:"version-1",sourceEventKeyDigest:sha256Digest({source:1})},
  subject:{kind:"project",subjectId:scope.projectId},safeSummary:"Project entered active monitoring",tone:"good",
  occurredAt:now,presentationOnly:true,grantsApproval:false,grantsCommandAuthority:false,grantsExecutionAuthority:false},1,null,now);
const page=buildProjectEventPageV1({...scope,mode:"snapshot",events:[event],nextCursor:null,hasMore:false,truncatedBefore:false});

function runtime(authorize:ProjectEventStreamRuntimeV1["scopeAuthority"]["authorize"],read:ProjectEventStreamRuntimeV1["eventSource"]["read"]):ProjectEventStreamRuntimeV1{
  return{scopeAuthority:{authorize}as ProjectEventStreamRuntimeV1["scopeAuthority"],eventSource:{read}};
}

test("CR13A-LIVE-000 SSE frames carry resumable IDs but no command authority",()=>{
  const body=formatProjectEventSseV1(page);
  assert.match(body,/^retry: 1000/m);assert.match(body,/^id: [A-Za-z0-9_-]+$/m);assert.match(body,/event: project\.event/);
  assert.match(body,/event: stream\.head/);assert.match(body,/"grantsApproval":false/);assert.match(body,/"grantsCommandAuthority":false/);
  assert.doesNotMatch(body,/event: project\.command|event: project\.approve|event: project\.retry/);
});

test("CR13A-LIVE-000 default endpoint is closed and never trusts caller identity headers",async()=>{
  const response=await GET(new Request(`http://localhost/api/v1/projects/${scope.projectId}/events`,{headers:{"x-control-room-tenant-id":scope.tenantId}}),context());
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:"protected_event_boundary_unavailable"});
});

test("CR13A-LIVE-000 authenticates scope and passes the resumable cursor to the protected source",async()=>{
  let credentialWasRequest=false,received:unknown;
  const handler=createProjectEventStreamHandlerV1(runtime(async input=>{credentialWasRequest=(input as{credential:unknown}).credential instanceof Request;return authorized();},async request=>{received=request;return page;}));
  const response=await handler(new Request(`http://localhost/api/v1/projects/${scope.projectId}/events?limit=25`,{headers:{"last-event-id":"cursor-safe-123456"}}),context());
  assert.equal(response.status,200);assert.equal(response.headers.get("content-type"),"text/event-stream; charset=utf-8");
  assert.equal(response.headers.get("cache-control"),"no-store, no-transform");assert.equal(credentialWasRequest,true);
  assert.deepEqual(received,{...scope,afterCursor:"cursor-safe-123456",limit:25});assert.match(await response.text(),/event: stream\.head/);
});

test("CR13A-LIVE-000 rejects cursor ambiguity and maps protected authorization failures before reads",async()=>{
  let reads=0;const deny=createProjectEventStreamHandlerV1(runtime(async()=>{throw new ProjectWorkspaceContractErrorV1("authentication_required");},async()=>{reads+=1;return page;}));
  const denied=await deny(new Request(`http://localhost/api/v1/projects/${scope.projectId}/events`),context());assert.equal(denied.status,401);assert.equal(reads,0);
  const handler=createProjectEventStreamHandlerV1(runtime(async()=>authorized(),async()=>page));
  const conflict=await handler(new Request(`http://localhost/api/v1/projects/${scope.projectId}/events?after=cursor-one-123456`,{headers:{"last-event-id":"cursor-two-123456"}}),context());
  assert.equal(conflict.status,400);assert.deepEqual(await conflict.json(),{error:"conflicting_stream_cursor"});
  assert.equal((await handler(new Request("http://localhost/api/v1/projects/bad/events"),context("../owner"))).status,404);
});
