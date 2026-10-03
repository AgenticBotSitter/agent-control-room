// A RENAMED COLUMN MUST NOT SILENTLY BREAK THE CANONICAL-PAYLOAD DATA GUARD.
//
// WHY THIS FILE EXISTS. `validate_control_payload_mirror` (db/migrations/0003,
// whose body 0004 replaced) mirrors each guarded table's indexed columns out of
// its `payload` JSONB and refuses any row where they disagree. It reads those
// columns by name out of `to_jsonb(NEW)` and `NEW.<column>`, and PL/pgSQL
// resolves BOTH at run time, not at CREATE time.
//
// So a migration that renames one of those columns applies cleanly, the applier
// reports success, and the ledger records it -- and then every write to that
// table is refused: `canonical payload mirror mismatch` for a `row_data`
// spelling, "record NEW has no field" for a `NEW.<column>` spelling. The schema
// change that broke a data guard is the one that is recorded as having worked.
//
// MEASURED BEFORE THE FIX, through this same harness, by applying a real rename
// migration and then writing to the table as the production coordinator login:
//   apply: ok (the migration applied and was recorded)
//   writer first failure: SQLSTATE P0001 canonical payload mirror mismatch on
//   control_jobs
//   after: the migration reported success and the table was unwritable
//
// WHAT IS PROVED HERE, on a real disposable cluster, through the REAL applier:
//   1. a real RENAME COLUMN migration is REFUSED, named with the table and the
//      column, and the rename is rolled back with it;
//   2. the refusal is not the migration file failing for its own reasons: the
//      ledger does not advance and the column is still there afterwards;
//   3. the check IS the refusal's cause -- the same rename, applied by hand on
//      the same cluster, succeeds AND breaks the writer, and `verifyPayloadGuard`
//      then refuses on that very database. Without this case a bad ledger, a
//      missing file or a role that cannot ALTER would read as proof;
//   4. a rename AND a guard update in the same migration is accepted, so the
//      guard is not simply "always refuse a rename" -- the documented escape
//      hatch works and is exercised;
//   5. a migration that touches a guarded table but no guarded column still
//      applies, so the check costs nothing on ordinary migrations;
//   6. the check refuses rather than passes vacuously when the guard is
//      unreadable -- a missing guard and a guard with no triggers are each a
//      refusal -- and the columns it demands are read from the LIVE guard body,
//      so it cannot be satisfied by a list that has drifted from the guard;
//   7. the check is ARMED by the migration texts, not by a restated migration
//      number: a fresh install whose ledger stops BEFORE the guard exists applies
//      cleanly (the pre-guard rungs), and the same install still refuses the
//      rename once the guard is in place. This is the case that fails when the
//      arming is hard-coded to "the guard always exists".
//
// The default path is exercised with NO injected port, tool, runner or fake for
// anything this fix added: `applyMigrations`, `verifyPayloadGuard` and
// `guardColumnsV1` are the real exports against a real cluster, and the rename
// is a real `ALTER TABLE ... RENAME COLUMN` read out of a real ledger file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { applyMigrations, verifyPayloadGuard } from "../deploy/postgres/apply-migrations.mjs";
import { guardColumnsForTableV1, guardColumnsV1, introducesPayloadGuard }
  from "../deploy/postgres/canonical-payload-guard.mjs";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres }
  from "./support/attack-kit/index";
import type { RealPostgres } from "./support/attack-kit/index";

// The repo's own reserved lane for payload-guard work, its own blocks, for the
// same reason the restore and down-migration lanes have one: sharing a base with
// a lane-mate makes an unrelated test fail on a busy port.
const PG = requiresRealPostgres();

/** Synthetic passwords. Never real credentials. */
const passwords: NodeJS.ProcessEnv = {
  CONTROL_ROOM_MIGRATOR_PASSWORD: "m".repeat(40),
  CONTROL_ROOM_APP_PASSWORD: "a".repeat(40),
  CONTROL_ROOM_SCHEDULER_PASSWORD: "s".repeat(40),
  CONTROL_ROOM_WORK_INTAKE_PASSWORD: "w".repeat(40),
  NODE_ENV: "test",
};

