// R4U-19a: the queue-worker's startup preflight REFUSES a correctly installed
// database, so a real install's native queue worker refuses to start.
//
// The shape of the defect. Migration 0213 and `db/roles/native_queue_worker_roles.sql`
// both grant the queue-worker group `control_room_native_queue_worker` SELECT on
// `control_worker_text_copy_derivations` -- an owner-style view (no
// `security_invoker` option, so it runs with the schema owner's privileges on the
// table beneath it) whose WHERE clause narrows rows to the jobs the CALLING LOGIN
// has an admission for. The
// queue-worker's exact-privilege check (`verifyPgBossNativeWorkerPermissions`,
// src/persistence/pg-boss-native-task-permissions.ts) pinned every readable
// relation to the `control_room_queue` schema and counted exactly four, so the
// one view 0213 added was an unlisted readable relation and the check refused.
// It is fail-closed, and the consequence is the whole product being down: the
// preflight also runs at queue start (src/persistence/pg-boss-bounded-runtime.ts),
// and `scripts/mac-local/check-database.ts` runs it as `mac:check-database`.
//
// MEASURED on a real PostgreSQL 17 cluster installed the production way (the
// attack kit's migration ledger + db/roles files), BEFORE the fix:
//
//   GRANT: {"readable":true,"view_owner":"control_room_schema_owner"}
//   RAW PERMISSION CHECK:  REFUSED -> native_task_worker_permissions_invalid
//   PREFLIGHT:             REFUSED -> private_database_preflight_failed
//   QUEUE WORKER START:    REFUSED -> native_queue_worker_start_failed
//
// The third line is the point of the file: that is the real queue worker, the
// real pinned pg-boss 12.30.0 and the real production login, driven through
// `createNativeQueueWorkerBootstrap` -- the default path with no injected port,
// tool, runner or fake. It is the test that fails on the old code.
//
// WHY THE GRANT IS RIGHT AND THE CHECK WAS WRONG, and this is the decision the
// file records rather than the one it merely implements. Nothing in the product
// reads that view through the queue-worker login yet (grepped: the only reader
// is a bot login in tests/text-copy-derivation-postgres.test.ts), so "revoke the
// unused grant" was genuinely available. It was rejected on two measured grounds:
//
//   1. The grant is not the raw authority it looks like, but it is not inert
//      either, and the two facts are different. The view is NOT security-invoker
//      -- 0213 deliberately creates it without that option, so it runs with the
//      schema owner's privileges on control_text_copy_derivations, and the login
//      holds no privilege on that table itself (asserted below, by 42501 on the
//      table). What stops a worker reading another worker's rows is therefore the
//      view's WHERE clause, which joins `work_batch_queue_admissions` on
//      `q.worker_id = session_user` -- the property 0213's comment argues at
//      length and which the zero-rows assertion in step 6 measures directly. The
//      direct-table refusal is worth keeping regardless: it is belt-and-suspenders
//      against any future code path that reads the table instead of the view.
//      Revoking the view grant would delete that surface at the cost of one row
//      in this file.
//   2. Removing it would need a new migration plus its down file, the
//      grant-source list, the SECURITY DEFINER / down-rung lists and a
//      re-derived privateWebSchemaDigest, to delete a grant no code path reads.
//      That is a strictly larger and more dangerous change than teaching one
//      check about one view, and it would have to be undone again the moment a
//      bot starts reading its input's text copy -- which plan v4.3 2.7 (MIG-E)
//      requires: "Bots get the text copy for their part inputs by default."
//
// So the fix is on the check side, and the shape of the fix is the security
// argument, not a convenience:
//
//   * The expected set becomes (schema, name, writable) rather than name alone,
//     so a pin names the SCHEMA it lives in. A view can now be allowed without
//     any way to pin a same-named relation in another schema.
//   * `control_worker_text_copy_derivations` is pinned READ ONLY, in `public`.
//   * The count is 5, and it is still an exact count: every one of the five must
//     hold exactly SELECT (two of them also INSERT/UPDATE/DELETE), so the check
//     still refuses a widened grant, a missing grant, a rename, and any second
//     readable relation anywhere.
//
// WHAT MUST STILL BE REFUSED is asserted below, one widening at a time, because a
// check that has been relaxed to accept a correct database is worth nothing if it
// also accepts a wrong one. The table behind the view, the owner-facing view,
// UPDATE on the worker view, a stray readable relation in the queue schema, and
// a widened privilege on any of the four pg-boss relations are each measured to
// still refuse.
import assert from "node:assert/strict";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { verifyNativeQueueWorkerDatabase } from "../src/web/v1/private-database-preflight";
import { verifyPgBossNativeWorkerPermissions } from "../src/persistence/pg-boss-native-task-permissions";
import { createNativeQueueWorkerBootstrap } from "../src/web/v1/native-queue-worker-startup";
import { createPrivatePostgresDatabase } from "../src/web/v1/private-postgres";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { PrivatePostgresConfiguration } from "../src/web/v1/private-postgres";

