import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database.ts";
import { sha256Digest } from "../src/security/index.ts";
import {
  DeterministicIdeaLabFakeDriverV1, IdeaLabBotCoordinatorV1, IdeaLabBotRunStoreV1,
  IdeaLabErrorV1, IdeaLabProjectRegistryStoreV1, buildIdeaLabBotRunV1, buildIdeaLabFixtureV1,
  buildRepositoryFakeProviderEvidenceV1,
} from "../src/idea-lab/v1/index.ts";

const key=new Uint8Array(32).fill(0x51),now="2026-08-31T16:00:30.000Z",expires="2026-08-31T16:10:30.000Z";
async function setup(){const raw=new PGlite();for(const file of (await readdir(resolve("db/migrations"))).filter(f=>f.endsWith(".sql")).sort())await raw.exec(await readFile(resolve("db/migrations",file),"utf8"));
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:owner','Owner')`);await raw.query(`INSERT INTO workspaces(id,tenant_id,display_name) VALUES ('workspace:control-room','tenant:owner','Control Room')`);
  const db=adaptPglite(raw),registry=new IdeaLabProjectRegistryStoreV1(db,key),ledger=new IdeaLabBotRunStoreV1(db,key),fixture=buildIdeaLabFixtureV1();await registry.registerSession(fixture.session);
  const evidence=fixture.session.participants.map((p,index)=>buildRepositoryFakeProviderEvidenceV1(fixture.session,p,{evidenceId:`evidence.idea:${index}`,capturedAt:now,expiresAt:expires}));
  return {raw,db,registry,ledger,fixture,evidence};}

test("CR12B-IDEA-030 runs every bounded fake panel turn and retains only filtered contributions",async()=>{const target=await setup();try{
  let calls=0;const prompts: { round:number; text:string }[]=[];const driver=new DeterministicIdeaLabFakeDriverV1();const coordinator=new IdeaLabBotCoordinatorV1(target.ledger,target.registry,{mode:"repository_fake",async invoke(input){calls+=1;prompts.push({round:input.round,text:input.safePrompt});return driver.invoke(input);}},()=>now);
  const run=await coordinator.execute({runId:"idea-run:complete",session:target.fixture.session,evidence:target.evidence,safePrompt:"Evaluate this bounded business idea."});
  assert.equal(run.state,"completed");assert.equal(run.messagesUsed,8);assert.equal(run.costUsd,0);assert.equal(run.providerContacted,false);assert.equal(calls,8);
  assert.ok(prompts.filter(p=>p.round===1).every(p=>p.text==="Evaluate this bounded business idea."));
  assert.ok(prompts.filter(p=>p.round===2).every(p=>p.text.includes("prior opinions")&&p.text.length<=800));
  assert.equal((await target.registry.listContributions(target.fixture.session.tenantId,target.fixture.session.sessionId)).length,8);
  assert.equal((await target.raw.query(`SELECT * FROM control_idea_bot_run_events WHERE run_id='idea-run:complete'`)).rows.length,18);
}finally{await target.raw.close();}});

test("CR12B-IDEA-030 makes a post-marker exception terminally ambiguous and never retries it",async()=>{const target=await setup();try{
  let calls=0;const driver=new DeterministicIdeaLabFakeDriverV1({"bot:customer:1":"throw"});const coordinator=new IdeaLabBotCoordinatorV1(target.ledger,target.registry,{mode:"repository_fake",async invoke(input){calls+=1;return driver.invoke(input);}},()=>now);
  const first=await coordinator.execute({runId:"idea-run:ambiguous",session:target.fixture.session,evidence:target.evidence,safePrompt:"Evaluate safely."});
  const replay=await coordinator.execute({runId:"idea-run:ambiguous",session:target.fixture.session,evidence:target.evidence,safePrompt:"Evaluate safely."});
  assert.deepEqual([first.state,first.safeCode,first.retryPermitted,calls],["ambiguous","provider_outcome_unknown",false,1]);assert.equal(replay.runDigest,first.runDigest);assert.equal(calls,1);
  assert.equal((await target.registry.listContributions(target.fixture.session.tenantId,target.fixture.session.sessionId)).length,0);
}finally{await target.raw.close();}});

