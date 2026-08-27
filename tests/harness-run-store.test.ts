import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { HARNESS_EVENT_SCHEMA_VERSION_V1, HarnessRunStoreV1, type HarnessRunEventV1, type HarnessRunV1 } from "../src/harness/v1";
import { adaptPglite } from "../src/persistence/database";

const digest = `sha256:${"a".repeat(64)}`;
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
    const store = new HarnessRunStoreV1(adaptPglite(raw));
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
    const store = new HarnessRunStoreV1(adaptPglite(raw)); await store.create(run); await store.append(event(1,{category:"lifecycle",state:"starting"},1));
    await assert.rejects(store.append(event(1,{category:"lifecycle",state:"failed",reasonCode:"different"},1)),/replay conflict/);
    await assert.rejects(store.append(event(2,{category:"lifecycle",state:"running"},0)),/time regression/);
    await assert.rejects(store.create({ ...run,id:"run:second" }),/unique|duplicate/i);
  } finally { await raw.close(); }
});
