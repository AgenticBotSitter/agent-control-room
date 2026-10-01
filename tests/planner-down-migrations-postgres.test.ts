// THE DOWN FILES FOR 0203, 0204 AND 0205, EXECUTED AS REAL ROLLBACKS.
//
// WHY THIS EXISTS SEPARATELY FROM work-intake.test.ts. The derived-rung test
// there walks the down files that 0093's own dependency graph requires, and it
// asserts four objects from that graph. It therefore says NOTHING about whether
// 0203, 0204 and 0205 roll back: mutating any of their down files to leave an
// object behind still passed it, because those three are not in 0093's closure.
//
// That is the same failure as a down file that leaves an object behind -- a
// database that looks rolled back and is not -- so each of the three is applied
// here against a real PostgreSQL 17 cluster built from the real migrations, and
// every object the corresponding UP file added is required to be GONE, with
// every shape 0202 had required to be BACK.
//
// Each down file is applied on its OWN freshly-migrated cluster rather than
// stacked on one cluster, because a stack would let an earlier file's success
// mask a later one's: 0203 restores the predicate-free view, and if 0205 then
// dropped that same view the assertions for 0203 would already have run.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { readMigrationGraph } from "./helpers/down-migration-order";

// Reserved disposable-cluster lane for the planner down migrations: 59500-59511,
// or the runner's assigned port block when it gives one, so concurrent runs never
// collide.
//
// Its OWN block, and that is the point. Three files in test:database default to
// 59370 -- the orchestrator lane's -- and two more share 59450, so a file that
// copies either number collides with its own lane-mates and fails
// `refusing_occupied_port` on tests that have nothing to do with the port. Four
// failures in one lane came from exactly that. It also used to read
// ORCHESTRATOR_PG_PORT, which is not this file's lane and is one more way to be
// handed somebody else's ports.
const PORT = Number(process.env.PLANNER_DOWN_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59500);
const ALLOWED = Array.from({ length: 12 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();

const MIGRATIONS = "db/migrations";
const DOWNS = "db/down";

type Expectation = { readonly name: string; readonly sql: string };

/**
 * Per down file: objects that must be GONE afterwards, and shapes that must be
 * BACK. Every entry is a real catalog read, not a re-read of the file, so a down
 * file that drops an object and then recreates it cannot satisfy both sides.
 */
const COVERAGE: Record<string, { gone: readonly Expectation[]; back: readonly Expectation[] }> = {
  "0203_work_batch_split_suggestions_tenant_bound_read.sql": {
    gone: [
      { name: "0203's predicate function",
        sql: "to_regprocedure('work_intake_split_suggestion_visible(text,text,text)')::text" },
      { name: "0203's policy still delegating to the predicate",
        sql: `(SELECT count(*)::text FROM pg_policies
                 WHERE policyname='work_batch_split_suggestions_work_intake_scope'
                   AND qual LIKE '%work_intake_split_suggestion_visible%')` },
      { name: "0203's view still filtering on the predicate",
        sql: `(SELECT count(*)::text FROM pg_views
                 WHERE viewname='work_batch_current_split_suggestions'
                   AND definition LIKE '%work_intake_split_suggestion_visible%')` },
    ],
    back: [
      // 0200's inline policy body is restored, spelled out rather than delegated.
      { name: "0200's policy using the inline EXISTS",
        sql: `(SELECT count(*)::text FROM pg_policies
                 WHERE policyname='work_batch_split_suggestions_work_intake_scope'
                   AND qual LIKE '%is_work_intake_session%')` },
      { name: "0200's predicate-free view body",
        sql: `(SELECT count(*)::text FROM pg_views
                 WHERE viewname='work_batch_current_split_suggestions'
                   AND definition NOT LIKE '%work_intake_split_suggestion_visible%')` },
    ],
  },
  "0204_planner_needs_you_digest_scopes.sql": {
    gone: [
      { name: "0204's scope key function",
        sql: "to_regprocedure('planner_failure_scope_key(text,jsonb)')::text" },
      { name: "0204's digest column",
        sql: `(SELECT count(*)::text FROM information_schema.columns
                 WHERE table_name='control_planner_needs_you_items' AND column_name='owner_request_digest')` },
    ],
    back: [
      // 0202's guard was an INVOKER function. 0204 made it SECURITY DEFINER so it
      // could call the scope function, so a rollback that restored the body but
      // kept the definer would leave a privilege this chain never had before --
      // and the private-web preflight refuses unreviewed SECURITY DEFINER
      // routines, so it would also refuse the rolled-back database.
      { name: "0202's guard as an invoker function",
        sql: `(SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='public' AND p.proname='guard_planner_needs_you_item_insert'
                   AND NOT p.prosecdef)` },
      { name: "0202's guard matching the request_key spelling",
        sql: `(SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='public' AND p.proname='guard_planner_needs_you_item_insert'
                   AND prosrc LIKE '%scope_key LIKE%')` },
    ],
  },
  "0205_planner_barrier_and_owner_retry.sql": {
    gone: [
      { name: "0205's owner-retry function",
        sql: "to_regprocedure('control_room_planner_grant_owner_retry(text,text,text[])')::text" },
      { name: "0205's scope unique index",
        sql: "to_regclass('control_planner_needs_you_scope_unique')::text" },
      { name: "0205's latch index",
        sql: "to_regclass('control_planner_failure_counters_owner_retry')::text" },
      { name: "0205's latch column",
        sql: `(SELECT count(*)::text FROM information_schema.columns
                 WHERE table_name='control_planner_failure_counters' AND column_name='owner_retry_cleared_at')` },
      { name: "0205's latch CHECK",
        sql: `(SELECT count(*)::text FROM pg_constraint
                 WHERE conname='control_planner_failure_counters_retry_check')` },
      { name: "0205's scope key column",
        sql: `(SELECT count(*)::text FROM information_schema.columns
                 WHERE table_name='control_planner_needs_you_items' AND column_name='scope_key')` },
      // Asserted as an ABSENCE, so it belongs in the `gone` shape rather than the
      // `back` one: a count of the column is '0' after the rollback, and demanding
      // '1' reported a correct rollback as a failure.
      { name: "0205's scope_key still on the owner-facing view",
        sql: `(SELECT count(*)::text FROM information_schema.columns
                 WHERE table_name='control_planner_open_needs_you' AND column_name='scope_key')` },
      { name: "any barrier left switched on, in the PUBLIC schema only",
        // Scoped to nspname='public' on purpose. Counted over all of pg_class it
        // also counts PostgreSQL's OWN catalog views -- pg_stats, pg_stats_ext and
        // pg_stats_ext_exprs all carry security_barrier=true out of the box -- so an
        // unscoped count can never reach zero and reports a correct rollback as a
        // failure. The claim is "0205 left no barrier set", which is a claim about
        // this database's views.
        sql: `(SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                 WHERE n.nspname='public' AND c.reloptions::text LIKE '%security_barrier=true%')` },
    ],
    back: [
      { name: "0202's counter guard as an invoker function",
        sql: `(SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='public' AND p.proname='guard_planner_failure_counter_write'
                   AND NOT p.prosecdef)` },
      { name: "0202's counter guard admitting only its two transitions",
        sql: `(SELECT count(*)::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='public' AND p.proname='guard_planner_failure_counter_write'
                   AND prosrc NOT LIKE '%owner_retry_cleared_at%')` },
    ],
  },
};

// Every down file the graph can name, and every migration that has one. A missing
// down file is a failure here rather than an ENOENT three rungs later: the derived
// rung test surfaces it as "no such file or directory", which reads like a harness
// bug and is not one.
test("every migration this branch added has a down file that revokes only what it granted", async t => {
  const graph = await readMigrationGraph(".");
  const downs = new Set(graph.downFiles.map(file => file.slice(0, 4)));
  const added = ["0203", "0204", "0205"];
  for (const ordinal of added) {
    assert.ok(downs.has(ordinal),
      `${ordinal} has no down file: the derived down rung would fail with ENOENT, which reads like a harness bug`);
  }
  t.diagnostic(`down files present for ${[...downs].sort().join(", ")}`);
});

for (const [index, file] of Object.keys(COVERAGE).entries()) {
  test(`${file} rolls back everything it added, on a real cluster`, { skip: !PG && realPostgresSkipMessage() }, async () => {
    await withRealPostgres(async postgres => {
      const admin = new Client(postgres.admin()); await admin.connect();
      try {
        // The harness has ALREADY migrated this cluster through the real
        // applyMigrations (deploy/postgres/apply-migrations.mjs), as the production
        // migrator login. Applying the files again here is both wrong and
        // self-defeating: several migrations create an index without
        // IF NOT EXISTS, so a second pass dies on `already exists` and the test
        // would report a migration bug instead of the rollback bug it is for.

        // The cluster really was migrated, so a `gone` assertion that passes
        // BECAUSE the object never existed cannot be mistaken for a rollback that
        // worked -- which is the failure mode of a coverage test written against a
        // cluster that did not apply the up file. Checked BEFORE the down runs.
        // Read in the SAME two shapes the assertion below reads: NULL from
        // to_regclass/to_regprocedure, '0' from a catalog count.
        const before = await admin.query<{ name: string; value: string | null }>(
          `SELECT * FROM (VALUES ${COVERAGE[file]!.gone.map(item => `(${literal(item.name)}, ${item.sql})`).join(", ")}) AS t(name, value)`);
        const beforeValues = new Map(before.rows.map(row => [row.name, row.value]));
        const isPresent = (value: string | null | undefined) => value !== null && value !== undefined && value !== "0";
        // A barrier count is allowed to start at any number: the claim is only that
        // it ENDS at none, so requiring a non-zero count here would break the moment
        // another migration adds a seventh barrier.
        const starts = COVERAGE[file]!.gone.filter(item => !item.sql.includes("security_barrier"));
        const missingUpfront = starts.filter(item => !isPresent(beforeValues.get(item.name))).map(item => item.name);
        assert.deepEqual(missingUpfront, [],
          `${file} claims to roll back objects the cluster did not have: ${missingUpfront.join(", ")}`);

        await admin.query(await readFile(`${DOWNS}/${file}`, "utf8"));

        const coverage = COVERAGE[file]!;
        const rows = await admin.query<{ name: string; value: string | null }>(
          `SELECT * FROM (VALUES ${[
            ...coverage.gone.map(item => `(${literal(item.name)}, ${item.sql})`),
            ...coverage.back.map(item => `(${literal(item.name)}, ${item.sql})`),
          ].join(", ")}) AS t(name, value)`);
        const value = new Map(rows.rows.map(row => [row.name, row.value]));

        // Two shapes in one list: `to_regclass`/`to_regprocedure` answer NULL for an
        // absent object, while a catalog COUNT answers '0'. Both mean the same thing
        // here, so both are read as a boolean rather than compared to one literal --
        // comparing a count against NULL reported a correct rollback as a failure.
        const present = (name: string) => {
          const raw = value.get(name);
          return raw !== null && raw !== undefined && raw !== "0";
        };
        const stillBehind = coverage.gone.filter(item => present(item.name));
        assert.deepEqual(stillBehind.map(item => item.name), [],
          `${file} left behind: ${stillBehind.map(item => `${item.name}=${value.get(item.name)}`).join(", ")}`);
        const notRestored = coverage.back.filter(item => value.get(item.name) !== "1");
        assert.deepEqual(notRestored.map(item => item.name), [],
          `${file} did not restore: ${notRestored.map(item => `${item.name}=${value.get(item.name)}`).join(", ")}`);
      } finally { await admin.end(); }
    }, { port: PORT + index, allowedPorts: ALLOWED, boundMs: 240_000 });
  });
}

/** A SQL string literal with any quote doubled, so a name cannot end it. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}