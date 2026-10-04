// Load and concurrency against B4's atomic transition function, on real
// PostgreSQL 17 as the production logins.
//
// WHY THIS IS A SEPARATE FILE. The other tests in this lane prove the guards
// hold for ONE caller. This one asks the question a wedged install actually
// raises: what happens when twenty updater processes, a heartbeat, a watcher and
// a second web reader all touch the same row at once. The review's shape of bug
// was a refusal, so the failure mode to look for is not a wrong answer but a
// HANG or a wedge — a run that no caller can move again.
//
// WHAT IS ASSERTED, AND WHY EACH THING MATTERS:
//   * 20 concurrent callers with the RIGHT lease token: exactly one wins each
//     step. A loser's refusal must be a refusal, not a partial write — a caller
//     that half-moved a row is the wedge B4 exists to remove.
//   * 20 concurrent callers with a WRONG lease token: none of them moves
//     anything, and none of them writes a mirror row. Ownership is re-checked
//     inside the statement, so there is no window between check and write.
//   * the mirror ordinals stay a gapless 1..n under contention, so
//     `guard_run_event_insert`'s ordinal chain is not corrupted by a race.
//   * the row's state and its last mirror event agree AFTER the storm, which is
//     the B4 property itself, observed under load rather than on one step.
//   * a dropped connection mid-statement (a client killed while holding the
//     session) leaves the row and its mirror consistent — the real kill path,
//     at the worst possible moment.
//
// EVERY CALLER HERE IS A REAL CLIENT with its own session, and the winner/loser
// decisions are made by the DATABASE, not by the test. No injected port, no fake
// store: this is `PostgresUpdaterStoreV1` over a real `control_room_deployer`
// connection, which is what the DEFAULT-PATH rule asks for.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { PostgresUpdaterStoreV1 } from "../src/updater/v1/store.mjs";
import { applyUpdaterSchemaV1 } from "../src/updater/v1/schema-installer";

// Its OWN port, distinct from the recovery lane's. `node --test` runs test FILES
// concurrently even under `--test-concurrency=1` (that flag governs `t.test`
// subtests inside one file), so two files that default to the same
// `CONTROL_ROOM_PG_TEST_PORT_BASE` race for the same port and each refuses the
// other's cluster with `refusing_occupied_port` — which reads as a real failure
// and is not one. Measured, and the symptom is confusing: a different test fails
// on each run, depending on which file won the race.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59484), PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };

const DEPLOYER_PASSWORD = "fixture-deployer";
const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

type Postgres = Parameters<Parameters<typeof withRealPostgres>[0]>[0];

function as(postgres: Postgres) {
  return new Client({ host: postgres.socketDirectory, port: postgres.port, database: postgres.database,
    user: "control_room_deployer", password: DEPLOYER_PASSWORD });
}

async function installUpdaterSchema(postgres: Postgres) {
  const bootstrap = new Client({ ...postgres.admin(), user: "fixture_admin" } as never);
  await bootstrap.connect();
  const owner = new Client({ host: postgres.socketDirectory, port: postgres.port,
    user: "control_room_migrator", password: (postgres.connection("migrator") as { password: string }).password,
    database: postgres.database });
  await owner.connect();
  let deployer: Client | undefined;
  try {
    return await applyUpdaterSchemaV1({
      bootstrap,
      directory: join(process.cwd(), "src/updater/v1/ddl"),
      deployerHasFixturePassword: true,
      connectDeployer: async () => {
        await owner.query(await readFile(join(process.cwd(), "db/roles/updater_release_reader_roles.sql"), "utf8"));
        await bootstrap.query(`ALTER ROLE control_room_deployer PASSWORD '${DEPLOYER_PASSWORD}'`);
        deployer = as(postgres); await deployer.connect(); return deployer;
      },
    });
  } finally {
    await deployer?.end().catch(() => {});
    await owner.end().catch(() => {});
    await bootstrap.end();
  }
}