// This suite's OWN port block. It deliberately does not read
// CONTROL_ROOM_PG_TEST_PORT_BASE: every other suite in this lane reads that one
// and asserts its own port sits inside its own block, so sharing it would fail
// those suites with attack_kit_port_outside_block for a conflict this file never
// created. See the same note in tests/text-copy-derivation-postgres.test.ts.
const PORT = Number(process.env.QUEUE_WORKER_PREFLIGHT_PG_PORT_BASE ?? 59810);
const ALLOWED = Array.from({ length: 10 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();
const WORKER_VIEW = "control_worker_text_copy_derivations";
const DERIVATION_TABLE = "control_text_copy_derivations";

/** The production queue-worker login, as the app configures it. */
function workerConfiguration(postgres: Parameters<Parameters<typeof withRealPostgres>[0]>[0]): PrivatePostgresConfiguration {
  const connection = postgres.connection("queueWorker");
  // Two hosts, both load-bearing, and they are different on purpose. The
  // CONFIGURATION carries 127.0.0.1 because the endpoint policy refuses a
  // unix-socket host, and the app's pools are built from the configuration. The
  // pool itself is built over `postgres.host`, the cluster's socket directory,
  // because the disposable cluster starts with `-h ''` and publishes no TCP
  // listener at all. Dropping either half produces `database_unavailable`, which
  // reads like a product fault and is not one. Same split, same reason, as
  // tests/private-startup-preflight-postgres.test.ts:76.
  return { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: connection.user, password: connection.password, majorVersion: 17 };
}

/** The product's own pool over this login, built the way the app builds one. */
function workerPool(postgres: Parameters<Parameters<typeof withRealPostgres>[0]>[0]) {
  const config = workerConfiguration(postgres);
  const connection = postgres.connection("queueWorker");
  const pool = new Pool({ ...privatePgOptions(config), host: connection.host });
  return { config, pool: bindPrivatePgPool(pool) };
}

/** Run the raw permission check as the queue-worker login. */
async function checkAs(client: Client): Promise<string> {
  try {
    await verifyPgBossNativeWorkerPermissions({ query: (sql, values) => client.query(sql, values) as never });
    return "accepted";
  } catch { return "refused"; }
}

test("the queue-worker's startup preflight ACCEPTS a production install and still refuses every widened grant",
  async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const worker = new Client(postgres.connection("queueWorker"));
    await worker.connect();
    /** Every step restores its own grant, so a refusal below is about that grant. */
    const step = async (label: string, ...statements: readonly string[]): Promise<string> => {
      for (const statement of statements) await admin.query(statement);
      return await checkAs(worker);
    };
    try {
      // 1. THE GRANT IS THERE, and it is the view and never the table. Asserting
      //    the shape before asserting the verdict is what stops this file passing
      //    on a database that simply lacks 0213.
      const shape = (await admin.query<{ view_readable: boolean; table_readable: boolean;
        view_owner: string; view_is_invoker: boolean }>(`SELECT
          has_table_privilege('control_room_native_queue_worker',$1,'SELECT') AS view_readable,
          has_table_privilege('control_room_native_queue_worker',$2,'SELECT') AS table_readable,
          pg_get_userbyid(c.relowner) AS view_owner,
          EXISTS (SELECT 1 FROM pg_options_to_table(c.reloptions)
                  WHERE option_name='security_invoker' AND option_value='true') AS view_is_invoker
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=$1`, [WORKER_VIEW, DERIVATION_TABLE])).rows[0];
      assert.equal(shape?.view_readable, true,
        "0213 did not grant the queue-worker login the view, so this file is not testing R4U-19a");
      assert.equal(shape?.table_readable, false,
        "the login holds SELECT on the TABLE behind the view; that is the cross-tenant read 0213's view exists to prevent");
      assert.equal(shape?.view_owner, "control_room_schema_owner");
      // `security_invoker` is the OPT-IN to invoker semantics, so a view created
      // without it -- which is what 0213 does, on purpose -- runs with its
      // OWNER's privileges on the table underneath. Asserting that is false is
      // asserting the property the narrowing actually rests on: the login's own
      // lack of table privilege is not what stops it reading another worker's
      // rows. The `WHERE` clause's `session_user` admission join is, and that is
      // what the zero-rows assertion in step 6 below measures.
      //
      // A previous version of this file computed the boolean inverted -- it read
      // `NOT EXISTS(...)`, which is true exactly when the option is unset -- and
      // then asserted it true with a message calling the very state it computed
      // "SECURITY DEFINER ... would match every row in the tenant". It passed
      // because the view IS the owner-style view. The name now matches the
      // computation and the message matches the value.
      assert.equal(shape?.view_is_invoker, false,
        "the worker view opted into SECURITY INVOKER: it would then need the CALLER's own privilege on control_text_copy_derivations, which 0213 deliberately does not grant, so every read through it would fail");

      // 2. ACCEPTS. This is the direction that was broken, and it is the one a
      //    new migration breaks again, so it is asserted first and on its own.
      assert.equal(await checkAs(worker), "accepted",
        "the queue-worker preflight refused a correctly installed database (R4U-19a)");
      const config = workerConfiguration(postgres);
      // The PRODUCT's own pool, not a bare `pg` client: `verifySession` reads the
      // session's timeouts, search_path and replication role off the live
      // connection, and those are set by src/web/v1/private-pg-options.ts when the
      // pool is built. A hand-rolled client here would be refused by
      // verifySession for a reason that has nothing to do with the privilege check
      // this file is about, which is a false failure dressed as a real one.
      const preflightPool = workerPool(postgres);
      try { await verifyNativeQueueWorkerDatabase(preflightPool.pool.client, preflightPool.config); }
      finally { await preflightPool.pool.close(); }
      void config;

      // 3. STILL REFUSES. Every arm below is a widening 0213 did NOT authorise.
      //    A check relaxed to accept a correct database is worth nothing if it
      //    also accepts a wrong one. Each entry carries its OWN undo, written
      //    out rather than derived by reversing the statements: reversing a
      //    GRANT is a REVOKE with a different grammar, so a reversed list would
      //    silently no-op and the "restored" assertion below would pass on a
      //    database that was never restored.
      const refusals: readonly (readonly [string, readonly string[], readonly string[]])[] = [
        ["the TABLE behind the view",
          [`GRANT SELECT ON ${DERIVATION_TABLE} TO control_room_native_queue_worker`],
          [`REVOKE SELECT ON ${DERIVATION_TABLE} FROM control_room_native_queue_worker`]],
        ["the owner-facing view",
          ["GRANT SELECT ON control_project_text_copy_derivations TO control_room_native_queue_worker"],
          ["REVOKE SELECT ON control_project_text_copy_derivations FROM control_room_native_queue_worker"]],
        ["UPDATE on the worker view",
          [`GRANT UPDATE ON ${WORKER_VIEW} TO control_room_native_queue_worker`],
          [`REVOKE UPDATE ON ${WORKER_VIEW} FROM control_room_native_queue_worker`]],
        ["a stray readable relation in the queue schema",
          ["CREATE TABLE control_room_queue.extra_relation_for_probe(id int)",
            "GRANT SELECT ON control_room_queue.extra_relation_for_probe TO control_room_native_queue_worker"],
          ["DROP TABLE control_room_queue.extra_relation_for_probe"]],
        ["a privilege outside the writable set on a pg-boss relation",
          // NOT UPDATE: `job` and `job_common` are pinned WRITABLE, so UPDATE on
          // them is already the install's own grant and re-granting it widens
          // nothing. TRUNCATE is outside the pinned set and is named in the
          // check's refusal arm, so it is a real widening.
          ["GRANT TRUNCATE ON control_room_queue.job TO control_room_native_queue_worker"],
          ["REVOKE TRUNCATE ON control_room_queue.job FROM control_room_native_queue_worker"]],
        ["a grant option on the worker view",
          [`GRANT SELECT ON ${WORKER_VIEW} TO control_room_native_queue_worker WITH GRANT OPTION`],
          [`REVOKE GRANT OPTION FOR SELECT ON ${WORKER_VIEW} FROM control_room_native_queue_worker`]],
        ["a grant option on a pg-boss relation",
          ["GRANT SELECT ON control_room_queue.queue TO control_room_native_queue_worker WITH GRANT OPTION"],
          ["REVOKE GRANT OPTION FOR SELECT ON control_room_queue.queue FROM control_room_native_queue_worker"]],
      ];
      for (const [label, statements, undo] of refusals) {
        assert.equal(await step(`+ ${label}`, ...statements), "refused",
          `the queue-worker preflight accepted a database where ${label} is granted`);
        // ...and it accepts the database again once the grant is taken back, so
        // the refusal above was about that grant and not about the login.
        assert.equal(await step(`  (undo ${label})`, ...undo), "accepted",
          `the queue-worker preflight did not return to accepting after ${label} was taken back`);
      }

      // 4. A RENAME is caught by the name pin, and the grant follows the object,
      //    so a renamed view is a readable relation with no pin -- refused.
      assert.equal(await step("+ the view renamed away",
        `ALTER TABLE ${WORKER_VIEW} RENAME TO ${WORKER_VIEW}_moved`), "refused",
        "a renamed worker view was accepted, so the pin follows the grant rather than the object");
      await admin.query(`ALTER TABLE ${WORKER_VIEW}_moved RENAME TO ${WORKER_VIEW}`);
      assert.equal(await checkAs(worker), "accepted", "the renamed-back database was not accepted");

      // 5. THE PIN NAMES THE SCHEMA, AND A SAME-NAMED RELATION IN ANOTHER SCHEMA
      //    CANNOT STAND IN FOR THE VIEW. This is the arm that measures the
      //    schema half of the pin, and the shape below is the only one that
      //    discriminates. Measured on a real cluster while writing it, against a
      //    name-only pin:
      //
      //      baseline                                       ACCEPTED
      //      view renamed away (one pin lost)               REFUSED
      //      renamed view's own grant taken back            REFUSED
      //      + same-named readable table in another schema  ACCEPTED  <-- the hole
      //
      //    Two earlier shapes were tried and neither measured anything, which is
      //    why they are recorded here rather than quietly dropped. A plain COPY
      //    beside the real view is refused either way, because the count arm
      //    catches the extra pinned relation for a reason that has nothing to do
      //    with the schema. And renaming the view while LEAVING its grant is also
      //    refused either way, because the renamed view is then a readable
      //    unpinned relation in its own right. The discriminating shape is the
      //    swap with the grant taken back: nothing but the stand-in can satisfy
      //    the fifth pin, so only the schema in the join key refuses it.
      await admin.query("CREATE SCHEMA probe_schema_for_worker_pin");
      try {
        // (a) The view renamed away on its own: one pin lost, so the install is
        //     incomplete and refused.
        assert.equal(await step("+ the view renamed away (one pin lost)",
          `ALTER TABLE ${WORKER_VIEW} RENAME TO ${WORKER_VIEW}_moved`), "refused",
          "a renamed worker view was accepted, so the pin follows the grant rather than the object");
        // (b) Take the renamed view's own read back, so the only candidate left
        //     for the fifth pin is the stand-in.
        assert.equal(await step("  (renamed view's own grant taken back)",
          `REVOKE SELECT ON ${WORKER_VIEW}_moved FROM control_room_native_queue_worker`), "refused",
          "the install was accepted with no readable worker view at all");
        // (c) THE SWAP: a same-named, readable table in another schema.
        assert.equal(await step("+ a same-named readable table standing in for the renamed view",
          `CREATE TABLE probe_schema_for_worker_pin.${WORKER_VIEW}(id int)`,
          `GRANT SELECT ON probe_schema_for_worker_pin.${WORKER_VIEW} TO control_room_native_queue_worker`),
        "refused",
        "a same-named relation in another schema stood in for the worker view and satisfied the pin");
        // The pin's own join, run twice: once keyed on name alone and once on
        // (schema, name). Under a name-only pin the stand-in matches, so the two
        // counts differ; with the schema in the key the stand-in does not match
        // and the count is the number of REAL pinned relations (4, because the
        // view is renamed away at this point).
        const pins = (await worker.query<{ by_name: string; by_nsp: string }>(`SELECT
          (SELECT count(*)::text FROM (
             SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
                AND c.relkind IN ('r','p','v','m','f')
                AND c.relname IN ('version','queue','job','job_common','${WORKER_VIEW}')) q) AS by_name,
          (SELECT count(*)::text FROM (
             SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
               JOIN (VALUES ('control_room_queue','version'),('control_room_queue','queue'),
                 ('control_room_queue','job'),('control_room_queue','job_common'),
                 ('public','${WORKER_VIEW}')) e(nsp,name) ON e.nsp=n.nspname AND e.name=c.relname
              WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
                AND c.relkind IN ('r','p','v','m','f')) q) AS by_nsp`)).rows[0];
        assert.equal(pins?.by_name, "5",
          "the name-only probe did not see the stand-in, so this arm cannot measure the schema half");
        assert.equal(pins?.by_nsp, "4",
          "a same-named relation in another schema satisfied the (schema, name) pin");
        // (d) Restore the correct install: the view renamed back, its read
        //     granted, and the stand-in dropped.
        await admin.query(`ALTER TABLE ${WORKER_VIEW}_moved RENAME TO ${WORKER_VIEW}`);
        assert.equal(await step("  (view restored and stand-in dropped)",
          `GRANT SELECT ON ${WORKER_VIEW} TO control_room_native_queue_worker`,
          `DROP TABLE probe_schema_for_worker_pin.${WORKER_VIEW}`), "accepted",
          "restoring the view did not return the install to accepting");
      } finally { await admin.query("DROP SCHEMA probe_schema_for_worker_pin"); }

      // 6. THE GRANT THE FIX ALLOWS IS STILL NARROWED BY THE VIEW ITSELF. This is
      //    the security property the relaxation rests on, asserted on the login
      //    that holds the grant: a worker with no admission of its own sees no
      //    rows, and cannot read the table under the view at all. The WHERE
      //    clause, not the login's lack of table privilege, is what produces the
      //    zero -- the view runs as its owner (see step 1).
      const rows = await worker.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${WORKER_VIEW}`);
      assert.equal(rows.rows[0]?.n, "0",
        "the worker view returned a row to a login with no admission, so the grant is wider than 0213 argues it is");
      await assert.rejects(() => worker.query(`SELECT * FROM ${DERIVATION_TABLE} LIMIT 1`),
        (error: unknown) => (error as { code?: string }).code === "42501",
        "the queue-worker login could read the table behind the view");
    } finally { await worker.end(); await admin.end(); }
  }, { port: PORT, allowedPorts: ALLOWED, pgBin: process.env.PG_BIN ?? undefined, boundMs: 300_000 });
});

test("the REAL native queue worker starts on a production install, and stops when the view grant is missing",
  async t => {
  // The end-to-end half. `createNativeQueueWorkerBootstrap` is the production
  // startup, and it is given the production login and the REAL pinned pg-boss:
  // no injected constructor, no synthetic database, no fake. Before the fix this
  // refused with native_queue_worker_start_failed on a correct database, which is
  // the whole product's queue being down.
  //
  // The second half is what stops this from being a test that only ever passes:
  // take the one view grant back and the same default path must refuse again, so
  // the acceptance above is about the install being complete rather than the
  // check having stopped reading anything.
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  const { PgBoss } = await import("pg-boss");
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const config = workerConfiguration(postgres);
    // The product's own pool, opened over the cluster's socket directory. The
    // bootstrap is given the app's REAL database factory, so the preflight, the
    // pool's session settings and the pg-boss start are all production objects;
    // only the transport's host differs, because this disposable cluster starts
    // with `-h ''` and publishes no TCP listener. Everything else -- the login,
    // the credentials, the session options, the preflight -- is untouched.
    const connection = postgres.connection("queueWorker");
    const start = async () => {
      const bootstrap = createNativeQueueWorkerBootstrap({ PgBoss,
        openDatabase: (given: PrivatePostgresConfiguration) => {
          const pool = new Pool({ ...privatePgOptions(given), host: connection.host });
          return Object.freeze({ client: bindPrivatePgPool(pool).client, close: () => pool.end(),
            isAvailable: () => true });
        } });
      return await bootstrap.start({ database: config,
        application: { host: config.host, port: config.port, database: config.database,
          loginNames: ["control_room_web", "control_room_coordinator"] },
        deliver: async () => ({ disposition: "held" }) });
    };
    try {
      const runtime = await start();
      assert.deepEqual(runtime.status(), { state: "running", faulted: false, accepting: true });
      await runtime.close();

      await admin.query(`REVOKE SELECT ON ${WORKER_VIEW} FROM control_room_native_queue_worker`);
      try {
        await assert.rejects(start(), /native_queue_worker_start_failed/u,
          "the real queue worker started without the view grant 0213 grants");
      } finally { await admin.query(`GRANT SELECT ON ${WORKER_VIEW} TO control_room_native_queue_worker`); }
      // And the database is startable again, so the refusal above was the grant.
      const restored = await start();
      assert.equal(restored.status().state, "running");
      await restored.close();
    } finally { await admin.end(); }
  }, { port: PORT + 1, allowedPorts: ALLOWED, pgBin: process.env.PG_BIN ?? undefined, boundMs: 300_000 });
});