import assert from "node:assert/strict";
import test from "node:test";
import { computeDatabaseRestoreIdentity } from "../deploy/postgres/restore-identity.mjs";
import { createArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1, PRIVATE_RECOVERY_NATIVE_PROCESS_GROUP_RECEIPT_V1,
  createPrivateRecoveryNativeExecutionHostV1, privateRecoveryNativeFixedArgvV1,
  type PrivateRecoveryNativeExecutionChildV1, type PrivateRecoveryNativeExecutionHostPortsV1,
  type PrivateRecoveryNativeExecutionLaunchRequestV1 } from
  "../src/installer/v1/private-recovery-native-execution-host";
import { createPrivateRecoveryRehearsalAdapterV1 } from
  "../src/installer/v1/private-recovery-rehearsal-adapter";
import { PRIVATE_RECOVERY_INSTALLATION_BINDING_V1, PRIVATE_RECOVERY_OWNER_ATTACHED_TERMINAL_V1,
  type PrivateRecoveryRequestV1, type PrivateRecoveryRunnerContextV1 } from
  "../src/installer/v1/private-recovery-owner-runner";
import { sha256Digest as d } from "../src/security/canonical-digest";

function fixture(mode: "normal" | "force-kill" | "bad-retirement" = "normal") {
  const calls: string[] = [], launches: PrivateRecoveryNativeExecutionLaunchRequestV1[] = [];
  const controller = new AbortController();
  const identity = { ledgerDigest: d("ledger"), rolesDigest: d("roles"), membershipsDigest: d("memberships"),
    schemaDigest: d("schema"), rowsDigest: d("rows"), ownersDigest: d("owners"),
    ledgerRowsDigest: d("ledger-rows"), databaseOwnerDigest: d("database-owner") };
  const inventory = createArtifactBackupInventoryV1({ tenantId: "tenant:local", releaseId: "release:local",
    releaseDigest: d("release"), databaseSchemaVersion: "schema:local", databaseSchemaDigest: identity.schemaDigest,
    storageNamespace: "artifacts:local", storageNamespaceDigest: d("namespace"), entries: [{ artifactId: "artifact:one",
      contentHash: d("bytes"), sizeBytes: 4, manifestDigest: d("manifest"), receiptDigest: d("receipt") }] });
  const request: PrivateRecoveryRequestV1 = { installationPlanDigest: d("plan"), installationPlanRevision: 8,
    topologyPlanDigest: d("topology"), releaseDigest: d("release"), preparationDigest: d("preparation"),
    protectedDataBindingDigest: d("protected"), storageConfigurationDigest: d("configuration"),
    storageNamespaceDigest: d("namespace"), databaseAuthorityOutcomeDigest: d("database"),
    expectedDatabaseIdentityDigest: computeDatabaseRestoreIdentity(identity).identityDigest,
    expectedDatabaseSchemaDigest: identity.schemaDigest, ownerActionRequestDigest: d("owner-action"),
    operation: "owner_run_existing_backup_restore_rehearsal", requestDigest: d("request") };
  const binding = { schema: PRIVATE_RECOVERY_INSTALLATION_BINDING_V1, installationId: "installation-one",
    installationPlanDigest: request.installationPlanDigest, installationPlanRevision: request.installationPlanRevision,
    topologyPlanDigest: request.topologyPlanDigest, releaseDigest: request.releaseDigest,
    protectedDataBindingDigest: request.protectedDataBindingDigest,
    databaseAuthorityOutcomeDigest: request.databaseAuthorityOutcomeDigest };
  const context: PrivateRecoveryRunnerContextV1 = { ...binding, requestDigest: request.requestDigest,
    signal: controller.signal };
  const target = { sourceTargetDigest: d("source-target"), disposableTargetDigest: d("disposable-target"),
    sourceReadOnly: true, disposableTargetEmpty: true, disposableTargetOwned: true, protectedRestoreTargetEmpty: true,
    clusterRolesIsolated: true, sourceQuiesced: true };
  const backup = { sourceTargetDigest: target.sourceTargetDigest, databaseDumpDigest: d("dump"),
    databaseIdentity: identity, artifactInventory: inventory, consistentDatabaseSnapshot: true, protectedArtifactsHeld: true };
  const restored = { disposableTargetDigest: target.disposableTargetDigest, databaseDumpDigest: backup.databaseDumpDigest,
    databaseIdentity: structuredClone(identity), artifactInventory: structuredClone(inventory) };
  const login = { disposableTargetDigest: target.disposableTargetDigest, applicationLoginSucceeded: true,
    requiredReadsSucceeded: true, forbiddenWritesRefused: true, privilegeEscalationRefused: true,
    schedulerBoundaryVerified: true };
  const cleanup = { retired: true, backupRetained: true, sourceUnchanged: true, disposableTargetAccountedFor: true };
  let retirementWaits = 0;
  const child: PrivateRecoveryNativeExecutionChildV1 = {
    start(input) { calls.push("start"); launches.push(input); },
    async ready() { calls.push("ready"); return { schema: PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1, ready: true,
      freshProcessGroup: true, credentialsPrivate: true, protectedBackupDestinationHeld: true, operationEntered: false }; },
    async inspectDisposableTargets() { calls.push("inspect"); return target; },
    async backupDatabaseAndProtectedArtifacts() { calls.push("backup"); return backup; },
    async restoreExactBackup(selected) { calls.push("restore"); assert.deepEqual(selected,
      { databaseDumpDigest: backup.databaseDumpDigest, artifactInventoryDigest: inventory.inventoryDigest }); return restored; },
    async verifyRestrictedLogins() { calls.push("login"); return login; },
    async requestClose(signal) {
      calls.push("close");
      if (mode === "force-kill") return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
      return cleanup;
    },
    signalProcessGroupTerminate() { calls.push("term"); },
    signalProcessGroupKill() { calls.push("kill"); },
    async waitForProcessGroupRetirement(signal) {
      calls.push("wait"); retirementWaits += 1;
      if (mode === "force-kill" && retirementWaits < 3) return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("still-running")), { once: true }));
      return { schema: PRIVATE_RECOVERY_NATIVE_PROCESS_GROUP_RECEIPT_V1, processGroupRetired: true,
        leaderReaped: true, descendantsReaped: mode !== "bad-retirement" } as never;
    },
  };
  const configuration = { schema: PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1,
    releaseRoot: "/private/fixture/release", releaseDigest: request.releaseDigest, requestDigest: request.requestDigest,
    nativeHost: { path: "/private/fixture/bin/recovery-host", sha256: d("native-host") },
    reviewedFiles: { "deploy/postgres/backup-database.mjs": d("backup"),
      "deploy/postgres/restore-database.mjs": d("restore"),
      "deploy/postgres/restore-identity.mjs": d("identity"), "deploy/postgres/evidence.mjs": d("evidence"),
      "deploy/postgres/apply-migrations.mjs": d("migrations"),
      "deploy/postgres/migration-ledger.json": d("ledger-file"),
      "deploy/postgres/private-owner-dependency-manifest.json": d("dependencies"),
      "db/roles/production_roles.sql": d("roles-file") },
    executables: { node: { path: "/private/fixture/bin/node", sha256: d("node") },
      pg_dump: { path: "/private/fixture/bin/pg_dump", sha256: d("pg-dump") },
      pg_restore: { path: "/private/fixture/bin/pg_restore", sha256: d("pg-restore") } },
    operationDeadlineMs: 100, retirementDeadlineMs: 40, terminationGraceMs: 5,
    isolatedDisposableClusterRequired: true as const };
  const ports: PrivateRecoveryNativeExecutionHostPortsV1 = {
    async verifyExecution(input) { calls.push("verify"); return { schema: PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1,
      outcome: "verified", releaseDigest: input.releaseDigest, requestDigest: input.requestDigest,
      nativeHostSha256: input.nativeHost.sha256, toolchainDigest: input.toolchainDigest,
      pinProvenanceVerified: true, dependencyContentsVerified: true,
      extendedAclVerified: true, freshProcessGroupSupported: true }; },
    assertCurrent() { calls.push("authority"); },
    prepareLaunch() { calls.push("prepare"); return child; },
  };
  const host = createPrivateRecoveryNativeExecutionHostV1(configuration, ports);
  return { calls, launches, controller, request, binding, context, target, backup, restored, login, cleanup,
    identity, inventory, configuration, ports, child, host };
}

