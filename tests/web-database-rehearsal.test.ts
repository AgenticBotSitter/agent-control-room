import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { createInjectedPrivateDatabaseRehearsal, createNativePrivateDatabaseRehearsal, rehearsalScopeDigest,
  type RehearsalInput } from "../src/web/v1/private-database-rehearsal";
import { boundPrivateDatabase, PrivateDatabaseError } from "../src/web/v1/bounded-database";
import { limitedWebFixture } from "./helpers/web-startup";
import { now, token, trust } from "./helpers/web-foundation";
import { webIdeaKey } from "./helpers/web-idea-project";
import { webConnectionKeys } from "./helpers/web-connection";
import { recordedProbeFixture } from "./helpers/web-rehearsal-probes";

function input(): RehearsalInput {
  const manifest = { commit: "1".repeat(40), tree: "2".repeat(40), artifactDigest: "3".repeat(64) };
  const database = { host: "127.0.0.1" as const, port: 5432, database: "cr14b_rehearsal_test", username: "web_test", password: "synthetic-private-password", majorVersion: 17 as const };
  return { manifest, database, material: { assertion: token(), keys: trust.keys, ideaIntegrityKey: webIdeaKey,
    ...webConnectionKeys }, packet: { manifest, scopeDigest: rehearsalScopeDigest(database), preparationDigest: "4".repeat(64),
    ownerApprovalDigest: "5".repeat(64), cleanupPlanDigest: "6".repeat(64), pgPackageDigest: "7".repeat(64), pgVersionNumber: 170005,
    expiresAt: now + 900_000, durationMs: 60_000, dedicatedSyntheticDatabase: true, sameHostPrivatePrimary: true, setupAccepted: true,
    connectionPools: 2, maxWebConnections: 8, validationSessions: 2, physicalListener: false, automaticRetry: false,
    cleanup: "close_owned_connections_then_operator_database_cleanup" } };
}

test("incomplete/mismatched/expired packets consume no pool/probe/SQL attempts and cannot retry", async () => {
  const initial = input(); const patches = [
    { packet: { ...initial.packet, preparationDigest: "" } }, { packet: { ...initial.packet, physicalListener: true } },
    { packet: { ...initial.packet, durationMs: 900001 } }, { packet: { ...initial.packet, expiresAt: now } },
    { packet: { ...initial.packet, scopeDigest: "a".repeat(64) } }, { manifest: { ...initial.manifest, tree: "a".repeat(40) } },
    { database: { ...initial.database, host: "192.0.2.1" } }, { database: { ...initial.database, database: "production" } },
    { material: { ...initial.material, assertion: token({ sub: "someone-else" }) } },
    { material: { ...initial.material, assertion: token({ exp: now / 1000 + 30 }) } },
    { signal: AbortSignal.abort() },
  ];
  for (const patch of patches) {
    let effects = 0;
    const runner = createInjectedPrivateDatabaseRehearsal({ clock: () => now, monotonic: () => 0,
      openDatabase: () => { effects++; throw new Error(); }, openProbe: () => { effects++; throw new Error(); } });
    const result = await runner.run({ ...initial, ...patch } as RehearsalInput);
    assert.equal(result.disposition, "setup_incomplete"); assert.equal(effects, 0);
    assert.equal((await runner.run(initial)).disposition, "already_attempted"); assert.equal(effects, 0);
  }
});

test("native composition is inert and an invalid packet has no native connection attempt", async () => {
  const runner = createNativePrivateDatabaseRehearsal();
  const result = await runner.run({ ...input(), packet: {} } as RehearsalInput);
  assert.equal(result.execution, "native_postgres"); assert.equal(result.disposition, "setup_incomplete");
  assert.equal(result.poolsCreated, 0); assert.equal(result.probesCreated, 0); assert.equal(result.realPostgresAccepted, false);
});

test("startup uncertainty stops once, closes once, strips private errors and records no false pass", async () => {
  let opens = 0, closes = 0;
  const runner = createInjectedPrivateDatabaseRehearsal({ clock: () => now, monotonic: () => 0,
    openDatabase: () => { opens++; return boundPrivateDatabase({ acquire: async () => { throw new Error("private host and SQL detail"); }, terminate: async () => { closes++; } }); },
    openProbe: () => { throw new Error("must not open"); } });
  const result = await runner.run(input()); assert.equal(result.disposition, "stopped");
  assert.equal(opens, 1); assert.equal(closes, 1); assert.equal(result.poolsClosed, 1);
  assert.equal(Object.values(result.checks).every(v => v === "not_exercised"), true);
  for (const hidden of ["private host", "synthetic-private-password", "test-owner", "web_test", "cr14b_rehearsal_test"])
    assert.equal(JSON.stringify(result).includes(hidden), false);
  await runner.run(input()); assert.equal(opens, 1);
});

