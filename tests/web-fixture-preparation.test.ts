import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { createInjectedPrivateFixturePreparation, createNativePrivateFixturePreparation,
  fixturePreparationPostgresOptions, type FixturePreparationInput } from "../src/web/v1/private-fixture-preparation";
import { createInjectedPrivateDatabaseRehearsal, rehearsalScopeDigest, type RehearsalInput } from "../src/web/v1/private-database-rehearsal";
import { emptyPreparationFixture, preparationInput } from "./helpers/web-fixture-preparation";
import { recordedProbeFixture } from "./helpers/web-rehearsal-probes";
import { now } from "./helpers/web-foundation";
import { buildPrivateRehearsalFixture } from "../src/web/v1/private-rehearsal-fixture";
import { PrivateDatabaseError } from "../src/web/v1/bounded-database";

test("invalid preparation packets consume no connections and cannot be repaired for a second attempt", async () => {
  const initial = preparationInput();
  const patches = [ { packet: {} }, { packet: { ...initial.packet, installOrProvision: true } },
    { packet: { ...initial.packet, maximumConnections: 2 } }, { packet: { ...initial.packet, automaticRetry: true } },
    { packet: { ...initial.packet, expiresAt: now } }, { packet: { ...initial.packet, durationMs: 5000 } },
    { packet: { ...initial.packet, migratorScopeDigest: "a".repeat(64) } },
    { packet: { ...initial.packet, webScopeDigest: "b".repeat(64) } },
    { manifest: { ...initial.manifest, tree: "a".repeat(40) } },
    { migrator: { ...initial.migrator, host: "192.0.2.1" } }, { migrator: { ...initial.migrator, database: "production" } },
    { webDatabase: { ...initial.webDatabase, username: initial.migrator.username } }, { signal: AbortSignal.abort() } ];
  for (const patch of patches) {
    let opens = 0;
    const preparer = createInjectedPrivateFixturePreparation({ clock: () => now, monotonic: () => 0,
      openDatabase: () => { opens++; throw new Error(); } });
    const result = await preparer.prepare({ ...initial, ...patch } as FixturePreparationInput);
    assert.equal(result.evidence.disposition, "setup_incomplete"); assert.equal(opens, 0); assert.equal(result.takeMaterial, undefined);
    assert.equal((await preparer.prepare(initial)).evidence.disposition, "already_attempted"); assert.equal(opens, 0);
  }
});

test("native preparation is inert; its explicit pool is single-connection without provisioning", async () => {
  const preparer = createNativePrivateFixturePreparation();
  const result = await preparer.prepare({} as FixturePreparationInput);
  assert.equal(result.evidence.execution, "native_postgres"); assert.equal(result.evidence.poolCreated, false);
  assert.equal(result.evidence.realPostgresAccepted, false); assert.equal(result.takeMaterial, undefined);
  const options = fixturePreparationPostgresOptions(preparationInput().migrator);
  assert.equal(options.max, 1); assert.equal(options.prepare, false); assert.equal(options.backoff, false);
});

test("one acknowledged outer transaction prepares all fixtures and a one-use private in-memory handoff", async t => {
  const f = await emptyPreparationFixture(); t.after(() => f.db.close());
  const preparer = createInjectedPrivateFixturePreparation({ clock: () => now, monotonic: () => 0, openDatabase: () => f.openPool() });
  const result = await preparer.prepare(f.input);
  assert.equal(result.evidence.disposition, "fixture_prepared", JSON.stringify(result));
  assert.equal(result.evidence.execution, "injected_test"); assert.equal(result.evidence.realPostgresAccepted, false);
  assert.deepEqual(result.evidence.fixtureCounts, { tenant: 1, owner: 1, workspace: 1, idea: 1, enrollment: 1, signal: 1 });
  assert.equal(f.statements.filter(sql => sql === "BEGIN").length, 1);
  assert.equal(f.statements.filter(sql => sql === "COMMIT").length, 1);
  assert.equal(f.statements.filter(sql => sql === "ROLLBACK").length, 0);
  assert.equal(f.opens(), 1); assert.equal(f.closes(), 1); assert.equal(result.evidence.poolClosed, true);
  assert.equal(result.evidence.transactionStatementsIssued <= 256, true);
  assert.equal(f.statements.some(sql => /^\s*(DROP |CREATE |ALTER |GRANT |DELETE )/i.test(sql)), false);
  const firstWrite = f.statements.findIndex(sql => /^\s*INSERT /i.test(sql));
  assert.equal(f.statements.findIndex(sql => sql.startsWith("LOCK TABLE ")) < firstWrite, true);
  assert.equal(result.evidence.handoffStartBy, now + 240_000);
  const material = result.takeMaterial!(); assert.throws(() => result.takeMaterial!(), /fixture_handoff_unavailable/);
  const encoded = JSON.stringify(result);
  for (const hidden of [material.assertion, "synthetic-private-password", "prep_test", "web_test", "cr14b_rehearsal_test", "privateKey", "ideaIntegrityKey"])
    assert.equal(encoded.includes(hidden), false);
  assert.equal(material.ideaIntegrityKey.length, 32); assert.equal(material.keys.length, 1);
  assert.equal("d" in material.keys[0].jwk, false); assert.equal(Object.isFrozen(result.evidence), true);
  assert.equal(Object.isFrozen(result.evidence.fixtureCounts), true);
  assert.equal((await preparer.prepare(f.input)).evidence.disposition, "already_attempted"); assert.equal(f.opens(), 1);
});

