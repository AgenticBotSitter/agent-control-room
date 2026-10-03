// R4B-08 and R4B-09 on REAL PostgreSQL, as the production login.
//
//   R4B-08 — an early evidence-query failure leaving sessions open.
//   R4B-09 — an interrupted restore the SAME command refuses on retry.
//
// The round-4 report could only model both, with fake pg clients and a shell
// file standing in for pg_restore. This lane asks the real server instead, and
// both assertions are about what the DATABASE observed rather than about what a
// stub recorded.
//
// WHAT IS REAL HERE, stated plainly:
//   REAL: a PostgreSQL 17 postmaster, `initdb`, the release migration ledger
//         applied as the production migrator, the production role files, the
//         shipped `pg_dump` and `pg_restore`, the real snapshot transaction,
//         the real role/grant reconciliation, the real identity verification,
//         and every refusal.
//   SIMULATED: the uid (creating a service account needs root, so this lane's
//         logins are this process's uid) and the socket path.
//
// It sits in the same lane as `tests/nightly-backup-postgres.test.ts` and uses
// the same assigned port, because it is the same database and the same login.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { backupDatabase } from "../deploy/postgres/backup-database.mjs";
import { restoreDatabase } from "../deploy/postgres/restore-database.mjs";
import { readBoundMacLocalDatabaseBackupV1 } from "../scripts/ops/verify-database-backup.mjs";

const PORT = Number(process.env.CONTROL_ROOM_NIGHTLY_BACKUP_PG_PORT ?? 59980);
const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PG = requiresRealPostgres();
const needsPg = () => (PG ? undefined : { skip: realPostgresSkipMessage() });
const REAL_PG_BIN = process.env.PG_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";

const ledgerDigest = () => `sha256:${JSON.parse(readFileSync(join(REPOSITORY, "deploy/postgres/migration-ledger.json"), "utf8")).digest}`;

function nightlyInstallRoot(label: string) {
  const root = mkdtempSync("/private/tmp/nightly-backup-r4b-");
  mkdirSync(join(root, "pg"), { recursive: true });
  mkdirSync(join(root, "runtime"), { recursive: true });
  mkdirSync(join(root, "pg", "socket"), { recursive: true });
  symlinkSync(dirname(REAL_PG_BIN), join(root, "runtime", "pg-current"), "dir");
  return root;
}

const publicTables = async (client: Client) => (await client.query(
  "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'")).rows[0]!.n;