test("cleanup failure remains uncertain, never checks_completed", async () => {
  const runner = createInjectedPrivateDatabaseRehearsal({ clock: () => now, monotonic: () => 0,
    openDatabase: () => boundPrivateDatabase({ acquire: async () => { throw new Error(); }, terminate: async () => { throw new Error("private cleanup detail"); } }),
    openProbe: () => { throw new Error(); } });
  const result = await runner.run(input()); assert.equal(result.disposition, "cleanup_uncertain"); assert.equal(result.poolsClosed, 0);
  assert.equal(JSON.stringify(result).includes("private cleanup detail"), false);
});

test("SQL journey creates and replays receipts, reads Idea/connections, drains, reopens and logs out; concurrency remains injected", async t => {
  const f = await limitedWebFixture(); t.after(() => f.pool.close());
  const probes = recordedProbeFixture(), setup = input();
  setup.packet.pgVersionNumber = Number((await f.client.query<{ version: string }>("SELECT current_setting('server_version_num') AS version")).rows[0].version);
  const recorded: string[] = []; let pools = 0, closes = 0;
  const runner = createInjectedPrivateDatabaseRehearsal({ clock: () => now, monotonic: () => 0, probeTiming: probes.timing,
    openProbe: (_, slot) => probes[slot],
    openDatabase: () => { pools++; return boundPrivateDatabase({ acquire: async () => ({ release: () => {},
      query: async <T>(sql: string, params: unknown[] = []) => {
        recorded.push(sql);
        if (sql.includes("FROM pg_stat_activity")) return probes.observer.query<T>(sql, params);
        // PGlite has one in-process SQL session, not a PG pool. Only preparation metadata differs.
        // It cannot revoke template1 TEMP. This result override is test-only and never in the runner.
        const metadata = sql.includes("AS database_temp");
        const bound = metadata ? [params[0], "template1"] : params;
        const result = await f.client.query<Record<string, unknown>>(sql, bound);
        if (metadata) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
        return result as { rows: T[] };
      },
    }), terminate: async () => { closes++; } }); },
  });
  const result = await runner.run(setup);
  assert.equal(result.disposition, "checks_completed", JSON.stringify(result));
  assert.equal(Object.values(result.checks).every(v => v === "observed"), true);
  assert.equal(result.execution, "injected_test"); assert.equal(result.realPostgresAccepted, false);
  assert.equal(pools, 2); assert.equal(closes, 2); assert.equal(result.poolsClosed, 2); assert.equal(result.probesClosed, 2);
  assert.equal(result.processRestart, "not_exercised"); assert.equal(result.backupRestore, "not_exercised");
  assert.equal(result.databaseCleanup, "not_owned_by_runner");
  assert.equal(result.physicalConnectionAttempts, "not_observed"); assert.equal(result.idleTimeoutCause, "unavailable_from_driver");
  assert.equal("idle_transaction_timeout" in result.checks, false);
  assert.equal(recorded.some(sql => /^\s*(DROP |CREATE DATABASE|ALTER ROLE|GRANT |DELETE )/i.test(sql)), false);
  assert.equal((await f.client.query<{ count: string }>("SELECT count(*)::text AS count FROM control_web_project_commands")).rows[0].count, "2");
  assert.equal((await runner.run(setup)).disposition, "already_attempted"); assert.equal(pools, 2);
});

test("a missing synthetic signal cannot pass the enrollment/signal fixture check", async t => {
  const f = await limitedWebFixture(); t.after(() => f.pool.close()); const setup = input();
  setup.packet.pgVersionNumber = Number((await f.client.query<{ version: string }>("SELECT current_setting('server_version_num') AS version")).rows[0].version);
  let probes = 0;
  const runner = createInjectedPrivateDatabaseRehearsal({ clock: () => now, monotonic: () => 0,
    openProbe: () => { probes++; throw new Error("must not open"); },
    openDatabase: () => boundPrivateDatabase({ acquire: async () => ({ release: () => {},
      query: async <T>(sql: string, params: unknown[] = []) => {
        if (sql.includes("FROM control_connection_authenticated_telemetry_receipts")) return { rows: [] as T[] };
        const metadata = sql.includes("AS database_temp");
        const result = await f.client.query<Record<string, unknown>>(sql, metadata ? [params[0], "template1"] : params);
        if (metadata) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
        return result as { rows: T[] };
      },
    }), terminate: async () => {} }),
  });
  const result = await runner.run(setup); assert.equal(result.disposition, "stopped");
  assert.equal(result.checks.project_commands, "observed"); assert.equal(result.checks.catalog_and_connections, "not_exercised");
  assert.equal(probes, 0); assert.equal(result.poolsCreated, 1); assert.equal(result.poolsClosed, 1);
});

