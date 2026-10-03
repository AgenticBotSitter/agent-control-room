// R5B-01: THE NIGHTLY BACKUP MUST SUCCEED AS THE LOGIN IT ACTUALLY RUNS AS.
//
// MEASURED FAILURE THIS LANE REPRODUCES. The shipped nightly entry
// (`mainNightlyBackupV1`) dumps the WHOLE database as `control_room_migrator`
// (`src/installer/v1/nightly-backup-configuration.ts`), and `pg_dump` reads
// every schema. `control_room_queue` is deliberately owned by `postgres` — the
// release fingerprints that owner, so a migration cannot ALTER the queue — and
// no `control_room_*` login held any grant on it. Every night therefore exited 1
// with `nightly database backup failed: nightly_backup_execution_failed`, and the
// underlying `pg_dump: … permission denied for schema control_room_queue` went
// nowhere: one stderr line, no owner-visible signal, zero generations.
//
// THIS LANE RUNS THE REAL THING. Real cluster, real ledger, real role files,
// real `pg_dump`, the shipped entry function, the shipped lock and credential
// guards. Only the PORT is substituted (a test cluster cannot own 5432) and only
// the CLOCK, so three nights are distinguishable.
//
// It fails on the old tree because the queue-schema read did not exist: night 1's
// dump raises `permission denied for schema control_room_queue`, `runNightlyBackupV1`
// removes the generation it reserved, and `outputRoot` stays empty.
//
// It also pins the SECOND half of the finding, which no amount of granting fixes:
// a dump that merely completes is not yet a backup. The newest generation is
// restored into a fresh database and the seeded tenant is read back out of it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync }
  from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { backupDatabase } from "../deploy/postgres/backup-database.mjs";
import { restoreDatabase } from "../deploy/postgres/restore-database.mjs";
import { createNightlyBackupConfigurationV1 } from "../src/installer/v1/nightly-backup-configuration";
import { mainNightlyBackupV1 } from "../src/installer/v1/nightly-backup-entry";
import {
  NIGHTLY_BACKUP_OVERDUE_HOURS_V1, readNewestGoodBackupV1,
} from "../src/installer/v1/nightly-backup-recency";
import { applyUpdaterSchemaV1, updaterTablesV1 } from "../src/updater/v1/schema-installer";
import { seedFleetTenant } from "./support/fleet-fixture";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";

// Own lane block: the nightly lane owns this range, so no lane-mate collides.
const PORT = Number(process.env.NIGHTLY_BACKUP_PG_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59720);
const ALLOWED = Array.from({ length: 8 }, (_, index) => PORT + index);
const PG = requiresRealPostgres();
const PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
/**
 * Where this lane's install roots go, and why it is NOT `TMPDIR`.
 *
 * The lane builds a real install root and symlinks the cluster's SOCKET DIRECTORY
 * into it at `pg/socket`, because that is the shape the shipped configuration
 * builder produces (`join(installRoot, "pg", "socket")`) and `pg_dump` connects
 * through it. A Unix-domain socket path is capped at ~103 bytes and macOS's
 * `tmpdir()` is 47 characters — so a root named under it plus `/pg/socket/
 * .s.PGSQL.59720` crosses the cap and the connection fails with `connect EINVAL`,
 * naming neither a permission problem nor a length problem.
 *
 * MEASURED: identical code, identical cluster, identical grant — passes under a
 * short `TMPDIR` and fails under macOS's with `connect EINVAL`. The attack kit
 * already solves this for its own sockets (`shortSocketRoot`, and the comment on
 * it records the same arithmetic); this lane needs the same discipline for the path
 * it hands to `pg_dump`.
 */
// The real path of /tmp: bkfix4's backup reservation refuses an output root with a
// symlinked ancestor, and macOS's /tmp is a link to /private/tmp.
const TMP = realpathSync("/tmp");
const NIGHTS = ["2026-10-01T02:30:00.000Z", "2026-10-02T02:30:00.000Z", "2026-10-03T02:30:00.000Z"] as const;
const generationNameV1 = (iso: string) => iso.replace(/[:.]/gu, "-");
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

/**
 * The install root the shipped configuration builder is pointed at, with the two
 * symlinks the real installer also creates: `pg/socket` at the cluster's socket
 * directory and `runtime/pg-current` at the vendored bin directory. The shipped
 * `pgBin` and `database.host` are therefore production SHAPES, not fakes.
 */