test("occupied database is refused before any fixture write and existing records remain intact", async t => {
  const f = await emptyPreparationFixture(); t.after(() => f.db.close());
  await f.client.query("INSERT INTO tenants(id,display_name) VALUES('existing','Existing record')");
  const result = await createInjectedPrivateFixturePreparation({ clock: () => now, monotonic: () => 0,
    openDatabase: () => f.openPool() }).prepare(f.input);
  assert.equal(result.evidence.disposition, "stopped"); assert.equal(result.takeMaterial, undefined);
  assert.equal(f.statements.some(sql => /^\s*INSERT /i.test(sql)), false);
  assert.deepEqual((await f.client.query("SELECT id,display_name FROM tenants")).rows, [{ id: "existing", display_name: "Existing record" }]);
  assert.equal(f.closes(), 1);
});

test("generated fixture feeds the reviewed SQL journey with fresh keys; no real agent or PostgreSQL acceptance", async t => {
  const f = await emptyPreparationFixture(); t.after(() => f.db.close());
  const prepared = await createInjectedPrivateFixturePreparation({ clock: () => now, monotonic: () => 0,
    openDatabase: () => f.openPool() }).prepare(f.input);
  assert.equal(prepared.evidence.disposition, "fixture_prepared", JSON.stringify(prepared));
  const database = { ...f.input.webDatabase, password: "synthetic-web-password" }, probes = recordedProbeFixture();
  const setup: RehearsalInput = { manifest: f.input.manifest, database, material: prepared.takeMaterial!(), packet: {
    manifest: f.input.manifest, scopeDigest: rehearsalScopeDigest(database), preparationDigest: prepared.preparationDigest,
    ownerApprovalDigest: "7".repeat(64), cleanupPlanDigest: "8".repeat(64), pgPackageDigest: f.input.packet.pgPackageDigest,
    pgVersionNumber: f.input.packet.pgVersionNumber, expiresAt: now + 900_000, durationMs: 60_000,
    dedicatedSyntheticDatabase: true, sameHostPrivatePrimary: true, setupAccepted: true, connectionPools: 2,
    maxWebConnections: 8, validationSessions: 2, physicalListener: false, automaticRetry: false,
    cleanup: "close_owned_connections_then_operator_database_cleanup" } };
  await f.useWebRole();
  const result = await createInjectedPrivateDatabaseRehearsal({ clock: () => now, monotonic: () => 0,
    openDatabase: () => f.openPool({ observer: probes.observer.query }), openProbe: (_, slot) => probes[slot], probeTiming: probes.timing }).run(setup);
  assert.equal(result.disposition, "checks_completed", JSON.stringify(result));
  assert.equal(Object.values(result.checks).every(value => value === "observed"), true);
  assert.equal(result.realPostgresAccepted, false); assert.equal(result.execution, "injected_test");
  assert.equal(f.opens(), 3); assert.equal(f.closes(), 3);
});

