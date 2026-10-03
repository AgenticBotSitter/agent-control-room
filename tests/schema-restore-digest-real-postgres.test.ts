// A RESTORED DATABASE MUST PASS THE PREFLIGHT, AND OWN WHAT IT OWNS.
//
// WHY THIS FILE EXISTS. scripts/test-pg17-restore.ts already proves a dump/restore
// round trip, but it is wired into no lane, so the defect it reports
// (private_database_preflight_failed on a correctly restored database) reached a
// release. This is the same claim as a LANE-ENFORCED test, on the repo's own
// harness and the repo's own backup/restore code.
//
// The digest is compared three ways, because one comparison cannot catch a
// canonicaliser that is merely self-consistent:
//   - the live install reads the PINNED constant (the app can start);
//   - the restored copy reads the SAME value (the restore is the fix);
//   - the restored copy's constraint TEXT, before canonicalisation, is actually
//     different from the source's -- otherwise "they match" could mean the
//     canonicaliser was never exercised, and this file would pass on a tree that
//     had reintroduced the bug somewhere else.
//
// The last one is the load-bearing assertion. It is what makes this a test of the
// fix rather than of the restore.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres } from "./support/attack-kit/index";
import { withRealPostgres } from "./support/attack-kit/index";
import { backupDatabase } from "../deploy/postgres/backup-database.mjs";
import { restoreDatabase } from "../deploy/postgres/restore-database.mjs";
import { privateWebSchemaDigest, readPrivateWebSchemaDigest } from "../src/web/v1/private-database-preflight";
import { digestReleaseSchemaRowsV1 } from "../src/updater/v1/pg/release-schema-digest.mjs";

