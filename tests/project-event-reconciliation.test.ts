import assert from "node:assert/strict";
import { readFile,readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { CONTROL_ROOM_IDEA_ADAPTER_V1,IdeaLabProjectRegistryStoreV1,buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/index.ts";
import { adaptPglite } from "../src/persistence/database.ts";
import { IdeaLabProjectEventReconcilerV1,ProjectEventStoreV1 } from "../src/project-events/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";

const ideaKey=new Uint8Array(32).fill(52),eventKey=new Uint8Array(32).fill(53),now="2026-08-31T16:12:00.000Z";
async function setup(){const raw=new PGlite();for(const file of(await readdir(resolve("db/migrations"))).filter(file=>file.endsWith(".sql")).sort())await raw.exec(await readFile(resolve("db/migrations",file),"utf8"));
  await raw.query("INSERT INTO tenants(id,display_name) VALUES('tenant:owner','Owner')");await raw.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:control-room','tenant:owner','Control Room')");
  await raw.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,project_types,
    supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days) VALUES($1,'tenant:owner',
    'control_room_native_ideas','control-room-idea-lab-session/v1','control_room_native','fixture','["business_validation"]',
    '["read_project"]','[]','redaction-v1',30)`,[CONTROL_ROOM_IDEA_ADAPTER_V1]);
  const db=adaptPglite(raw),registry=new IdeaLabProjectRegistryStoreV1(db,ideaKey),fixture=buildIdeaLabFixtureV1();
  await registry.registerSession(fixture.session);for(const contribution of fixture.contributions)await registry.recordContribution(contribution);
  await registry.recordSynthesis(fixture.synthesis);const recorded=await registry.recordDecision(fixture.decision),project=recorded.project!;
  return{raw,registry,project,eventStore:new ProjectEventStoreV1(db,eventKey,()=>now)};}

test("CR13A-LIVE-000 reconciliation repairs crash gaps and projects each exact lifecycle event once",async()=>{const target=await setup();try{
  const actor=sha256Digest({actor:"owner"});await target.registry.transitionProject({tenantId:target.project.tenantId,
    projectId:target.project.projectId,expectedVersion:1,toState:"paused",actorIdentityDigest:actor,safeReasonCode:"owner_pause",
    occurredAt:"2026-08-31T16:09:00.000Z"});await target.registry.transitionProject({tenantId:target.project.tenantId,
    projectId:target.project.projectId,expectedVersion:2,toState:"active",actorIdentityDigest:actor,safeReasonCode:"owner_resume",
    occurredAt:"2026-08-31T16:10:00.000Z"});
  let calls=0;const interrupted=new IdeaLabProjectEventReconcilerV1(target.registry,{append:async input=>{calls+=1;
    if(calls===2)throw new Error("simulated_projection_crash");return target.eventStore.append(input);}}as Pick<ProjectEventStoreV1,"append">);
  await assert.rejects(interrupted.reconcileProject(target.project.tenantId,target.project.projectId),/simulated_projection_crash/);
  assert.equal((await target.eventStore.read({tenantId:target.project.tenantId,workspaceId:target.project.workspaceId,
    projectId:target.project.projectId,limit:100})).events.length,1);
  const recovered=new IdeaLabProjectEventReconcilerV1(target.registry,target.eventStore);await Promise.all([
    recovered.reconcileProject(target.project.tenantId,target.project.projectId),recovered.reconcileProject(target.project.tenantId,target.project.projectId)]);
  const page=await target.eventStore.read({tenantId:target.project.tenantId,workspaceId:target.project.workspaceId,
    projectId:target.project.projectId,limit:100});assert.deepEqual(page.events.map(event=>event.safeSummary),
    ["Idea promoted to a monitored project","Project lifecycle changed to paused","Project lifecycle changed to active"]);
  assert.deepEqual(page.events.map(event=>event.source.sourceVersion),["lifecycle-v1","lifecycle-v2","lifecycle-v3"]);
}finally{await target.raw.close();}});