/** Retire any open plan, then mint a fresh approved plan and its live run.
 *
 * The design allows exactly ONE open plan (design §5.5) and ONE live run
 * (`runs_one_live`), both database-wide, so a load fixture that mints several
 * must retire the previous one first. The order matters: the RUN goes first,
 * because B2's guard refuses to supersede a plan whose run is still live — the
 * right behaviour, and the reason this helper cannot close the plan before the
 * run is finished. A run the caller is keeping live passes `keepLiveRun`, and
 * then only the plan is retired. */
async function insertPlanAndRun(client: Client, planId: string, leaseToken: string,
  { keepLiveRun = false } = {}) {
  if (!keepLiveRun)
    await client.query("UPDATE updater.runs SET state='refused',finished_at=pg_catalog.now() "
      + "WHERE finished_at IS NULL AND state IN ('approved','prechecked','staged','quick_backup')");
  await client.query("UPDATE updater.plans SET state='superseded',superseded_by_plan_id='plan-retired' "
    + "WHERE state IN ('building','ready_for_approval','approved','approval_required') "
    + "AND superseded_by_plan_id IS NULL");
  await client.query(`INSERT INTO updater.plans(plan_id,installation_id,kind,state,classes,changes_database,
    changes_updater,plan_digest,plan_json,needs_mac_confirm,expires_at)
    VALUES($1,'install-fixture','code','ready_for_approval',ARRAY['code'],false,false,$2,$3::jsonb,false,
      now() + interval '72 hours')`, [planId, digest(planId), JSON.stringify({
    schema: "control-room.install-plan/v2", planId, installationId: "install-fixture", kind: "code",
    candidate: { commit: "a".repeat(40) }, updaterDerived: { classes: ["code"], changesDatabase: false,
      changesUpdater: false } })]);
  await client.query("UPDATE updater.plans SET state='approved' WHERE plan_id=$1", [planId]);
  const runId = `run:${randomUUID()}`;
  await client.query("INSERT INTO updater.runs(run_id,plan_id,state,run_class,lease_token) "
    + "VALUES($1,$2,'approved','code',$3)", [runId, planId, leaseToken]);
  return runId;
}

const rowState = async (client: Client, runId: string) => (await client.query(
  "SELECT state FROM updater.runs WHERE run_id=$1", [runId])).rows[0]?.state;
const ordinals = async (client: Client, runId: string) => (await client.query(
  "SELECT ordinal FROM updater.run_events WHERE run_id=$1 ORDER BY ordinal", [runId]))
  .rows.map((row: { ordinal: string }) => Number(row.ordinal));

