// DOWN MIGRATIONS RUN BY A SUPERUSER MUST STILL LEAVE EVERY OBJECT OWNED BY THE
// SCHEMA OWNER.
//
// WHY. Every down file in db/down is read as "the operator runs this". The
// applier runs UP migrations as control_room_migrator with SET ROLE
// control_room_schema_owner, so anything it creates is owned correctly -- but a
// rollback run the obvious way, as the operator's superuser, creates objects
// owned by the superuser. `applyMigrations` then refuses the next install with
// `migration_refused_non_owner_objects`, so the rollback itself is what breaks
// the database. That is 0205's `control_planner_open_needs_you`, which its down
// file DROPs and CREATEs.
//
// This runs each DROP-THEN-CREATE down file BOTH ways on its own fresh full
// install and requires zero non-schema-owner objects afterwards, in both. Running
// it only as the schema owner would pass on the broken file: the file is correct
// in the one way the applier happens to use, which is exactly how the defect
// survived.
//
// The digest is compared before and after too. `ALTER VIEW ... OWNER TO` must
// not change the view's definition, and if it did, this would catch it.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres } from "./support/attack-kit/index";
import { withRealPostgres } from "./support/attack-kit/index";

// Own lane block, for the same reason the planner down-migration lane has one:
// a shared base collides with a lane-mate and fails an unrelated test.
const PORT = Number(process.env.DOWN_OWNER_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59572);
const ALLOWED = Array.from({ length: 8 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();

/** Down files that DROP an object and CREATE it again in the same file. */
const RECREATING = ["0205_planner_barrier_and_owner_retry.sql"] as const;

const nonOwnerObjects = async (client: Client) => (await client.query(
  `SELECT n.nspname || '.' || c.relname AS object, pg_get_userbyid(c.relowner) AS owner
   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
   ORDER BY 1`)).rows as Array<{ object: string; owner: string }>;

for (const [index, file] of RECREATING.entries()) {
  for (const [label, asSuperuser] of [["as the schema owner", false], ["as the superuser", true]] as const) {
    test(`${file} leaves no foreign-owned relation ${label}`, { skip: !PG && realPostgresSkipMessage() }, async () => {
      await withRealPostgres(async postgres => {
        const admin = new Client(postgres.admin());
        await admin.connect();
        const migrator = new Client(postgres.connection("migrator"));
        await migrator.connect();
        try {
          assert.ok(postgres.appliedMigrations > 100,
            `the harness must have installed the real ledger, got ${postgres.appliedMigrations}`);
          const owner = "control_room_schema_owner";
          // Every object is owned correctly on a clean install. If this fails, the
          // assertion below is measuring the wrong thing.
          const before = await nonOwnerObjects(admin);
          const foreignBefore = before.filter(row => row.owner !== owner);
          assert.deepEqual(foreignBefore, [],
            `the fresh install itself has foreign-owned relations: ${JSON.stringify(foreignBefore)}`);

          // The rollback, both ways.
          const runner = asSuperuser ? admin : migrator;
          if (!asSuperuser) await runner.query("SET ROLE control_room_schema_owner");
          try { await runner.query(await readFile(`db/down/${file}`, "utf8")); }
          finally { if (!asSuperuser) await runner.query("RESET ROLE"); }

          const after = await nonOwnerObjects(admin);
          const foreign = after.filter(row => row.owner !== owner);
          assert.deepEqual(foreign, [],
            `${file} run ${label} left objects owned by the wrong role, and the next applyMigrations will refuse them with migration_refused_non_owner_objects: ${JSON.stringify(foreign)}`);
          // The recreated view must still be there, or "no foreign objects" is
          // trivially true because the file dropped more than it should.
          assert.ok(after.some(row => row.object === "public.control_planner_open_needs_you"),
            `${file} must leave the view it recreated in place`);
        } finally { await migrator.end(); await admin.end(); }
      }, { port: PORT + index * 2 + (asSuperuser ? 1 : 0), allowedPorts: ALLOWED, boundMs: 300_000 });
    });
  }
}

test("re-owning a view does not change the schema digest", { skip: !PG && realPostgresSkipMessage() }, async () => {
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin());
    await admin.connect();
    const migrator = new Client(postgres.connection("migrator"));
    await migrator.connect();
    try {
      const view = "control_planner_open_needs_you";
      const definition = async () => (await admin.query("SELECT pg_get_viewdef($1::regclass, true) AS def", [view])).rows[0].def as string;
      const ownerOf = async () => (await admin.query(
        "SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid = $1::regclass", [view])).rows[0].owner as string;

      const definitionBefore = await definition();
      const ownerBefore = await ownerOf();
      assert.equal(ownerBefore, "control_room_schema_owner",
        "the fresh install's view is schema-owner owned, so this test can tell whether the ALTER did anything");

      await admin.query(`ALTER VIEW public.${view} OWNER TO ${postgres.admin().user}`);
      assert.equal(await ownerOf(), postgres.admin().user, "the ownership really changed, or this test proves nothing");
      assert.equal(await definition(), definitionBefore,
        `ALTER VIEW ... OWNER TO must not change the view's definition; if it does, every re-owned down file moves the schema digest`);
      // And back, so a later assertion in this cluster sees the install shape.
      await admin.query(`ALTER VIEW public.${view} OWNER TO control_room_schema_owner`);
      void migrator;
    } finally { await migrator.end(); await admin.end(); }
  }, { port: PORT + 6, allowedPorts: ALLOWED, boundMs: 300_000 });
});