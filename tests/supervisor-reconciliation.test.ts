import assert from "node:assert/strict";
import test from "node:test";
import { DOMAIN_CONTRACT_VERSION, type JobRecord, type LeaseRecord } from "../src/domain/v1";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { classifyProviderWaitV1, ProviderWaitStoreV1, SupervisorReconcilerV1,
  SupervisorWatchdogV1, supervisorMachineHealthConfigV1 } from "../src/supervisor/v1";
import { at, nativeTaskFixture } from "./native-task-fixture";
import { binding } from "./hermes-native-fixture";

test("explicit usage, rate-limit and provider outages classify as waits while generic failures do not", () => {
  assert.equal(classifyProviderWaitV1("out of usage",0)?.reason,"out_of_usage");
  assert.equal(classifyProviderWaitV1("HTTP 429 rate limited",0)?.reason,"rate_limited");
  assert.equal(classifyProviderWaitV1("provider unavailable",0)?.reason,"provider_down");
  assert.equal(classifyProviderWaitV1("exit_nonzero",0),undefined);
});

test("the supervisor refuses an invalid sweep bound before touching the database", async () => {
  const unavailable={} as DatabaseClient;
  await assert.rejects(new SupervisorReconcilerV1(unavailable,binding.tenantId).reconcileStalled(0),
    /supervisor_limit_invalid/u);
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
  const concurrent=(await Promise.all([secondService.reconcileStalled(),secondService.reconcileStalled()])).flat();
  const second=concurrent.filter(outcome=>!outcome.replayed);
  assert.equal(second.length,1,"two concurrent sweep callers commit one second-lapse event");
  assert.equal(second[0]?.disposition,"needs_attention");assert.equal(second[0]?.lapseNumber,2);
  assert.equal((await secondService.reconcileStalled()).length,0,"retry does not create another Needs-you item");
  // TWO attention items, and they are about DIFFERENT things, which is the
  // point. Before U05 a lost worker heartbeat produced no item at all, so this
  // query saw only the stall's. The offline worker now escalates to its own
  // `attention:supervisor-agent:` item (0250), and the assertion names both so
  // a regression that merged them -- or that lost one -- fails here rather than
  // looking like a count that drifted.
  const attention=await f.raw.query<{id:string;payload:{reasonCode:string}}>(`SELECT id,payload FROM control_action_inbox
    WHERE tenant_id=$1 AND kind='incident' ORDER BY id`,[binding.tenantId]);
  assert.deepEqual(attention.rows.map(row=>row.payload.reasonCode).sort(),
    ["second_stall_needs_attention","worker_heartbeat_lost"],
    "the stalled task and the lost worker are two separate owner questions, not one");
  assert.deepEqual(attention.rows.map(row=>row.id.split(":").slice(0,2).join(":")).sort(),
    ["attention:supervisor","attention:supervisor-agent"],
    "and each carries the id namespace its own writer owns");
  assert.equal(attention.rows.length,2,"exactly two: the health row the supervisor already wrote is now an owner question too");
  const incident=await f.raw.query<{safe_reason_code:string;state:string}>(`SELECT safe_reason_code,state
    FROM control_service_incidents WHERE tenant_id=$1 AND correlation_key LIKE 'supervisor.lapse.%'`,[binding.tenantId]);
  assert.deepEqual(incident.rows,[{safe_reason_code:"second_stall_needs_attention",state:"open"}]);
  const outbox=await f.raw.query<{topic:string;aggregate_type:string}>(`SELECT topic,aggregate_type FROM control_outbox
    WHERE tenant_id=$1 AND aggregate_type='service_incident' AND payload->>'safeReasonCode'='second_stall_needs_attention'`,
  [binding.tenantId]);
  assert.deepEqual(outbox.rows,[{topic:"service.incident.opened",aggregate_type:"service_incident"}]);
  const agent=await f.raw.query<{state:string;safe_reason_code:string}>(`SELECT state,safe_reason_code
    FROM control_supervisor_agent_health WHERE tenant_id=$1 AND worker_id='worker:fixture'`,[binding.tenantId]);
  assert.deepEqual(agent.rows[0],{state:"suspect",safe_reason_code:"heartbeat_lost"});
});