test("CR12B-IDEA-030 recovery converts an unsettled marker to ambiguity without provider contact",async()=>{const target=await setup();try{
  const prepared=await target.ledger.prepare(buildIdeaLabBotRunV1({runId:"idea-run:restart",tenantId:target.fixture.session.tenantId,workspaceId:target.fixture.session.workspaceId,sessionId:target.fixture.session.sessionId,sessionDigest:target.fixture.session.sessionDigest,evidenceDigests:target.evidence.map(e=>e.evidenceDigest).sort(),state:"prepared",attempts:[],messagesUsed:0,costUsd:0,safeCode:"prepared",providerContacted:false,startedAt:now,updatedAt:now}));
  await target.ledger.markProvider(prepared.runId,{attemptId:"attempt.idea:restart",participantId:"bot:customer",participantIdentityDigest:target.fixture.session.participants[0]!.identityDigest,round:1,state:"provider_marked",markerDigest:`sha256:${"c".repeat(64)}`,costUsd:0,messagesUsed:0,startedAt:now});
  const recovered=await target.ledger.recover(prepared.runId,"2026-08-31T16:01:00.000Z");assert.deepEqual([recovered.state,recovered.safeCode,recovered.retryPermitted],["ambiguous","restart_after_provider_marker",false]);
}finally{await target.raw.close();}});

test("CR12B-IDEA-030 rejects expired, mismatched, and accessor-bearing provider evidence before a call",async()=>{const target=await setup();try{
  let calls=0;const coordinator=new IdeaLabBotCoordinatorV1(target.ledger,target.registry,{mode:"repository_fake",async invoke(){calls+=1;return {}; }},()=>now);
  await assert.rejects(coordinator.execute({runId:"idea-run:mismatch",session:target.fixture.session,evidence:target.evidence.slice(1),safePrompt:"Evaluate."}),e=>e instanceof IdeaLabErrorV1&&e.safeCode==="scope_mismatch");
  const expired={...target.evidence[0],expiresAt:"2026-08-31T16:00:00.000Z"};
  await assert.rejects(coordinator.execute({runId:"idea-run:expired",session:target.fixture.session,evidence:[expired,...target.evidence.slice(1)],safePrompt:"Evaluate."}),e=>e instanceof IdeaLabErrorV1);
  const accessor={...target.evidence[0]};Object.defineProperty(accessor,"mode",{enumerable:true,get(){calls+=100;return "repository_fake";}});
  await assert.rejects(coordinator.execute({runId:"idea-run:accessor",session:target.fixture.session,evidence:[accessor,...target.evidence.slice(1)],safePrompt:"Evaluate."}),e=>e instanceof IdeaLabErrorV1&&e.safeCode==="invalid_input");assert.equal(calls,0);
}finally{await target.raw.close();}});

test("CR12B-IDEA-030 append-only run history detects mutation",async()=>{const target=await setup();try{
  await target.ledger.prepare(buildIdeaLabBotRunV1({runId:"idea-run:immutable",tenantId:target.fixture.session.tenantId,workspaceId:target.fixture.session.workspaceId,sessionId:target.fixture.session.sessionId,sessionDigest:target.fixture.session.sessionDigest,evidenceDigests:target.evidence.map(e=>e.evidenceDigest).sort(),state:"prepared",attempts:[],messagesUsed:0,costUsd:0,safeCode:"prepared",providerContacted:false,startedAt:now,updatedAt:now}));
  await assert.rejects(target.raw.query(`UPDATE control_idea_bot_run_events SET payload='{}'::jsonb`));await assert.rejects(target.raw.query(`DELETE FROM control_idea_bot_run_events`));
}finally{await target.raw.close();}});

test("CR12B-IDEA-030 refuses self-authorizing live Hermes evidence before invoking a driver",async()=>{const target=await setup();try{
  let calls=0;const liveEvidence=target.evidence.map(item=>{const {evidenceDigest:_digest,...base}=item;void _digest;const material={...base,mode:"hermes_bot_mode_filtered" as const,harnessPackage:"hermes_agent" as const,harnessVersion:"0.21.0",sourceRevision:"hermes-021-compatible",liveProviderAuthorized:true,providerContacted:true};return{...material,evidenceDigest:sha256Digest(material)};});
  const coordinator=new IdeaLabBotCoordinatorV1(target.ledger,target.registry,{mode:"hermes_bot_mode_filtered",async invoke(){calls+=1;return{};}},()=>now);
  await assert.rejects(coordinator.execute({runId:"idea-run:forged-live",session:target.fixture.session,evidence:liveEvidence,safePrompt:"Evaluate."}),e=>e instanceof IdeaLabErrorV1&&e.safeCode==="authorization_denied");assert.equal(calls,0);
}finally{await target.raw.close();}});