test("R4B-08: a failed evidence read leaves no session open, at one caller or at fifty", needsPg(), async () => {
  // The model's claim was "50 connected fake clients and zero calls to end".
  // The real question is the same one the real server can answer: after a burst
  // of backups whose evidence read really fails, are there any sessions left in
  // pg_stat_activity?
  //
  // `application_name` is how this counts ONLY its own sessions. A blanket
  // `count(*)` would be dominated by the lane's own clients and would prove
  // nothing about a leak.
  const result = await withRealPostgres(async postgres => {
    const root = nightlyInstallRoot("r4b08");
    const applicationName = "bk4_r4b08_probe";
    const target = { ...postgres.connection("migrator"),
      host: postgres.socketDirectory, application_name: applicationName };
    try {
      const monitor = new Client({ ...target, application_name: `${applicationName}_monitor` });
      await monitor.connect();
      try {
        const login = (await monitor.query(
          "SELECT current_user AS login, rolsuper FROM pg_roles WHERE rolname = current_user")).rows[0]!;
        assert.equal(login.login, "control_room_migrator", "the probe runs as the production backup login");
        assert.equal(login.rolsuper, false, "and not as a superuser");
        // The failure is a REAL one and a real one only: a required table that
        // does not exist. The evidence transaction opens, queries, and is
        // rejected by the server with the client holding a live session.
        assert.equal((await monitor.query("SELECT to_regclass($1) AS r",
          ["public.bk4_r4b08_absent"])).rows[0]!.r, null, "the deliberately missing relation is absent");
        const count = async (name: string) => (await monitor.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1", [name])).rows[0]!.n;

        const before = await count(applicationName);
        const results = await Promise.allSettled(Array.from({ length: 50 }, () => backupDatabase({
          source: target, out: join(root, "out"), pgBin: join(root, "runtime", "pg-current", "bin"),
          ledgerDigest: ledgerDigest(), requiredTables: ["bk4_r4b08_absent"], release: "r4b08-probe",
        })));
        const after = await count(applicationName);

        // A CONNECT failure, which is the branch the R4S-03 fix cannot cover:
        // `collect()` never ran, so nothing could have ended a client.
        // int10: the kit's local socket is `--auth-local=trust`, so a wrong PASSWORD
        // connects anyway; this call used to fail only because the migrator could not
        // dump the queue schema, which r5bk's 0285 now allows. A login that does not
        // exist is refused at connect under any auth method.
        const wrongPassword = { ...target, user: "bk4_r4b08_no_such_login", password: `${String(target.password)}-wrong` };
        const connectFailure = await backupDatabase({
          source: wrongPassword, out: join(root, "out-bad"), pgBin: join(root, "runtime", "pg-current", "bin"),
          ledgerDigest: ledgerDigest(), requiredTables: [],
        }).then(() => null, (error: unknown) => String((error as Error).message).split("\n")[0]!);
        const badConnectSessions = await count(`${applicationName}_badconnect`);

        return { rejected: results.filter(r => r.status === "rejected").length,
          resolved: results.filter(r => r.status === "fulfilled").length,
          before, after, connectFailure, badConnectSessions };
      } finally { await monitor.end(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);
  assert.equal(result.value.rejected, 50,
    "every call really did fail: the probe is measuring the failure path, not a success path");
  assert.equal(result.value.resolved, 0, "and none of them claimed a backup");
  assert.equal(result.value.after, result.value.before,
    `R4B-08: fifty failed evidence reads left ${result.value.after - result.value.before} sessions open in the real server`);
  assert.ok(result.value.connectFailure !== null, "a connect failure still refuses rather than reporting success");
  assert.equal(result.value.badConnectSessions, 0,
    "R4B-08: a connect failure leaves no session either, because the server never grants one");
});

test("R4B-09: an interrupted restore leaves a target the same command refuses, and says how to recover", needsPg(), async () => {
  // What the report asked for, read carefully: "validate the outer binding
  // before target effects and document/use a fresh owned scratch target after
  // failure, or journal ownership of a scratch restore and implement a safe
  // explicit restart. Preserve refusal for unrelated nonempty targets."
  //
  // So the NONEMPTY refusal itself is NOT the finding and is not being weakened
  // — an unrelated database must still be refused. The findings are:
  //
  //   (a) the outer binding was not validated before the target was touched, so
  //       a damaged dump reached `pg_restore` and left the target dirty; and
  //   (b) an interruption left the operator with a refusal and no way forward.
  //
  // Both are asserted here, on a real cluster, with a real `pg_restore`.
  const result = await withRealPostgres(async postgres => {
    const root = nightlyInstallRoot("r4b09");
    const source = { ...postgres.connection("migrator"), host: postgres.socketDirectory };
    // A disposable target, separate from the lane's own `control_room`.
    //
    // OWNED BY THE MIGRATOR, which is what makes the interrupted-restore case
    // reachable at all. `CREATE DATABASE` defaults the owner to the creating
    // role, so a target created without this is owned by the superuser and the
    // production login cannot connect to it at all — which is what the first
    // version of this probe hit, and it is worth stating rather than hiding:
    // `pg_restore: permission denied for database bk4_r4b09_target` happens
    // BEFORE any table is created, so it silently makes the interruption
    // unobservable. Owner-granting is also the realistic shape: an operator
    // provisions a disposable restore target for the backup login.
    const admin = new Client(postgres.admin({ database: "postgres" }));
    await admin.connect();
    try {
      await admin.query("DROP DATABASE IF EXISTS bk4_r4b09_target");
      await admin.query("CREATE DATABASE bk4_r4b09_target OWNER control_room_migrator");
      await admin.query("GRANT ALL ON DATABASE bk4_r4b09_target TO control_room_schema_owner");
      // PostgreSQL 15+ gives `public` no CREATE to non-owners, so `pg_restore`
      // cannot create the first table without this. It is the same grant the
      // production provisioning gives a restore target, and its absence shows up
      // as `permission denied for schema public` AFTER the schema statements,
      // which is exactly the kind of mid-restore failure this probe is about.
      await admin.query(`GRANT ALL ON SCHEMA public TO control_room_schema_owner`);
      await admin.query(`GRANT ALL ON SCHEMA public TO control_room_migrator`);
    }
    finally { await admin.end(); }
    const target = { ...postgres.connection("migrator"), host: postgres.socketDirectory,
      database: "bk4_r4b09_target" };
    const grantQueue = postgres.admin({ database: "control_room" });
    const grant = new Client(grantQueue);
    await grant.connect();
    try {
      await grant.query("GRANT USAGE ON SCHEMA control_room_queue TO control_room_schema_owner");
      await grant.query("GRANT SELECT ON ALL TABLES IN SCHEMA control_room_queue TO control_room_schema_owner");
    } finally { await grant.end(); }
    try {
      // A REAL backup, made by the production tool.
      const good = join(root, "good");
      await backupDatabase({ source, out: good, pgBin: join(root, "runtime", "pg-current", "bin"),
        ledgerDigest: ledgerDigest(), requiredTables: [], release: "r4b09-probe" });

      // (a) A DAMAGED dump. Before the fix this ran the tool's role creation and
      // its REVOKE TEMPORARY against the TARGET, and only then invoked
      // pg_restore. Now the outer binding is read first and refused.
      const damaged = join(root, "damaged");
      await backupDatabase({ source, out: damaged, pgBin: join(root, "runtime", "pg-current", "bin"),
        ledgerDigest: ledgerDigest(), requiredTables: [], release: "r4b09-probe" });
      const manifest = JSON.parse(readFileSync(join(damaged, "manifest.json"), "utf8"));
      writeFileSync(join(damaged, "database.dump"), "X");
      const verifierOnDamaged = await readBoundMacLocalDatabaseBackupV1(damaged)
        .then(() => null, (error: Error) => error.message);
      const targetClient = new Client(target);
      await targetClient.connect();
      let tablesAfterDamaged: number, damagedError: string | null;
      try {
        tablesAfterDamaged = await publicTables(targetClient);
        damagedError = await restoreDatabase({ backup: damaged, target, confirmTarget: { ...target },
          pgBin: join(root, "runtime", "pg-current", "bin"), requiredTables: [] })
          .then(() => null, (error: Error) => error.message);
        tablesAfterDamaged = await publicTables(targetClient);
      } finally { await targetClient.end(); }

      // (b) An INTERRUPTED restore of a GOOD backup: real `pg_restore`, allowed
      // to run only the pre-data section, then stopped by a wrapper that exits
      // non-zero after it — exactly the "the process died mid-restore" case.
      const interruptedBin = join(root, "interrupted-bin");
      mkdirSync(interruptedBin, { recursive: true });
      writeFileSync(join(interruptedBin, "pg_restore"),
        `#!/bin/sh\n${JSON.stringify(join(REAL_PG_BIN, "pg_restore"))} --section=pre-data "$@"\nexit 1\n`, { mode: 0o700 });
      const targetClient2 = new Client(target);
      await targetClient2.connect();
      let afterInterrupt: number, retry: string | null, beforeInterrupt: number;
      try {
        beforeInterrupt = await publicTables(targetClient2);
        const first = await restoreDatabase({ backup: good, target, confirmTarget: { ...target },
          pgBin: interruptedBin, requiredTables: [] }).then(() => null, (error: Error) => error.message);
        afterInterrupt = await publicTables(targetClient2);
        // The operator's obvious next move: run the SAME command again, with the
        // REAL binary, against the same target.
        retry = await restoreDatabase({ backup: good, target, confirmTarget: { ...target },
          pgBin: join(root, "runtime", "pg-current", "bin"), requiredTables: [] })
          .then(() => "completed", (error: Error) => error.message);
        return { manifestSchema: manifest.schema, verifierOnDamaged, damagedError, tablesAfterDamaged,
          first, beforeInterrupt, afterInterrupt, retry };
      } finally { await targetClient2.end(); }
    } finally {
      rmSync(root, { recursive: true, force: true });
      const drop = new Client(postgres.admin({ database: "postgres" }));
      await drop.connect();
      try { await drop.query("DROP DATABASE IF EXISTS bk4_r4b09_target"); } finally { await drop.end(); }
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);

  // (a) The damaged dump is refused by the BINDING READER, which is what the
  // documented verifier uses, and the restore refuses it before any target
  // effect — the target still has zero tables.
  assert.equal(result.value.verifierOnDamaged, "database_backup_digest_refused",
    "a dump altered after its manifest was written is refused by the documented binding reader");
  assert.equal(result.value.damagedError, "restore_refused_damaged_dump",
    `R4B-09: a damaged dump must be refused BY NAME before any target effect, got ${String(result.value.damagedError)}`);
  assert.equal(result.value.tablesAfterDamaged, 0,
    "R4B-09: a damaged dump must not create, grant or revoke anything on the target");

  // (b) The interrupted restore really did leave tables behind, and the same
  // command really does refuse the target it left. That refusal is CORRECT and is
  // not being weakened — what is asserted is that the refusal now CARRIES THE
  // RECOVERY PATH, so the operator is not left holding a half-restored database
  // and no instruction.
  assert.ok(result.value.afterInterrupt > result.value.beforeInterrupt,
    `the interruption really did leave tables behind (${result.value.beforeInterrupt} -> ${result.value.afterInterrupt})`);
  assert.equal(result.value.retry, "restore_refused_nonempty_target:bk4_r4b09_target",
    `R4B-09: the retry must refuse AND name the recovery path; got ${String(result.value.retry)}`);
});

test("R4B-09: the nonempty refusal is still the refusal for an unrelated target", needsPg(), async () => {
  // The counterweight, and the guard against "fixing" R4B-09 by weakening the
  // refusal: a database this tool has never touched is still refused, and now
  // says what to do about it.
  const result = await withRealPostgres(async postgres => {
    const root = nightlyInstallRoot("r4b09-refusal");
    const source = { ...postgres.connection("migrator"), host: postgres.socketDirectory };
    try {
      const grant = new Client(postgres.admin({ database: "control_room" }));
      await grant.connect();
      try {
        await grant.query("GRANT USAGE ON SCHEMA control_room_queue TO control_room_schema_owner");
        await grant.query("GRANT SELECT ON ALL TABLES IN SCHEMA control_room_queue TO control_room_schema_owner");
      } finally { await grant.end(); }
      const out = join(root, "good");
      await backupDatabase({ source, out, pgBin: join(root, "runtime", "pg-current", "bin"),
        ledgerDigest: ledgerDigest(), requiredTables: [], release: "r4b09-refusal" });
      // The lane's OWN `control_room`, which holds the migrated schema and was
      // never restored into by this tool.
      const live = { ...postgres.connection("migrator"), host: postgres.socketDirectory,
        database: "control_room" };
      const message = await restoreDatabase({ backup: out, target: live, confirmTarget: { ...live },
        pgBin: join(root, "runtime", "pg-current", "bin"), requiredTables: [] })
        .then(() => null, (error: Error) => error.message);
      const tables = new Client(live);
      await tables.connect();
      try { return { message, tables: await publicTables(tables) }; }
      finally { await tables.end(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);
  assert.equal(result.value.message, "restore_refused_nonempty_target:control_room",
    "an unrelated nonempty target is still refused, and now names the recovery path");
  assert.ok(result.value.tables > 0, "and the refusal really did leave the target alone rather than emptying it");
});
test("R4B-10: a manifest can only be written over output that is really there", needsPg(), async () => {
  // The guard that failed its mutation run twice, and both times the mutation
  // was lying rather than the guard being dead.
  //
  // First attempt: the manifest's read was removed. Nothing failed, because
  // nothing had ever produced a generation without a metadata file --
  // `backupDatabase` writes it itself, one line above the check.
  //
  // Second attempt: the lstat loop that proves the dump exists, is a regular
  // file and is nonempty was neutered. It did not parse (TypeScript syntax in a
  // .mjs file), so the mutation was reported as a parse failure rather than a
  // surviving one. Once it parsed, it still caught nothing -- and MEASURED on the
  // real cluster, it cannot: `backupDatabase` writes `metadata.json` itself, so
  // by the time the loop runs, metadata is always there. The only reachable
  // case is the DUMP: pg_dump is a subprocess, so a failure or a zero-byte exit
  // leaves `database.dump` absent or empty.
  //
  // So that is what this makes happen, with a real pg_dump replaced by a
  // stand-in that writes nothing.
  const result = await withRealPostgres(async postgres => {
    const root = nightlyInstallRoot("r4b10-output");
    const source = { ...postgres.connection("migrator"), host: postgres.socketDirectory };
    try {
      const grant = new Client(postgres.admin({ database: "control_room" }));
      await grant.connect();
      try {
        await grant.query("GRANT USAGE ON SCHEMA control_room_queue TO control_room_schema_owner");
        await grant.query("GRANT SELECT ON ALL TABLES IN SCHEMA control_room_queue TO control_room_schema_owner");
      } finally { await grant.end(); }
      const pgBin = join(root, "empty-dump-bin");
      mkdirSync(pgBin, { recursive: true });
      // A real pg_dump stand-in: it is invoked for real, with the real
      // arguments, and writes no file at all -- a full disk, a quota, a crash.
      writeFileSync(join(pgBin, "pg_dump"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const out = join(root, "no-dump");
      const message = await backupDatabase({ source, out, pgBin,
        ledgerDigest: ledgerDigest(), requiredTables: [], release: "r4b10-output" })
        .then(() => null, (error: Error) => error.message.split("\n")[0]!);
      // And the complete case, for the control: the same tool against the real
      // pg_dump really does publish all three files.
      const complete = join(root, "complete");
      await backupDatabase({ source, out: complete, pgBin: join(root, "runtime", "pg-current", "bin"),
        ledgerDigest: ledgerDigest(), requiredTables: [], release: "r4b10-output" });
      return { message,
        dumpLeft: existsSync(join(out, "database.dump")),
        manifestLeft: existsSync(join(out, "manifest.json")),
        completeFiles: existsSync(join(complete, "manifest.json")) };
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 300_000 });

  assert.equal(result.cleanedUp, true, `cluster teardown left ${JSON.stringify(result.leftovers)}`);
  assert.equal(result.value.completeFiles, true, "a complete backup really does publish its manifest");
  assert.equal(result.value.message, "backup_refused_incomplete_output",
    `R4B-10: a dump that is not there is refused before a manifest can claim to bind it; got ${String(result.value.message)}`);
  assert.equal(result.value.manifestLeft, false,
    "and no manifest is left claiming a binding for bytes that were never written");
  assert.equal(result.value.dumpLeft, false, "which is what the stand-in pg_dump did");
});

/**
 * A TCP server that accepts and then never speaks PostgreSQL.
 *
 * This is a WEDGED database: the socket is granted, the startup handshake never
 * completes, and `connect()` eventually times out. It is what a PostgreSQL
 * stopped on a full disk, or blocked in recovery, looks like to a client, and it
 * is the only shape that exercises the connect-failure path against a real wire.
 */
async function wedgedPostgres(): Promise<{
  port: number; accepted: () => number; close: () => Promise<void>;
}> {
  const sockets: Socket[] = [];
  const server = createServer(socket => { sockets.push(socket); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    accepted: () => sockets.length,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

test("R4B-08: a connection that never completes its handshake ends the client it created", needsPg(), async () => {
  // Real TCP, real `node-postgres`, real `backupDatabase`, real timeout. Only the
  // database is not real — and it is WEDGED rather than fake, which is the case
  // this guard is for.
  //
  // What is asserted is a CALL, and the comment says why that is the only thing
  // available. MEASURED against a wedged server: `node-postgres` destroys its
  // own stream when `connect()` rejects whether or not this module calls
  // `end()`, so the client's handle, the peer socket count, and `pg_stat_activity`
  // are all identical with and without the guard. A test written against any of
  // them passes with the guard deleted — which is exactly what the mutation run
  // reported, twice, and what this file's first attempt at it got wrong.
  //
  // So the observation is whether the module ended the client it made. The
  // `connect` seam exists for that and is used nowhere else; production passes
  // nothing and gets `connectTarget`.
  const wedged = await wedgedPostgres();
  const scratch = mkdtempSync("/private/tmp/r4b08-wedged-");
  const calls: string[] = [];
  try {
    const error = await backupDatabase({
      source: { host: "127.0.0.1", port: wedged.port, user: "control_room_migrator",
        database: "control_room", password: "fixture-only", connectionTimeoutMillis: 500 },
      out: join(scratch, "out"),
      pgBin: "/nonexistent", ledgerDigest: ledgerDigest(), requiredTables: [],
      // A REAL `Client` — the driver, not a stand-in — wrapped only so the
      // `end()` this module makes is observable.
      connect: source => {
        const client = new Client(source as never);
        const realEnd = client.end.bind(client);
        client.end = async () => { calls.push("end"); await realEnd(); };
        return client;
      },
    }).then(() => null, (thrown: unknown) => thrown);
    assert.ok(error !== null, "a handshake that never completes must refuse rather than report a backup");
    assert.equal(wedged.accepted(), 1,
      "the wedged server really did accept the connection, so this exercised the handshake-timeout path and not an early refusal");
    assert.deepEqual(calls, ["end"],
      "R4B-08: a rejected connection must still end the client it created, so no handle outlives the run");
  } finally {
    await wedged.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});
