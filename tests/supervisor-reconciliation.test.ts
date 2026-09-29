import assert from "node:assert/strict";
import test from "node:test";
import { DOMAIN_CONTRACT_VERSION, type JobRecord } from "../src/domain/v1";
import { classifyProviderWaitV1, ProviderWaitStoreV1, SupervisorReconcilerV1,
  SupervisorWatchdogV1 } from "../src/supervisor/v1";
import { at, nativeTaskFixture } from "./native-task-fixture";
import { binding } from "./hermes-native-fixture";

test("explicit usage, rate-limit and provider outages classify as waits while generic failures do not", () => {
  assert.equal(classifyProviderWaitV1("out of usage",0)?.reason,"out_of_usage");
  assert.equal(classifyProviderWaitV1("HTTP 429 rate limited",0)?.reason,"rate_limited");
  assert.equal(classifyProviderWaitV1("provider unavailable",0)?.reason,"provider_down");
  assert.equal(classifyProviderWaitV1("exit_nonzero",0),undefined);
});

test("a provider wait remains waiting until its retry time, then returns the task to its queue without a failure", async t => {
  const f=await nativeTaskFixture();t.after(f.close);
  const store=new ProviderWaitStoreV1(f.db),observedAt=at(10_000),retryAfter=at(60_000);
  const first=await store.schedule({tenantId:binding.tenantId,projectId:binding.projectId,jobId:binding.jobId,
    attemptId:binding.attemptId,nodeId:binding.nodeId,reason:"rate_limited",observedAt,retryAfter});
  assert.equal(first.replayed,false);
  assert.equal((await store.schedule({tenantId:binding.tenantId,projectId:binding.projectId,jobId:binding.jobId,
    attemptId:binding.attemptId,nodeId:binding.nodeId,reason:"rate_limited",observedAt,retryAfter})).replayed,true);
  assert.equal((await f.raw.query<{state:string}>("SELECT state FROM control_attempts WHERE id=$1",[binding.attemptId])).rows[0]?.state,"waiting");
  assert.equal(await new SupervisorReconcilerV1(f.db,binding.tenantId,()=>Date.parse(at(59_999))).releaseDueProviderWaits(),0);
  assert.equal(await new SupervisorReconcilerV1(f.db,binding.tenantId,()=>Date.parse(at(60_000))).releaseDueProviderWaits(),1);
  assert.equal((await f.canonical.get(binding.tenantId,"job",binding.jobId))?.state,"ready");
  assert.equal((await f.canonical.get(binding.tenantId,"attempt",binding.attemptId))?.state,"orphaned");
  const wait=(await f.raw.query<{state:string}>("SELECT state FROM control_provider_waits WHERE id=$1",[first.id])).rows[0];
  assert.equal(wait?.state,"released");
});

test("the first recorded stall requeues, the second raises Needs Attention, and heartbeat loss marks suspect", async t => {
  const f=await nativeTaskFixture();t.after(f.close);
  const firstService=new SupervisorReconcilerV1(f.db,binding.tenantId,()=>Date.parse(at(310_000)));
  const first=await firstService.reconcileStalled();assert.equal(first.length,1);assert.equal(first[0]?.disposition,"queued");
  assert.equal(first[0]?.lapseNumber,1);assert.equal((await firstService.reconcileStalled()).length,0);
  const ready=await f.canonical.get(binding.tenantId,"job",binding.jobId) as JobRecord;
  await f.canonical.claimReadyJob({tenantId:binding.tenantId,jobId:binding.jobId,expectedJobVersion:ready.version,
    nodeId:binding.nodeId,workerId:"worker:fixture",attemptId:"attempt:second",leaseId:"lease:second",
    transitionId:"transition:claim-second",idempotencyKey:"supervisor-second-claim",actor:{actorId:"identity:test",actorType:"human"},
    acquiredAt:at(320_000),expiresAt:at(350_000)});
  const secondService=new SupervisorReconcilerV1(f.db,binding.tenantId,()=>Date.parse(at(360_000)));
  assert.equal(await secondService.refreshAgentHeartbeatHealth(),1);
  const second=await secondService.reconcileStalled();assert.equal(second[0]?.disposition,"needs_attention");
  assert.equal(second[0]?.lapseNumber,2);
  const attention=await f.raw.query<{payload:{reasonCode:string}}>(`SELECT payload FROM control_action_inbox
    WHERE tenant_id=$1 AND kind='failure'`,[binding.tenantId]);
  assert.equal(attention.rows[0]?.payload.reasonCode,"second_stall_needs_attention");
  const agent=await f.raw.query<{state:string;safe_reason_code:string}>(`SELECT state,safe_reason_code
    FROM control_supervisor_agent_health WHERE tenant_id=$1 AND worker_id='worker:fixture'`,[binding.tenantId]);
  assert.deepEqual(agent.rows[0],{state:"suspect",safe_reason_code:"heartbeat_lost"});
});

test("an uncertain-effect stall is never guessed into a retry", async t => {
  const authority:JobRecord["authority"]={projectId:binding.projectId,allowedExecutor:"executor:fixture",
    allowedOperations:["operation:fixture"],credentialRefs:[],filesystemRoots:[],networkPolicy:"none",allowedNetworkDestinations:[],
    effectPolicy:"preauthorized",maxRisk:"low",maxDurationSeconds:600,maxConcurrentEffects:1,expiresAt:at(600_000),digest:""};
  const f=await nativeTaskFixture({authority});t.after(f.close);
  const result=await new SupervisorReconcilerV1(f.db,binding.tenantId,()=>Date.parse(at(310_000))).reconcileStalled();
  assert.equal(result[0]?.disposition,"uncertain");
  assert.equal((await f.canonical.get(binding.tenantId,"job",binding.jobId))?.state,"orphaned");
  const attention=await f.raw.query<{kind:string}>("SELECT kind FROM control_action_inbox WHERE tenant_id=$1",[binding.tenantId]);
  assert.equal(attention.rows[0]?.kind,"ambiguity");
  assert.equal(DOMAIN_CONTRACT_VERSION,"control-room-domain/v1");
});

test("a stale supervisor loop records health, pauses starts through the operations interface, and raises an incident", async t => {
  const f=await nativeTaskFixture();t.after(f.close);let now=Date.parse(at(20_000)),pauses=0;
  const machine={async sample(){return{hostAlive:true,sharedMemorySegments:3,loadOneMinute:2};}};
  const operations={async pauseNewStarts(){pauses++;return{state:"paused" as const,receiptId:`pause:${pauses}`};}};
  const watchdog=new SupervisorWatchdogV1(f.db,binding.tenantId,"service:supervisor",machine,operations,()=>now);
  assert.equal((await watchdog.cycle()).healthy,true);now+=121_000;
  const unhealthy=await watchdog.cycle();assert.equal(unhealthy.healthy,false);assert.deepEqual(unhealthy.reasonCodes,["loop_not_alive"]);
  assert.equal(pauses,1);
  const incident=await f.raw.query<{safe_reason_code:string;state:string}>(`SELECT safe_reason_code,state
    FROM control_service_incidents WHERE tenant_id=$1 AND correlation_key='supervisor.health.loop_not_alive'`,[binding.tenantId]);
  assert.deepEqual(incident.rows[0],{safe_reason_code:"loop_not_alive",state:"open"});
  const attention=await f.raw.query<{kind:string;payload:{reasonCode:string}}>(`SELECT kind,payload FROM control_action_inbox
    WHERE tenant_id=$1 AND kind='incident'`,[binding.tenantId]);
  assert.equal(attention.rows[0]?.payload.reasonCode,"loop_not_alive");
});