function assertSanitizedUncertain(error: unknown, privateDetail: string): boolean {
  assert.ok(error instanceof Error);
  assert.equal(error.message, "private_recovery_native_execution_host_uncertain");
  assert.equal(error.stack, undefined);
  assert.doesNotMatch(String(error), new RegExp(privateDetail, "u"));
  return true;
}

test("the existing rehearsal adapter uses one fixed private process session and retires the full process group", async () => {
  const f = fixture();
  const adapter = createPrivateRecoveryRehearsalAdapterV1({ request: f.request,
    runtime: { binding: f.binding, signal: f.controller.signal, controlDeadlineMs: 1_000,
      async confirmOwnerAttachedTerminal(context) { const { signal: _signal, ...fields } = context;
        return { ...fields, schema: PRIVATE_RECOVERY_OWNER_ATTACHED_TERMINAL_V1, ownerAttached: true as const,
          confirmed: true as const }; } }, ports: f.host, cleanupDeadlineMs: 100 });
  assert.deepEqual(f.calls, [], "construction is inert");
  const proof = await adapter.runExistingBackupRestoreRehearsal(f.context) as { databaseDumpDigest: string };
  assert.equal(proof.databaseDumpDigest, f.backup.databaseDumpDigest);
  assert.deepEqual(f.calls, ["verify", "prepare", "authority", "start", "ready", "inspect", "backup", "inspect", "restore",
    "login", "close", "wait"]);
  assert.equal(f.launches.length, 1);
  const launch = f.launches[0]!;
  assert.deepEqual(launch.argv, privateRecoveryNativeFixedArgvV1);
  assert.equal(launch.freshProcessGroup, true); assert.equal(launch.shell, false);
  assert.equal(launch.credentialsOnArgv, false); assert.equal(launch.isolatedDisposableClusterRequired, true);
  assert.equal(JSON.stringify(launch.argv).includes("password"), false);
  assert.equal(Object.hasOwn(launch, "sourceTarget"), false); assert.equal(Object.hasOwn(launch, "disposableTarget"), false);
  await assert.rejects(adapter.runExistingBackupRestoreRehearsal(f.context), /refused/u);
  assert.equal(f.launches.length, 1, "the same host cannot mint a second native session");
});

