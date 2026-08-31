import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { HARNESS_EVENT_SCHEMA_VERSION_V1, HarnessRunStoreV1, type HarnessRunEventV1, type HarnessRunV1 } from "../src/harness/v1";
import { adaptPglite } from "../src/persistence/database";
import { sha256Digest } from "../src/security";

const digest = `sha256:${"a".repeat(64)}`;
const integrityKey = new Uint8Array(32).fill(7);
async function setup(): Promise<PGlite> {
  const raw = new PGlite(); for (const file of (await readdir(resolve("db/migrations"))).filter((f) => f.endsWith(".sql")).sort()) await raw.exec(await readFile(resolve("db/migrations",file),"utf8"));
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:harness','Harness'),('tenant:other','Other')`);
  await raw.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at) VALUES ('node:harness','tenant:harness','active',1,'key:harness',$1::jsonb,'2026-08-27T20:00:00Z','2026-08-27T20:00:00Z')`,[JSON.stringify({id:"node:harness",tenantId:"tenant:harness",state:"active",version:1,identityKeyId:"key:harness"})]);
  await raw.query(`INSERT INTO control_requests(id,tenant_id,state,version,idempotency_key,payload,created_at,updated_at) VALUES ('request:harness','tenant:harness','draft',0,'request-harness-key',$1::jsonb,'2026-08-27T20:00:00Z','2026-08-27T20:00:00Z')`,[JSON.stringify({id:"request:harness",tenantId:"tenant:harness",state:"draft",version:0,idempotencyKey:"request-harness-key"})]);
  await raw.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at) VALUES ('workflow:harness','tenant:harness','request:harness','project:harness',$1,'proposed',0,$2::jsonb,'2026-08-27T20:00:00Z','2026-08-27T20:00:00Z')`,[digest,JSON.stringify({id:"workflow:harness",tenantId:"tenant:harness",state:"proposed",version:0,requestId:"request:harness",projectId:"project:harness",definitionDigest:digest})]);
  await raw.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,created_at,updated_at) VALUES ('job:harness','tenant:harness','workflow:harness','project:harness','running',2,50,'harness.hermes',$1,$2::jsonb,'2026-08-27T20:00:00Z','2026-08-27T20:00:00Z')`,[digest,JSON.stringify({id:"job:harness",tenantId:"tenant:harness",state:"running",version:2,workflowId:"workflow:harness",projectId:"project:harness",priority:50,requiredCapability:"harness.hermes",authority:{digest}})]);
  await raw.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,node_id,lease_epoch,payload,created_at,updated_at) VALUES ('attempt:harness','tenant:harness','job:harness',1,'running',2,'node:harness',1,$1::jsonb,'2026-08-27T20:00:00Z','2026-08-27T20:00:00Z')`,[JSON.stringify({id:"attempt:harness",tenantId:"tenant:harness",state:"running",version:2,jobId:"job:harness",attemptNumber:1,nodeId:"node:harness",leaseEpoch:1})]);
  return raw;
}
const run: HarnessRunV1 = { schemaVersion:"control-room-harness/v1",id:"run:harness",tenantId:"tenant:harness",projectId:"project:harness",jobId:"job:harness",attemptId:"attempt:harness",nodeId:"node:harness",adapterId:"adapter.hermes.gateway.v1",adapterVersion:"1.0.0",harness:"hermes",harnessVersion:"0.20.6",nativeSessionKeyDigest:digest,state:"discovered",resumable:true,cancelState:"not_requested",createdAt:"2026-08-27T20:00:00.000Z",updatedAt:"2026-08-27T20:00:00.000Z",lastObservedAt:"2026-08-27T20:00:00.000Z" };
function event(sequence: number, state: HarnessRunEventV1["payload"], second: number): HarnessRunEventV1 { return { schemaVersion:HARNESS_EVENT_SCHEMA_VERSION_V1,tenantId:run.tenantId,runId:run.id,sequence,occurredAt:`2026-08-27T20:00:${String(second).padStart(2,"0")}.000Z`,source:"adapter",sourceEventKeyDigest:`sha256:${String(sequence).repeat(64).slice(0,64)}`,payload:state }; }

