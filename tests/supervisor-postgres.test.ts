// Real-PostgreSQL production-role proof for the M2 supervisor. This file is
// intentionally skipped when PostgreSQL 17 cannot start; the cook helper must
// report that skip and give the exact command for a DB-capable helper.
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";

// Reserved disposable-cluster lane for the supervisor: 58390-58399.
const PORT=58390,PG=requiresRealPostgres();
const needsPg=()=>PG?undefined:{skip:realPostgresSkipMessage()};

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