test("the host independently refuses a live-cluster alias or non-isolated cluster before backup", async () => {
  for (const changed of [{ clusterRolesIsolated: false }, { disposableTargetDigest: d("source-target") },
    { disposableTargetEmpty: false }] as const) {
    const f = fixture(); Object.assign(f.target, changed);
    const session = await f.host.open(f.context);
    await assert.rejects(session.inspectDisposableTargets(f.context.signal), /_refused/u);
    await assert.rejects(session.backupDatabaseAndProtectedArtifacts(f.context.signal), /_refused/u,
      "catching an invalid target observation cannot advance the native session to backup");
    assert.equal(f.calls.includes("backup"), false);
    await assert.rejects(session.close(f.context.signal), /_uncertain/u);
  }
});

test("fixed operation ordering cannot be used as a generic command or alternate recovery authority", async () => {
  const f = fixture(), session = await f.host.open(f.context);
  await assert.rejects(session.restoreExactBackup({ databaseDumpDigest: d("dump"), artifactInventoryDigest: d("inventory") },
    f.context.signal), /_refused/u);
  assert.equal(f.calls.includes("restore"), false);
  await session.inspectDisposableTargets(f.context.signal);
  await assert.rejects(session.verifyRestrictedLogins(f.context.signal), /_refused/u);
  assert.equal(f.calls.includes("login"), false);
  await session.close(f.context.signal);
  assert.deepEqual(Reflect.ownKeys(session), ["inspectDisposableTargets", "backupDatabaseAndProtectedArtifacts",
    "restoreExactBackup", "verifyRestrictedLogins", "close"]);
});

test("a changed binding, asynchronous authority fence, accessor or proxy refuses before launch", async () => {
  const changed = fixture();
  await assert.rejects(changed.host.open({ ...changed.context, requestDigest: d("other") }), /_refused/u);
  assert.equal(changed.launches.length, 0); assert.deepEqual(changed.calls, []);

  const asynchronous = fixture();
  const host = createPrivateRecoveryNativeExecutionHostV1(asynchronous.configuration,
    { ...asynchronous.ports, async assertCurrent() {} });
  await assert.rejects(host.open(asynchronous.context), /_refused/u);
  assert.equal(asynchronous.launches.length, 0);
  assert.deepEqual(asynchronous.calls.filter(value => ["prepare", "start", "close", "wait"].includes(value)),
    ["prepare", "close", "wait"], "a rejected final fence retires the dormant handle without starting it");

  const accessor = fixture(); let reads = 0;
  const hostile: Record<string, unknown> = { ...accessor.configuration };
  Object.defineProperty(hostile, "releaseRoot", { enumerable: true, get() { reads += 1; return "/private/fixture/release"; } });
  assert.throws(() => createPrivateRecoveryNativeExecutionHostV1(hostile, accessor.ports), /_refused/u);
  assert.equal(reads, 0);
  assert.throws(() => createPrivateRecoveryNativeExecutionHostV1(accessor.configuration,
    new Proxy(accessor.ports, {})), /_refused/u);
});

