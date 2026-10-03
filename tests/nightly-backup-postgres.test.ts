// The nightly backup's REAL-PostgreSQL lane (R4S-03, R4S-11), plus one
// characterisation test for a privilege gap this lane found rather than caused.
//
// WHAT IS REAL HERE, stated plainly:
//   REAL: a PostgreSQL 17 postmaster, `initdb`, the release migration ledger
//         applied as the production migrator, the production role files, the
//         shipped `pg_dump` binary, the real SERIALIZABLE READ ONLY DEFERRABLE
//         snapshot transaction, the real `pg_export_snapshot` handoff, and every
//         refusal.
//   SIMULATED: the uid (creating a service account needs root, so this lane's
//         logins are this process's uid) and the socket path (the cluster's own
//         short socket directory, symlinked where the install root expects one).
//   ONE PORT IS REWRITTEN: the configuration pins 5432 by design, so only the
//         port is substituted. Nothing else about the chain differs.
//
// The entry runs in a CHILD PROCESS, because the round-4 defect was not in what
// the entry printed — it was in whether the process ever stopped. Asserting on an
// in-process call could not see it at all.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { createFleetReleaseTrustForTestV1 } from "./support/fleet-release.ts";
import { createMacosLaunchDaemonBundleV1, type MacosLaunchDaemonBundleV1 } from "../src/installer/v1/macos-launch-daemon-bundle";
import { createNightlyBackupConfigurationV1 } from "../src/installer/v1/nightly-backup-configuration";
import { NIGHTLY_DUMP_TIMEOUT_MS_V1, backupDatabase } from "../deploy/postgres/backup-database.mjs";

// 59980 is this lane's block, chosen above every other lane's base (59960 is the
// highest already in package.json) so a concurrent lane cannot be fought over.
const PORT = Number(process.env.CONTROL_ROOM_NIGHTLY_BACKUP_PG_PORT ?? 59980);
const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PG = requiresRealPostgres();
const needsPg = () => (PG ? undefined : { skip: realPostgresSkipMessage() });

/** The real pg_dump the install root's `pg-current` symlink resolves to. */
const REAL_PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
/** The real `pg` entry, by path, for modules written outside the repository. */
const PG_ENTRY = createRequire(import.meta.url).resolve("pg");

/**
 * An install root whose shape is production's: the exact protected tree
 * `createNightlyBackupConfigurationV1` names, an owner-only password file, and a
 * `pg-current` link pointing at real pg_dump binaries.
 */
function nightlyInstallRoot(label: string) {
  const root = realpathSync(mkdtempSync(join("/private/tmp", `nightly-backup-${label}-`)));
  const configuration = createNightlyBackupConfigurationV1(root);
  for (const directory of [dirname(configuration.database.passwordFile), dirname(configuration.lockFile),
    configuration.outputRoot, join(root, "pg", "socket"), join(root, "runtime")]) {
    mkdirSync(directory, { recursive: true });
  }
  // `pgBin` in the configuration is `<root>/runtime/pg-current/bin`, so
  // `pg-current` has to resolve to the directory that CONTAINS `bin`. REAL_PG_BIN
  // is that `bin` directory (PG_BIN), so the link points one level above it —
  // which is also production's shape, `runtime/pg-current -> runtime/pg-<version>`.
  symlinkSync(dirname(REAL_PG_BIN), join(root, "runtime", "pg-current"), "dir");
  writeFileSync(join(root, "Protected", "config", "backup.json"), `${JSON.stringify(configuration)}\n`);
  return { root, configuration };
}

type EntryExitV1 = Readonly<{ code: number | null; signal: string | null; msAfterMainReturned: number | null }>;
type EntryOutcomeV1 = Readonly<{ lines: readonly string[]; exited: EntryExitV1 | undefined; hungForMs: number }>;

/**
 * The two grants a FIXED install would carry, and only those two.
 *
 * The nightly backup runs as the service account reading
 * `control_room_migrator`'s password file, and no shipped grant gives that login
 * USAGE on `control_room_queue`, so `pg_dump` refuses the whole database. The
 * last test in this file pins that gap; this helper supplies the narrowest fix
 * so the other tests can exercise a dump that RUNS: USAGE on the schema and
 * SELECT on its tables. No INSERT, UPDATE or DELETE, because a backup login must
 * not be able to write the queue.
 */