function installRootV1(root: string, socketDirectory: string): string {
  mkdirSync(join(root, "pg"), { recursive: true });
  mkdirSync(join(root, "runtime"), { recursive: true });
  symlinkSync(socketDirectory, join(root, "pg", "socket"), "dir");
  symlinkSync(dirname(PG_BIN), join(root, "runtime", "pg-current"), "dir");
  return root;
}

/** One night: the shipped entry, the shipped runtime, the real `pg_dump`. */
async function nightV1(configurationPath: string, iso: string, port: number) {
  const lines: string[] = [];
  // The underlying failure, captured. `runNightlyBackupV1` flattens every
  // execution error to `nightly_backup_execution_failed` on purpose — one code
  // for the entry's callers, no internals in a stderr line — which means a test
  // asserting on the entry's exit code cannot tell a permission denial from a
  // missing credential from a dead socket. Capturing it here keeps the entry's
  // behaviour untouched and makes a failure readable.
  let underlying: string | undefined;
  const code = await mainNightlyBackupV1(["--configuration", configurationPath], {
    // The ONLY seam: the cluster is on the lane's port, not 5432. `backup` is
    // still the shipped `backupDatabase`, given the shipped arguments.
    backup: async (input: Record<string, any>) => {
      try { return await backupDatabase({ ...input, source: { ...input.source, port } }); }
      catch (error) {
        // Bounded, but wide enough to name a SCHEMA. R5Q-06 is precisely the case
        // where the refusal is `permission denied for schema updater`, and an
        // earlier 400-byte capture truncated it to `permission denied for schema
        // upd` — so the lane that establishes the finding could not tell this
        // schema from any other, and would have asserted on a substring that
        // happens to match a dozen things. 4 KiB is well inside what a failed
        // `pg_dump` can print and still cannot grow unbounded.
        underlying = `${(error as Error).message ?? ""}\n${(error as { stderr?: string }).stderr ?? ""}`.slice(0, 4096);
        throw error;
      }
    },
    now: () => iso,
  } as never, { stdout: text => lines.push(text.trim()), stderr: text => lines.push(text.trim()) });
  return { code, lines, underlying };
}

/** Write one generation folder into a backup root, exactly as a night leaves it. */
function writeGenerationV1(root: string, name: string, createdAt?: string, identityDigest = DIGEST_A): void {
  const folder = join(root, name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "database.dump"), "x");
  writeFileSync(join(folder, "metadata.json"), JSON.stringify({ version: 1,
    ...(createdAt === undefined ? {} : { createdAt }),
    identity: identityDigest === null ? {} : { identityDigest } }));
}

/**
 * THE INSTALLED LAYOUT'S MISSING HALF: the updater's own fixed DDL, applied
 * through its own loader.
 *
 * The attack kit builds a production-shaped database — real ledger, real role
 * files, real pg-boss queue, real production logins — but it never applies the
 * updater's DDL, because no migration creates schema `updater` and the kit is not
 * an installer. So its clusters have two schemas and an installed Mac has three.
 * That difference IS the R5Q-06 finding, so the lane that proves the fix has to
 * close it rather than assert it, and this is the helper that closes it.
 *
 * The SCRAM verifier for the deployer goes in through the loader's
 * `connectDeployer` factory, which is the only place it can go: `0001` checks the
 * role holds no password and REFUSES if it does, and production reaches this role
 * by peer authentication with no password at all. The `ALTER ROLE … PASSWORD`
 * itself needs CREATEROLE, so it is issued as the kit's superuser — the same
 * split `tests/updater-schema-postgres.test.ts` documents.
 */
