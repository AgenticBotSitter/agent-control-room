// THE PRODUCTION APPLIER MUST REFUSE A DUPLICATE LEDGER POSITION BEFORE IT RUNS
// ANY DDL (rv-mr5o Finding 1).
//
// WHAT WAS WRONG, and it was not cosmetic. `db/migrations/*.sql` are sorted and
// numbered SEQUENTIALLY by `scripts/generate-migration-ledger.mjs`, so a merged
// tree never puts two files at one ledger order. The collision is between a
// MERGED LEDGER and a DATABASE already migrated from ONE branch's ledger:
//
//   branch A adds 0003_branch_a.sql   -> the database records it at order 3.
//   branch B adds 0002b_branch_b.sql  -> merged, "0002b" sorts BEFORE "0003",
//                                          so in the merged ledger order 3
//                                          belongs to 0002b_branch_b and 0003
//                                          moves to order 4.
//
// Three checks in `deploy/postgres/apply-migrations.mjs` each passed that state:
//
//   * the per-row validation looks each applied row up BY FILENAME, so the
//     database's own row still matched its own (unchanged) bytes;
//   * the gap check compares ORDER NUMBERS positionally and never filenames, so
//     "order 3 at index 2" equalled "order 3 at index 2" for two different files;
//   * `pending` is keyed by filename, so 0003_branch_a was correctly pending.
//
// `ledger_order` had no UNIQUE constraint, so the applier ran 0003's DDL,
// COMMITTED it with its row, and only then failed on `migration_live_schema_drift`
// -- because `ORDER BY ledger_order DESC LIMIT 1` hit the tie and picked the
// stale row as "the head". The database was left with 0003's table created, a
// SECOND row at order 3, and a ledger that no longer described itself.
//
// WHAT IS PROVEN HERE, on a real disposable PostgreSQL 17 through the real
// applier as the real migrator login:
//
//   1. the refusal is NAMED, and says which position, which applied file and
//      which new file disagree;
//   2. it happens BEFORE any DDL: the colliding migration's table does not exist
//      afterwards, and the live schema digest is byte-identical to the pre-run one;
//   3. it leaves NO new ledger row, and no two rows share a ledger_order;
//   4. `ledger_order` is UNIQUE in the catalog, so the class of bug is closed by
//      the schema and not only by the applier's ordering check;
//   5. the operator's real remedy -- renumbering the migration so it lands after
//      the applied head -- converges on the refused database;
//   6. a fresh install and a normal upgrade still apply every migration.
//
// DEFAULT PATH. Every applier call below passes only the two production targets
// (`postgres.admin()` for bootstrap, `postgres.connection("migrator")` for the
// migrate phase) and the real `rootDir`/`ledgerPath`. No port, tool, runner or
// fake is injected for anything this fix added.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { applyMigrations, readSchemaDigest } from "../deploy/postgres/apply-migrations.mjs";
import { withRealPostgres, requiresRealPostgres, realPostgresSkipMessage }
  from "./support/attack-kit/real-postgres.ts";
import { COLLISION_BRANCH_A, COLLISION_BRANCH_B, COLLISION_BRANCH_RENAMED, COLLISION_LEDGER_A,
  COLLISION_LEDGER_MERGED, COLLISION_TABLE_FOR_FILE, stageCollisionLedger }
  from "./helpers/migration-ledger-collision-stage.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// This lane's assigned block: the base is overridable so a local run can move
