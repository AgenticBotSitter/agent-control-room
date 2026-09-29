import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { PRIVATE_POSTGRES_CONFIGURATION_V1, PRIVATE_POSTGRES_REVIEWED_FILES_V1,
  createPrivatePostgresOwnerAdapterV1, type PrivatePostgresEvidenceRequestV1,
  type PrivatePostgresMigrationRequestV1, type PrivatePostgresProvisionRequestV1 } from
  "../src/installer/v1/private-postgres-owner-adapter";
import { POSTGRES_OWNER_ATTACHED_TERMINAL_V1, type PostgresOwnerRunnerContextV1 } from
  "../src/installer/v1/private-postgres-owner-runner";

const digest = (value: unknown) => sha256Digest(value);
const secret = (name: string) => `${name}-`.repeat(12);

function fixture(options: Readonly<{ migrationResult?: unknown; provisionResult?: unknown }> = {}) {
  const calls: string[] = [];
  let provision: PrivatePostgresProvisionRequestV1 | undefined;
  let migration: PrivatePostgresMigrationRequestV1 | undefined;
  let evidence: PrivatePostgresEvidenceRequestV1 | undefined;
  const signal = new AbortController().signal;
  const configuration = {
    schema: PRIVATE_POSTGRES_CONFIGURATION_V1, majorVersion: 17, host: "127.0.0.1", port: 5432,
    database: "control_room", maintenanceDatabase: "postgres",
    operator: { username: "postgres", password: secret("operator") },
    migratorPassword: secret("migrator"), applicationPassword: secret("application"),
    schedulerPassword: secret("scheduler"), requiredTables: ["tenants", "control_projects"],
  } as const;
  const reviewedFiles = { schema: PRIVATE_POSTGRES_REVIEWED_FILES_V1, releaseDigest: digest("release"), files: {
    provision: { path: "deploy/postgres/provision-database.sql", sha256: "1".repeat(64) },
    migrations: { path: "deploy/postgres/apply-migrations.mjs", sha256: "2".repeat(64) },
    evidence: { path: "deploy/postgres/evidence.mjs", sha256: "3".repeat(64) },
    ledger: { path: "deploy/postgres/migration-ledger.json", sha256: "4".repeat(64) },
  } } as const;
  const runtime = createPrivatePostgresOwnerAdapterV1({
    custody: {
      async withConfiguration<T>(_signal: AbortSignal, use: (value: unknown) => Promise<T>) {
        calls.push("configuration"); return use(configuration);
      },
      async close() { calls.push("close-configuration"); },
    },
    tools: {
      async provisionDatabase(request: PrivatePostgresProvisionRequestV1) {
        calls.push("provision"); provision = request;
        return (options.provisionResult ?? { outcome: "succeeded" as const, exitCode: 0 as const }) as never;
      },
      async applyMigrations(request: PrivatePostgresMigrationRequestV1) {
        calls.push("migrate"); migration = request; return (options.migrationResult ?? { outcome: "succeeded" as const,
          result: { planned: false, applied: [], noOp: true, schemaDigest: digest("schema"), objects: 2,
            logins: "applied", grants: "applied" } }) as never;
      },
      async collectDatabaseEvidence(request: PrivatePostgresEvidenceRequestV1) {
        calls.push("evidence"); evidence = request; return { ledger: [], roles: [], memberships: [], grants: [], rows: [],
          schemaDigest: digest("schema"), databaseOwner: "control_room_schema_owner" };
      },
      async cleanup() { calls.push("cleanup-tools"); },
    },
    reviewedFiles,
    baseRuntime: {
      signal, controlDeadlineMs: 100, cleanupDeadlineMs: 100,
      async verifyExactRelease() { return { outcome: "verified" as const, releaseDigest: reviewedFiles.releaseDigest }; },
      async verifyExactMigrationLedger() { return { outcome: "verified" as const,
        ledgerDigest: digest("ledger"), entries: [] }; },
      async confirmOwnerAttachedTerminal(context: PostgresOwnerRunnerContextV1) {
        return { schema: POSTGRES_OWNER_ATTACHED_TERMINAL_V1, requestDigest: context.requestDigest,
          operation: context.request.operation, ownerAttached: true as const, confirmed: true as const };
      },
    },
  });
  const context = { signal, requestDigest: digest("request"), request: {
    releaseDigest: reviewedFiles.releaseDigest,
  } } as unknown as PostgresOwnerRunnerContextV1;
  return { runtime, calls, context, configuration, reviewedFiles,
    requests: { provision: () => provision, migration: () => migration, evidence: () => evidence } };
}