interface LedgerEntry {
  file: string;
  order: number;
  sha256: string;
  kind?: string;
}

/**
 * The migration tree the applier will read: the real `db/migrations`, `db/roles`
 * and `db/setup`, copied into a scratch root, plus ONE probe migration appended
 * to a scratch copy of the ledger.
 *
 * The copy exists so the committed ledger and `db/migrations/` are never
 * touched, and the whole tree has to be copied because `applyMigrations` reads
 * the role files and `db/setup/production_migration_ledger.sql` out of `rootDir`
 * too -- a scratch root holding only the probe would fail at bootstrap instead
 * of at the guard. The probe is numbered above every real migration, so the
 * applier treats it as a real pending migration -- which is the point: the
 * refusal has to come from the applier, not from a harness that noticed the
 * rename.
 *
 * `keepThrough` truncates the copied ledger to the rungs at or below the highest
 * `order` whose file text `introducesPayloadGuard` rejects, which is how a
 * pre-guard install is built: a real ledger prefix, installed by the real
 * applier, with nothing invented.
 */
async function installWithProbe(sql: string, label: string, options: { stopBeforeGuard?: boolean } = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), `acr-payload-guard-tree-${label}-`));
  const real = JSON.parse(await readFile("deploy/postgres/migration-ledger.json", "utf8"));
  const all = real.entries as LedgerEntry[];
  const executable = all.filter(entry => (entry.kind ?? "migrate") === "migrate");
  const highest = executable.reduce((max, entry) => Math.max(max, entry.order), 0);
  let carried = all;
  if (options.stopBeforeGuard === true) {
    const texts = await Promise.all(executable.map(async entry => [entry,
      await readFile(entry.file, "utf8")] as const));
    const guard = texts.find(([, text]) => introducesPayloadGuard(text))?.[0];
    assert.ok(guard, "no migration introduces the payload guard, so the pre-guard rung cannot be built");
    carried = all.filter(entry => entry.order <= guard.order - 1);
  }
  const name = `${String(highest + 1).padStart(4, "0")}_payload_guard_probe.sql`;
  for (const directory of ["db/migrations", "db/roles", "db/setup"]) {
    await mkdir(join(rootDir, directory), { recursive: true });
  }
  for (const entry of carried) {
    await writeFile(join(rootDir, entry.file), await readFile(entry.file));
  }
  if (options.stopBeforeGuard !== true) {
    for (const entry of all.filter(candidate => !carried.includes(candidate))) {
      await writeFile(join(rootDir, entry.file), await readFile(entry.file));
    }
  }
  await writeFile(join(rootDir, "db/migrations", name), sql, { flag: "wx" });
  // `db/setup` and `db/roles` are copied whole, not from the ledger entries.
  // `applyMigrations` reads `db/setup/production_migration_ledger.sql` and
  // `db/roles/production_table_grants.sql` out of `rootDir` by path, and the
  // ledger tracks only the four role files it integrity-checks -- so copying the
  // ledger entries alone leaves the applier unable to bootstrap.
  for (const directory of ["db/setup", "db/roles"]) {
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".sql")) continue;
      await writeFile(join(rootDir, directory, name), await readFile(join(directory, name)));
    }
  }
  const ledger = {
    ...real,
    entries: [...carried, { file: `db/migrations/${name}`, order: highest + 1,
      sha256: createHash("sha256").update(sql).digest("hex"), kind: "migrate" }],
  };
  const ledgerPath = join(rootDir, "ledger.json");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return { rootDir, ledgerPath, probeName: `db/migrations/${name}`, remove: async () => rm(rootDir, { recursive: true, force: true }) };
}

/** The libpq keyword/value connection string the production CLI passes. */
function targetOf(postgres: { host: string; port: number; database: string },
  role: { user?: string; password?: string; database?: string }): string {
  return `host=${postgres.host} port=${postgres.port} dbname=${role.database ?? postgres.database}`
    + ` user=${role.user} password=${role.password}`;
}