// inside it, and the kit refuses any port outside it rather than trusting this.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59500);
const ALLOWED = Array.from({ length: 12 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();

// Synthetic throwaway constants. Never real credentials, never printed.
const passwords = {
  CONTROL_ROOM_MIGRATOR_PASSWORD: "m".repeat(24),
  CONTROL_ROOM_APP_PASSWORD: "a".repeat(24),
  CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(24),
  CONTROL_ROOM_WORK_INTAKE_PASSWORD: "w".repeat(24),
};

const skip = !PG && realPostgresSkipMessage();

/** One staged cluster: the applier on the real production targets, plus a
 * database factory and a per-database admin client.
 *
 * `client(database)` is a SEPARATE call from `fresh(database)` because the
 * database has to exist before anything can connect to it: connecting first
 * fails with 3D000 and says nothing about the migration. */
function harness(postgres: Parameters<Parameters<typeof withRealPostgres>[0]>[0]) {
  /** An admin client on the maintenance database, for DDL on no database in particular. */
  const admin = async () => {
    const client = new Client(postgres.admin());
    await client.connect();
    return client;
  };
  return {
    /** The applier's own call shape, on the real production targets. */
    apply: (database: string, rootDir: string, ledgerPath: string) => applyMigrations({
      bootstrapTarget: { ...postgres.admin(), database },
      migrateTarget: { ...postgres.connection("migrator"), database },
      // `target` and `ledgerPath` are plan-mode flags the applier's JSDoc marks
      // required; tests/down-migration-sweep-real-postgres.test.ts passes them for
      // the same reason, to match the repository's own call shape. Supplying
      // bootstrap + migrate targets is what actually runs.
      target: `host=${postgres.host} port=${postgres.port} dbname=${database} user=fixture_admin`,
      rootDir,
      ledgerPath,
      env: { ...passwords, NODE_ENV: "test" as const },
    }),
    /** Create a database from scratch, on the cluster's maintenance database.
     *
     * An admin CLIENT rather than `postgres.query`: the kit's `query` resolves a
     * short role name against ROLE_LOGINS and answers
     * `attack_kit_unknown_role:fixture_admin` for the cluster's own superuser,
     * which is exactly the login this needs. */
    fresh: async (database: string) => {
      const client = await admin();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        await client.query(`CREATE DATABASE ${database}`);
      } finally {
        await client.end();
      }
    },
    /** An admin client on a database that already exists. */
    client: async (database: string) => {
      const client = new Client({ ...postgres.admin(), database });
      await client.connect();
      return client;
    },
    admin,
  };
}

/** The collision tables' presence, read the way a reviewer would. */
const tableState = async (client: Client) => ({
  branchA: (await client.query("SELECT to_regclass('public.collision_branch_a')::text AS t")).rows[0]!.t,
  branchB: (await client.query("SELECT to_regclass('public.collision_branch_b')::text AS t")).rows[0]!.t,
});

const ledgerState = async (client: Client) => (await client.query(
  "SELECT filename, ledger_order FROM control_room_schema_migrations ORDER BY ledger_order")).rows;

const DATABASE = "cr_ledger_collision";

test("a merged ledger that renumbers an applied position is refused before any DDL runs", { skip }, async () => {
  await withRealPostgres(async postgres => {
    const { apply, fresh, client: open } = harness(postgres);
    const stages: string[] = [];
    // The database has to EXIST before anything connects to it, and the applier
    // has to run before there is a schema to read. So the client opens after the
    // first apply, and stays open for every read after that.
    await fresh(DATABASE);
    const branchADir = await mkdtemp(join(tmpdir(), "cr-collision-a-"));
    stages.push(branchADir);
    const ledgerA = await stageCollisionLedger(branchADir, COLLISION_LEDGER_A, ROOT);
    const client = await open(DATABASE);
    try {
      // Phase 1: the database reaches branch A's real head. This is the
      // pre-merge state a real installation is in.
      const head = await apply(DATABASE, branchADir, ledgerA.ledgerPath);
      assert.deepEqual(head.applied!.map(entry => entry.file),
        COLLISION_LEDGER_A.map(file => `db/migrations/${file}`),
        "phase 1 must reach branch A's head exactly");

      const before = {
        ledger: await ledgerState(client),
        digest: await readSchemaDigest(client),
        tables: await tableState(client),
      };
      assert.equal(before.tables.branchB, null,
        "the colliding migration's table must not exist before the collision run");
      assert.equal(before.tables.branchA, "collision_branch_a",
        "branch A's migration really ran in phase 1, or the collision proves nothing");

      // Phase 2: the MERGED tree. `0002b_branch_b` sorts ahead of
      // `0003_branch_a`, so the merged ledger gives order 3 to branch B's
      // migration and pushes the applied one to order 4.
      const merged = await mkdtemp(join(tmpdir(), "cr-collision-merged-"));
      stages.push(merged);
      const ledgerMerged = await stageCollisionLedger(merged, COLLISION_LEDGER_MERGED, ROOT);
      const mergedOrder = new Map(ledgerMerged.migrate.map(entry =>
        [entry.file.replace("db/migrations/", ""), entry.order]));
      const appliedOrder = (before.ledger.find(row =>
        row.filename === `db/migrations/${COLLISION_BRANCH_A}`) as { ledger_order: number }).ledger_order;
      assert.equal(mergedOrder.get(COLLISION_BRANCH_A), appliedOrder + 1,
        "the merged ledger must have RENUMBERED the applied position -- otherwise this stage proves nothing");
      assert.equal(mergedOrder.get(COLLISION_BRANCH_B), appliedOrder,
        "the colliding migration must claim the position the database already holds");

      // The refusal names the position the DATABASE holds, the applied file, and the
      // file this release gives that position to. In the review's real scenario
      // (database at 0285's ledger, merged ledger renumbered 0285 and put 0240 at
      // order 154) that is `0285:0240`: the applied file, then the file that
      // took its position. This stage produces the mirror case -- branch B's
      // migration is the one the merged ledger puts at branch A's recorded
      // position -- so the third name is 0002b_branch_b.
      // No leading `^`: `assert.rejects` given a RegExp tests it against
      // `String(error)` -- "Error: <message>" -- so an anchored pattern can never
      // match. Measured on Node 26, and it is the reason an anchored refusal
      // regex passes in isolation and fails here.
      await assert.rejects(apply(DATABASE, merged, ledgerMerged.ledgerPath),
        new RegExp(`migration_ledger_position_conflict:${appliedOrder}:db/migrations/`
          + `${COLLISION_BRANCH_A}:db/migrations/${COLLISION_BRANCH_B} \\(this migration`),
        "the refusal must be named, and name the position and both files");

      // NOTHING RAN. Not the colliding migration's DDL, and not any ledger row.
      assert.deepEqual(await tableState(client), before.tables,
        "the colliding migration's DDL ran before the refusal");
      assert.deepEqual(await ledgerState(client), before.ledger,
        "a new ledger row was written for a migration that did not run");
      assert.equal(await readSchemaDigest(client), before.digest, "the live schema moved");
      assert.deepEqual((await client.query("SELECT ledger_order, count(*)::int AS rows FROM control_room_schema_migrations"
        + " GROUP BY ledger_order HAVING count(*) > 1")).rows, [], "two ledger rows share a ledger_order");

      // THE CONSTRAINT, so the class of bug is closed by the schema and not only
      // by the applier's ordering check: a hand-written INSERT that duplicates a
      // position is the database's own refusal.
      const constraint = (await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint"
        + " WHERE conrelid = 'control_room_schema_migrations'::regclass AND contype = 'u' ORDER BY 1"))
        .rows.map(row => row.definition as string);
      assert.ok(constraint.some(definition => definition.includes("ledger_order")),
        `ledger_order must be UNIQUE on control_room_schema_migrations; found ${JSON.stringify(constraint)}`);
      await assert.rejects(client.query(
        "INSERT INTO control_room_schema_migrations(filename, digest, ledger_order, pre_schema_digest,"
        + " post_schema_digest) SELECT filename, digest, $1, pre_schema_digest, post_schema_digest"
        + " FROM control_room_schema_migrations LIMIT 1", [appliedOrder]),
        /duplicate key value violates unique constraint/,
        "a duplicate ledger position must be refused by the database itself");

      // STILL USABLE. The operator's real remedy is to renumber the migration so it
      // sorts AFTER the applied head -- which, for this collision, means naming it
      // above `0003_branch_a`. Reusing branch B's own filename would just rebuild
      // the same collision (0002b still sorts first), so the remedy stage renames
      // it, which is what the lead does when it reassigns a migration number.
      const renumbered = await mkdtemp(join(tmpdir(), "cr-collision-fixed-"));
      stages.push(renumbered);
      const ledgerFixed = await stageCollisionLedger(renumbered,
        [...COLLISION_LEDGER_A, COLLISION_BRANCH_RENAMED].sort(), ROOT);
      const fixed = await apply(DATABASE, renumbered, ledgerFixed.ledgerPath);
      assert.deepEqual(fixed.applied!.map(entry => entry.file), [`db/migrations/${COLLISION_BRANCH_RENAMED}`],
        "a renumbered migration is applied as the pending suffix");
      assert.equal((await tableState(client)).branchB, COLLISION_TABLE_FOR_FILE[COLLISION_BRANCH_B],
        "the renumbered migration really created its table");
    } finally {
      await client.end();
      for (const stage of stages) await rm(stage, { recursive: true, force: true });
    }
  }, { port: PORT, allowedPorts: ALLOWED, boundMs: 1_800_000 });
});