test("a second-lapse transaction stopped after its incident rolls back and a retry creates exactly one Needs-you item", async t => {
  const f=await nativeTaskFixture();t.after(f.close);
  const first=new SupervisorReconcilerV1(f.db,binding.tenantId,()=>Date.parse(at(310_000)));
  assert.equal((await first.reconcileStalled())[0]?.lapseNumber,1);
  const ready=await f.canonical.get(binding.tenantId,"job",binding.jobId) as JobRecord;
  await f.canonical.claimReadyJob({tenantId:binding.tenantId,jobId:binding.jobId,expectedJobVersion:ready.version,
    nodeId:binding.nodeId,workerId:"worker:fixture",attemptId:"attempt:rollback-retry",leaseId:"lease:rollback-retry",
    transitionId:"transition:rollback-retry",idempotencyKey:"supervisor-rollback-retry",
    actor:{actorId:"identity:test",actorType:"human"},acquiredAt:at(320_000),expiresAt:at(350_000)});
  let refuse=true;
  const wrapped=(tx:DatabaseSession):DatabaseSession=>({query:async<T>(sql:string,params?:unknown[])=>{
    if(refuse&&sql.startsWith("INSERT INTO control_action_inbox")){refuse=false;throw new Error("synthetic_attention_failure");}
    return tx.query<T>(sql,params);
  }});
  const failing:DatabaseClient={query:f.db.query.bind(f.db),
    transaction:work=>f.db.transaction(tx=>work(wrapped(tx))),
    transactionWithPreCommitCheck:(work,check)=>f.db.transactionWithPreCommitCheck(tx=>work(wrapped(tx)),check)};
  await assert.rejects(new SupervisorReconcilerV1(failing,binding.tenantId,()=>Date.parse(at(360_000))).reconcileStalled(),
    /synthetic_attention_failure/u);
  assert.equal((await f.raw.query(`SELECT * FROM control_service_incidents WHERE correlation_key LIKE 'supervisor.lapse.%'`)).rows.length,0,
    "the incident and outbox roll back with the incomplete reconciliation");
  assert.equal((await f.raw.query<{lapse_count:number}>(`SELECT lapse_count FROM control_supervisor_task_heads WHERE tenant_id=$1 AND job_id=$2`,
    [binding.tenantId,binding.jobId])).rows[0]?.lapse_count,1);
  const retried=await new SupervisorReconcilerV1(f.db,binding.tenantId,()=>Date.parse(at(360_001))).reconcileStalled();
  assert.equal(retried[0]?.disposition,"needs_attention");
  assert.equal((await f.raw.query(`SELECT * FROM control_action_inbox WHERE tenant_id=$1 AND kind='incident'`,
    [binding.tenantId])).rows.length,1);
  assert.equal((await f.raw.query(`SELECT * FROM control_outbox WHERE tenant_id=$1 AND aggregate_type='service_incident'
    AND payload->>'safeReasonCode'='second_stall_needs_attention'`,[binding.tenantId])).rows.length,1);
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

test("an owner Stop revocation is not counted as a lease lapse by the supervisor sweep", async t => {
  const f=await nativeTaskFixture();t.after(f.close);
  const lease=await f.canonical.get(binding.tenantId,"lease","lease:test") as LeaseRecord|undefined;
  const attempt=await f.canonical.get(binding.tenantId,"attempt",binding.attemptId);
  const job=await f.canonical.get(binding.tenantId,"job",binding.jobId);
  assert.ok(lease&&attempt&&job);
  await f.canonical.revokeLease({tenantId:binding.tenantId,leaseId:lease.id,jobId:job.id,attemptId:attempt.id,
    expectedLeaseVersion:lease.version,expectedAttemptVersion:attempt.version,expectedJobVersion:job.version,
    epoch:lease.epoch,transitionId:"transition:operations-stop:test",idempotencyKey:"operations-stop:test",
    actor:{actorId:"identity:test",actorType:"human"},occurredAt:at(310_000)});
  const result=await new SupervisorReconcilerV1(f.db,binding.tenantId,()=>Date.parse(at(320_000))).reconcileStalled();
  assert.deepEqual(result,[]);
  assert.equal((await f.raw.query(`SELECT * FROM control_supervisor_task_heads WHERE tenant_id=$1 AND job_id=$2`,
    [binding.tenantId,binding.jobId])).rows.length,0);
  assert.equal((await f.raw.query(`SELECT * FROM control_action_inbox WHERE tenant_id=$1`,[binding.tenantId])).rows.length,0);
});

test("a stale supervisor loop records health, pauses starts through the operations interface, and raises an incident", async t => {
  const f=await nativeTaskFixture();t.after(f.close);let now=Date.parse(at(20_000)),pauses=0;
  const machine={async sample(){return{hostAlive:true,sharedMemorySegments:3,loadOneMinute:2};}};
  const operations={async pauseNewStarts(){pauses++;return{state:"paused" as const,receiptId:`pause:${pauses}`};},
    async resumeAfterMachineHealth(){return{state:"not_automatic" as const,receiptId:"resume:fixture"};}};
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

test("flapping load holds the automatic recovery window until the Mac is calmly healthy for five minutes", async t => {
  const f=await nativeTaskFixture();t.after(f.close);let now=Date.parse(at(20_000)),load=18,pauses=0,resumes=0;
  const machine={async sample(){return{hostAlive:true,sharedMemorySegments:3,loadOneMinute:load};}};
  const operations={async pauseNewStarts(){pauses++;return{state:"paused" as const,receiptId:`pause:${pauses}`};},
    async resumeAfterMachineHealth(){resumes++;return{state:"resumed" as const,receiptId:`resume:${resumes}`};}};
  const watchdog=new SupervisorWatchdogV1(f.db,binding.tenantId,"service:supervisor",machine,operations,()=>now,
    supervisorMachineHealthConfigV1({cpuCount:12}));
  assert.equal((await watchdog.cycle()).healthy,false);assert.equal(pauses,1);
  for (const next of [11,11,12,11,11,11,11,11,11]) {
    now+=60_000;load=next;await watchdog.cycle();
  }
  assert.equal(resumes,1,"load at the 12-core recovery boundary resets the sustained window instead of flapping starts");
  now+=60_000;await watchdog.cycle();
  assert.equal(resumes,1,"a successful automatic recovery is not retried every later healthy cycle");
});