test("fixture preparation stays outside app routes, startup and credential/network loaders", async () => {
  for (const file of ["private-fixture-preparation.ts", "private-rehearsal-fixture.ts"]) {
    const source = await readFile(`src/web/v1/${file}`, "utf8");
    assert.doesNotMatch(source, /process\.env|process\.on\(|fetch\(|node:http|node:net|private-serving|@electric-sql/);
  }
  for (const dir of ["app", "private-app"]) for (const file of (await readdir(dir, { recursive: true })).filter(file => /\.[tj]sx?$/.test(file)))
    assert.doesNotMatch(await readFile(`${dir}/${file}`, "utf8"), /private-fixture-preparation|private-rehearsal-fixture/);
});

test("wrong login and changed schema stop before seeding without altering the supplied database", async t => {
  for (const mode of ["login", "schema"] as const) await t.test(mode, async t => {
    const f = await emptyPreparationFixture(); t.after(() => f.db.close());
    if (mode === "login") await f.useWebRole();
    else await f.client.query("ALTER TABLE tenants ADD COLUMN synthetic_drift text");
    const result = await createInjectedPrivateFixturePreparation({ clock: () => now, monotonic: () => 0,
      openDatabase: () => f.openPool() }).prepare(f.input);
    assert.equal(result.evidence.disposition, "stopped"); assert.equal(result.takeMaterial, undefined);
    assert.equal(f.statements.some(sql => /^\s*INSERT /i.test(sql)), false); assert.equal(f.closes(), 1);
  });
});

test("seed failure and cancellation roll back the entire joined transaction and expose no handoff", async t => {
  for (const mode of ["failure", "abort", "deadline"] as const) await t.test(mode, async t => {
    const f = await emptyPreparationFixture(); t.after(() => f.db.close());
    const controller = new AbortController(); f.input.signal = controller.signal; let elapsed = 0;
    const result = await createInjectedPrivateFixturePreparation({ clock: () => now, monotonic: () => elapsed,
      openDatabase: () => f.openPool({ after: sql => {
        if (sql.startsWith("INSERT INTO workspaces")) {
          if (mode === "failure") throw new Error("private synthetic SQL failure");
          if (mode === "abort") controller.abort();
          if (mode === "deadline") elapsed = f.input.packet.durationMs;
        }
      } }) }).prepare(f.input);
    // Cancellation fences immediately; the pending query callback settles without any later write.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(result.evidence.disposition, "stopped"); assert.equal(result.takeMaterial, undefined);
    assert.equal(f.statements.includes("COMMIT"), false);
    assert.equal(f.statements.some(sql => sql.includes("INSERT INTO control_identities")), false);
    // The injected terminate does not close PGlite, so explicitly finish any invalidated open test TX.
    // Real connection shutdown rolls back its open transaction; that native behavior is not claimed here.
    if (!f.statements.includes("ROLLBACK")) await f.client.query("ROLLBACK");
    assert.equal((await f.client.query<{ count: string }>("SELECT count(*)::text AS count FROM tenants")).rows[0].count, "0");
    assert.equal(f.closes(), 1); assert.equal(JSON.stringify(result).includes("private synthetic"), false);
  });
});

test("uncertain commit acknowledgement never returns keys, rolls back after commit, or retries", async t => {
  const f = await emptyPreparationFixture(); t.after(() => f.db.close());
  const preparer = createInjectedPrivateFixturePreparation({ clock: () => now, monotonic: () => 0,
    openDatabase: () => f.openPool({ after: sql => { if (sql === "COMMIT") throw new PrivateDatabaseError("database_outcome_uncertain"); } }) });
  const result = await preparer.prepare(f.input);
  assert.equal(result.evidence.disposition, "stopped"); assert.equal(result.takeMaterial, undefined);
  assert.equal(f.statements.filter(sql => sql === "COMMIT").length, 1); assert.equal(f.statements.includes("ROLLBACK"), false);
  assert.equal((await f.client.query<{ count: string }>("SELECT count(*)::text AS count FROM tenants")).rows[0].count, "1");
  assert.equal(result.evidence.fixtureCounts.tenant, 0); assert.equal(result.evidence.poolClosed, true);
  assert.equal((await preparer.prepare(f.input)).evidence.disposition, "already_attempted"); assert.equal(f.opens(), 1); assert.equal(f.closes(), 1);
});

test("failed owned-client close keeps committed fixture unavailable for handoff", async t => {
  const f = await emptyPreparationFixture(); t.after(() => f.db.close());
  const result = await createInjectedPrivateFixturePreparation({ clock: () => now, monotonic: () => 0,
    openDatabase: () => f.openPool({ closeFails: true }) }).prepare(f.input);
  assert.equal(result.evidence.disposition, "cleanup_uncertain"); assert.equal(result.evidence.poolClosed, false);
  assert.equal(result.takeMaterial, undefined); assert.equal(result.evidence.fixtureCounts.tenant, 1);
  assert.equal(JSON.stringify(result).includes("private cleanup detail"), false); assert.equal(f.closes(), 1);
});

test("expired or backwards-clock handoff is consumed without returning material", async t => {
  for (const mode of ["expired", "backwards"] as const) await t.test(mode, async t => {
    const f = await emptyPreparationFixture(); t.after(() => f.db.close()); let time = now;
    const result = await createInjectedPrivateFixturePreparation({ clock: () => time, monotonic: () => 0,
      openDatabase: () => f.openPool() }).prepare(f.input);
    assert.equal(result.evidence.disposition, "fixture_prepared");
    time = mode === "expired" ? now + 240_000 : now - 1;
    assert.throws(() => result.takeMaterial!(), /fixture_handoff_unavailable/);
    time = now; assert.throws(() => result.takeMaterial!(), /fixture_handoff_unavailable/);
  });
});

test("independent fixture builders generate fresh synthetic keys with no signing private key returned", () => {
  const first = buildPrivateRehearsalFixture(now), second = buildPrivateRehearsalFixture(now);
  assert.notEqual(first.material.assertion, second.material.assertion);
  for (const key of ["ideaIntegrityKey", "registryIntegrityKey", "telemetryIntegrityKey"] as const)
    assert.notDeepEqual(first.material[key], second.material[key]);
  assert.equal("d" in first.material.keys[0].jwk, false);
});