test("an installation whose ledger already holds two rows at one position is refused, not half-fixed",
  { skip }, async () => {
    await withRealPostgres(async postgres => {
      const { apply, fresh, client: open } = harness(postgres);
      const stage = await mkdtemp(join(tmpdir(), "cr-collision-dupe-"));
      const branchA = await stageCollisionLedger(stage, COLLISION_LEDGER_A, ROOT);
      await fresh(DATABASE);
      await apply(DATABASE, stage, branchA.ledgerPath);
      const client = await open(DATABASE);
      try {
        const applied = await apply(DATABASE, stage, branchA.ledgerPath);
        assert.equal(applied.noOp, true, "the fixture must really be at branch A's head");

        // The state the review left behind on a real cluster: a migration ran and
        // committed, and a second row landed at the same position. It is
        // reproduced by DROPPING the constraint this branch adds (which is what an
        // installation that has not run the migration yet looks like) and then
        // inserting the duplicate the old applier would have inserted.
        //
        // The duplicate carries a DIFFERENT filename, because `filename` is the
        // PRIMARY KEY: the real half-applied ledger held two DIFFERENT migrations
        // at one position (0285 and 0240 in the review), and re-inserting the head
        // row's own filename would be refused by that key -- a different failure,
        // on the fixture rather than on the code under test.
        await client.query("ALTER TABLE control_room_schema_migrations"
          + " DROP CONSTRAINT control_room_schema_migrations_ledger_order_key");
        const head = (await client.query("SELECT filename, digest, ledger_order, pre_schema_digest,"
          + " post_schema_digest FROM control_room_schema_migrations ORDER BY ledger_order DESC LIMIT 1")).rows[0]!;
        await client.query("INSERT INTO control_room_schema_migrations(filename, digest, ledger_order,"
          + " pre_schema_digest, post_schema_digest) VALUES($1, $2, $3, $4, $5)",
          [`db/migrations/${COLLISION_BRANCH_B}`, head.digest, head.ledger_order,
            head.pre_schema_digest, head.post_schema_digest]);
        const corrupted = await ledgerState(client);
        assert.equal((await client.query("SELECT count(*)::int AS rows FROM control_room_schema_migrations"
          + " WHERE ledger_order = $1", [head.ledger_order])).rows[0]!.rows, 2,
          "the fixture must really hold two rows at one position");

        // The applier must refuse this database by name, and the refusal must NAME
        // both files, because which row is the real one is exactly what the
        // operator cannot work out from here. It must NOT converge it: deleting a
        // row would erase the record of what ran.
        await assert.rejects(apply(DATABASE, stage, branchA.ledgerPath),
          new RegExp(`migration_ledger_duplicate_rows:${head.ledger_order}:`
            + `db/migrations/${COLLISION_BRANCH_B},db/migrations/${COLLISION_BRANCH_A} \\(two migrations`),
          "a ledger that already holds two rows at one position must be refused by name");
        // The refusal changed nothing: the ledger reads byte-identically afterwards.
        assert.deepEqual(await ledgerState(client), corrupted,
          "the duplicate-ledger refusal must not delete, rewrite or add a row");
      } finally {
        await client.end();
        await rm(stage, { recursive: true, force: true });
      }
    }, { port: PORT + 1, allowedPorts: ALLOWED, boundMs: 1_800_000 });
  });

