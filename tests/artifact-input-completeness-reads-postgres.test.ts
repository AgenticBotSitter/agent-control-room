// Real-PostgreSQL regression for migration 0238.
//
// 0211 hangs `guard_job_artifact_inputs_complete` off `control_jobs` as a
// BEFORE UPDATE trigger, and that guard reads control_task_declared_inputs and
// control_job_artifact_inputs. The guard is SECURITY INVOKER, by design, so
// PostgreSQL checks the WRITER's privilege on both tables. 0211 granted them to
// the fleet gateway, the private web login and the native publisher, and to
// nobody else -- so the two roles holding
// `UPDATE (state, version, payload, updated_at) ON control_jobs` could not
// satisfy their own trigger.
//
// Measured on real PostgreSQL 17 before 0238: the production coordinator login
// running the supervisor's own reconcile statement
// (`UPDATE control_jobs SET state='ready' ... WHERE state='running'`) got
// `42501 permission denied for table control_task_declared_inputs`, which the
// production driver surfaces as `database_unavailable`. Every stalled task
// therefore stayed stranded in 'running' with a live claim and an expired
// lease: the recovery path was dead for both fleet and local work, and only on
// the merge, because neither side alone had both the trigger and the writer.
//
// What this file proves, on a real cluster, as the real production logins:
//
//   1. The coordinator can perform the supervisor's reconcile UPDATE with the
//      0211 trigger ENABLED. This is the assertion that fails without 0238.
//   2. It can do so on BOTH of the supervisor's 'ready' edges (from 'running'
//      and from 'orphaned'), not just the one the failing lane happened to take.
//   3. The grant is read-only and narrow: INSERT, UPDATE and DELETE on both
//      tables are still refused, so a scheduler cannot declare a combine input
//      or re-point a binding.
//   4. The news coordinator -- the other writer of control_jobs.state, and the
//      one the Mac-local owner never runs, so the defect would have survived on
//      the branch that found it -- can satisfy the same trigger.
//   5. The combine rule itself still HOLDS: with 0238's grants in place, a job
//      with a declared-but-unbound input is still refused 23514, and a job with
//      every declared input bound is still allowed. A fix that granted the read
//      but let the guard through vacuously would pass assertions 1 and 2 and
//      fail this one, so it is the assertion that makes the others mean
//      something.
//   6. 0238's own down revokes exactly what 0238 granted, restoring the 42501
//      -- so the down file reverses one migration rather than quietly widening
//      or narrowing the ACL beyond it.
//
// The attack kit provisions a disposable socket-only cluster on this file's
// reserved port lane and destroys it afterwards.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, REPOSITORY_ROOT } from
  "./support/attack-kit/index";
import { seedFleetTenant, seedProposedTask, FLEET_TENANT } from "./support/fleet-fixture";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";

const MIGRATION = "0238_artifact_input_completeness_reads.sql";
// This file's own reserved disposable-cluster lane, 59960-59969 by default.
// A DEFAULT, not the caller's CONTROL_ROOM_PG_TEST_PORT_BASE: every postgres
// test file owns a distinct fixed lane, because the lanes run with
// --test-concurrency=1 inside one process and share that environment variable.
// Reading it here made this file follow whatever the enclosing lane happened to
// set, which put two files' clusters on one port whenever they ran side by
// side. Its default honours the same rule; an explicit override still moves it.
const PORT = Number(process.env.CONTROL_ROOM_ARTIFACT_INPUT_READS_PG_PORT ?? 59960);
const PG = requiresRealPostgres();
const needsPg = () => PG ? undefined : { skip: realPostgresSkipMessage() };

/** A real job row, created through the fixture so the 0003 payload mirror holds. */
async function seedJob(admin: DatabaseClient, name: string) {
  const { jobId } = await seedProposedTask(admin, "project-a", name);
  return jobId;
}

/** The supervisor's reconcile statement, with the 0003 payload mirror in step. */
const reconcile = (to: string, from: string) => `UPDATE control_jobs SET state='${to}',version=version+1,
  payload=jsonb_set(jsonb_set(payload,'{state}',to_jsonb('${to}'::text)),'{version}',to_jsonb(version+1)),
  updated_at=statement_timestamp()
  WHERE tenant_id=$1 AND id=$2 AND state='${from}'`;

const TABLES = ["control_task_declared_inputs", "control_job_artifact_inputs"] as const;