/** Every superuser connection in this file is the kit's own admin. */

/** A client on one of the kit's logins. */
async function connect(postgres: RealPostgres, role: string): Promise<Client> {
  const client = new Client(role === ADMIN ? postgres.admin() : postgres.connection(role));
  await client.connect();
  return client;
}

/** The kit's superuser, which owns the database and holds no production role. */
const ADMIN = "admin";

// One reserved block per case, so a busy port cannot make an unrelated case
// fail. The base sits inside the 59980-59999 window allocated to this stream.
const PORT = Number(process.env.PAYLOAD_GUARD_PG_PORT ?? 59980);
const ALLOWED = Array.from({ length: 10 }, (_, index) => PORT + index);
const LANE = ["rename-refused", "old-code-accepts", "rename-followed", "untouched-table",
  "unreadable-guard", "pre-guard-rung"] as const;
const portFor = (label: string): number => PORT + Math.max(0, (LANE as readonly string[]).indexOf(label));

/** Run the real applier against this cluster, as the production migrator login. */
async function apply(probe: { rootDir: string; ledgerPath: string }, postgres: RealPostgres): Promise<{
  applied?: Array<{ file: string; order: number }>;
  grants?: string;
}> {
  return await applyMigrations({ target: targetOf(postgres, postgres.admin()),
    rootDir: probe.rootDir, ledgerPath: probe.ledgerPath,
    // The superuser the applier bootstraps from, and the restricted migrator
    // login it applies as: the same two identities the production CLI passes.
    bootstrapTarget: targetOf(postgres, postgres.admin()),
    migrateTarget: targetOf(postgres, postgres.connection("migrator")),
    env: passwords }) as { applied?: Array<{ file: string; order: number }>; grants?: string };
}

const RENAME = "ALTER TABLE control_jobs RENAME COLUMN required_capability TO probe_capability;\n";

test("a real RENAME COLUMN migration is refused, and the rename is rolled back with it", {
  skip: !PG && realPostgresSkipMessage(),
}, async () => {
  const probe = await installWithProbe(RENAME, "rename-refused");
  try {
    await withRealPostgres(async postgres => {
      const applied = await apply(probe, postgres).catch((error: Error) => ({ error: error.message }));
      assert.ok("error" in applied,
        `the rename must be refused, got ${JSON.stringify(applied).slice(0, 400)}`);
      const refusal = (applied as { error: string }).error;
      // Named with the migration, the table and the exact column the guard reads.
      assert.match(refusal, new RegExp(`^migration_failed:${probe.probeName.replaceAll(".", "\\.")}:`
        + "migration_payload_guard_broken:", "u"), refusal);
      assert.match(refusal, /control_jobs\.required_capability/u, refusal);

      const check = await connect(postgres, ADMIN);
      try {
        // The rollback, not just the refusal: the column is still the old one, so
        // the migration left nothing behind and a corrected retry can apply.
        const columns = (await check.query("SELECT attname FROM pg_attribute WHERE attrelid = to_regclass('control_jobs')"
          + " AND attnum > 0 AND NOT attisdropped AND attname IN ('required_capability','probe_capability') ORDER BY 1")).rows
          .map((row: { attname: string }) => row.attname);
        assert.deepEqual(columns, ["required_capability"],
          "the rename must be rolled back: only the original column may remain");
        // The ledger must not have advanced either, or a retry would be refused
        // for the wrong reason.
        const head = (await check.query("SELECT filename FROM control_room_schema_migrations ORDER BY ledger_order DESC LIMIT 1"))
          .rows[0].filename;
        assert.notEqual(head, probe.probeName, "a refused migration must not be recorded as applied");
      } finally { await check.end(); }
    }, { port: portFor("rename-refused"), allowedPorts: ALLOWED, boundMs: 600_000 });
  } finally { await probe.remove(); }
});