test("a fresh install and a normal upgrade still apply every migration", { skip }, async () => {
  await withRealPostgres(async postgres => {
    const { apply, fresh, client: open } = harness(postgres);
    const stage = await mkdtemp(join(tmpdir(), "cr-collision-plain-"));
    const prefix = await mkdtemp(join(tmpdir(), "cr-collision-prefix-"));
    const ledger = await stageCollisionLedger(stage, COLLISION_LEDGER_MERGED, ROOT);
    const short = await stageCollisionLedger(prefix, COLLISION_LEDGER_MERGED.slice(0, 2), ROOT);
    await fresh(DATABASE);
    // The FIRST apply is the fresh install, and its result is the one asserted:
    // a client opened beforehand cannot read a schema that does not exist yet,
    // so the build and the read are ordered rather than interleaved.
    const freshRun = await apply(DATABASE, stage, ledger.ledgerPath);
    const client = await open(DATABASE);
    try {
      assert.deepEqual(freshRun.applied!.map(entry => entry.order), ledger.migrate.map(entry => entry.order),
        "a fresh install applies every migration in ledger order");
      assert.equal(freshRun.noOp, false, "the fresh install has pending work");
      // A second run on the up-to-date database is a clean no-op. Nothing here
      // collides, so the new check must not fire.
      const rerun = await apply(DATABASE, stage, ledger.ledgerPath);
      assert.equal(rerun.noOp, true, "a second run on an up-to-date database is a no-op");
      assert.deepEqual(rerun.applied, []);
      assert.deepEqual(await tableState(client),
        { branchA: "collision_branch_a", branchB: "collision_branch_b" },
        "a fresh install really created both collision tables");

      // A normal upgrade: a database at a prefix of the merged ledger takes the
      // suffix, positionally, with no collision.
      await fresh("cr_ledger_upgrade");
      const before = await apply("cr_ledger_upgrade", prefix, short.ledgerPath);
      assert.equal(before.applied!.length, 2);
      const upgraded = await apply("cr_ledger_upgrade", stage, ledger.ledgerPath);
      assert.deepEqual(upgraded.applied!.map(entry => entry.order), [3, 4],
        "an ordinary upgrade appends the pending suffix at the orders the ledger gives it");
      const upgraded2 = await open("cr_ledger_upgrade");
      try {
        assert.deepEqual(await tableState(upgraded2),
          { branchA: "collision_branch_a", branchB: "collision_branch_b" },
          "both collision migrations really created their tables on the ordinary upgrade");
      } finally {
        await upgraded2.end();
      }
    } finally {
      await client.end();
      await rm(stage, { recursive: true, force: true });
      await rm(prefix, { recursive: true, force: true });
    }
  }, { port: PORT + 2, allowedPorts: ALLOWED, boundMs: 1_800_000 });
});