async function grantQueueReadToMigratorV1(postgres: RealPostgres) {
  const admin = new Client(postgres.admin({ database: "control_room" }));
  await admin.connect();
  try {
    await admin.query("GRANT USAGE ON SCHEMA control_room_queue TO control_room_schema_owner");
    await admin.query("GRANT SELECT ON ALL TABLES IN SCHEMA control_room_queue TO control_room_schema_owner");
  } finally { await admin.end(); }
}

/**
 * Run the nightly entry AS THE ENTRY, in its own process, the way the launchd
 * StartCalendarInterval job runs it, and report what the PROCESS did.
 *
 * Two things about this helper are load-bearing, and both were got wrong in the
 * first version of this file:
 *
 *  1. It runs the entry MODULE as the entry module, not a child that imports
 *     `mainNightlyBackupV1`. The direct-entry tail — the `process.exit(code)`
 *     R4S-03 added — only runs when `isMainModuleV1` is true, so a child that
 *     imports the function never executes it. The mutation run caught exactly
 *     that: with `process.exit` deleted, the test still passed, because the test
 *     had never been running the line it claimed to cover.
 *
 *     The entry needs its `backup` port overridden, so the port override lives
 *     in a tiny module the entry imports through a runtime-overridable hook —
 *     see `CONTROL_ROOM_NIGHTLY_BACKUP_TEST_HOOK` below — rather than in a
 *     child that replaces the entry.
 *
 *  2. `msAfterMainReturned` is the finding that matters. The round-4 defect
 *     wrote the right line and returned the right code and then stayed alive, so
 *     an assertion on the output alone passes on a hung job.
 */