test("0238 makes 0211's combine-readiness guard satisfiable for every login that writes control_jobs.state",
  needsPg(), async t => {
    await withRealPostgres(async postgres => {
      const adminLogin = postgres.admin({ database: postgres.database });
      // Wired exactly as fleet-claim-contention-postgres.test.ts's own adminPool
      // helper wires it, which is the wiring the failing lane observes. The
      // diagnostics below use raw pg so a 42501 is visible rather than
      // translated by the production driver into `database_unavailable`.
      const adminBound = bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1",
        port: postgres.port, database: postgres.database, username: adminLogin.user,
        password: adminLogin.password, majorVersion: 17 }), host: adminLogin.host }));
      const admin = adminBound.client as DatabaseClient;
      const coordinator = new Client(postgres.connection("coordinator"));
      const news = new Client(postgres.connection("news"));
      t.after(async () => {
        await coordinator.end().catch(() => {});
        await news.end().catch(() => {});
        await adminBound.close().catch(() => {});
      });
      await coordinator.connect();
      await news.connect();
      // A bare pg Client is an EventEmitter: when the attack kit tears the
      // cluster down under these connections, each emits an 'error' that would
      // otherwise be an uncaught exception rather than a test failure. Absorbed
      // here so a real assertion below is what the run reports.
      coordinator.on("error", () => {});
      news.on("error", () => {});

      await seedFleetTenant((sql, params) => admin.query(sql, params));
      const jobId = await seedJob(admin, "artifact-input-reads");

      // ---- 1 + 2: the supervisor's own reconcile, both 'ready' edges.
      await admin.query(reconcile("running", "proposed"), [FLEET_TENANT, jobId]);
      const runningToReady = await coordinator.query(reconcile("ready", "running"), [FLEET_TENANT, jobId])
        .then(result => ({ ok: true as const, rows: result.rowCount }),
          (error: Error & { code?: string }) => ({ ok: false as const, code: error.code, message: error.message }));
      assert.equal(runningToReady.ok, true,
        `the coordinator's own reconcile UPDATE must satisfy 0211's BEFORE UPDATE trigger -- ${JSON.stringify(runningToReady)}`);
      assert.equal(runningToReady.rows, 1, "and it must move the job, not match nothing");

      await admin.query(reconcile("orphaned", "ready"), [FLEET_TENANT, jobId]);
      const orphanedToReady = await coordinator.query(reconcile("ready", "orphaned"), [FLEET_TENANT, jobId])
        .then(result => result.rowCount, (error: Error & { code?: string }) => {
          throw new Error(`the orphaned -> ready edge must be satisfiable too: ${error.code} ${error.message}`); });
      assert.equal(orphanedToReady, 1, "the supervisor's other 'ready' edge is covered by the same grant");

      // ---- 4: the other writer of control_jobs.state. The Mac-local owner
      // never runs a news coordinator, so nothing else in the suite would have
      // caught this half of the same 42501.
      await admin.query(reconcile("running", "ready"), [FLEET_TENANT, jobId]);
      const newsReady = await news.query(reconcile("ready", "running"), [FLEET_TENANT, jobId])
        .then(result => result.rowCount, (error: Error & { code?: string }) => {
          throw new Error(`the news coordinator holds UPDATE on control_jobs.state and must satisfy the same trigger: ${error.code} ${error.message}`); });
      assert.equal(newsReady, 1, "the news coordinator can move a job into 'ready' with the guard enabled");

      // ---- 3: the grant is read-only. A scheduler that could write these two
      // tables could promise a project where to send its files, or hand itself
      // an input to combine.
      //
      // Matched on the SQLSTATE rather than the message, and with `DEFAULT
      // VALUES` avoided for UPDATE/DELETE: a statement refused for a NOT NULL or
      // a missing-column reason would satisfy a loose matcher while saying
      // nothing about privilege, and a privilege check is the only thing this
      // asserts. 42501 is insufficient_privilege, which is what a role with only
      // SELECT must get.
      for (const table of TABLES) {
        const refusals: Array<{ statement: string; code: string | undefined; message: string }> = [];
        for (const statement of [
          `INSERT INTO ${table}(tenant_id) VALUES ('nope')`,
          `UPDATE ${table} SET tenant_id='nope'`,
          `DELETE FROM ${table}`,
        ]) await coordinator.query(statement).then(
          () => refusals.push({ statement, code: undefined, message: "ACCEPTED" }),
          (error: Error & { code?: string }) => refusals.push({ statement, code: error.code, message: error.message }));
        assert.deepEqual(refusals.map(refusal => refusal.code), ["42501", "42501", "42501"],
          `the coordinator must hold no write privilege on ${table}: ${JSON.stringify(refusals)}`);
      }

      // ---- 5: the rule still holds. The grants make the guard EVALUABLE; they
      // must not make it vacuous. A job with a declared-but-unbound input is
      // still refused, and the coordinator's own login is what refuses it.
      //
      // A job of its own, because the steps above have already moved `jobId`
      // through running/ready/orphaned, and this assertion is about the guard
      // refusing a start rather than about a particular prior state. 0211 fires
      // on the proposed -> running edge too, so one coordinator statement is
      // enough: the very first move a combine job makes is the one that must be
      // refused while its input is unbound.
      const combine = await seedJob(admin, "artifact-input-combine");
      const producer = await seedJob(admin, "artifact-input-producer");
      await admin.query(`INSERT INTO control_job_dependencies(tenant_id,job_id,depends_on_job_id)
        VALUES($1,$2,$3)`, [FLEET_TENANT, combine, producer]);
      const owner = await admin.query<{ id: string }>(
        `SELECT id FROM control_identities WHERE tenant_id=$1 AND actor_type='human' LIMIT 1`,
        [FLEET_TENANT]);
      // The declaration is the owner's approval artefact, so it is written here
      // as the seed/admin connection rather than as the scheduler.
      await admin.query(`INSERT INTO control_task_declared_inputs
        (tenant_id,project_id,job_id,ordinal,producer_job_id,display_name,decided_by_identity_id,created_at)
        VALUES($1,'project-a',$2,1,$3,'combined.txt',$4,statement_timestamp())`,
        [FLEET_TENANT, combine, producer, owner.rows[0].id]);

      const state = await admin.query<{ state: string }>("SELECT state FROM control_jobs WHERE id=$1",
        [combine]);
      assert.equal(state.rows[0].state, "proposed",
        "the combine job really is still 'proposed' when the coordinator tries to start it");
      const unbound = await coordinator.query(reconcile("running", "proposed"), [FLEET_TENANT, combine])
        .then(result => ({ ok: true as const, rows: result.rowCount }),
          (error: Error & { code?: string }) => ({ ok: false as const, code: error.code, message: error.message }));
      assert.equal(unbound.ok, false,
        `a combine job with a declared but unbound input must still be refused: the grant must not make the guard vacuous -- ${JSON.stringify(unbound)}`);
      assert.equal(unbound.code, "23514",
        `and refused for the reason 0211 states, not for want of privilege: ${JSON.stringify(unbound)}`);

      // ---- 6: the migration's own job. A role file is only read when the module
      // is provisioned, so an installation provisioned before 0238 existed keeps
      // the older ACL, and the migration is what converges it. That is the only
      // behaviour the role files cannot mask, and it is the one an owner
      // upgrading in place actually depends on -- so it is asserted by taking
      // the role-file grants away first and then applying 0238 to restore them.
      const adminClient = new Client(postgres.admin({ database: postgres.database }));
      await adminClient.connect();
      try {
        const readableFor = async (role: string) => (await adminClient.query<{ readable: boolean }>(
          "SELECT has_table_privilege($1,'control_task_declared_inputs','SELECT') AS readable", [role]))
          .rows[0].readable;
        for (const role of ["control_room_task_coordinator", "control_room_news_coordinator"])
          assert.equal(await readableFor(role), true,
            `${role} can read the combine tables on a freshly provisioned database, from the role files`);

        // The upgrade case: the older ACL this migration exists to repair.
        await adminClient.query(`REVOKE SELECT ON control_task_declared_inputs, control_job_artifact_inputs
          FROM control_room_task_coordinator, control_room_news_coordinator`);
        for (const role of ["control_room_task_coordinator", "control_room_news_coordinator"])
          assert.equal(await readableFor(role), false, `${role} starts from the pre-0238 ACL`);

        // And the guard really is unevaluable in that state -- the bug itself,
        // re-created on purpose so the restoration below is measured against it.
        await adminClient.query(reconcile("running", "ready"), [FLEET_TENANT, jobId]);
        const beforeUpgrade = await coordinator.query(reconcile("ready", "running"), [FLEET_TENANT, jobId])
          .then(result => ({ ok: true as const }),
            (error: Error & { code?: string }) => ({ ok: false as const, code: error.code, message: error.message }));
        assert.equal(beforeUpgrade.ok, false, "the pre-0238 ACL cannot satisfy the guard, which is the bug");
        assert.equal(beforeUpgrade.code, "42501",
          `and it is 42501, not something else: ${JSON.stringify(beforeUpgrade)}`);

        await adminClient.query(await readFile(join(REPOSITORY_ROOT, "db/migrations", MIGRATION), "utf8"));
        for (const role of ["control_room_task_coordinator", "control_room_news_coordinator"])
          assert.equal(await readableFor(role), true, `0238 converges ${role} onto the role file's ACL`);

        // ---- 7: the down revokes exactly what the up granted, and the state it
        // leaves behind is the bug again -- a faithful reversal, not a second
        // and different fix.
        await adminClient.query(await readFile(join(REPOSITORY_ROOT, "db/down", MIGRATION), "utf8"));
        for (const role of ["control_room_task_coordinator", "control_room_news_coordinator"])
          assert.equal(await readableFor(role), false, `0238's down revokes exactly 0238's grant from ${role}`);

        // A job moved back to 'running' first, so a 0-row UPDATE cannot pass
        // this as a success: the statement has to reach the trigger, and the
        // trigger has to be what refuses it.
        await adminClient.query(reconcile("running", "ready"), [FLEET_TENANT, jobId]);
        const afterDown = await coordinator.query(reconcile("ready", "running"), [FLEET_TENANT, jobId])
          .then(result => ({ ok: true as const, rows: result.rowCount }),
            (error: Error & { code?: string }) => ({ ok: false as const, code: error.code, message: error.message }));
        assert.equal(afterDown.ok, false, "after 0238's down the coordinator is back to failing its own guard");
        assert.equal(afterDown.code, "42501",
          `and it fails for exactly the privilege 0238 granted: ${JSON.stringify(afterDown)}`);
      } finally { await adminClient.end(); }
    }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });
  });