test("the complete dormant lifecycle is captured before start and an uncertain start uses that retirement handle", async () => {
  const malformed = fixture(); let malformedStarts = 0;
  const malformedHost = createPrivateRecoveryNativeExecutionHostV1(malformed.configuration, {
    ...malformed.ports,
    prepareLaunch() { malformed.calls.push("prepare"); return { start() { malformedStarts += 1; } } as never; },
  });
  await assert.rejects(malformedHost.open(malformed.context), /_uncertain/u);
  assert.equal(malformedStarts, 0, "a malformed dormant handle is rejected before any start method can run");

  const uncertainStart = fixture();
  const original = uncertainStart.child.start;
  uncertainStart.child.start = ((request: PrivateRecoveryNativeExecutionLaunchRequestV1) => {
    original.call(uncertainStart.child, request);
    return Promise.resolve();
  }) as never;
  await assert.rejects(uncertainStart.host.open(uncertainStart.context), /_uncertain/u);
  assert.deepEqual(uncertainStart.calls.filter(value => ["start", "close", "wait"].includes(value)),
    ["start", "close", "wait"], "post-start uncertainty retains and retires the already captured group handle");
});

test("same-tick owner and operation aborts never enter the queued native operation", async () => {
  for (const source of ["owner", "operation"] as const) {
    const f = fixture(), session = await f.host.open(f.context);
    await session.inspectDisposableTargets(f.context.signal);
    const operation = new AbortController();
    const pending = session.backupDatabaseAndProtectedArtifacts(operation.signal);
    if (source === "owner") f.controller.abort(); else operation.abort();
    await assert.rejects(pending, /_uncertain/u);
    assert.equal(f.calls.includes("backup"), false,
      `${source} cancellation in the call's tick must win before the queued native method`);
    assert.deepEqual(f.calls.filter(value => ["close", "wait"].includes(value)), ["close", "wait"]);
  }

  const already = fixture(), session = await already.host.open(already.context);
  await session.inspectDisposableTargets(already.context.signal);
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(session.backupDatabaseAndProtectedArtifacts(stopped.signal), /_refused/u);
  assert.equal(already.calls.includes("backup"), false);
  await session.close(already.context.signal);
});

test("start and native-operation failures are sanitized only after process-group retirement", async () => {
  const start = fixture();
  start.child.start = (() => { start.calls.push("start"); throw new Error("private-start-path"); }) as never;
  await assert.rejects(start.host.open(start.context), error => {
    assert.deepEqual(start.calls.filter(value => ["start", "close", "wait"].includes(value)),
      ["start", "close", "wait"]);
    return assertSanitizedUncertain(error, "private-start-path");
  });

  const operation = fixture();
  operation.child.backupDatabaseAndProtectedArtifacts = async () => {
    operation.calls.push("backup"); throw new Error("private-backup-target");
  };
  const session = await operation.host.open(operation.context);
  await session.inspectDisposableTargets(operation.context.signal);
  await assert.rejects(session.backupDatabaseAndProtectedArtifacts(operation.context.signal), error => {
    assert.deepEqual(operation.calls.filter(value => ["backup", "close", "wait"].includes(value)),
      ["backup", "close", "wait"]);
    return assertSanitizedUncertain(error, "private-backup-target");
  });
});

test("deadline retirement escalates TERM to KILL and cannot turn forced cleanup into readiness", async () => {
  const f = fixture("force-kill"), session = await f.host.open(f.context);
  await session.inspectDisposableTargets(f.context.signal);
  await assert.rejects(session.close(f.context.signal), /_uncertain/u);
  assert.deepEqual(f.calls.filter(value => ["close", "term", "kill", "wait"].includes(value)),
    ["close", "wait", "term", "wait", "kill", "wait"]);
});