async function runNightlyEntryV1(root: string, options: Readonly<{
  port: number; socketDirectory: string; password: string; waitMs: number;
  requiredTables?: readonly string[];
  /**
   * A file the child appends one line to every time a database client is ended.
   *
   * `pg_stat_activity` cannot prove the evidence client was ended, and the
   * mutation run found that guard unprotected for exactly this reason: a failed
   * evidence read ABORTS the transaction server-side, so the session is gone
   * either way and the count is zero with or without the `end()`. This records
   * the call itself, which is the only thing the module controls.
   */
  endedMarker?: string;
}>): Promise<EntryOutcomeV1> {
  const configuration = createNightlyBackupConfigurationV1(root);
  writeFileSync(configuration.database.passwordFile, `${options.password}\n`, { mode: 0o600 });
  rmdirSync(join(root, "pg", "socket"));
  symlinkSync(options.socketDirectory, join(root, "pg", "socket"), "dir");

  // The port and the required-table list are the ONLY two things a scratch
  // cluster forces to differ, and both are supplied through a hook module the
  // entry picks up from its environment. The hook is off unless the variable is
  // set, so a production run of this entry takes exactly the path it always did.
  const hook = join(root, `hook-${Math.random().toString(36).slice(2)}.mjs`);
  // `pg` is imported by its RESOLVED path, not by name, and as a DEFAULT import:
  // the hook lives under /private/tmp, which has no node_modules above it, so a
  // bare `import "pg"` cannot resolve; and `pg` is CommonJS, so a named import of
  // `Client` from it throws. The same reason the backup tool is imported by URL.
  writeFileSync(hook, `import { appendFile } from "node:fs/promises";
import pg from ${JSON.stringify(PG_ENTRY)};
import { backupDatabase } from ${JSON.stringify(`file://${REPOSITORY}/deploy/postgres/backup-database.mjs`)};
const marker = ${JSON.stringify(options.endedMarker ?? null)};
// A REAL Client, wrapped only so the end() the module makes is observable.
// The connection, the handshake and the failure are all the production path.
export const backup = configuration => backupDatabase({ ...configuration,
  requiredTables: ${JSON.stringify(options.requiredTables ?? [])},
  source: { ...configuration.source, port: ${options.port} },
  connect: source => {
    const client = new pg.Client(source);
    const realEnd = client.end.bind(client);
    client.end = async () => { if (marker) await appendFile(marker, "end\\n"); await realEnd(); };
    return client;
  } });
`);
  return new Promise(resolve => {
    const proc = spawn(process.execPath,
      ["--import", "tsx", join(REPOSITORY, "src", "installer", "v1", "nightly-backup-entry.ts"),
        "--configuration", join(root, "Protected", "config", "backup.json")],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env,
        CONTROL_ROOM_NIGHTLY_BACKUP_TEST_HOOK: hook } });
    let output = "", returnedAt: number | undefined, exited: EntryExitV1 | undefined;
    // The entry EXITS rather than returning, so there is no "returned" moment to
    // measure from. The last thing it does before exiting is write its one
    // bounded line, and that write is what the process must not delay leaving
    // after: a leaked handle keeps the loop alive for the whole session. So the
    // measurement is "time from the last line to the process being gone".
    // A FAILURE line goes to stderr; a success line goes to stdout. Both are the
    // "last thing this process wrote", and both are followed immediately by its
    // exit, so either one is the right instant to measure the exit from.
    const note = (data: Buffer) => {
      output += data;
      if (returnedAt === undefined && output.includes("nightly database backup")) returnedAt = Date.now();
    };
    proc.stdout.on("data", note);
    proc.stderr.on("data", note);
    proc.on("exit", (code, signal) => { exited = { code, signal, msAfterMainReturned: returnedAt === undefined ? null : Date.now() - returnedAt }; });
    const began = Date.now();
    const poll = setInterval(() => {
      if (exited === undefined && Date.now() - began <= options.waitMs) return;
      clearInterval(poll);
      if (exited === undefined) proc.kill("SIGKILL");
      resolve({ lines: output.trim().split("\n").filter(Boolean), exited,
        hungForMs: exited === undefined ? Date.now() - (returnedAt ?? began) : 0 });
    }, 100);
  });
}

test("R4S-03: a nightly backup that fails while reading the database exits by itself and leaves no session", needsPg(), async () => {
  const result = await withRealPostgres(async postgres => {
    const { root, configuration } = nightlyInstallRoot("r4s03");
    const password = (postgres.connection("migrator") as { password: string }).password;
    try {
      // The failure is a REAL one: the snapshot transaction really runs against
      // the real server and really rejects a table that does not exist, with the
      // client really holding an open session when it does.
      const marker = join(root, "client-ended");
      const outcome = await runNightlyEntryV1(root, { port: postgres.port, socketDirectory: postgres.socketDirectory,
        password, waitMs: 45_000, requiredTables: ["nightly_backup_absent_table"], endedMarker: marker });
      const admin = new Client(postgres.admin({ database: "control_room" }));
      await admin.connect();
      const sessions = (await admin.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()")).rows[0]!.n;
      await admin.end();
      return { outcome, sessions, generations: readdirSync(configuration.outputRoot),
        lockLeft: existsSync(configuration.lockFile),
        endedCalls: existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).length : 0 };
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);
  assert.deepEqual(result.value.outcome.lines,
    ["nightly database backup failed: nightly_backup_execution_failed"],
    "the failure is named on one bounded line");
  assert.ok(result.value.outcome.exited !== undefined,
    "R4S-03: the entry must not wait for the event loop to drain after a database failure");
  assert.equal(result.value.outcome.exited.code, 1, "the failure exits non-zero");
  assert.equal(result.value.outcome.exited.signal, null, "the entry is not killed; it ends by itself");
  // A leaked socket keeps the event loop alive for as long as the session lasts,
  // which is minutes. One second is generous for a process that has already
  // written its line and set its exit code.
  assert.ok(result.value.outcome.exited.msAfterMainReturned !== null,
    "R4S-03: the process must write its one line and then be gone");
  assert.ok(result.value.outcome.exited.msAfterMainReturned < 1000,
    `R4S-03: the process stayed alive ${String(result.value.outcome.exited.msAfterMainReturned)}ms after writing its failure line`);
  assert.equal(result.value.sessions, 0, "R4S-03: a failed backup must leave no session open in the database");
  // The count above is ZERO either way — a failed evidence read aborts the
  // transaction server-side — so it cannot prove the client was ended. The
  // mutation run reported this guard UNPROTECTED for that reason, and it was
  // right. This is the assertion that actually bites.
  assert.ok(result.value.endedCalls >= 1,
    "R4S-03: the evidence client must be ended on the failure path, so no handle outlives the run");
  assert.equal(result.value.lockLeft, false, "the run lock is released on the failure path");
  assert.deepEqual(result.value.generations, [], "the reserved generation folder is removed when the dump fails");
});

test("R4S-03: the entry ends the process even with a handle still open", needsPg(), async () => {
  // The guard the mutation run reported as UNPROTECTED, and the reason it was
  // unprotected is now the subject of its own test.
  //
  // The failed evidence client is ENDED, which releases the leaked database
  // socket — so for THAT failure nothing is left holding the event loop, and
  // deleting the entry's `process.exit(code)` changed nothing observable. That is
  // a true statement about that failure and no guarantee at all about the next
  // one: a handle this process never owned, a driver timer, a pending promise
  // chain, anything the `end()` does not reach.
  //
  // So the exit is proved against a handle that is genuinely still open when
  // `mainNightlyBackupV1` returns: the child opens a real listening socket, and
  // only the entry's own `process.exit` can end the process while it is held.
  const result = await withRealPostgres(async postgres => {
    const { root } = nightlyInstallRoot("r4s03-handle");
    const password = (postgres.connection("migrator") as { password: string }).password;
    const configuration = createNightlyBackupConfigurationV1(root);
    writeFileSync(configuration.database.passwordFile, `${password}\n`, { mode: 0o600 });
    rmdirSync(join(root, "pg", "socket"));
    symlinkSync(postgres.socketDirectory, join(root, "pg", "socket"), "dir");
    const hook = join(root, "handle-hook.mjs");
    // The hook is the lane's only injection point, and it is where the handle
    // is opened: a real listening socket, which the runtime will not drop.
    writeFileSync(hook, `import { createServer } from "node:net";
import { backupDatabase } from ${JSON.stringify(`file://${REPOSITORY}/deploy/postgres/backup-database.mjs`)};
const held = createServer(() => {});
await new Promise(resolve => held.listen(0, "127.0.0.1", resolve));
// A REAL failure, so the entry takes its failure path exactly as it would at
// 02:30 on a night the database could not be read.
export const backup = configuration => backupDatabase({ ...configuration, requiredTables: ["nightly_backup_absent_table"],
  source: { ...configuration.source, port: ${postgres.port} } });
`);
    const began = Date.now();
    const outcome = await new Promise<{ code: number | null; ms: number }>(resolve => {
      const proc = spawn(process.execPath,
        ["--import", "tsx", join(REPOSITORY, "src", "installer", "v1", "nightly-backup-entry.ts"),
          "--configuration", join(root, "Protected", "config", "backup.json")],
        { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CONTROL_ROOM_NIGHTLY_BACKUP_TEST_HOOK: hook } });
      let output = "";
      proc.stdout.on("data", data => { output += data; });
      proc.stderr.on("data", data => { output += data; });
      const poll = setInterval(() => {
        if (proc.exitCode !== null || proc.signalCode !== null || Date.now() - began > 30_000) {
          clearInterval(poll);
          if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
          resolve({ code: proc.exitCode, ms: Date.now() - began });
        }
      }, 100);
    });
    return { outcome };
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);
  // Without the explicit exit this process would wait for the held socket until
  // launchd's ExitTimeOut SIGKILLed it. Five seconds is generous for a process
  // that has already printed its failure line.
  assert.ok(result.value.outcome.ms < 5_000,
    `R4S-03: with a handle still open the entry took ${result.value.outcome.ms}ms to exit; the explicit process.exit is what ends it`);
});

test("R4S-11: the dump deadline is sized for a real database, and the nightly job is given room to finish it", () => {
  // The LIMIT is a product decision, and it is asserted here without a cluster
  // because waiting out 45 minutes is not something a lane can do.
  //
  // What is asserted is that the ceiling is (a) far above what 120 s could
  // manage, and (b) NOT larger than the launchd `ExitTimeOut` the nightly job is
  // actually installed with.
  //
  // (b) is not a formality, and this is the correction the lane forced. My
  // first version of this comment claimed 45 minutes "fits inside the window
  // launchd will wait for", which was wrong: the nightly job was installed with
  // `exitTimeOut: 120`, and launchd's `ExitTimeOut` is how long it waits AFTER
  // SIGTERM before sending SIGKILL. A limit ABOVE that budget means a dump that
  // legitimately runs long is killed by launchd at 120 s, silently, with no
  // line in the log — the exact failure R4S-11 is about, reintroduced one layer
  // up. The job's timeout is now DERIVED from the limit, and this test builds
  // the real bundle through the real factory to read the real plist, so the
  // relationship is asserted against what ships rather than against a constant.
  assert.ok(NIGHTLY_DUMP_TIMEOUT_MS_V1 >= 30 * 60_000,
    `R4S-11: ${NIGHTLY_DUMP_TIMEOUT_MS_V1}ms is still too short for a real dump`);
  const generated = createMacosLaunchDaemonBundleV1({
    installRoot: "/opt/control-room-nightly-backup-proof",
    accounts: JSON.parse(readFileSync(join(REPOSITORY, "src/updater/v1/policy/accounts.json"), "utf8")),
    postgresExecutable: "/opt/control-room-nightly-backup-proof/runtime/pg-current/bin/postgres",
    // The gateway block is required by the bundle's strict parser, so this
    // test builds the same shape the bundle's own lane builds rather than a
    // thinner one that would fail on Zod before reaching the assertion.
    fleetGateway: {
      tenantId: "tenant:nightly-backup-proof",
      database: { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_fleet",
        password: "fixture-fleet-password", majorVersion: 17 },
      workIntakeDatabase: { host: "127.0.0.1", port: 5432, database: "control_room",
        username: "control_room_work_intake_agent", password: "fixture-intake-password", majorVersion: 17 },
      workIntakeIntegrityKey: Buffer.alloc(32, 7).toString("base64url"),
      harnessIntegrityKey: Buffer.alloc(32, 9).toString("base64url"),
      releaseTrust: createFleetReleaseTrustForTestV1().trust,
    },
  });
  const plistOf = (generated: MacosLaunchDaemonBundleV1, role: string) => generated.resources.find(resource =>
    resource.kind === "launchd_plist" && resource.path.endsWith(`.${role}.plist`))!.contents;
  const exitTimeOut = Number(/<key>ExitTimeOut<\/key>\s*<integer>(\d+)<\/integer>/u.exec(plistOf(generated, "nightly-backup"))![1]);
  assert.ok(Number.isSafeInteger(exitTimeOut) && exitTimeOut > 0, "the nightly plist carries a real ExitTimeOut");
  assert.ok(NIGHTLY_DUMP_TIMEOUT_MS_V1 < exitTimeOut * 1000,
    `R4S-11: a ${NIGHTLY_DUMP_TIMEOUT_MS_V1}ms dump outlives the nightly job's ${exitTimeOut}s ExitTimeOut, so launchd would SIGKILL a legitimate long dump with nothing in the log`);
});