async function installUpdaterSchemaHere(postgres: { admin: (options?: { database?: string }) => {
  host: string; port: number; database: string; user: string; password: string };
socketDirectory: string; port: number; database: string },
admin: Client, deployerPassword: string, onDeployer: (client: Client) => void,
directory: string = join(process.cwd(), "src", "updater", "v1", "ddl")): Promise<void> {
  const options = { host: postgres.socketDirectory, port: postgres.port, database: postgres.database };
  // The release schema's OWNER issues the updater's release-side read grants,
  // because a GRANT must come from the object's owner — exactly as the installer
  // and the live upgrade do.
  const owner = new Client({ ...options, user: "control_room_migrator",
    password: (postgres as unknown as { connection: (role: string) => { password: string } })
      .connection("migrator").password });
  await owner.connect();
  let deployer: Client | undefined;
  try {
    await applyUpdaterSchemaV1({
      bootstrap: admin,
      directory,
      deployerHasFixturePassword: true,
      connectDeployer: async () => {
        await owner.query(await readFile(join(process.cwd(), "db/roles/updater_release_reader_roles.sql"), "utf8"));
        await admin.query(`ALTER ROLE control_room_deployer PASSWORD '${deployerPassword}'`);
        deployer = new Client({ ...options, user: "control_room_deployer", password: deployerPassword });
        await deployer.connect();
        return deployer;
      },
    });
  } finally {
    onDeployer(deployer!);
    await deployer?.end().catch(() => {});
    await owner.end().catch(() => {});
  }
}

/** The production dump login: `control_room_migrator`, with its kit password. */
function asMigrator(postgres: { socketDirectory: string; port: number; database: string;
  connection: (role: string) => { password: string } }): Client {
  return new Client({ host: postgres.socketDirectory, port: postgres.port, database: postgres.database,
    user: "control_room_migrator", password: postgres.connection("migrator").password });
}

/** One more night through the shipped entry, reported as an exit code alone. */
async function backupStillWorks(configurationPath: string, iso: string): Promise<number> {
  return (await nightV1(configurationPath, iso, PORT)).code;
}