test("stalled close and reap attempts share one absolute retirement deadline", { timeout: 2_000 }, async () => {
  const f = fixture();
  f.configuration.retirementDeadlineMs = 180;
  f.configuration.terminationGraceMs = 30;
  const stall = (signal: AbortSignal) => new Promise<never>((_resolve, reject) =>
    signal.addEventListener("abort", () => reject(new Error("private-retirement-detail")), { once: true }));
  f.child.requestClose = signal => { f.calls.push("close"); return stall(signal); };
  f.child.waitForProcessGroupRetirement = signal => { f.calls.push("wait"); return stall(signal); };
  const host = createPrivateRecoveryNativeExecutionHostV1(f.configuration, f.ports);
  const session = await host.open(f.context), started = performance.now();
  await assert.rejects(session.close(f.context.signal), /_uncertain/u);
  const elapsed = performance.now() - started;
  assert.deepEqual(f.calls.filter(value => ["close", "wait", "term", "kill"].includes(value)),
    ["close", "wait", "term", "wait", "kill", "wait"]);
  assert.ok(elapsed >= 140, `stalled retirement returned too early after ${elapsed}ms`);
  assert.ok(elapsed < 230, `retirement steps received additive deadlines and took ${elapsed}ms`);
});

test("short valid retirement budgets still reserve TERM, KILL and final reap", { timeout: 2_000 }, async () => {
  for (const [deadline, grace] of [[121, 60], [150, 60]] as const) {
    const f = fixture();
    f.configuration.retirementDeadlineMs = deadline;
    f.configuration.terminationGraceMs = grace;
    const stall = (signal: AbortSignal) => new Promise<never>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("private-retirement-detail")), { once: true }));
    f.child.requestClose = signal => { f.calls.push("close"); return stall(signal); };
    f.child.waitForProcessGroupRetirement = signal => { f.calls.push("wait"); return stall(signal); };
    const host = createPrivateRecoveryNativeExecutionHostV1(f.configuration, f.ports);
    const session = await host.open(f.context), started = performance.now();
    await assert.rejects(session.close(f.context.signal), /_uncertain/u);
    const elapsed = performance.now() - started;
    assert.deepEqual(f.calls.filter(value => ["close", "wait", "term", "kill"].includes(value)),
      ["close", "wait", "term", "wait", "kill", "wait"]);
    assert.ok(elapsed < deadline + 50, `retirement exceeded the absolute budget tolerance after ${elapsed}ms`);
  }
});

test("malformed process-group retirement remains uncertain even after an otherwise clean session", async () => {
  const f = fixture("bad-retirement"), session = await f.host.open(f.context);
  await session.inspectDisposableTargets(f.context.signal);
  await assert.rejects(session.close(f.context.signal), /_uncertain/u);
});

test("cancellation aborts the active native operation and retirement remains the only exit", async () => {
  const f = fixture();
  f.child.backupDatabaseAndProtectedArtifacts = async signal => {
    f.calls.push("backup"); return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("private target detail")), { once: true }));
  };
  const session = await f.host.open(f.context);
  await session.inspectDisposableTargets(f.context.signal);
  const pending = session.backupDatabaseAndProtectedArtifacts(f.context.signal);
  f.controller.abort();
  await assert.rejects(pending, /_uncertain/u);
  await assert.rejects(session.close(new AbortController().signal), /_uncertain/u);
  assert.equal(f.calls.filter(value => value === "start").length, 1);
  assert.equal(f.calls.includes("wait"), true);
});

test("a cancelled close signal cannot skip process-group retirement or report clean cleanup", async () => {
  const f = fixture(), session = await f.host.open(f.context);
  const close = new AbortController(); close.abort();
  await assert.rejects(session.close(close.signal), /_uncertain/u);
  assert.deepEqual(f.calls.filter(value => ["close", "wait"].includes(value)), ["close", "wait"]);
});

test("source surface contains no child-process, database, credential, provisioning or tool execution default", async () => {
  const source = await import("node:fs/promises").then(fs =>
    fs.readFile("src/installer/v1/private-recovery-native-execution-host.ts", "utf8"));
  assert.doesNotMatch(source, /from "node:(?:child_process|fs|net)"|\bspawn\s*\(|\bexecFile\s*\(|new Client\s*\(/u);
  assert.doesNotMatch(source, /provisionDatabase|CONTROL_ROOM_[A-Z_]+_PASSWORD|postgresql:\/\//u);
});