test("R4S-11: a dump that is still working when its deadline arrives is killed and named", needsPg(), async () => {
  // This is the only test that can reach the deadline branch without waiting 45
  // minutes, and it reaches it through the ONE thing that changes: the deadline
  // handed to `execFile`. Everything else is the real module, the real pg_dump,
  // the real snapshot transaction and the real server.
  //
  // `dumpTimeoutMs` is a parameter rather than a test hook: it is how an
  // operator backup run sizes a deadline for a database of a known size, and the
  // production default is the constant the launch-daemon bundle derives its
  // `ExitTimeOut` from. The value below is 1500 ms, which a real dump of this
  // database cannot meet, so the branch under test is the one production hits
  // on a dump that is still working.
  const result = await withRealPostgres(async postgres => {
    const { root } = nightlyInstallRoot("r4s11-deadline");
    const password = (postgres.connection("migrator") as { password: string }).password;
    rmdirSync(join(root, "pg", "socket"));
    symlinkSync(postgres.socketDirectory, join(root, "pg", "socket"), "dir");
    // The queue privileges a FIXED install would carry. Without them the dump
    // refuses in milliseconds on the queue schema and the deadline is never
    // reached, which is the gap the last test in this file characterises. They
    // are granted here explicitly, and only SELECT, so pg_dump can read the
    // queue and nothing else about it.
    await grantQueueReadToMigratorV1(postgres);
    // The blocker takes its lock as the cluster superuser, because the shipped
    // grants give the migrator no privilege on the queue tables at all — which
    // is the very gap the last test in this file characterises. A blocker that
    // cannot lock the table it is meant to lock would make this test vacuous.
    const blocker = new Client(postgres.admin({ database: "control_room" }));
    await blocker.connect();
    try {
      // The lock is what makes pg_dump WAIT rather than fail fast, and WHICH
      // table it takes is the whole test.
      //
      // `control_room_queue.job`, not a `public` table. The evidence
      // transaction's schema-digest query reads `pg_trigger` for every table in
      // `public`, so a lock on any of those blocks the EVIDENCE read (that is
      // the sibling test below). `control_room_queue` is outside that catalog
      // query entirely, so the snapshot completes and pg_dump itself is the
      // thing that waits for the lock — which is precisely the case the product's
      // dump deadline governs, and the only way to reach it.
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE control_room_queue.job IN ACCESS EXCLUSIVE MODE");
      const began = Date.now();
      const error = await backupDatabase({
        source: { host: join(root, "pg", "socket"), port: postgres.port, database: "control_room",
          user: "control_room_migrator", password },
        out: join(root, "out"), pgBin: join(root, "runtime", "pg-current", "bin"),
        ledgerDigest: `sha256:${"a".repeat(64)}`, requiredTables: [], release: "nightly-backup-pg",
        dumpTimeoutMs: 1500,
      }).then(() => null, (thrown: unknown) => thrown);
      return { message: error === null ? null : String((error as Error).message).split("\n")[0]!,
        elapsed: Date.now() - began };
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);
  assert.ok(result.value.message !== null, "a dump stopped by its deadline must refuse rather than report success");
  // The guard R4S-11 added: the deadline is DETECTED and the refusal names it,
  // instead of the owner seeing an unbounded "Command failed: pg_dump" line.
  assert.equal(result.value.message, "nightly_backup_dump_timeout:1500",
    `a dump stopped by its deadline must be refused BY NAME: ${String(result.value.message)}`);
  assert.ok(result.value.elapsed >= 1500,
    `the deadline must actually have been reached, dump gave up after ${result.value.elapsed}ms`);
  assert.ok(result.value.elapsed < 60_000,
    `R4S-11: the dump must be bounded by its deadline, gave up after ${result.value.elapsed}ms`);
});

test("R4S-11: the evidence transaction is bounded too, not only the dump", needsPg(), async () => {
  // The half of R4S-11 that the report did not reach, and the one this lane
  // found: the pg_dump deadline bounds the DUMP, and the evidence transaction
  // that precedes it had no deadline at all. Its schema-digest catalog query
  // reads `pg_trigger` for every table in `public`, so locking ANY table in the
  // schema blocks it — MEASURED at 199,990 ms with no error and no timeout,
  // because a plain SELECT waits on a lock indefinitely.
  //
  // The consequence in production is worse than a slow backup: the nightly job's
  // `ExitTimeOut` SIGKILLs a job that never reached its dump deadline and wrote
  // nothing at all. The same silent-failure shape as R4S-03, a different cause.
  //
  // `evidenceTimeoutMs` is the product's bound on that transaction, and this
  // test sets it to something a lane can wait for. What is asserted is that the
  // backup REFINES, and in bounded time, where before it waited for a lock.
  const result = await withRealPostgres(async postgres => {
    const { root } = nightlyInstallRoot("r4s11-evidence");
    const password = (postgres.connection("migrator") as { password: string }).password;
    rmdirSync(join(root, "pg", "socket"));
    symlinkSync(postgres.socketDirectory, join(root, "pg", "socket"), "dir");
    const blocker = new Client(postgres.connection("migrator"));
    await blocker.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE public.control_web_sessions IN ACCESS EXCLUSIVE MODE");
      const began = Date.now();
      const error = await backupDatabase({
        source: { host: join(root, "pg", "socket"), port: postgres.port, database: "control_room",
          user: "control_room_migrator", password },
        out: join(root, "out"), pgBin: join(root, "runtime", "pg-current", "bin"),
        ledgerDigest: `sha256:${"a".repeat(64)}`, requiredTables: [], release: "nightly-backup-pg",
        evidenceTimeoutMs: 1500,
      }).then(() => null, (thrown: unknown) => thrown);
      return { code: (error as { code?: string } | null)?.code ?? null,
        message: error === null ? null : String((error as Error).message).split("\n")[0]!,
        elapsed: Date.now() - began };
    } finally {
      await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);
  assert.ok(result.value.message !== null, "a blocked evidence read must refuse rather than hang");
  // `55P03` is `lock_not_available`, raised by `lock_timeout`; `57014` is
  // `query_canceled`, raised by `statement_timeout`. Either is a refusal that
  // names its cause; what must not happen is an unbounded wait.
  assert.ok(result.value.code === "55P03" || result.value.code === "57014",
    `a blocked evidence read must fail with a lock/statement timeout, got ${result.value.code}: ${String(result.value.message)}`);
  assert.ok(result.value.elapsed >= 1500,
    `the evidence deadline must actually have been reached, gave up after ${result.value.elapsed}ms`);
  assert.ok(result.value.elapsed < 30_000,
    `R4S-11: the evidence transaction must be bounded by its own deadline, gave up after ${result.value.elapsed}ms`);
});

test("the migrator can read, and only read, the queue schema the backup has to dump", needsPg(), async () => {
  // CHARACTERISATION, not a fix. Building this lane surfaced a privilege gap the
  // round-4 report did not name: the nightly backup runs as the service account
  // reading `control_room_migrator`'s password file, and no shipped grant gives
  // that login USAGE on `control_room_queue`, so `pg_dump` refuses the whole
  // database with `permission denied for schema control_room_queue`.
  //
  // This asserts the CURRENT state so the gap cannot become invisible. It is the
  // one assertion here that is EXPECTED to fail when someone fixes the grant, and
  // its message says to update this test rather than to be alarmed by it.
  const result = await withRealPostgres(async postgres => {
    // The CATALOG is asked as the cluster superuser, and the ANSWER is about the
    // migrator. Asking the migrator itself cannot work: `has_table_privilege`
    // on a table in a schema it has no USAGE on raises 42501, which is the very
    // refusal this test exists to characterise.
    const admin = new Client(postgres.admin({ database: "control_room" }));
    await admin.connect();
    try {
      return await admin.query(
        `SELECT has_schema_privilege('control_room_migrator', 'control_room_queue', 'USAGE') AS queue_usage,
                has_schema_privilege('control_room_migrator', 'control_room_queue', 'CREATE') AS queue_create,
                has_table_privilege('control_room_migrator', 'control_room_queue.job', 'SELECT') AS job_select,
                has_table_privilege('control_room_migrator', 'control_room_queue.job', 'INSERT,UPDATE,DELETE,TRUNCATE') AS job_write,
                has_table_privilege('control_room_migrator', 'public.tenants', 'SELECT') AS tenants_select`
      ).then(rows => rows.rows[0]!);
    } finally { await admin.end(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);
  assert.equal(result.value.tenants_select, true, "the migrator can read the public schema the backup needs");
  // UPDATED in int10, as this test asked: r5bk's 0285 (queue backup read, lead decision
  // D11) gives the backup login USAGE on control_room_queue so pg_dump can dump it.
  // The gap this test characterised is closed; it now pins the fix.
  assert.equal(result.value.queue_usage, true,
    "the migrator holds USAGE on control_room_queue, so the nightly backup can dump it (0285)");
  // The fix is a READ grant (D11: adopt r5bk's positive read and negative write
  // checks): pg_dump reads the queue rows, and nothing else is granted.
  assert.equal(result.value.job_select, true, "the dump can read the queue rows it has to copy");
  assert.equal(result.value.job_write, false, "and the backup login cannot change a queue row");
  assert.equal(result.value.queue_create, false, "or create anything in the queue schema");
});