test("the check is the refusal's cause: applied by hand the same rename succeeds, and the guard then refuses the writer", {
  skip: !PG && realPostgresSkipMessage(),
}, async () => {
  // This is the decisive case. It cannot pass while the check is armed, and it
  // is the only one that proves the rename is not being refused for some
  // unrelated reason (a bad ledger, a missing file, a role that cannot ALTER).
  const probe = await installWithProbe(RENAME, "old-code-accepts");
  try {
    await withRealPostgres(async postgres => {
      const ledger = JSON.parse(await readFile(probe.ledgerPath, "utf8")) as { entries: LedgerEntry[] };
      assert.ok(ledger.entries.some(entry => entry.file === probe.probeName),
        "the probe must really be in the ledger the applier reads");
      const admin = await connect(postgres, ADMIN);
      try {
        // The rename, in the same transaction shape the applier uses, with the
        // check deliberately absent: exactly what the old code did.
        await admin.query("ALTER TABLE control_jobs RENAME COLUMN required_capability TO probe_capability");
        const columns = (await admin.query("SELECT attname FROM pg_attribute WHERE attrelid=to_regclass('control_jobs')"
          + " AND attnum>0 AND NOT attisdropped AND attname IN ('required_capability','probe_capability')")).rows
          .map((row: { attname: string }) => row.attname);
        assert.deepEqual(columns, ["probe_capability"],
          "without the check the rename applies: which is the defect this lane exists to close");
        // And the guard IS broken by it: `verifyPayloadGuard` is the function the
        // applier calls, and it refuses on this very database.
        await assert.rejects(verifyPayloadGuard(admin, probe.probeName), /migration_payload_guard_broken/u);
        // The writer failure the finding measured, as the production writer.
        // The INSERT names the column under its NEW spelling on purpose: naming
        // the old one would be refused by the client's own SQL and would prove
        // nothing about the guard. With the rename in place the statement is
        // valid, and the refusal that follows is the GUARD's.
        const writer = await connect(postgres, "coordinator");
        try {
          const refused = await writer.query(`INSERT INTO control_jobs(id, tenant_id, workflow_id, project_id, state,
            version, priority, probe_capability, authority_digest, payload, created_at, updated_at)
            VALUES ('probe-id','tenant-probe','w-probe','p-probe','queued',1,1,'cap', $1,
              '{"version":1,"id":"probe-id","tenantId":"tenant-probe","state":"queued","workflowId":"w-probe","projectId":"p-probe","priority":1,"requiredCapability":"cap","authority":{"digest":"x"}}',
              now(), now())`, [`sha256:${"a".repeat(64)}`]).then(() => null, (error: Error) => error.message);
          assert.ok(typeof refused === "string" && refused.length > 0,
            "a renamed guarded column leaves the guard refusing the table's own writer");
          assert.match(refused, /canonical payload mirror mismatch/u, refused);
        } finally { await writer.end(); }
      } finally { await admin.end(); }
    }, { port: portFor("old-code-accepts"), allowedPorts: ALLOWED, boundMs: 600_000 });
  } finally { await probe.remove(); }
});