test("rehearsal is not mounted into routes, production startup, listeners, environment or credential loaders", async () => {
  const source = await readFile("src/web/v1/private-database-rehearsal.ts", "utf8");
  assert.doesNotMatch(source, /process\.env|process\.on\(|fetch\(|node:http|node:net|private-serving/);
  for (const dir of ["app", "private-app"]) {
    let entries: string[] = [];
    try { entries = await readdir(dir, { recursive: true }); } catch { continue; }
    for (const file of entries.filter(file => /\.[tj]sx?$/.test(file)))
      assert.doesNotMatch(await readFile(`${dir}/${file}`, "utf8"), /private-database-rehearsal|private-rehearsal-probe/);
  }
});

test("lost acknowledgement after a real synthetic commit stops without replay or planned reopen", async t => {
  const f = await limitedWebFixture(); t.after(() => f.pool.close()); const setup = input();
  setup.packet.pgVersionNumber = Number((await f.client.query<{ version: string }>("SELECT current_setting('server_version_num') AS version")).rows[0].version);
  let commandInserted = false, opens = 0, closes = 0, inserts = 0;
  const runner = createInjectedPrivateDatabaseRehearsal({ clock: () => now, monotonic: () => 0,
    openProbe: () => { throw new Error("must not open"); },
    openDatabase: () => { opens++; return boundPrivateDatabase({ acquire: async () => ({ release: () => {},
      query: async <T>(sql: string, params: unknown[] = []) => {
        const metadata = sql.includes("AS database_temp");
        const result = await f.client.query<Record<string, unknown>>(sql, metadata ? [params[0], "template1"] : params);
        if (metadata) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
        if (sql.startsWith("INSERT INTO control_web_project_commands")) { commandInserted = true; inserts++; }
        if (commandInserted && sql === "COMMIT") throw new PrivateDatabaseError("database_outcome_uncertain");
        return result as { rows: T[] };
      },
    }), terminate: async () => { closes++; } }); },
  });
  const result = await runner.run(setup); assert.equal(result.disposition, "stopped");
  assert.equal(result.checks.synthetic_fixture, "observed"); assert.equal(result.checks.project_commands, "not_exercised");
  assert.equal(result.checks.pool_reopen_receipts, "not_exercised"); assert.equal(opens, 1); assert.equal(closes, 1); assert.equal(inserts, 1);
  assert.equal((await f.client.query<{ count: string }>("SELECT count(*)::text AS count FROM control_web_project_commands")).rows[0].count, "1");
  assert.equal((await runner.run(setup)).disposition, "already_attempted"); assert.equal(opens, 1);
});

test("cancellation during read-only preparation closes the pool and prevents application writes", async t => {
  const f = await limitedWebFixture(); t.after(() => f.pool.close()); const setup = input(), controller = new AbortController();
  setup.signal = controller.signal; let writes = 0, closes = 0;
  const runner = createInjectedPrivateDatabaseRehearsal({ clock: () => now, monotonic: () => 0,
    openProbe: () => { throw new Error("must not open"); },
    openDatabase: () => boundPrivateDatabase({ acquire: async () => ({ release: () => {},
      query: async <T>(sql: string, params: unknown[] = []) => {
        if (/^\s*(INSERT|UPDATE)/.test(sql)) writes++;
        const metadata = sql.includes("AS database_temp");
        const result = await f.client.query<Record<string, unknown>>(sql, metadata ? [params[0], "template1"] : params);
        if (metadata) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
        if (sql.includes("AS audits")) controller.abort();
        return result as { rows: T[] };
      },
    }), terminate: async () => { closes++; } }),
  });
  const result = await runner.run(setup); assert.equal(result.disposition, "stopped");
  assert.equal(result.checks.preflight, "observed"); assert.equal(writes, 0); assert.equal(closes, 1);
  assert.equal(result.probesCreated, 0);
});