// The repo's own reserved lane for restore/digest work. Its own block, for the
// same reason tests/planner-down-migrations-postgres.test.ts has one: sharing a
// base with a lane-mate makes an unrelated test fail on a busy port.
const PORT = Number(process.env.RESTORE_DIGEST_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59560);
const ALLOWED = Array.from({ length: 12 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();

/** Synthetic passwords, never real credentials. */
const passwords = {
  CONTROL_ROOM_MIGRATOR_PASSWORD: "m".repeat(24),
  CONTROL_ROOM_APP_PASSWORD: "a".repeat(24),
  CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(24),
  CONTROL_ROOM_WORK_INTAKE_PASSWORD: "w".repeat(24),
};

/** The manifest query, read from the release module exactly as the
 * install-database-phase equivalence test reads it, so this file cannot drift
 * from the query the app actually runs. */
async function manifestSql(): Promise<string> {
  const source = await readFile(join(process.cwd(), "src/web/v1/private-database-preflight.ts"), "utf8");
  const match = /const result = await db\.query<[^>]*>\(`([\s\S]*?)`\);/u.exec(source);
  assert.ok(match?.[1], "the release module's manifest query must be extractable, or this test proves nothing");
  return match[1];
}

test("a restored database reads the pinned schema digest, and re-owns its functions",
  { skip: !PG && realPostgresSkipMessage() }, async () => {
    await withRealPostgres(async postgres => {
      const source = new Client(postgres.admin());
      await source.connect();
      try {
        // The live install, applied the production way by the harness itself.
        assert.ok(postgres.appliedMigrations > 100,
          `the harness must have installed the real ledger, got ${postgres.appliedMigrations}`);
        assert.equal(await readPrivateWebSchemaDigest(source), privateWebSchemaDigest,
          "the live install must read the pinned digest before a restore means anything");

        // A second database on the same cluster, provisioned the way an operator
        // provisions a restore target: the roles the dump's GRANT statements
        // reference, plus the logins the recorded memberships name.
        const restoreDatabaseName = "restore_digest_target";
        await source.query(`DROP DATABASE IF EXISTS ${restoreDatabaseName} WITH (FORCE)`);
        await source.query(`CREATE DATABASE ${restoreDatabaseName}`);
        for (const name of ["control_room_schema_owner", "control_room_application", "control_room_reader",
          "control_room_backup", "control_room_schedule_admissions", "control_room_github_broker",
          "control_room_work_intake"]) {
          await source.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${name}')
            THEN CREATE ROLE ${name} NOLOGIN; END IF; END; $$;`);
        }
        await source.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='control_room_migrator') THEN
          CREATE ROLE control_room_migrator LOGIN PASSWORD '${passwords.CONTROL_ROOM_MIGRATOR_PASSWORD}'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END; $$;`);

        // The repo's own backup and restore code, not hand-run pg_dump.
        const ledger = JSON.parse(await readFile(join(process.cwd(), "deploy/postgres/migration-ledger.json"), "utf8"));
        const backupDirectory = join(postgres.runDirectory, "backup-set");
        await backupDatabase({
          source: postgres.admin(), out: backupDirectory,
          pgBin: process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin",
          ledgerDigest: `sha256:${ledger.digest}`, requiredTables: [],
        });
        const target = postgres.admin({ database: restoreDatabaseName });
        await restoreDatabase({
          backup: backupDirectory, target, confirmTarget: { ...target },
          pgBin: process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin", requiredTables: [],
        });

        const restored = new Client(target);
        await restored.connect();
        try {
          // THE FIX. Before this branch the restored database read a different
          // digest and verifyPrivateDatabase refused it, so the app could not
          // start on a correct restore.
          assert.equal(await readPrivateWebSchemaDigest(restored), privateWebSchemaDigest,
            `a restored database must read the pinned digest\n  pinned:   ${privateWebSchemaDigest}\n  restored: ${await readPrivateWebSchemaDigest(restored)}`);

          // THE FIX WAS ACTUALLY NEEDED. If the source and the restored copy
          // rendered every constraint identically, the canonicaliser would never
          // have run and this test would pass for the wrong reason -- so the raw,
          // UN-canonicalised text is required to still differ.
          const sql = await manifestSql();
          const readConstraints = async (client: Client) => new Map((await client.query(
            `SELECT c.relname || '.' || x.conname AS name, pg_get_constraintdef(x.oid) AS definition
             FROM pg_constraint x JOIN pg_class c ON c.oid = x.conrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND x.contype = 'c'`)).rows
            .map(row => [row.name as string, row.definition as string]));
          const before = await readConstraints(source);
          const after = await readConstraints(restored);
          const rawDifferences = [...before].filter(([name, definition]) => after.get(name) !== definition);
          assert.ok(rawDifferences.length > 0,
            "the source and restored constraint text are IDENTICAL, so the canonicaliser was never exercised and this test would pass on a tree that had reintroduced the defect somewhere else");
          for (const [name] of rawDifferences.slice(0, 3)) {
            assert.notEqual(after.get(name), undefined, `${name} must exist in the restored database`);
          }

          // The updater's own digest, on the SAME rows, must agree with the
          // release's. These are two copies of one query and one hash, and a
          // divergence between them would be a silent disagreement.
          const rows = (await restored.query(sql)).rows;
          assert.equal(digestReleaseSchemaRowsV1(rows), await readPrivateWebSchemaDigest(restored),
            "the updater's digest function and the release's must agree on the same schema");
          assert.equal(digestReleaseSchemaRowsV1((await source.query(sql)).rows),
            await readPrivateWebSchemaDigest(source),
            "the updater's digest function and the release's must agree on the same schema");

          // MDB-002. pg_restore --no-owner creates every function owned by whoever
          // ran the restore; seven of them are SECURITY DEFINER, so their
          // effective authority was the restoring superuser's. Before this branch
          // applyMigrations then failed on the restored database with
          // 'permission denied for function ...'.
          const owners = (await restored.query(
            `SELECT pg_get_userbyid(p.proowner) AS owner, count(*)::int AS total,
                    count(*) FILTER (WHERE p.prosecdef)::int AS security_definer
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' GROUP BY 1 ORDER BY 2 DESC`)).rows as
            Array<{ owner: string; total: number; security_definer: number }>;
          assert.ok(owners.length > 0, "the restored database must have functions to own");
          assert.deepEqual(owners, [{ owner: "control_room_schema_owner", total: owners[0]!.total,
            security_definer: owners[0]!.security_definer }],
            `every restored function must be owned by the schema owner, not by the restoring superuser: ${JSON.stringify(owners)}`);
          assert.ok(owners[0]!.total > 50,
            `a real schema has far more than ${owners[0]!.total} functions, so this is not a thin fixture`);
          assert.ok(owners[0]!.security_definer > 0,
            "a real schema has SECURITY DEFINER functions; a count of zero means the restore dropped them");
        } finally { await restored.end(); }
      } finally { await source.end(); }
    }, { port: PORT, allowedPorts: ALLOWED, boundMs: 600_000 });
  });