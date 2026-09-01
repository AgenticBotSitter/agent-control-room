import assert from "node:assert/strict";
import { readFile,readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database.ts";
import {
  PROJECT_EVENT_INPUT_V1,
  ProjectEventErrorV1,
  ProjectEventStoreV1,
  encodeProjectEventCursorV1,
  type ProjectEventInputV1,
} from "../src/project-events/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";

const scope={tenantId:"tenant:events",workspaceId:"workspace:events",projectId:"project:events"};
const otherProjectId="project:other";
const key=new Uint8Array(32).fill(43);
const t0="2026-09-01T16:00:00.000Z";

async function setup(){
  const raw=new PGlite();
  for(const file of (await readdir(resolve("db/migrations"))).filter(file=>file.endsWith(".sql")).sort())
    await raw.exec(await readFile(resolve("db/migrations",file),"utf8"));
  await raw.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)",[scope.tenantId,"Event tenant"]);
  await raw.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$3)",[scope.workspaceId,scope.tenantId,"Events"]);
  await raw.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    project_types,supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days)
    VALUES('adapter:events',$1,'event_fixture','fixture-v1','control_room_native','fixture','[]','[]','[]','redaction-v1',30)`,[scope.tenantId]);
  for(const projectId of [scope.projectId,otherProjectId])await raw.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,
    source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
    VALUES($1,$2,$3,'adapter:events',$1,'fixture-v1',$1,'running','active','healthy','control_room_native',$4,'{}')`,
  [projectId,scope.tenantId,scope.workspaceId,t0]);
  return{raw,store:new ProjectEventStoreV1(adaptPglite(raw),key,()=>t0)};
}

function input(index:number,overrides:Partial<ProjectEventInputV1>={}):ProjectEventInputV1{
  const sourceId=`source:event:${index}`,eventId=`event:project:${index}`;
  return{schemaVersion:PROJECT_EVENT_INPUT_V1,...scope,eventId,eventKind:"project",source:{kind:"control_room",sourceId,
    sourceVersion:`version-${index}`,sourceEventKeyDigest:sha256Digest({sourceId})},subject:{kind:"project",subjectId:scope.projectId},
    safeSummary:`Project event ${index}`,safeDetail:`Safe event detail ${index}.`,tone:"neutral",
    deepLinkPath:`/projects/${scope.projectId}/activity`,occurredAt:t0,presentationOnly:true,
    grantsApproval:false,grantsCommandAuthority:false,grantsExecutionAuthority:false,...overrides};
}

function hasCode(code:ProjectEventErrorV1["safeCode"]){return(error:unknown)=>error instanceof ProjectEventErrorV1&&error.safeCode===code;}

test("CR13A-LIVE-000 appends an authenticated chain and replays exact sources",async()=>{
  const{raw,store}=await setup();try{
    const first=await store.append(input(1)),second=await store.append(input(2)),replay=await store.append(input(1));
    assert.deepEqual([first.event.sequence,second.event.sequence,replay.event.sequence,replay.replayed],[1,2,1,true]);
    assert.equal(second.event.previousEventDigest,first.event.eventDigest);
    const snapshot=await store.read({...scope,limit:100});
    assert.equal(snapshot.mode,"snapshot");assert.deepEqual(snapshot.events.map(event=>event.sequence),[1,2]);
    assert.equal(snapshot.nextCursor,encodeProjectEventCursorV1(second.event));
    assert.deepEqual([snapshot.presentationOnly,snapshot.grantsApproval,snapshot.grantsCommandAuthority,snapshot.grantsExecutionAuthority],[true,false,false,false]);
    await assert.rejects(store.append(input(1,{safeSummary:"Changed replay"})),hasCode("replay_conflict"));
  }finally{await raw.close();}
});

test("CR13A-LIVE-000 serializes concurrent writers and resumes after a verified cursor",async()=>{
  const{raw,store}=await setup();try{
    const events=await Promise.all(Array.from({length:12},(_,index)=>store.append(input(index+1))));
    assert.deepEqual(events.map(result=>result.event.sequence).sort((a,b)=>a-b),Array.from({length:12},(_,index)=>index+1));
    const firstPage=await store.read({...scope,limit:5});
    assert.deepEqual(firstPage.events.map(event=>event.sequence),[8,9,10,11,12]);
    assert.equal(firstPage.truncatedBefore,true);assert.equal(firstPage.hasMore,true);
    const cursor=encodeProjectEventCursorV1(events.find(result=>result.event.sequence===6)!.event);
    const replay=await store.read({...scope,afterCursor:cursor,limit:3});
    assert.equal(replay.mode,"replay");assert.deepEqual(replay.events.map(event=>event.sequence),[7,8,9]);assert.equal(replay.hasMore,true);
  }finally{await raw.close();}
});

test("CR13A-LIVE-000 resets invalid, foreign, stale, and ahead cursors without skipping current truth",async()=>{
  const{raw,store}=await setup();try{
    await store.append(input(1));await store.append(input(2));
    for(const afterCursor of ["not-a-valid-cursor",Buffer.from(JSON.stringify({projectId:otherProjectId,sequence:1,eventDigest:sha256Digest({foreign:true})})).toString("base64url"),
      Buffer.from(JSON.stringify({projectId:scope.projectId,sequence:1,eventDigest:sha256Digest({stale:true})})).toString("base64url"),
      Buffer.from(JSON.stringify({projectId:scope.projectId,sequence:99,eventDigest:sha256Digest({ahead:true})})).toString("base64url")]){
      const page=await store.read({...scope,afterCursor,limit:100});assert.equal(page.mode,"reset");assert.deepEqual(page.events.map(event=>event.sequence),[1,2]);
    }
  }finally{await raw.close();}
});

test("CR13A-LIVE-000 detects event, head, and payload tampering and enforces append-only rows",async()=>{
  const{raw,store}=await setup();try{
    await store.append(input(1));
    await assert.rejects(raw.query("UPDATE control_project_events SET safe_summary='tampered' WHERE project_id=$1",[scope.projectId]));
    await assert.rejects(raw.query("DELETE FROM control_project_events WHERE project_id=$1",[scope.projectId]));
    await raw.query("UPDATE control_project_event_stream_heads SET last_sequence=2 WHERE tenant_id=$1 AND project_id=$2",[scope.tenantId,scope.projectId]);
    await assert.rejects(store.read({...scope,limit:100}),hasCode("integrity_failed"));
  }finally{await raw.close();}
});

test("CR13A-LIVE-000 rejects missing projects, cross-workspace scope, and unsafe caller values",async()=>{
  const{raw,store}=await setup();try{
    await assert.rejects(store.append(input(1,{projectId:"project:missing"})),hasCode("project_not_found"));
    await assert.rejects(store.read({...scope,workspaceId:"workspace:foreign",limit:100}),hasCode("project_not_found"));
    await assert.rejects(store.append(input(1,{safeDetail:"token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"})),hasCode("invalid_input"));
    const proxied=new Proxy(input(1),{get(target,property,receiver){return Reflect.get(target,property,receiver);}});
    await assert.rejects(store.append(proxied),hasCode("invalid_input"));
  }finally{await raw.close();}
});