test("provisioning uses only the fixed reviewed SQL and exact structured psql arguments", async () => {
  const f = fixture();
  const result = await f.runtime.provisionDatabase(f.runtime.privateConfiguration, f.context);
  assert.equal(result.outcome, "succeeded");
  const request = f.requests.provision(); assert.ok(request);
  assert.deepEqual(request.args, ["-v", "ON_ERROR_STOP=1", "-v", "dbname=control_room", "-f",
    "deploy/postgres/provision-database.sql", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres", "-d", "postgres"]);
  assert.equal(request.env.PGPASSWORD, f.configuration.operator.password);
  assert.equal(request.environmentMode, "replace");
  assert.deepEqual({ ...request.env, PGPASSWORD: "redacted" }, { PGPASSWORD: "redacted", PGSSLMODE: "disable",
    PGAPPNAME: "control-room-owner-provision", PGOPTIONS: "-c search_path=pg_catalog,\\ public -c timezone=UTC",
    PGCLIENTENCODING: "UTF8", PGREPLICATION: "false", PGCONNECT_TIMEOUT: "5" });
  assert.doesNotMatch(JSON.stringify(request.args), /operator-|password|postgresql:\/\//u);
  assert.equal(request.files.length, 4);
  assert.doesNotMatch(JSON.stringify(result), /operator-|migrator-|application-|scheduler-/u);
});

test("migration reuses the existing export with structured targets and only its reviewed password names", async () => {
  const f = fixture();
  const result = await f.runtime.applyMigrations(f.runtime.privateConfiguration, f.context);
  assert.equal(result.outcome, "succeeded");
  const request = f.requests.migration(); assert.ok(request);
  assert.equal(request.module, "deploy/postgres/apply-migrations.mjs");
  assert.equal(request.exportName, "applyMigrations");
  assert.equal(request.environmentMode, "replace");
  assert.equal(request.ledgerPath, "deploy/postgres/migration-ledger.json");
  assert.deepEqual(request.bootstrapTarget, { host: "127.0.0.1", port: 5432, database: "control_room",
    user: "postgres", password: f.configuration.operator.password, ssl: false, sslnegotiation: "postgres",
    client_encoding: "UTF8", replication: "false", target_session_attrs: "primary",
    application_name: "control-room-owner-bootstrap",
    options: "-c search_path=pg_catalog,\\ public -c timezone=UTC", statement_timeout: 120000,
    lock_timeout: 5000, idle_in_transaction_session_timeout: 15000, connectionTimeoutMillis: 5000, keepAlive: true,
    binary: false });
  assert.deepEqual(request.migrateTarget, { ...request.bootstrapTarget, user: "control_room_migrator",
    password: f.configuration.migratorPassword, application_name: "control-room-owner-migrate" });
  assert.deepEqual(Object.keys(request.env).sort(), ["CONTROL_ROOM_APP_PASSWORD", "CONTROL_ROOM_MIGRATOR_PASSWORD",
    "CONTROL_ROOM_SCHEDULER_PASSWORD"]);
  assert.doesNotMatch(JSON.stringify(result), /operator-|migrator-|application-|scheduler-/u);
});

test("evidence reuses the existing collector with explicit required tables", async () => {
  const f = fixture();
  const returned = await f.runtime.collectDatabaseEvidence(f.runtime.privateConfiguration, f.context);
  const request = f.requests.evidence(); assert.ok(request);
  assert.equal(request.module, "deploy/postgres/evidence.mjs");
  assert.equal(request.exportName, "collectDatabaseEvidence");
  assert.equal(request.environmentMode, "replace");
  assert.deepEqual(request.env, {});
  assert.deepEqual(request.requiredTables, ["tenants", "control_projects"]);
  assert.equal(request.target.user, "control_room_migrator");
  assert.equal(request.target.application_name, "control-room-owner-evidence");
  assert.equal((returned as { databaseOwner: string }).databaseOwner, "control_room_schema_owner");
});

test("hostile libpq environment cannot alter explicit process or module request semantics", async () => {
  const overrides = { PGHOST: "attacker.example", PGPORT: "1", PGDATABASE: "wrong", PGUSER: "wrong",
    PGPASSWORD: "wrong", PGSSLMODE: "require", PGAPPNAME: "wrong", PGOPTIONS: "-c search_path=wrong",
    PGCLIENTENCODING: "LATIN1", PGREPLICATION: "database", PGCONNECT_TIMEOUT: "999", PGBINARY: "1",
    PGSSLNEGOTIATION: "direct" };
  const prior = new Map(Object.keys(overrides).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, overrides);
    const f = fixture();
    await f.runtime.provisionDatabase(f.runtime.privateConfiguration, f.context);
    await f.runtime.applyMigrations(f.runtime.privateConfiguration, f.context);
    await f.runtime.collectDatabaseEvidence(f.runtime.privateConfiguration, f.context);
    const provision = f.requests.provision(), migration = f.requests.migration(), evidence = f.requests.evidence();
    assert.ok(provision && migration && evidence);
    assert.equal(provision.environmentMode, "replace");
    assert.equal(migration.environmentMode, "replace");
    assert.equal(provision.args.includes("attacker.example"), false);
    assert.deepEqual(Object.keys(provision.env).sort(), ["PGAPPNAME", "PGCLIENTENCODING", "PGCONNECT_TIMEOUT", "PGOPTIONS",
      "PGPASSWORD", "PGREPLICATION", "PGSSLMODE"]);
    assert.equal(evidence.environmentMode, "replace"); assert.deepEqual(evidence.env, {});
    for (const target of [migration.bootstrapTarget, migration.migrateTarget, evidence.target]) {
      assert.equal(target.host, "127.0.0.1"); assert.equal(target.ssl, false);
      assert.equal(target.client_encoding, "UTF8"); assert.equal(target.replication, "false");
      assert.equal(target.target_session_attrs, "primary");
      assert.equal(target.connectionTimeoutMillis, 5000);
      assert.equal(target.binary, false);
    }
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("migration result accepts only the bounded existing applyMigrations schema", async () => {
  const validEntry = { file: "db/migrations/0001_control_room_core.sql", order: 1,
    preSchemaDigest: digest("before"), postSchemaDigest: digest("after") };
  const cases = [
    { planned: false, applied: [{ ...validEntry, extra: "secret" }], noOp: false, schemaDigest: digest("schema"),
      objects: 2, logins: "applied", grants: "applied" },
    { planned: false, applied: [{ ...validEntry, file: "private/secret.sql" }], noOp: false,
      schemaDigest: digest("schema"), objects: 2, logins: "applied", grants: "applied" },
    { planned: false, applied: [{ ...validEntry, order: -1 }], noOp: false, schemaDigest: digest("schema"),
      objects: 2, logins: "applied", grants: "applied" },
    { planned: false, applied: [validEntry], noOp: true, schemaDigest: digest("schema"), objects: 2,
      logins: "applied", grants: "applied" },
    { planned: false, applied: [], noOp: true, schemaDigest: digest("schema"), objects: -1,
      logins: "applied", grants: "applied" },
    { planned: false, applied: [], noOp: true, schemaDigest: digest("schema"), objects: 2,
      logins: "private detail", grants: "applied" },
    { planned: false, applied: [], noOp: true, schemaDigest: digest("schema"), objects: 2,
      logins: "applied", grants: "deferred_partial_schema:private detail" },
  ];
  const sparse = new Array(1);
  const overridden = [validEntry] as typeof validEntry[] & { map?: unknown };
  Object.defineProperty(overridden, "map", { value: () => [{ ...validEntry, file: "private/secret.sql" }], enumerable: true });
  class HostileArray<T> extends Array<T> {}
  cases.push(
    { planned: false, applied: sparse, noOp: false, schemaDigest: digest("schema"), objects: 2,
      logins: "applied", grants: "applied" },
    { planned: false, applied: overridden, noOp: false, schemaDigest: digest("schema"), objects: 2,
      logins: "applied", grants: "applied" },
    { planned: false, applied: new HostileArray(validEntry), noOp: false, schemaDigest: digest("schema"), objects: 2,
      logins: "applied", grants: "applied" },
  );
  for (const result of cases) {
    const f = fixture({ migrationResult: { outcome: "succeeded", result } });
    await assert.rejects(f.runtime.applyMigrations(f.runtime.privateConfiguration, f.context),
      /private_postgres_owner_adapter_uncertain/u);
  }
});

test("connection URLs, ambient hosts and changed reviewed files are refused before a tool call", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => ({ ...f.configuration, host: "db.example" }),
    (f: ReturnType<typeof fixture>) => ({ ...f.configuration, database: "postgresql://private.example/control_room" }),
  ]) {
    const f = fixture();
    const original = f.runtime;
    const runtime = createPrivatePostgresOwnerAdapterV1({
      custody: { async withConfiguration<T>(_signal: AbortSignal, use: (value: unknown) => Promise<T>) {
        return use(mutate(f)); }, async close() {} },
      tools: { async provisionDatabase() { f.calls.push("tool"); return { outcome: "succeeded" as const, exitCode: 0 as const }; },
        async applyMigrations() { throw new Error("unused"); }, async collectDatabaseEvidence() { throw new Error("unused"); },
        async cleanup() {} },
      reviewedFiles: f.reviewedFiles,
      baseRuntime: { signal: original.signal, controlDeadlineMs: original.controlDeadlineMs,
        cleanupDeadlineMs: original.cleanupDeadlineMs, verifyExactRelease: original.verifyExactRelease,
        verifyExactMigrationLedger: original.verifyExactMigrationLedger,
        confirmOwnerAttachedTerminal: original.confirmOwnerAttachedTerminal },
    });
    await assert.rejects(runtime.provisionDatabase(runtime.privateConfiguration, f.context),
      /private_postgres_owner_adapter_refused/u);
    assert.equal(f.calls.includes("tool"), false);
  }
  const f = fixture();
  assert.throws(() => createPrivatePostgresOwnerAdapterV1({
    custody: { async withConfiguration() {}, async close() {} },
    tools: { async provisionDatabase() {}, async applyMigrations() {}, async collectDatabaseEvidence() {}, async cleanup() {} },
    reviewedFiles: { ...f.reviewedFiles, files: { ...f.reviewedFiles.files,
      provision: { ...f.reviewedFiles.files.provision, path: "deploy/postgres/other.sql" } } },
    baseRuntime: { signal: f.runtime.signal, controlDeadlineMs: 100, cleanupDeadlineMs: 100,
      verifyExactRelease: f.runtime.verifyExactRelease, verifyExactMigrationLedger: f.runtime.verifyExactMigrationLedger,
      confirmOwnerAttachedTerminal: f.runtime.confirmOwnerAttachedTerminal },
  }), /private_postgres_owner_adapter_refused/u);
});

test("tool exceptions and malformed post-start replies are uncertain and sanitized", async () => {
  for (const mode of ["throw", "malformed"] as const) {
    const f = fixture(), original = f.runtime;
    const runtime = createPrivatePostgresOwnerAdapterV1({
      custody: { async withConfiguration<T>(_signal: AbortSignal, use: (value: unknown) => Promise<T>) {
        return use(f.configuration); }, async close() {} },
      tools: { async provisionDatabase() {
        if (mode === "throw") throw new Error(`psql failed ${f.configuration.operator.password}`);
        return { outcome: "succeeded", exitCode: 12 } as never;
      }, async applyMigrations() { throw new Error("unused"); }, async collectDatabaseEvidence() { throw new Error("unused"); },
      async cleanup() {} },
      reviewedFiles: f.reviewedFiles,
      baseRuntime: { signal: original.signal, controlDeadlineMs: original.controlDeadlineMs,
        cleanupDeadlineMs: original.cleanupDeadlineMs, verifyExactRelease: original.verifyExactRelease,
        verifyExactMigrationLedger: original.verifyExactMigrationLedger,
        confirmOwnerAttachedTerminal: original.confirmOwnerAttachedTerminal },
    });
    let caught: unknown;
    try { await runtime.provisionDatabase(runtime.privateConfiguration, f.context); } catch (error) { caught = error; }
    assert.ok(caught instanceof Error);
    assert.equal(caught.message, "private_postgres_owner_adapter_uncertain");
    assert.equal(caught.stack, undefined);
    assert.doesNotMatch(String(caught), /operator-|psql failed/u);
  }
});

test("operation replies require their exact success or pre-effect shapes", async () => {
  for (const provisionResult of [
    { outcome: "succeeded" },
    { outcome: "succeeded", result: { exitCode: 0 } },
    { outcome: "failed_before_effect", exitCode: 0 },
  ]) {
    const f = fixture({ provisionResult });
    await assert.rejects(f.runtime.provisionDatabase(f.runtime.privateConfiguration, f.context),
      /private_postgres_owner_adapter_uncertain/u);
  }
  for (const migrationResult of [
    { outcome: "succeeded" },
    { outcome: "succeeded", exitCode: 0 },
    { outcome: "failed_before_effect", result: { private: "must-not-be-normalized" } },
  ]) {
    const f = fixture({ migrationResult });
    await assert.rejects(f.runtime.applyMigrations(f.runtime.privateConfiguration, f.context),
      /private_postgres_owner_adapter_uncertain/u);
  }
  const provision = fixture({ provisionResult: { outcome: "failed_before_effect" } });
  assert.deepEqual(await provision.runtime.provisionDatabase(provision.runtime.privateConfiguration, provision.context),
    { outcome: "failed_before_effect" });
  const migration = fixture({ migrationResult: { outcome: "failed_before_effect" } });
  assert.deepEqual(await migration.runtime.applyMigrations(migration.runtime.privateConfiguration, migration.context),
    { outcome: "failed_before_effect" });
});

test("cleanup closes the tool boundary and credential custody once, then prevents reuse", async () => {
  const f = fixture();
  assert.deepEqual(await f.runtime.cleanup(new AbortController().signal), { outcome: "confirmed" });
  assert.deepEqual(await f.runtime.cleanup(new AbortController().signal), { outcome: "confirmed" });
  assert.deepEqual(f.calls, ["cleanup-tools", "close-configuration"]);
  await assert.rejects(f.runtime.provisionDatabase(f.runtime.privateConfiguration, f.context),
    /private_postgres_owner_adapter_refused/u);
});

test("cleanup still closes credential custody when tool cleanup fails", async () => {
  const f = fixture(), original = f.runtime;
  let custodyCloses = 0;
  const runtime = createPrivatePostgresOwnerAdapterV1({
    custody: { async withConfiguration<T>(_signal: AbortSignal, use: (value: unknown) => Promise<T>) {
      return use(f.configuration); }, async close() { custodyCloses++; } },
    tools: { async provisionDatabase() { throw new Error("unused"); }, async applyMigrations() { throw new Error("unused"); },
      async collectDatabaseEvidence() { throw new Error("unused"); }, async cleanup() { throw new Error("private path"); } },
    reviewedFiles: f.reviewedFiles,
    baseRuntime: { signal: original.signal, controlDeadlineMs: original.controlDeadlineMs,
      cleanupDeadlineMs: original.cleanupDeadlineMs, verifyExactRelease: original.verifyExactRelease,
      verifyExactMigrationLedger: original.verifyExactMigrationLedger,
      confirmOwnerAttachedTerminal: original.confirmOwnerAttachedTerminal },
  });
  await assert.rejects(runtime.cleanup(new AbortController().signal), /private_postgres_owner_adapter_uncertain/u);
  await assert.rejects(runtime.cleanup(new AbortController().signal), /private_postgres_owner_adapter_uncertain/u);
  assert.equal(custodyCloses, 1);
});

test("cleanup attempts credential-custody close even when tool cleanup ignores abort forever", async () => {
  const f = fixture(), original = f.runtime;
  let custodyCloses = 0;
  const runtime = createPrivatePostgresOwnerAdapterV1({
    custody: { async withConfiguration<T>(_signal: AbortSignal, use: (value: unknown) => Promise<T>) {
      return use(f.configuration); }, async close() { custodyCloses++; } },
    tools: { async provisionDatabase() { throw new Error("unused"); }, async applyMigrations() { throw new Error("unused"); },
      async collectDatabaseEvidence() { throw new Error("unused"); }, async cleanup() { return new Promise<never>(() => {}); } },
    reviewedFiles: f.reviewedFiles,
    baseRuntime: { signal: original.signal, controlDeadlineMs: original.controlDeadlineMs,
      cleanupDeadlineMs: original.cleanupDeadlineMs, verifyExactRelease: original.verifyExactRelease,
      verifyExactMigrationLedger: original.verifyExactMigrationLedger,
      confirmOwnerAttachedTerminal: original.confirmOwnerAttachedTerminal },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10);
  try { await assert.rejects(runtime.cleanup(controller.signal), /private_postgres_owner_adapter_uncertain/u); }
  finally { clearTimeout(timer); }
  await assert.rejects(runtime.cleanup(new AbortController().signal), /private_postgres_owner_adapter_uncertain/u);
  assert.equal(custodyCloses, 1);
});

test("a delayed custody callback cannot start a tool after cancellation and cleanup", async () => {
  const f = fixture(), outer = new AbortController(), cleanup = new AbortController();
  let lend!: () => Promise<void>, settle!: () => void, toolCalls = 0, custodyCloses = 0;
  const held = new Promise<void>(resolve => { settle = resolve; });
  const runtime = createPrivatePostgresOwnerAdapterV1({
    custody: {
      async withConfiguration<T>(_signal: AbortSignal, use: (value: unknown) => Promise<T>) {
        return new Promise<T>((resolve, reject) => {
          lend = async () => { try { resolve(await use(f.configuration)); } catch (error) { reject(error); } finally { settle(); } };
        });
      },
      async close() { custodyCloses++; },
    },
    tools: {
      async provisionDatabase() { toolCalls++; return { outcome: "succeeded" as const, exitCode: 0 as const }; },
      async applyMigrations() { throw new Error("unused"); }, async collectDatabaseEvidence() { throw new Error("unused"); },
      async cleanup() {},
    },
    reviewedFiles: f.reviewedFiles,
    baseRuntime: { signal: outer.signal, controlDeadlineMs: 100, cleanupDeadlineMs: 100,
      verifyExactRelease: f.runtime.verifyExactRelease, verifyExactMigrationLedger: f.runtime.verifyExactMigrationLedger,
      confirmOwnerAttachedTerminal: f.runtime.confirmOwnerAttachedTerminal },
  });
  const context = { ...f.context, signal: outer.signal };
  const attempt = runtime.provisionDatabase(runtime.privateConfiguration, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof lend, "function");
  outer.abort();
  const closing = runtime.cleanup(cleanup.signal);
  await new Promise(resolve => setImmediate(resolve));
  await lend(); await held;
  await assert.rejects(attempt, /private_postgres_owner_adapter_uncertain/u);
  assert.deepEqual(await closing, { outcome: "confirmed" });
  assert.equal(toolCalls, 0);
  assert.equal(custodyCloses, 1);
});

test("a changed release binding refuses before private configuration or tools are touched", async () => {
  const f = fixture();
  const context = { ...f.context, request: { ...f.context.request, releaseDigest: digest("other-release") } };
  await assert.rejects(f.runtime.provisionDatabase(f.runtime.privateConfiguration, context),
    /private_postgres_owner_adapter_refused/u);
  assert.deepEqual(f.calls, []);
  assert.equal(f.requests.provision(), undefined);
});