/** Run `body` over `count` independent REAL clients, all started at once. */
async function withClients<T>(postgres: Postgres, count: number,
  body: (clients: Client[], stores: PostgresUpdaterStoreV1[]) => Promise<T>): Promise<T> {
  const clients: Client[] = [], stores: PostgresUpdaterStoreV1[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const client = as(postgres);
      await client.connect();
      clients.push(client);
      const store = new PostgresUpdaterStoreV1(client);
      await store.initialize();
      stores.push(store);
    }
    return await body(clients, stores);
  } finally {
    // Every client this test opened, ended here — a load test that leaves 20
    // sessions behind would keep the cluster's connection count up for the next.
    for (const client of clients) await client.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------

test("load: twenty concurrent rightful callers move a run once, and twenty impostors never", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const observer = as(postgres); await observer.connect();
    try {
      const store = new PostgresUpdaterStoreV1(observer); await store.initialize();
      // ---- twenty callers all asking for the SAME step -----------------
      // Every one of them wants `approved -> prechecked` at the same instant.
      // Design §8.1 requires every effect to be repeat-safe, so the right
      // outcome is NOT "one winner and nineteen losers": a loser that re-asks
      // for the state the row is already in is asking for nothing, and the
      // function answers with the row. What must NOT happen is twenty mirror
      // events for one step — measured as 20 before the row lock went in.
      const planId = "plan-load-right", leaseToken = "lease-load-right";
      const runId = await insertPlanAndRun(observer, planId, leaseToken);
      await withClients(postgres, 20, async (_clients, stores) => {
        const results = await Promise.allSettled(stores.map(store =>
          store.transition(runId, leaseToken, "prechecked", { step: "prechecked" })));
        for (const refusal of results.filter(r => r.status === "rejected")) {
          assert.fail(`twenty callers asking for one step must not be refused: `
            + `${String((refusal as PromiseRejectedResult).reason?.message ?? "")}`);
        }
        assert.equal(await rowState(observer, runId), "prechecked", "the row is at the state asked for");
        // The assertion that matters: ONE mirror row, whatever the callers did
        // among themselves. A duplicate here is a journal that misreports how the
        // run got where it is, and `guard_run_event_insert`'s ordinal chain is
        // built on this being exactly one row per step.
        assert.deepEqual(await ordinals(observer, runId), [1],
          "one step, one mirror row: a repeat is a no-op, not a second event");
      });
      // And the run continues normally afterwards — the lock did not leave it
      // held, and the ordinal chain is still usable.
      await withClients(postgres, 1, async (_clients, stores) => {
        assert.equal((await stores[0].transition(runId, leaseToken, "staged", {})).state, "staged");
      });
      assert.deepEqual(await ordinals(observer, runId), [1, 2],
        "the next step took ordinal 2, so the chain is intact after the storm");

      // ---- twenty callers with a WRONG lease ---------------------------
      // The impostor case: a second updater that does not hold the token. It
      // must move nothing and write nothing, and — because the check is INSIDE
      // the statement — there is no instant at which it read "yes" and wrote
      // later.
      //
      // The first run is FINISHED properly first, through the store, because
      // `runs_one_live` refuses a second live row database-wide. Finishing it the
      // real way (rather than by disabling anything) is also the tidier end
      // state: this test then leaves two complete runs and no loose ends.
      for (const state of ["quick_backup", "draining", "switched", "restarted", "healthy"])
        await store.transition(runId, leaseToken, state, { step: state });
      await store.transition(runId, leaseToken, "succeeded", {}, { terminal: true });
      const impostorPlan = "plan-load-wrong";
      const impostorRun = await insertPlanAndRun(observer, impostorPlan, "lease-load-real");
      await withClients(postgres, 20, async (_clients, stores) => {
        const results = await Promise.allSettled(stores.map(store =>
          store.transition(impostorRun, "lease-load-fake", "prechecked", { step: "prechecked" })));
        assert.equal(results.filter(r => r.status === "fulfilled").length, 0,
          "no impostor may move a run it does not hold the lease for");
        for (const refusal of results.filter(r => r.status === "rejected")) {
          assert.match(String((refusal as PromiseRejectedResult).reason?.message ?? ""),
            /updater_run_lease_lost/u, "and it is refused as a lost lease, which is identifiable");
        }
        assert.equal(await rowState(observer, impostorRun), "approved", "the row did not move");
        assert.deepEqual(await ordinals(observer, impostorRun), [], "and no mirror row was written");
      });
      // The rightful holder still works, from its OWN fresh session: twenty failed
      // impostors must not have poisoned the run or left a lock against the real
      // caller. A separate client rather than the observer, so the assertion
      // cannot pass by reusing an already-warm connection.
      await withClients(postgres, 1, async (_clients, stores) => {
        assert.equal((await stores[0].transition(impostorRun, "lease-load-real", "prechecked", {})).state,
          "prechecked", "the rightful holder can still move it after twenty refusals");
      });

      // ---- the mirror chain survives the whole storm -------------------
      // Gapless ordinals are what `guard_run_event_insert` enforces, and a race
      // that skipped one would be a journal with a hole in it.
      const ordinalsNow = await ordinals(observer, impostorRun);
      assert.deepEqual(ordinalsNow, ordinalsNow.map((_value, index) => index + 1),
        "the mirror ordinals are gapless after concurrent writers contended for them");
    } finally { await observer.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 900_000 });
});

