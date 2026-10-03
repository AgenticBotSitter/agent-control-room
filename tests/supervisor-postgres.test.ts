// Real-PostgreSQL production-role proof for the M2 supervisor. This file is
// intentionally skipped when PostgreSQL 17 cannot start; the cook helper must
// report that skip and give the exact command for a DB-capable helper.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { SupervisorWatchdogV1, type SupervisorOperationsModePortV1 } from "../src/supervisor/v1";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";

// Reserved disposable-cluster lane for the supervisor: 58390-58399.
const PORT=58390,PG=requiresRealPostgres();
const needsPg=()=>PG?undefined:{skip:realPostgresSkipMessage()};
// This file's own second lane, kept distinct from PORT above so the two tests
// never race each other's cluster.
const UNHEALTHY_PORT=58391;

/** Wraps one real connection (not a pool: a transaction must stay on one
 * session) as the minimal DatabaseClient the watchdog and incident store need. */
function singleConnectionDatabaseClient(client: Client): DatabaseClient {
  const query = async <T>(statement: string, params: unknown[] = []): Promise<{ rows: T[] }> =>
    ({ rows: (await client.query(statement, params as never[])).rows as T[] });
  const session: DatabaseSession = { query };
  const runInTransaction = async <T>(work: (session: DatabaseSession) => Promise<T>): Promise<T> => {
    await client.query("BEGIN");
    try { const result = await work(session); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  };
  return Object.freeze({ query, transaction: runInTransaction,
    async transactionWithPreCommitCheck<T>(work: (session: DatabaseSession) => Promise<T>, check: () => void | Promise<void>): Promise<T> {
      return runInTransaction(async session => { const result = await work(session); await check(); return result; });
    } });
}

test("supervisor migrations and least-privilege coordinator grants work on PostgreSQL 17",needsPg(),async()=>{
  const result=await withRealPostgres(async postgres=>{
    const admin=new Client(postgres.admin());await admin.connect();
    try{
      await admin.query("INSERT INTO tenants(id,display_name) VALUES('tenant:supervisor-pg','Supervisor fixture')");
      const objects=await admin.query<{name:string}>(`SELECT relname AS name FROM pg_class
        WHERE relname=ANY($1::text[]) ORDER BY relname`,[["control_provider_waits","control_supervisor_agent_health",
          "control_supervisor_health_observations","control_supervisor_loop_heads",
          "control_supervisor_reconciliation_events","control_supervisor_task_heads"]]);
      assert.equal(objects.rows.length,6);
    }finally{await admin.end();}
    const coordinator=new Client(postgres.connection("coordinator"));await coordinator.connect();
    try{
      await coordinator.query(`INSERT INTO control_supervisor_loop_heads
        (tenant_id,supervisor_id,version,last_started_at,last_completed_at,state)
        VALUES('tenant:supervisor-pg','service:supervisor',1,'2026-09-29T01:00:00.000Z',NULL,'starting')`);
      await coordinator.query(`UPDATE control_supervisor_loop_heads SET last_completed_at='2026-09-29T01:00:01.000Z',state='healthy'
        WHERE tenant_id='tenant:supervisor-pg' AND supervisor_id='service:supervisor'`);
      await assert.rejects(coordinator.query("DELETE FROM control_supervisor_loop_heads"),/permission denied/u);
      await assert.rejects(coordinator.query("UPDATE control_supervisor_loop_heads SET supervisor_id='service:other'"),/permission denied/u);
    }finally{await coordinator.end();}
    return postgres.appliedMigrations;
  },{port:PORT,allowedPorts:[PORT],boundMs:240_000});
  assert.equal(result.cleanedUp,true);assert.deepEqual(result.leftovers,[]);assert.ok(result.value>=1);
});

// Regression for the watchdog crash found by the preview builder: a busy
// machine at startup made the FIRST SupervisorWatchdogV1.cycle() judge the
// machine unhealthy, and its incident-outbox insert (topic
// 'service.incident.opened', aggregate_type 'service_incident') was then
// rejected by migration 0046's coordinator outbox guard, which only ever
// admitted the coordinator's own domain-transition topics. Real PostgreSQL,
// the real trigger, and the real `control_room_coordinator` login are what
// this test exercises -- a fake or superuser connection would not have caught
// the original bug, since the guard trigger exempts superusers.
test("an unhealthy first cycle records its incident on real PostgreSQL as the coordinator login, instead of crashing",needsPg(),async()=>{
  const result=await withRealPostgres(async postgres=>{
    const admin=new Client(postgres.admin());await admin.connect();
    try{
      await admin.query("INSERT INTO tenants(id,display_name) VALUES('tenant:supervisor-load','Supervisor load fixture')");
    }finally{await admin.end();}
    const coordinator=new Client(postgres.connection("coordinator"));await coordinator.connect();
    try{
      const db=singleConnectionDatabaseClient(coordinator);
      // The exact shape observed in the field: load far past
      // SUPERVISOR_MAX_LOAD_ONE_MINUTE_V1, shared memory still within bounds.
      const machine={async sample(){return{hostAlive:true,sharedMemorySegments:5,loadOneMinute:23.4};}};
      let pauses=0;
      const operations:SupervisorOperationsModePortV1={async pauseNewStarts(){pauses++;
        return{state:"paused" as const,receiptId:`pause:${pauses}`};},
        async resumeAfterMachineHealth(){return{state:"not_automatic" as const,receiptId:"resume:fixture"};}};
      const watchdog=new SupervisorWatchdogV1(db,"tenant:supervisor-load","service:supervisor",machine,operations,
        ()=>Date.parse("2026-09-29T19:35:00.000Z"));
      // This is the assertion that would have failed before the fix: the
      // production login's first cycle must resolve, not throw.
      const health=await watchdog.cycle();
      assert.equal(health.healthy,false);
      assert.deepEqual(health.reasonCodes,["load_limit"]);
      assert.equal(pauses,1,"an unhealthy first cycle must still pause new starts");
      const incident=await coordinator.query<{safe_reason_code:string;state:string}>(
        `SELECT safe_reason_code,state FROM control_service_incidents
         WHERE tenant_id='tenant:supervisor-load' AND correlation_key='supervisor.health.load_limit'`);
      assert.deepEqual(incident.rows[0],{safe_reason_code:"load_limit",state:"open"});
      const attention=await coordinator.query<{kind:string;payload:{reasonCode:string}}>(
        `SELECT kind,payload FROM control_action_inbox WHERE tenant_id='tenant:supervisor-load' AND kind='incident'`);
      assert.equal(attention.rows[0]?.payload.reasonCode,"load_limit");
    }finally{await coordinator.end();}
    return postgres.appliedMigrations;
  },{port:UNHEALTHY_PORT,allowedPorts:[UNHEALTHY_PORT],boundMs:240_000});
  assert.equal(result.cleanedUp,true);assert.deepEqual(result.leftovers,[]);assert.ok(result.value>=1);
});