test("CR7 harness persistence is tenant-bound, monotonic, replay-safe, and terminal", async () => {
  const raw = await setup(); try {
    const store = new HarnessRunStoreV1(adaptPglite(raw),integrityKey);
    assert.equal((await store.create(run)).replayed,false); assert.equal((await store.create(run)).replayed,true);
    assert.equal((await store.append(event(1,{category:"lifecycle",state:"starting"},1))).run.state,"starting");
    assert.equal((await store.append(event(2,{category:"lifecycle",state:"running"},2))).run.state,"running");
    assert.equal((await store.append(event(2,{category:"lifecycle",state:"running"},2))).replayed,true);
    await assert.rejects(store.append(event(4,{category:"lifecycle",state:"succeeded"},4)),/sequence gap/);
    assert.equal((await store.append(event(3,{category:"attention",attention:"approval",state:"requested"},3))).run.state,"waiting_approval");
    assert.equal((await store.append(event(4,{category:"lifecycle",state:"running"},4))).run.state,"running");
    const finished = (await store.append(event(5,{category:"lifecycle",state:"succeeded"},5))).run;
    assert.equal(finished.finishedAt,"2026-08-27T20:00:05.000Z");
    await assert.rejects(store.append(event(6,{category:"lifecycle",state:"running"},6)),/illegal harness run transition/);
    assert.equal(await store.get("tenant:other",run.id),undefined);
    assert.deepEqual((await store.events(run.tenantId,run.id)).map((item) => item.sequence),[1,2,3,4,5]);
    assert.deepEqual((await store.watch(run.tenantId)).map((item) => item.id),[run.id]);
    assert.deepEqual(await store.watch("tenant:other"),[]);
  } finally { await raw.close(); }
});

test("CR7 harness persistence rejects conflicting replay, identity reuse, and time regression", async () => {
  const raw = await setup(); try {
    const store = new HarnessRunStoreV1(adaptPglite(raw),integrityKey); await store.create(run); await store.append(event(1,{category:"lifecycle",state:"starting"},1));
    await assert.rejects(store.append(event(1,{category:"lifecycle",state:"failed",reasonCode:"different"},1)),/replay conflict/);
    await assert.rejects(store.append(event(2,{category:"lifecycle",state:"running"},0)),/time regression/);
    await assert.rejects(store.create({ ...run,id:"run:second" }),/unique|duplicate/i);
  } finally { await raw.close(); }
});

test("CR7Q harness history is append-only and every stored payload is digest-verified on read",async()=>{
  const raw=await setup(); try {
    const store=new HarnessRunStoreV1(adaptPglite(raw),integrityKey); await store.create(run); await store.append(event(1,{category:"lifecycle",state:"starting"},1));
    await assert.rejects(raw.exec(`UPDATE control_harness_run_events SET payload='{}'::jsonb WHERE tenant_id='tenant:harness' AND run_id='run:harness' AND sequence=1`),/append-only relation/);
    await assert.rejects(raw.exec(`DELETE FROM control_harness_run_events WHERE tenant_id='tenant:harness' AND run_id='run:harness' AND sequence=1`),/append-only relation/);
    await raw.query(`UPDATE control_harness_runs SET payload=$1::jsonb WHERE tenant_id=$2 AND id=$3`,[JSON.stringify({...run,state:"starting",updatedAt:"2026-08-27T20:00:01.000Z",lastObservedAt:"2026-08-27T20:00:01.000Z",safeReasonCode:"tampered"}),run.tenantId,run.id]);
    await assert.rejects(store.get(run.tenantId,run.id),/integrity failure/);
  } finally { await raw.close(); }
});

test("CR7Q independent remediation authenticates normalized rows and complete event history",async()=>{
  const raw=await setup(); try {
    const store=new HarnessRunStoreV1(adaptPglite(raw),integrityKey); await store.create(run); await store.append(event(1,{category:"lifecycle",state:"starting"},1));
    const forgedRun={...run,adapterId:"adapter.hostile.v1",state:"starting" as const,updatedAt:"2026-08-27T20:00:01.000Z",lastObservedAt:"2026-08-27T20:00:01.000Z"};
    await raw.query(`UPDATE control_harness_runs SET adapter_id=$1,payload=$2::jsonb,run_digest=$3 WHERE id=$4`,[forgedRun.adapterId,JSON.stringify(forgedRun),sha256Digest(forgedRun),run.id]);
    await assert.rejects(store.get(run.tenantId,run.id),/integrity failure/);
  } finally { await raw.close(); }

  const gapRaw=await setup(); try {
    const store=new HarnessRunStoreV1(adaptPglite(gapRaw),integrityKey); await store.create(run);
    const forged=event(2,{category:"lifecycle",state:"running"},2);
    await gapRaw.query(`INSERT INTO control_harness_run_events(tenant_id,run_id,sequence,occurred_at,source,source_event_key_digest,event_digest,event_auth_tag,payload,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,[forged.tenantId,forged.runId,forged.sequence,forged.occurredAt,forged.source,forged.sourceEventKeyDigest,sha256Digest(forged),`hmac-sha256:${"0".repeat(64)}`,JSON.stringify(forged),forged.occurredAt]);
    await gapRaw.query(`UPDATE control_harness_runs SET last_sequence=2 WHERE tenant_id=$1 AND id=$2`,[run.tenantId,run.id]);
    await assert.rejects(store.get(run.tenantId,run.id),/integrity failure/);
    await assert.rejects(store.events(run.tenantId,run.id),/integrity failure/);
    await assert.rejects(store.watch(run.tenantId),/integrity failure/);
  } finally { await gapRaw.close(); }
});