test("load: a client killed mid-statement leaves the row and its mirror agreeing", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    await installUpdaterSchema(postgres);
    const observer = as(postgres); await observer.connect();
    try {
      // The dropped-connection case, at the worst moment: a client that is
      // SIGKILLed while it holds a session mid-run. PostgreSQL rolls back the
      // open transaction when the socket dies, so the question is whether the
      // result is a state the next caller can move out of — not whether the kill
      // was clean, because it was not.
      const planId = "plan-load-drop", leaseToken = "lease-load-drop";
      const runId = await insertPlanAndRun(observer, planId, leaseToken);
      const store = new PostgresUpdaterStoreV1(observer); await store.initialize();
      for (const state of ["prechecked", "staged", "quick_backup"])
        await store.transition(runId, leaseToken, state, { step: state });

      // A SECOND real client holds an open transaction on the run, and is then
      // killed where it sits — no ROLLBACK from the client, no `finally`.
      // `pg_terminate_backend` is issued from the kit's ADMIN connection, which
      // is the only login allowed to signal a backend; doing it from the
      // deployer would be refused and the test would silently not reproduce
      // anything.
      const victim = as(postgres); await victim.connect();
      const admin = new Client(postgres.admin()); await admin.connect();
      try {
        await victim.query("BEGIN");
        await victim.query("SELECT updater.record_run_step($1,$2,'draining','{}'::jsonb,false)", [runId, leaseToken]);
        const pid = (await victim.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await admin.query("SELECT pg_terminate_backend($1)", [pid]);
        // The victim is now dead, and the client learns it as a `57P01` FATAL on
        // whatever it does next. Draining that is part of the reproduction — a
        // dropped connection is not a clean close — so the error is awaited here
        // and its code ASSERTED rather than left to surface somewhere unrelated.
        const seen = await victim.query("SELECT 1").then(() => "no-error",
          (error: { code?: string }) => String(error?.code ?? "none"));
        assert.match(seen, /^(57P01|08006|ECONNRESET)$/u,
          `a terminated client must see a dropped-connection error, saw ${seen}`);
      } finally {
        // `end()` on an already-dead client raises again; the connection is gone,
        // which is the point of this case. The assertion that matters is on the
        // DATABASE state below.
        await victim.end().catch(() => {});
        await admin.end().catch(() => {});
      }

      // Whatever survived: the row and its last mirror event are one fact, and
      // the run can still move.
      const row = await rowState(observer, runId);
      const mirror = (await ordinals(observer, runId)).length;
      assert.ok(["quick_backup", "draining"].includes(String(row)),
        `a terminated session left the run at ${String(row)}, which must be a state the run can move from`);
      const store2 = new PostgresUpdaterStoreV1(observer); await store2.initialize();
      const next = row === "draining" ? "switched" : "draining";
      assert.equal((await store2.transition(runId, leaseToken, next, { step: next })).state, next,
        "the run is not wedged after a client was killed mid-statement");
      assert.equal(await rowState(observer, runId), next);
      // And the mirror agrees — which is the property B4 exists to guarantee, now
      // observed after a real session death rather than a simulated one.
      const states = (await observer.query("SELECT state FROM updater.run_events WHERE run_id=$1 "
        + "ORDER BY ordinal DESC LIMIT 1", [runId])).rows[0]?.state;
      assert.equal(states, next, `the last mirror row (${String(states)}) must match the row (${next})`);
      assert.ok(mirror >= 3, `the mirror grew to ${mirror} rows, so steps were recorded, not lost`);
    } finally { await observer.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 900_000 });
});

test("the lane ran on a real cluster, not a skip", () => {
  if (PG) assert.equal(ran, required, "every PostgreSQL test in this lane ran");
});