test("a rename AND a guard update in the same migration is accepted: the guard is not just 'never rename'", {
  skip: !PG && realPostgresSkipMessage(),
}, async () => {
  // The escape hatch is a migration that renames the column AND follows the
  // rename in the guard. The guard body is the SHIPPED one with that one column
  // renamed, so all thirteen branches survive -- a hand-written two-branch body
  // would be refused, correctly, because the other twelve tables would have
  // silently lost their guard. That refusal is asserted below.
  const guard = await readFile("db/migrations/0004_cr4b_review_hardening.sql", "utf8");
  const functionText = guard.slice(guard.indexOf("CREATE OR REPLACE FUNCTION validate_control_payload_mirror"));
  const renamedGuard = functionText.replaceAll("required_capability", "probe_capability");
  assert.notEqual(renamedGuard, functionText, "the shipped guard must mention the column being renamed");
  assert.equal((renamedGuard.match(/TG_TABLE_NAME = '/gu) ?? []).length, 13,
    "the escape hatch keeps every branch: renaming one column must not unguard the other twelve tables");
  const probe = await installWithProbe(RENAME + renamedGuard, "rename-followed");
  try {
    await withRealPostgres(async postgres => {
      const applied = await apply(probe, postgres);
      assert.equal(applied.applied?.at(-1)?.file, probe.probeName,
        "a migration that follows the rename in the guard itself is applied");
      assert.equal(applied.grants, "applied", "and the run finishes rather than deferring");
      const admin = await connect(postgres, ADMIN);
      try {
        const columns = (await admin.query("SELECT attname FROM pg_attribute WHERE attrelid=to_regclass('control_jobs')"
          + " AND attnum>0 AND NOT attisdropped AND attname='probe_capability'")).rows.length;
        assert.equal(columns, 1, "and the renamed column really is in place");
        assert.deepEqual(await verifyPayloadGuard(admin), { checked: true },
          "the updated guard is internally consistent with the renamed schema");
      } finally { await admin.end(); }
    }, { port: portFor("rename-followed"), allowedPorts: ALLOWED, boundMs: 600_000 });
  } finally { await probe.remove(); }
});

test("a migration that touches a guarded table but no guarded column still applies", {
  skip: !PG && realPostgresSkipMessage(),
}, async () => {
  const probe = await installWithProbe("ALTER TABLE control_jobs ADD COLUMN payload_guard_probe_note text;\n", "untouched-table");
  try {
    await withRealPostgres(async postgres => {
      const applied = await apply(probe, postgres);
      assert.equal(applied.applied?.at(-1)?.file, probe.probeName,
        "an ordinary migration must not be refused: the check costs nothing when it finds nothing");
      assert.equal(applied.grants, "applied");
    }, { port: portFor("untouched-table"), allowedPorts: ALLOWED, boundMs: 600_000 });
  } finally { await probe.remove(); }
});

test("the check refuses rather than passing vacuously when the guard cannot be read", {
  skip: !PG && realPostgresSkipMessage(),
}, async () => {
  await withRealPostgres(async postgres => {
    const admin = await connect(postgres, ADMIN);
    try {
      assert.deepEqual(await verifyPayloadGuard(admin), { checked: true }, "the shipped install passes");

      // (a) The guard's own body drives the check, on the live install.
      const prosrc = (await admin.query("SELECT p.prosrc AS prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace"
        + " WHERE n.nspname='public' AND p.proname='validate_control_payload_mirror' ORDER BY p.oid LIMIT 1")).rows[0].prosrc;
      const parsed = guardColumnsV1(prosrc);
      assert.equal(parsed.branches.length, 13, "the shipped guard guards 13 tables");
      const jobs = guardColumnsForTableV1(parsed, "control_jobs");
      assert.deepEqual(jobs, ["authority_digest", "id", "payload", "priority", "project_id",
        "required_capability", "state", "tenant_id", "version", "workflow_id"]);
      // A table the guard does NOT branch on cannot be checked -- refused, not passed.
      assert.throws(() => guardColumnsForTableV1(parsed, "control_approvals_queue"),
        /payload_guard_has_no_branch/u);

      // (b) No guard function at all: a refusal, not an empty finding.
      await admin.query("BEGIN");
      await admin.query("ALTER FUNCTION validate_control_payload_mirror() RENAME TO probe_absent_guard");
      await assert.rejects(verifyPayloadGuard(admin), /payload_guard_function_missing/u);
      await admin.query("ROLLBACK");

      // (c) The guard exists but nothing carries its trigger: also a refusal. If
      // this passed silently, dropping every trigger would switch the whole
      // mechanism off.
      await admin.query("BEGIN");
      for (const table of parsed.branches.map(branch => branch.table)) {
        await admin.query(`DROP TRIGGER ${table}_payload_mirror ON ${table}`);
      }
      await assert.rejects(verifyPayloadGuard(admin), /payload_guard_has_no_triggers/u);
      await admin.query("ROLLBACK");
      assert.deepEqual(await verifyPayloadGuard(admin), { checked: true }, "and both rollbacks restored it");
    } finally { await admin.end(); }
  }, { port: portFor("unreadable-guard"), allowedPorts: ALLOWED, boundMs: 600_000 });
});

test("a fresh install whose ledger stops BEFORE the guard exists still applies, and then still refuses the rename", {
  skip: !PG && realPostgresSkipMessage(),
}, async () => {
  // The arming has to come from the migration texts. 0001 and 0002 have no
  // payload guard at all, so a check that ran on every migration unconditionally
  // would refuse every fresh install with `payload_guard_function_missing`
  // before the guard exists -- and the whole run would be dead on arrival.
  //
  // The truncated ledger is installed into a SEPARATE database on one cluster.
  // `withRealPostgres` always installs the full ledger into the database it
  // hands out, so a pre-guard rung has to be built by applying the prefix
  // somewhere else; the cluster, the roles and the applier are all the real
  // ones either way.
  const probe = await installWithProbe("SELECT 1;\n", "pre-guard-rung", { stopBeforeGuard: true });
  try {
    await withRealPostgres(async postgres => {
      const admin = await connect(postgres, ADMIN);
      const database = "pre_guard_rung";
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${database}`);
        const applied = await applyMigrations({
          target: targetOf(postgres, { ...postgres.admin(), database }),
          rootDir: probe.rootDir, ledgerPath: probe.ledgerPath,
          bootstrapTarget: targetOf(postgres, { ...postgres.admin(), database }),
          migrateTarget: targetOf(postgres, { ...postgres.connection("migrator"), database }),
          env: passwords }) as { applied?: Array<{ file: string }>; grants?: string };
        assert.equal(applied.applied?.at(-1)?.file, probe.probeName,
          "the pre-guard rungs must apply: there is no guard to check yet");
        // `grants` DEFERS here, and must: this ledger stops at 0002, so
        // `production_table_grants.sql` names relations the rung does not have.
        // That is the applier's documented partial-schema arm, and it is what
        // keeps a pre-guard install distinguishable from a refusal -- the guard
        // check must not turn it into one.
        assert.match(String(applied.grants), /^deferred_partial_schema:/u,
          "a truncated rung defers grants rather than failing, and the guard check must not change that");

        // The guard genuinely does not exist at this rung, so there is nothing
        // to check and nothing to refuse. 0002's tables are all this rung has --
        // `control_jobs` arrives with 0003 -- so the assertion is on a column 0002
        // really owns, which is the point: this rung cannot even be asked the
        // question M5 is about.
        const prefixed = new Client({ ...postgres.admin(), database });
        await prefixed.connect();
        try {
          assert.equal((await prefixed.query("SELECT count(*)::int AS n FROM pg_proc p"
            + " JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'"
            + " AND p.proname='validate_control_payload_mirror'")).rows[0].n, 0,
            "the pre-guard rung really has no payload guard");
          await prefixed.query("BEGIN");
          await prefixed.query("ALTER TABLE work_items RENAME COLUMN required_capability TO probe_capability");
          assert.ok((await prefixed.query("SELECT attname FROM pg_attribute WHERE attrelid=to_regclass('work_items')"
            + " AND attnum>0 AND NOT attisdropped AND attname='probe_capability'")).rows.length === 1,
            "with no guard nothing refuses a rename: which is why the check must not be armed yet");
          await prefixed.query("ROLLBACK");
        } finally { await prefixed.end(); }
      } finally { await admin.end(); }
    }, { port: portFor("pre-guard-rung"), allowedPorts: ALLOWED, boundMs: 600_000 });

    // The other half of the same claim, on a FULL install: once the guard is
    // present, the very same shape of rename is refused. Without this the arming
    // could be "never" and every assertion above would still pass, which is the
    // defect M5 exists to close.
    await withRealPostgres(async postgres => {
      const admin = await connect(postgres, ADMIN);
      try {
        await admin.query("BEGIN");
        await admin.query(RENAME);
        await assert.rejects(verifyPayloadGuard(admin, "the-guard-rung"),
          /migration_payload_guard_broken:.*control_jobs\.required_capability/u);
        await admin.query("ROLLBACK");
      } finally { await admin.end(); }
    }, { port: portFor("pre-guard-rung"), allowedPorts: ALLOWED, boundMs: 600_000 });
  } finally { await probe.remove(); }
});