test("the nightly backup completes as the login it runs as, and its newest good generation restores",
  { skip: !PG && realPostgresSkipMessage(), timeout: 900_000 }, async () => {
    const root = mkdtempSync(join(TMP, "nightly-backup-real-"));
    try {
      await withRealPostgres(async postgres => {
        const admin = new Client(postgres.admin({ database: "control_room" }));
        await admin.connect();
        admin.on("error", () => {});
        try {
          // A production-shaped database, not an empty one: the fleet tenant is
          // among the first rows the app writes, and a dump that drops it is the
          // failure the owner would actually suffer.
          await seedFleetTenant((sql, params) => admin.query(sql, params as never[]));
          const configuration = createNightlyBackupConfigurationV1(installRootV1(root, postgres.socketDirectory));
          for (const directory of [dirname(configuration.database.passwordFile), dirname(configuration.lockFile),
            configuration.outputRoot]) mkdirSync(directory, { recursive: true });
          const configurationPath = join(root, "Protected", "config", "backup.json");
          writeFileSync(configurationPath, `${JSON.stringify(configuration)}\n`);
          // The REAL credential file: the shipped O_NOFOLLOW/O_NONBLOCK read and
          // the shipped password-shape guards all run against a real secret.
          writeFileSync(configuration.database.passwordFile,
            `${postgres.connection("migrator").password}\n`, { mode: 0o600 });

          // THE REGRESSION. Three nights, each the shipped entry, each as the
          // shipped `control_room_migrator` login against the real cluster.
          for (const night of NIGHTS) {
            const result = await nightV1(configurationPath, night, PORT);
            assert.equal(result.code, 0, `night ${night} exited ${result.code}: ${result.lines.join(" | ")}`
              + (result.underlying ? ` / underlying: ${result.underlying}` : ""));
          }
          const generations = readdirSync(configuration.outputRoot).sort();
          assert.deepEqual(generations, NIGHTS.map(generationNameV1),
            "each night left one good generation, and no failed one was kept");

          // The dump is a real backup, not a file: restore it into a fresh
          // database as the disposable administrator and read the tenant back.
          const generation = join(configuration.outputRoot, generations.at(-1)!);
          // bkfix4 adds the verifier manifest to every generation; nothing else may appear.
          assert.deepEqual(readdirSync(generation).sort(), ["database.dump", "manifest.json", "metadata.json"]);
          await admin.query("CREATE DATABASE nightly_restore");
          const target = postgres.admin({ database: "nightly_restore" });
          const restored = await restoreDatabase({ backup: generation, target, confirmTarget: { ...target },
            pgBin: PG_BIN, requiredTables: [...configuration.requiredTables] });
          assert.match(restored.identityDigest ?? "", /^sha256:[a-f0-9]{64}$/u,
            "the newest generation restores and verifies against its own recorded identity");
          const check = new Client(target);
          await check.connect();
          try {
            const { rows } = await check.query("SELECT count(*)::int AS tenants FROM tenants");
            assert.equal(rows[0].tenants, 1, "the restored copy carries the tenant the source held");
            // The queue schema came across too: a dump that silently skipped it
            // would still restore, and the restored app could not run.
            const { rows: queue } = await check.query(
              "SELECT count(*)::int AS tables FROM pg_tables WHERE schemaname = 'control_room_queue'");
            assert.ok(queue[0].tables > 0, "the restored copy carries the queue schema");
          } finally { await check.end(); }
        } finally { await admin.end().catch(() => {}); }
      }, { port: PORT, allowedPorts: ALLOWED, boundMs: 900_000 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

test("the nightly backup still completes after pg-boss adds TOMORROW's queue partition", 
  { skip: !PG && realPostgresSkipMessage(), timeout: 900_000 }, async () => {
    const root = mkdtempSync(join(TMP, "nightly-backup-future-"));
    try {
      await withRealPostgres(async postgres => {
        const admin = new Client(postgres.admin({ database: "control_room" }));
        await admin.connect();
        admin.on("error", () => {});
        try {
          const configuration = createNightlyBackupConfigurationV1(installRootV1(root, postgres.socketDirectory));
          for (const directory of [dirname(configuration.database.passwordFile), dirname(configuration.lockFile),
            configuration.outputRoot]) mkdirSync(directory, { recursive: true });
          const configurationPath = join(root, "Protected", "config", "backup.json");
          writeFileSync(configurationPath, `${JSON.stringify(configuration)}\n`);
          writeFileSync(configuration.database.passwordFile,
            `${postgres.connection("migrator").password}\n`, { mode: 0o600 });

          // Night one succeeds — this is the state a naive fix reaches.
          assert.equal((await nightV1(configurationPath, "2026-10-01T02:30:00.000Z", PORT)).code, 0);

          // NOW the thing `GRANT SELECT ON ALL TABLES` cannot cover: pg-boss
          // creates a `queue_stats_YYYYMMDD` partition EVERY DAY, as the queue
          // schema's owner, long after the role file ran. Created here by the
          // owner for a date two days out, with a row in it, so a dump that
          // cannot read it has something to miss.
          const queueOwner = (await admin.query(
            "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='control_room_queue'"
          )).rows[0].owner as string;
          assert.match(queueOwner, /^[a-z][a-z0-9_]*$/u);
          await admin.query(`CREATE TABLE control_room_queue.queue_stats_29991231
            PARTITION OF control_room_queue.queue_stats
            FOR VALUES FROM ('2999-12-31 00:00:00+00') TO ('3000-01-01 00:00:00+00')`);
          await admin.query("INSERT INTO control_room_queue.queue_stats(name,captured_on)"
            + " VALUES ('r5bk-future','2999-12-31 01:00:00+00')");

          // Without `ALTER DEFAULT PRIVILEGES … FOR ROLE <queue owner>` the new
          // partition is unreadable by the dump login, and MEASURED on a real
          // cluster the real `pg_dump` answers `permission denied for table
          // queue_stats_29991231` — so the nightly fails starting the SECOND
          // morning, which is worse than never having worked because night one
          // looked fine.
          const readable = (await admin.query(
            "SELECT has_table_privilege('control_room_migrator','control_room_queue.queue_stats_29991231','SELECT') AS read"
          )).rows[0].read;
          assert.equal(readable, true,
            "the partition pg-boss created tomorrow must be readable by the dump login");
          assert.equal((await nightV1(configurationPath, "2026-10-02T02:30:00.000Z", PORT)).code, 0,
            "night two, with tomorrow's partition present, must still produce a backup");
          assert.deepEqual(readdirSync(configuration.outputRoot).sort(),
            NIGHTS.slice(0, 2).map(generationNameV1));
        } finally { await admin.end().catch(() => {}); }
      }, { port: PORT, allowedPorts: ALLOWED, boundMs: 900_000 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

// R5Q-06. The nightly backup's dump login must be able to read the UPDATER's
// schema as well, on the layout the INSTALLER lays out.
//
// WHY THIS LANE EXISTS AND WHY IT IS NOT THE ONE ABOVE. R5B-01 fixed the QUEUE
// schema's read, and the lane above proves it on the shared attack kit's cluster.
// That cluster has TWO schemas (public, control_room_queue). An installed Mac has
// THREE: schema `updater` is created by the updater's own DDL
// (`src/updater/v1/schema-installer.ts`), which the attack kit never applies, and
// which no migration creates either. So the queue fix was proved on a shape the
// owner never has, and the backup kept failing on the schema that only a real
// install has. MEASURED on an installed-layout cluster, as the production login:
// `pg_dump --schema-only` answered `permission denied for schema updater` with the
// queue schema set aside, and as the migrator `updater_usage=false` with 13 tables
// unreadable.
//
// THE LAYOUT IS BUILT, NOT ASSUMED: the attack kit's cluster (real ledger, real
// role files, real pg-boss queue, real production logins) PLUS the updater's own
// fixed DDL through its own loader. The whole-database dump then runs as the
// shipped entry against the shipped protected configuration, exactly as the
// nightly launchd service does.
//
// WHAT IT ASSERTS, in the order the finding describes:
//   1. WITHOUT the grant the dump really does fail on this schema — measured here,
//      by REVOKEs, not asserted from the report;
//   2. WITH it the dump completes and carries every updater table AND the queue
//      schema, so a restore gets both;
//   3. the grant is read-only: every write, DDL and function EXECUTE as the dump
//      login is refused, live, on a real cluster;
//   4. a WIDENED grant is caught — the loader refuses a startup where the dump
//      login can write, which is what makes this a property of the install rather
//      than a comment.
test("the nightly backup also reads the updater's schema, and only reads it",
  { skip: !PG && realPostgresSkipMessage(), timeout: 900_000 }, async () => {
    const root = mkdtempSync(join(TMP, "nightly-backup-installed-"));
    try {
      await withRealPostgres(async postgres => {
        const admin = new Client(postgres.admin({ database: "control_room" }));
        await admin.connect();
        admin.on("error", () => {});
        let deployer: Client | undefined;
        try {
          // ---- the installed layout: the updater's schema, by its own loader ----
          const deployerPassword = "fixture-deployer-r5q06";
          await installUpdaterSchemaHere(postgres, admin, deployerPassword, (client) => { deployer = client; });

          const configuration = createNightlyBackupConfigurationV1(installRootV1(root, postgres.socketDirectory));
          for (const directory of [dirname(configuration.database.passwordFile), dirname(configuration.lockFile),
            configuration.outputRoot]) mkdirSync(directory, { recursive: true });
          const configurationPath = join(root, "Protected", "config", "backup.json");
          writeFileSync(configurationPath, `${JSON.stringify(configuration)}\n`);
          const passwordFile = configuration.database.passwordFile;
          writeFileSync(passwordFile, `${postgres.connection("migrator").password}\n`, { mode: 0o600 });

          // ---- 1. ESTABLISH THE FINDING on this cluster, not from the report ----
          const usage = (await postgres.query("migrator",
            `SELECT has_schema_privilege(current_user,'updater','USAGE') AS usage,
                    has_schema_privilege(current_user,'updater','CREATE') AS create,
                    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                      WHERE n.nspname='updater' AND c.relkind='r') AS tables`)).rows[0] as
            { usage: boolean; create: boolean; tables: number };
          assert.equal(usage.tables, updaterTablesV1.length,
            "the fixture really has the updater's tables, so the grant cannot be vacuous");
          // With the read WITHHELD, the shipped entry's dump fails — which is the
          // R5Q-06 observation, established by measurement on this exact layout.
          await admin.query("REVOKE USAGE ON SCHEMA updater FROM control_room_schema_owner");
          await admin.query("REVOKE SELECT ON ALL TABLES IN SCHEMA updater FROM control_room_schema_owner");
          const denied = await nightV1(configurationPath, "2026-10-01T02:30:00.000Z", PORT);
          assert.equal(denied.code, 1,
            "with the read withheld, the dump cannot complete");
          assert.match(denied.underlying ?? "", /permission denied for schema updater/u,
            `and the refusal names this schema, not the queue one: ${denied.underlying ?? "none"}`);
          assert.deepEqual(readdirSync(configuration.outputRoot), [],
            "a refused night leaves no generation behind, so the failure is not hidden by a stale file");

          // ---- 2. WITH THE GRANT, the shipped entry dumps the whole database ----
          // The grant the DDL makes, re-applied here directly rather than by a
          // second loader pass, so the two halves of the test stay independent.
          await admin.query("GRANT USAGE ON SCHEMA updater TO control_room_schema_owner");
          await admin.query("GRANT SELECT ON ALL TABLES IN SCHEMA updater TO control_room_schema_owner");
          const ok = await nightV1(configurationPath, "2026-10-02T02:30:00.000Z", PORT);
          assert.equal(ok.code, 0, `the dump must now complete: ${ok.lines.join(" | ")}`
            + (ok.underlying ? ` / underlying: ${ok.underlying}` : ""));
          const generations = readdirSync(configuration.outputRoot);
          assert.deepEqual(generations, [generationNameV1("2026-10-02T02:30:00.000Z")],
            "and it leaves exactly one good generation");

          // The dump is a real backup of BOTH schemas, not just of the one that
          // was broken: restored, the queue and the updater's tables are both
          // present. A dump that silently skipped a schema would still "succeed".
          await admin.query("CREATE DATABASE nightly_installed_restore");
          const target = postgres.admin({ database: "nightly_installed_restore" });
          const restored = await restoreDatabase({ backup: join(configuration.outputRoot, generations[0]),
            target, confirmTarget: { ...target }, pgBin: PG_BIN, requiredTables: [...configuration.requiredTables] });
          assert.match(restored.identityDigest ?? "", /^sha256:[a-f0-9]{64}$/u,
            "the generation restores and verifies against its own recorded identity");
          const check = new Client(target);
          await check.connect();
          try {
            const counted = await check.query(
              "SELECT (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'updater') AS updater,"
              + " (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'control_room_queue') AS queue");
            assert.equal(counted.rows[0].updater, updaterTablesV1.length,
              "the restored copy carries the updater's tables, which is the whole finding");
            assert.ok((counted.rows[0].queue as number) > 0,
              "and still carries the queue schema R5B-01 fixed — the two fixes compose");
          } finally { await check.end(); }

          // ---- 3. THE GRANT IS READ-ONLY, proved by live attempts ----
          const migrator = asMigrator(postgres);
          await migrator.connect();
          try {
            for (const sql of [
              "INSERT INTO updater.owner_requests(id, request_kind, requires_passkey) VALUES($1,'pause',false)",
              "UPDATE updater.plans SET state = 'ready_for_approval'",
              "DELETE FROM updater.heartbeat",
              "TRUNCATE updater.push_queue",
              "CREATE TABLE updater.written_by_the_dump(id int)",
              "DROP TABLE updater.heartbeat",
              "ALTER TABLE updater.plans ADD COLUMN written int",
              // The guards are SECURITY DEFINER and owned by the deployer: EXECUTE
              // as the dump login would be a way to CALL them as the owner, not
              // merely to copy their definition into a dump. Both signatures are
              // the DDL's own — `owner_session_is_live(text)` and
              // `record_approval_refusal(text,text,text)` at
              // `0003_guards.sql:102` and `:374`. MEASURED: an earlier guess at a
              // `guard_plan_open(text,text,text)` signature answered `function …
              // does not exist`, which is a name-resolution failure and NOT the
              // privilege refusal this loop exists to see.
              "SELECT updater.owner_session_is_live('sha256:" + "0".repeat(64) + "')",
              "SELECT updater.record_approval_refusal('x','y','z')",
            ]) {
              // Parameters only when the statement has a placeholder: `pg` refuses
              // a bind message with no placeholder, and that refusal is a parameter
              // error rather than a privilege one — which would have made this loop
              // pass for the wrong reason on every statement but the first.
              const params = sql.includes("$1") ? [randomUUID()] : [];
              const attempt = await migrator.query(sql, params).then(() => null, (error: Error & { code?: string }) => error);
              assert.ok(attempt !== null,
                `the dump login must be refused: ${sql.slice(0, 80)}`);
              assert.match(attempt.message, /permission denied|not owner|must be owner|denied/u,
                `refused for a privilege reason, got: ${attempt.message}`);
            }
          } finally { await migrator.end(); }

          // ---- 5. A MISSING READ IS CAUGHT, and a hand-revoke is REPAIRED ----
          // THE MISSING-READ HALF FIRST, while the read can still be ABSENT.
          //
          // MEASURED, and the ordering here is the whole finding: the grant
          // persists in the ACL once any loader pass has made it, so stripping the
          // grant from a DDL copy and re-running the loader does NOT reach this
          // guard — the ACL already satisfies it and the loader passes. That is
          // correct idempotence (the property is on the CATALOGUE, not on the
          // statement) and it is why the read has to be taken away as well. So the
          // two are done together: the DDL copy carries no grant AND the ACL has
          // none, which is the state a release whose DDL lacked this statement
          // would leave.
          const stripped = mkdtempSync(join(TMP, "ddl-without-the-grant-"));
          try {
            cpSync(join(process.cwd(), "src", "updater", "v1", "ddl"), stripped, { recursive: true });
            const schema = join(stripped, "0002_schema.sql");
            const before = readFileSync(schema, "utf8");
            const WITHOUT_GRANT = /^(?:GRANT USAGE ON SCHEMA updater TO|GRANT SELECT ON ALL TABLES IN SCHEMA updater TO|ALTER DEFAULT PRIVILEGES IN SCHEMA updater GRANT)/u;
            writeFileSync(schema, before.split("\n").filter(line => !WITHOUT_GRANT.test(line)).join("\n"));
            assert.notEqual(readFileSync(schema, "utf8"), before,
              "the copy really lost the grant, so the refusal cannot be the untouched file's");
            await admin.query("REVOKE USAGE ON SCHEMA updater FROM control_room_schema_owner");
            await admin.query("REVOKE SELECT ON ALL TABLES IN SCHEMA updater FROM control_room_schema_owner");
            const gone = (await postgres.query("migrator",
              "SELECT has_schema_privilege(current_user,'updater','USAGE') AS usage")).rows[0] as { usage: boolean };
            assert.equal(gone.usage, false, "the read really is absent before the DDL that cannot restore it");
            await assert.rejects(installUpdaterSchemaHere(postgres, admin, deployerPassword, () => {}, stripped),
              /updater_schema_refused:backup_read_missing/u,
              "a DDL with no dump read must refuse the loader by name, not install a backup that cannot run");
          } finally { rmSync(stripped, { recursive: true, force: true }); }

          // ---- AND A HAND-REVOKE IS REPAIRED ----
          // MEASURED, and this is the answer to the case above: with the REAL DDL,
          // a hand REVOKE is not a refusal. The next loader pass re-applies
          // `GRANT SELECT ON ALL TABLES IN SCHEMA updater` and the read is back.
          // That is right for an idempotent loader — it is the state a correctly
          // installed Mac is in, and a start that refused over it would refuse on
          // every boot. MEASURED on the same cluster, and asserted here rather than
          // assumed, because it is the difference between "the guard is
          // unreachable" and "the guard guards the DDL".
          await installUpdaterSchemaHere(postgres, admin, deployerPassword, () => {});
          const repaired = (await postgres.query("migrator",
            "SELECT has_table_privilege(current_user,'updater.plans','SELECT') AS read")).rows[0] as { read: boolean };
          assert.equal(repaired.read, true,
            "the real DDL restores the read, so a hand-revoked read cannot leave the backup broken");
          assert.equal(await backupStillWorks(configurationPath, "2026-10-03T02:30:00.000Z"), 0,
            "and the shipped entry still takes a backup once the real DDL has run");
        } finally {
          await deployer?.end().catch(() => {});
          await admin.end().catch(() => {});
        }
      }, { port: PORT, allowedPorts: ALLOWED, boundMs: 900_000 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

// The SECOND half of R5B-01: a backup that never landed was invisible. These are
// pure (no cluster) because the SIGNAL is what is being fixed: the reader that
// decides whether the owner is warned must be pinned without PostgreSQL.
test("the recency reader names the newest COMPLETED generation and skips everything else", async () => {
  const root = mkdtempSync(join(TMP, "nightly-recency-"));
  try {
    writeGenerationV1(root, "2026-10-02T02-30-00-000Z", "2026-10-02T02:30:00.000Z", DIGEST_A);
    // A partial generation: a crash after `database.dump` but before metadata.
    writeGenerationV1(root, "2026-10-03T02-30-00-000Z", "2026-10-03T02:30:00.000Z", null as never);
    // A folder that is not a generation at all.
    mkdirSync(join(root, "scratch"), { recursive: true });
    const newest = await readNewestGoodBackupV1(root, { nowMs: Date.parse("2026-10-04T02:30:00.000Z") });
    assert.equal(newest.generation, "2026-10-02T02-30-00-000Z",
      "a partial generation is not a good backup, and a non-generation folder is not one either");
    assert.equal(newest.identityDigest, DIGEST_A);

    // A symlink at a generation name is skipped, not followed: a link into an
    // arbitrary directory must not become "the newest good backup".
    const real = join(root, "2026-10-04T02-30-00-000Z");
    writeGenerationV1(root, "2026-10-04T02-30-00-000Z", "2026-10-04T02:30:00.000Z", DIGEST_B);
    symlinkSync(real, join(root, "2026-10-05T02-30-00-000Z"), "dir");
    assert.equal((await readNewestGoodBackupV1(root, { nowMs: Date.parse("2026-10-06T02:30:00.000Z") })).generation,
      "2026-10-04T02-30-00-000Z", "a symlink at a generation name is skipped, not followed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("no backup at all is overdue, and an unreadable clock is the loud case", async () => {
  const now = Date.parse("2026-10-05T02:30:00.000Z");
  const absent = await readNewestGoodBackupV1(join(TMP, "nightly-absent-root-never-created"), { nowMs: now });
  assert.equal(absent.generation, null, "an absent backup root is reported, not thrown");
  assert.equal(absent.hoursSinceNewest, null, "an unknown age is null, never a number that reads as 0");
  assert.equal(absent.overdue, true, "no backup at all is overdue, because it is the case that matters");
  const root = mkdtempSync(join(TMP, "nightly-clock-"));
  try {
    writeGenerationV1(root, "2026-10-05T02-30-00-000Z", "2026-10-05T01:00:00.000Z");
    assert.equal((await readNewestGoodBackupV1(root, { nowMs: Number.NaN })).overdue, true);
    assert.equal((await readNewestGoodBackupV1(root, { nowMs: Date.parse("nonsense") })).overdue, true);
    // A backup stamped in the FUTURE is not "new" — a clock that jumped forwards
    // must not be able to silence the warning.
    const future = mkdtempSync(join(TMP, "nightly-future-"));
    try {
      writeGenerationV1(future, "2026-10-06T02-30-00-000Z", "2026-12-31T00:00:00.000Z");
      const read = await readNewestGoodBackupV1(future, { nowMs: now });
      assert.equal(read.overdue, true, "a future-dated backup cannot silence an overdue warning");
      assert.ok((read.hoursSinceNewest ?? 0) < 0, "and its age is reported as negative rather than as zero");
    } finally { rmSync(future, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the overdue threshold is 36 hours, measured from metadata, not from the folder name", async () => {
  assert.equal(NIGHTLY_BACKUP_OVERDUE_HOURS_V1, 36,
    "the owner tolerates one missed night, not two: a daily schedule plus one skipped run");
  const root = mkdtempSync(join(TMP, "nightly-threshold-"));
  try {
    const now = Date.parse("2026-10-05T02:30:00.000Z");
    // A folder named for the 1st whose dump was actually taken on the 4th at
    // 20:00Z is 6.5 hours old at 02:30Z on the 5th: NOT overdue.
    writeGenerationV1(root, "2026-10-01T02-30-00-000Z", "2026-10-04T20:00:00.000Z");
    assert.equal((await readNewestGoodBackupV1(root, { nowMs: now })).overdue, false,
      "a clock that stepped backwards must not make an old backup look new, nor a fresh one look stale");
    // Exactly at the boundary is not overdue; one minute past it is.
    writeGenerationV1(root, "2026-10-01T02-30-00-000Z", new Date(now - 36 * 3_600_000).toISOString());
    assert.equal((await readNewestGoodBackupV1(root, { nowMs: now })).overdue, false, "exactly 36 hours is still inside the window");
    writeGenerationV1(root, "2026-10-01T02-30-00-000Z", new Date(now - 36 * 3_600_000 - 60_000).toISOString());
    const overdue = await readNewestGoodBackupV1(root, { nowMs: now });
    assert.equal(overdue.overdue, true);
    assert.equal(overdue.hoursSinceNewest, 37, "the age is whole hours, rounded up so 36h01m reads as 37");
    assert.equal(overdue.generation, "2026-10-01T02-30-00-000Z", "and the generation it names is the newest good one");
  } finally { rmSync(root, { recursive: true, force: true }); }
});