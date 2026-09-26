import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CODEX_APP_SERVER_CAPABILITY, CODEX_APP_SERVER_ADAPTER,
  CODEX_DELIVERY_FEATURE } from "../src/harness/codex-v1/delivery-contract";
import { CODEX_RESULT_RETURN_FEATURE_V1 } from "../src/harness/codex-v1/result-return";
import { HERMES_021_MACOS_LOCAL_ADAPTER_V1 } from "../src/harness/hermes-021-v1/macos-local-worker";
import { createCodexPhysicalQualificationReceiptBodyV1 } from "../src/harness/codex-v1/result-publication-contract";
import { CODEX_APP_SERVER_READ_CONTRACT, CODEX_APP_SERVER_RESULT_CONTRACT,
  CODEX_APP_SERVER_START_CONTRACT } from "../src/harness/codex-v1/schema-contract";
import { signArtifact } from "../src/node-policy/v1/crypto";
import { sha256Digest } from "../src/security";
import { createInstallationReadinessV1 } from "../src/harness/v1/installation-readiness";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { createArtifactBackupInventoryV1, verifyRestoredArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { createLocalBackupRestoreReadinessV1 } from "../src/harness/v1/local-backup-restore-readiness";
import { createCodexMacosCustodyReadinessV1 } from "../src/harness/codex-v1/macos-custody-readiness";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";
import { createClaudeCodeLocalProcessReadinessV1 } from "../src/harness/claude-code-v1/local-process-readiness";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "../src/harness/claude-code-v1/task-planning-contract";
import { createPrivateTaskHost } from "../src/web/v1/private-task-host";
import { startPrivateHostLifecycle } from "../src/web/v1/private-host-lifecycle";
import { bindPrivateCodexResultReturnV1, validatePrivateTaskStartupConfiguration,
  type PrivateTaskStartupConfiguration } from "../src/web/v1/private-task-startup";
import { createTaskCoordinatorLifecycle, type TaskCoordinatorConfiguration } from "../src/web/v1/task-coordinator-lifecycle";
import { privateArtifactStorageNamespaceDigestV1 } from "../src/web/v1/private-artifact-storage";
import { instant } from "./hermes-native-fixture";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";
import { assemblePrivateAgentTaskOperatorConfiguration } from "../src/web/v1/private-agent-task-operator-configuration";
import { operatorConfigurationScenario } from "./helpers/private-agent-task-operator-configuration";

const handler = async () => new Response("synthetic");
const assets = { count: 0, digest: "synthetic", respond: () => undefined };

function localBackupRestoreProof(planDigest: string) {
  const inventory = createArtifactBackupInventoryV1({ tenantId: "tenant:local", releaseId: "release:local",
    releaseDigest: sha256Digest("release"), databaseSchemaVersion: "schema:local", databaseSchemaDigest: sha256Digest("schema"),
    storageNamespace: "artifact-namespace:local", storageNamespaceDigest: sha256Digest("namespace"),
    entries: [{ artifactId: "artifact:local", contentHash: sha256Digest("bytes"), sizeBytes: 5,
      manifestDigest: sha256Digest("manifest"), receiptDigest: sha256Digest("receipt") }], });
  return createLocalBackupRestoreReadinessV1({ planDigest, databaseRestore: { tenantId: "tenant:local", releaseId: "release:local",
    releaseDigest: sha256Digest("release"), databaseIdentityDigest: sha256Digest("database-identity"),
    databaseDumpDigest: sha256Digest("database-dump"), databaseSchemaVersion: "schema:local", databaseSchemaDigest: sha256Digest("schema"),
    restoredToDisposableTarget: true, promoted: false, startsWork: false, grantsExecutionAuthority: false,
    permitsRetry: false, permitsCleanup: false }, expectedArtifactInventory: inventory,
    restoredArtifactInventory: structuredClone(inventory),
    artifactRestoreVerification: verifyRestoredArtifactBackupInventoryV1({ expected: inventory, restored: inventory }) });
}

function resultReturnQualification(tenantId = "tenant:test", nodeId = "node:test") {
  const keys = generateKeyPairSync("ed25519");
  const publicKeySpki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const connectorProfileDigest = sha256Digest("private-result-return-profile");
  const withDigest = <T extends object>(value: T) => ({ ...value, evidenceDigest: sha256Digest(value) });
  const body = createCodexPhysicalQualificationReceiptBodyV1({
    schema: "control-room.codex-physical-qualification-receipt/v1", qualificationId: "qualification:private-result",
    qualificationSignerKeyId: "qualification-key:private-result", tenantId, nodeId,
    connectorProfileId: "profile:private-result", connectorProfileDigest,
    exactPackage: { adapterId: CODEX_APP_SERVER_ADAPTER, packageName: CODEX_APP_SERVER_READ_CONTRACT.package,
      packageVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
      generatedSchemaBundleSha256: CODEX_APP_SERVER_READ_CONTRACT.generatedBundleSha256,
      threadStartParamsSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.threadStart.paramsSchemaSha256,
      threadStartResponseSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.threadStart.responseSchemaSha256,
      turnStartParamsSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.turnStart.paramsSchemaSha256,
      turnStartResponseSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.turnStart.responseSchemaSha256,
      threadReadResponseSchemaSha256: CODEX_APP_SERVER_RESULT_CONTRACT.threadReadResponseSchemaSha256,
      agentMessageSourceSha256: CODEX_APP_SERVER_RESULT_CONTRACT.agentMessageSourceSha256 },
    qualifiedAt: new Date(instant - 1_000).toISOString(),
    start: withDigest({ evidenceId: "evidence:private-result:start", processAttemptId: "process:private-result:start",
      connectionAttemptId: "connection:private-result:start", initializedConnectionDigest: sha256Digest("start"),
      threadId: "thread:private-result", turnId: "turn:private-result", startObserved: true as const,
      cleanupVerified: true as const }),
    restartRead: withDigest({ evidenceId: "evidence:private-result:restart", processAttemptId: "process:private-result:restart",
      connectionAttemptId: "connection:private-result:restart", initializedConnectionDigest: sha256Digest("restart"),
      threadId: "thread:private-result", turnId: "turn:private-result", itemId: "item:private-result",
      restartObserved: true as const, exactReadObserved: true as const, cleanupVerified: true as const }),
    oneFreshProcessPerAttempt: true, sameDurableThreadObserved: true, sameDurableTurnObserved: true,
    terminalCleanupVerified: true, processReuseObserved: false, retryObserved: false,
    canonicalPublicationAllowed: false, completionVerified: false, grantsExecutionAuthority: false,
    permitsRetry: false, permitsResume: false, permitsThreadRead: false,
  });
  return { connectorProfileDigest, settings: { qualificationReceipt: signArtifact(body, keys.privateKey),
    qualificationPublicKeySpki: publicKeySpki, qualificationMaximumAgeMs: 300_000 } };
}

test("agent-tasks composition acquires, becomes ready, drains and closes every owned resource exactly once", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario();
  let installed = 0, submissionCloses = 0;
  let installedApplication: { handle(request: Request, render: () => Response | Promise<Response>): Promise<Response> } | undefined;
  const host = createPrivateTaskHost({
    clock: f.lifecycle.f.clock,
    openDatabase: f.openDatabase,
    install(application) { installed++; installedApplication = application as unknown as typeof installedApplication; f.trace.push("install"); },
    prepareNativeSubmission: async () => {
      f.trace.push("submission-open");
      return { async enqueueInSession() { throw new Error("synthetic_inert_submission"); },
        async recoverUnsentInSession() { return false; },
        async close() { submissionCloses++; f.trace.push("submission-close"); } };
    },
    startNativeWorker: f.startNativeWorker,
    createNativeServer: (() => f.makeServer("native")) as never,
    createServer: (() => f.makeServer("web")) as never,
  });
  const runtime = await host.start({ configuration: f.configuration, port: 3210, nativeHttps: f.tls, handler, assets });
  assert.equal(runtime.isReady(), true); assert.equal(installed, 1);
  assert.equal(f.configuration.coordinator.codex, undefined);
  const hermesCalls = f.lifecycle.local.calls.length;
  assert.deepEqual(f.trace.slice(0, 16), [
    "pool-open:web_test", "pool-open:coordinator_test", "pool-open:result_test", "pool-open:evidence_test",
    "pool-open:session_test", "submission-open", "worker-pool-open", "queue-constructor", "queue-error-listener",
    "queue-start", "queue-poller-start", "install", "native-listen", "web-listen",
  ]);
  assert.deepEqual(f.servers.map(server => [server.boundHost, server.boundPort]), [["127.0.0.1", 443], ["127.0.0.1", 3210]]);
  assert.deepEqual(f.workerStatus(), { state: "running", faulted: false, accepting: true });
  const firstClose = runtime.close();
  assert.equal(runtime.isReady(), false);
  while (!f.trace.includes("queue-poller-stop")) await new Promise(resolve => setImmediate(resolve));
  const unavailable = await installedApplication!.handle(new Request(`${f.configuration.web.origin}/`), () => new Response("unused"));
  assert.equal(unavailable.status, 503);
  assert.equal(runtime.close(), firstClose);
  await firstClose;
  assert.equal(submissionCloses, 1); assert.deepEqual(f.workerStatus(), { state: "closed", faulted: false, accepting: false });
  await assert.rejects(f.poll(), /native_task_delivery_unresolved/);
  assert.equal(f.lifecycle.local.calls.length, hermesCalls, "synthetic queue polling must not invoke Hermes");
  assert.equal(f.servers.length, 2); assert.ok(f.servers.every(server => server.bindCount === 1 && server.closeCount === 1));
  assert.ok(f.trace.indexOf("queue-poller-stop") < f.trace.indexOf("submission-close"));
  assert.ok(f.trace.indexOf("worker-pool-close") < f.trace.indexOf("submission-close"));
  assert.equal(f.workerPool.closes(), 1);
  for (const name of ["web_test", "coordinator_test", "result_test", "evidence_test", "session_test"])
    assert.equal(f.pools.get(name)?.closes(), 1, name);
});

test("a disconnect on any owned pool closes the composition to new work and a reconnect restores it", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario();
  let installedApplication: { handle(request: Request, render: () => Response | Promise<Response>): Promise<Response> } | undefined;
  const host = createPrivateTaskHost({
    clock: f.lifecycle.f.clock, openDatabase: f.openDatabase,
    install(application) { installedApplication = application as unknown as typeof installedApplication; },
    prepareNativeSubmission: async () => ({ async enqueueInSession() { throw new Error("synthetic_inert_submission"); },
      async recoverUnsentInSession() { return false; }, async close() {} }),
    startNativeWorker: f.startNativeWorker,
    createNativeServer: (() => f.makeServer("native")) as never,
    createServer: (() => f.makeServer("web")) as never,
  });
  const runtime = await host.start({ configuration: f.configuration, port: 3210, nativeHttps: f.tls, handler, assets });
  assert.equal(runtime.isReady(), true);
  const probe = () => installedApplication!.handle(new Request(`${f.configuration.web.origin}/`),
    () => new Response("rendered"));
  assert.notEqual((await probe()).status, 503);
  // Every pool the composition acquired participates in readiness. Losing any
  // one of them must fail closed for new browser work without tearing the
  // composition down, and restoring the same pool must make it serve again.
  for (const login of ["web_test", "coordinator_test", "result_test", "evidence_test", "session_test"]) {
    f.disconnect(login);
    assert.equal(runtime.isReady(), false, `${login} disconnected`);
    assert.equal((await probe()).status, 503, `${login} disconnected`);
    f.reconnect(login);
    assert.equal(runtime.isReady(), true, `${login} reconnected`);
    assert.notEqual((await probe()).status, 503, `${login} reconnected`);
  }
  // A disconnect is not a close: nothing was drained while the pool was away.
  for (const [name, pool] of f.pools) assert.equal(pool.closes(), 0, name);
  assert.equal(f.workerPool.closes(), 0);
  await runtime.close();
  assert.equal(runtime.isReady(), false);
  for (const [name, pool] of f.pools) assert.equal(pool.closes(), 1, name);
  assert.equal(f.workerPool.closes(), 1);
});

test("a restarted composition restores durable delivery state and refuses to execute the same attempt twice", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  // The lifecycle fixture already staged, transmitted and receipted this
  // attempt, so the durable record proves the work was executed once.
  const before = await fixture.scenario().durableEvidence();
  assert.deepEqual(before, { envelopes: 1, intents: 1, receipts: 1, runs: 0, recoveries: 0 });

  const compose = async (label: string) => {
    const f = fixture.scenario();
    const host = createPrivateTaskHost({
      clock: f.lifecycle.f.clock, openDatabase: f.openDatabase, install() {},
      prepareNativeSubmission: async () => ({ async enqueueInSession() { throw new Error("synthetic_inert_submission"); },
        // A recovering producer that would happily re-send. The canonical fence,
        // not the producer, is what must refuse the second execution.
        async recoverUnsentInSession() { return true; }, async close() {} }),
      startNativeWorker: f.startNativeWorker,
      createNativeServer: (() => f.makeServer("native")) as never,
      createServer: (() => f.makeServer("web")) as never,
    });
    const runtime = await host.start({ configuration: f.configuration, port: 3210, nativeHttps: f.tls, handler, assets });
    assert.equal(runtime.isReady(), true, label);
    assert.equal(typeof runtime.queueRecovery?.verify, "function", label);
    assert.equal(typeof runtime.queueRecovery?.recover, "function", label);
    assert.equal(typeof runtime.queueDelivery, "function", label);
    return { f, runtime };
  };

  const signal = new AbortController().signal;
  const first = await compose("first start");
  // A locator whose packet digest does not match the durable queue intent never
  // reaches the canonical fence: queue authorization refuses it outright.
  await assert.rejects(first.runtime.queueRecovery!.recover(first.f.reference, signal), /access_denied/);
  await assert.rejects(first.runtime.queueRecovery!.verify(first.f.reference, 1, signal), /access_denied/);
  // The canonical locator is admitted by queue authorization, so the refusal
  // below is the never-staged fence: this attempt already has a delivery
  // envelope, transmission intent and receipt.
  await assert.rejects(first.runtime.queueRecovery!.recover(first.f.approvedReference, signal), /conflict/);
  await assert.rejects(first.runtime.queueRecovery!.verify(first.f.approvedReference, 1, signal), /conflict/);
  await assert.rejects(first.f.poll({ retryCount: 1, canonical: true }), /native_task_delivery_unresolved/);
  await assert.rejects(first.f.poll({ retryCount: 1 }), /native_task_delivery_unresolved/);
  await first.runtime.close();
  assert.equal(first.runtime.isReady(), false);
  for (const [name, pool] of first.f.pools) assert.equal(pool.closes(), 1, `first ${name}`);
  assert.deepEqual(await first.f.durableEvidence(), before, "first start must not add durable execution evidence");

  // Restart: an entirely new composition over the same durable database, with
  // new pools, a new producer and a new worker. No process state is shared, so
  // every refusal below is derived from rows the previous run left behind.
  const second = await compose("restart");
  assert.notEqual(second.f.pools.get("web_test"), first.f.pools.get("web_test"));
  await assert.rejects(second.runtime.queueRecovery!.recover(second.f.reference, signal), /access_denied/);
  await assert.rejects(second.runtime.queueRecovery!.verify(second.f.reference, 1, signal), /access_denied/);
  await assert.rejects(second.runtime.queueRecovery!.recover(second.f.approvedReference, signal), /conflict/);
  await assert.rejects(second.runtime.queueRecovery!.verify(second.f.approvedReference, 1, signal), /conflict/);
  await assert.rejects(second.f.poll({ retryCount: 1, canonical: true }), /native_task_delivery_unresolved/);
  await assert.rejects(second.f.poll({ canonical: true }), /native_task_delivery_unresolved/);
  await assert.rejects(second.f.poll({ retryCount: 1 }), /native_task_delivery_unresolved/);
  await assert.rejects(second.f.poll(), /native_task_delivery_unresolved/);
  await second.runtime.close();
  for (const [name, pool] of second.f.pools) assert.equal(pool.closes(), 1, `restart ${name}`);
  assert.deepEqual(await second.f.durableEvidence(), before, "restart must not duplicate execution");
});

test("configuration and host mismatches refuse before any resource or listener opens", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  for (const mode of ["invalid-port", "database-host", "native-port", "worker-profile"] as const) await t.test(mode, async () => {
    const f = fixture.scenario();
    const host = createPrivateTaskHost({ clock: f.lifecycle.f.clock, openDatabase: f.openDatabase, install() { throw new Error("must_not_install"); },
      prepareNativeSubmission: async () => { throw new Error("must_not_prepare"); },
      startNativeWorker: async () => { throw new Error("must_not_start_worker"); },
      createServer: (() => f.makeServer("web")) as never, createNativeServer: (() => f.makeServer("native")) as never });
    let configuration: PrivateTaskStartupConfiguration = f.configuration;
    if (mode === "database-host") configuration = { ...f.configuration, coordinator: { ...f.configuration.coordinator,
      database: { ...f.configuration.coordinator.database, host: "127.0.0.2" } } } as unknown as PrivateTaskStartupConfiguration;
    if (mode === "worker-profile") configuration = { ...f.configuration, coordinator: { ...f.configuration.coordinator,
      queueWorker: { database: f.configuration.coordinator.database, concurrency: 2 } } };
    const tls = mode === "native-port" ? { ...f.tls, port: 444 } : f.tls;
    await assert.rejects(host.start({ configuration, port: mode === "invalid-port" ? 0 : 3210, nativeHttps: tls, handler, assets }),
      { message: mode === "invalid-port" || mode === "native-port" ? "private_task_host_config_invalid" : "private_task_startup_config_invalid" });
    assert.deepEqual(f.trace, []); assert.equal(f.servers.length, 0);
  });
});

test("Codex result-return startup requires the complete trusted composition and binds its one storage port", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario(), qualification = resultReturnQualification();
  const storage = { async put() { throw new Error("inert"); }, async read() { return undefined; } };
  const rootPath = "/synthetic/private-result-storage", storageNamespace = "private-result-storage";
  const base = f.configuration, baseTasks = base.web.tasks!;
  const valid: PrivateTaskStartupConfiguration = {
    ...base,
    artifactStorage: { local: { rootPath, maximumArtifacts: 100, maximumFileBytes: 65_536,
      maximumTotalBytes: 6_553_600, operationTimeoutMs: 1_000 }, inventory: {
      releaseId: "release:private-result", releaseDigest: sha256Digest("release:private-result"),
      databaseSchemaVersion: "schema:private-result", databaseSchemaDigest: sha256Digest("schema:private-result"),
      storageNamespace, storageNamespaceDigest: privateArtifactStorageNamespaceDigestV1(storageNamespace, rootPath),
    } },
    web: { ...base.web, tasks: { ...baseTasks, results: {
      ...baseTasks.results!, storageClass: "local", storage,
    } } },
    coordinator: {
      ...base.coordinator,
      routes: base.coordinator.routes.map(route => ({ ...route, capabilityProbeId: CODEX_APP_SERVER_CAPABILITY })),
      quality: { ...base.coordinator.quality!, results: { ...base.coordinator.quality!.results,
        storageClass: "local", storage } },
      evidence: { ...base.coordinator.evidence!, storage: { ...base.coordinator.evidence!.storage,
        storageClass: "local", storage } },
      sessions: { ...base.coordinator.sessions!, nodes: base.coordinator.sessions!.nodes.map(node => ({ ...node,
        features: [...node.features, CODEX_DELIVERY_FEATURE, CODEX_RESULT_RETURN_FEATURE_V1] })) },
      codex: { integrityKey: new Uint8Array(32).fill(94), enrollments: [{
        tenantId: "tenant:test", nodeId: "node:test", nodeClass: "personal-compute",
        enrollmentDigest: sha256Digest("private-result-enrollment"),
        connectorProfileDigest: qualification.connectorProfileDigest,
        workspaceIntentDigest: sha256Digest("private-result-workspace"), credentialRef: "credential:private-result",
        filesystemRoot: "/synthetic", workspacePath: "/synthetic/workspace", validUntil: instant + 300_000,
        approvalKeyId: "approval-key:private-result", approvals: { binding: () => ({
          tenantId: "tenant:test", nodeId: "node:test", nodeClass: "personal-compute" }), assertAvailable() {},
        async resolveApprovalKey() { return new Uint8Array(32); } },
        security: { currentServerTrustRevision: () => "trust-revision:private-result" },
      }] },
      codexResultReturn: qualification.settings,
    },
  };
  const captured = validatePrivateTaskStartupConfiguration(valid);
  assert.equal(captured.codexResultReturn?.qualificationReceipt.body.nodeId, "node:test");
  const bound = bindPrivateCodexResultReturnV1(captured.codexResultReturn!, storage);
  assert.equal(bound.storage, storage);
  assert.deepEqual(bound.qualificationReceipt, captured.codexResultReturn!.qualificationReceipt);

  const invalid = [
    { name: "codex", value: { ...valid, coordinator: { ...valid.coordinator, codex: undefined } } },
    { name: "quality", value: { ...valid, coordinator: { ...valid.coordinator, quality: undefined } } },
    { name: "result database", value: { ...valid, coordinator: { ...valid.coordinator, resultDatabase: undefined } } },
    { name: "sessions", value: { ...valid, coordinator: { ...valid.coordinator, sessions: undefined } } },
    { name: "artifact storage", value: { ...valid, artifactStorage: undefined } },
    { name: "negotiated feature", value: { ...valid, coordinator: { ...valid.coordinator, sessions: {
      ...valid.coordinator.sessions!, nodes: valid.coordinator.sessions!.nodes.map(node => ({ ...node,
        features: node.features.filter(feature => feature !== CODEX_RESULT_RETURN_FEATURE_V1) })) } } } },
    { name: "qualification profile", value: { ...valid, coordinator: { ...valid.coordinator, codex: {
      ...valid.coordinator.codex!, enrollments: valid.coordinator.codex!.enrollments.map(value => ({ ...value,
        connectorProfileDigest: sha256Digest("wrong-private-result-profile") })) } } } },
    { name: "qualification tenant", value: { ...valid, coordinator: { ...valid.coordinator,
      codexResultReturn: resultReturnQualification("tenant:other").settings } } },
    { name: "qualification node", value: { ...valid, coordinator: { ...valid.coordinator,
      codexResultReturn: resultReturnQualification("tenant:test", "node:other").settings } } },
  ];
  for (const entry of invalid) assert.throws(() => validatePrivateTaskStartupConfiguration(
    entry.value as PrivateTaskStartupConfiguration), /private_task_startup_config_invalid/, entry.name);
});

test("each database acquisition failure closes only resources already returned", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  for (let failure = 1; failure <= 5; failure++) await t.test(`pool-${failure}`, async () => {
    const f = fixture.scenario(); let opens = 0;
    const host = createPrivateTaskHost({ clock: f.lifecycle.f.clock, openDatabase(database) {
      opens++; if (opens === failure) throw new Error("synthetic_open_failure"); return f.openDatabase(database);
    }, install() {}, prepareNativeSubmission: async () => { throw new Error("must_not_prepare"); },
    startNativeWorker: async () => { throw new Error("must_not_start_worker"); },
    createServer: (() => f.makeServer("web")) as never, createNativeServer: (() => f.makeServer("native")) as never });
    await assert.rejects(host.start({ configuration: f.configuration, port: 3210, nativeHttps: f.tls, handler, assets }),
      { message: "private_task_startup_prerequisites_failed" });
    assert.equal(opens, failure); assert.equal(f.servers.length, 0);
    const opened = [...f.pools.keys()].slice(0, failure - 1);
    for (const [name, pool] of f.pools) assert.equal(pool.closes(), opened.includes(name) ? 1 : 0, name);
  });
});

test("submission failures, timeout and an aborted late return leave no producer, worker or listener alive", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  for (const mode of ["throw", "malformed", "late-abort", "timeout"] as const) await t.test(mode, async t => {
    const f = fixture.scenario(); let producerCloses = 0, workerStarts = 0;
    let release: ((value: { enqueueInSession(): Promise<never>; recoverUnsentInSession(): Promise<boolean>; close(): Promise<void> }) => void) | undefined;
    const deferred = new Promise<{ enqueueInSession(): Promise<never>; recoverUnsentInSession(): Promise<boolean>; close(): Promise<void> }>(resolve => { release = resolve; });
    const controller = new AbortController();
    if (mode === "timeout") {
      const schedule = globalThis.setTimeout;
      t.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
        schedule(callback, delay === 5000 ? 1 : delay, ...args)) as never);
    }
    const host = createPrivateTaskHost({ clock: f.lifecycle.f.clock, openDatabase: f.openDatabase, install() {},
      prepareNativeSubmission: async () => {
        f.trace.push("submission-open");
        if (mode === "throw") throw new Error("synthetic_submission_failure");
        if (mode === "malformed") return { enqueueInSession: undefined, async close() { producerCloses++; } } as never;
        return deferred;
      },
      startNativeWorker: async () => { workerStarts++; throw new Error("must_not_start_worker"); },
      createServer: (() => f.makeServer("web")) as never, createNativeServer: (() => f.makeServer("native")) as never });
    const starting = host.start({ configuration: f.configuration, port: 3210, nativeHttps: f.tls, handler, assets, signal: controller.signal });
    if (mode === "late-abort") {
      while (!f.trace.includes("submission-open")) await new Promise(resolve => setImmediate(resolve));
      controller.abort();
      release!({ async enqueueInSession() { throw new Error("inert"); }, async recoverUnsentInSession() { return false; },
        async close() { producerCloses++; f.trace.push("late-submission-close"); } });
    }
    await assert.rejects(starting, { message: mode === "throw" || mode === "timeout"
      ? "private_task_startup_cleanup_uncertain" : "private_task_startup_prerequisites_failed" });
    if (mode === "timeout") {
      release!({ async enqueueInSession() { throw new Error("inert"); }, async recoverUnsentInSession() { return false; },
        async close() { producerCloses++; f.trace.push("late-submission-close"); } });
      while (producerCloses === 0) await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(workerStarts, 0); assert.equal(f.servers.length, 0);
    assert.equal(producerCloses, mode === "throw" ? 0 : 1);
    for (const pool of f.pools.values()) assert.equal(pool.closes(), 1);
  });
});

test("worker and listener failures, timeouts and abort drain every acquired component", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  for (const mode of ["worker-throw", "worker-malformed", "worker-late-abort", "worker-timeout", "install-throw",
    "native-factory-throw", "native-factory-malformed", "native-bind", "native-abort", "native-timeout",
    "web-factory-throw", "web-factory-malformed", "web-bind", "web-abort", "web-timeout"] as const)
    await t.test(mode, async t => {
      const f = fixture.scenario(); let producerCloses = 0, workerCloses = 0;
      let release: ((value: { status(): { accepting: boolean }; close(): Promise<void> }) => void) | undefined;
      const deferred = new Promise<{ status(): { accepting: boolean }; close(): Promise<void> }>(resolve => { release = resolve; });
      const controller = new AbortController();
      if (mode.endsWith("timeout")) {
        const schedule = globalThis.setTimeout;
        t.mock.method(globalThis, "setTimeout", ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
          schedule(callback, delay === 5000 || delay === 30_000 ? 1 : delay, ...args)) as never);
      }
      const host = createPrivateTaskHost({ clock: f.lifecycle.f.clock, openDatabase: f.openDatabase, install() {
        f.trace.push("install"); if (mode === "install-throw") throw new Error("synthetic_install_failure");
      },
        prepareNativeSubmission: async () => ({ async enqueueInSession() { throw new Error("inert"); },
          async recoverUnsentInSession() { return false; }, async close() { producerCloses++; f.trace.push("submission-close"); } }),
        startNativeWorker: async () => {
          f.trace.push("worker-open");
          if (mode === "worker-throw") throw new Error("synthetic_worker_failure");
          if (mode === "worker-malformed") return { status: undefined, async close() { workerCloses++; } } as never;
          if (mode === "worker-late-abort" || mode === "worker-timeout") return deferred;
          return { status: () => ({ accepting: true }), async close() { workerCloses++; f.trace.push("worker-close"); } };
        },
        createNativeServer: (() => {
          if (mode === "native-factory-throw") throw new Error("synthetic_native_factory_failure");
          if (mode === "native-factory-malformed") return {};
          const server = f.makeServer("native", mode === "native-bind" ? "bind-failure"
            : mode === "native-timeout" ? "bind-timeout" : "success");
          if (mode === "native-abort") {
            const listen = server.listen.bind(server);
            server.listen = (options, callback) => { controller.abort(); return listen(options, callback); };
          }
          return server;
        }) as never,
        createServer: (() => {
          if (mode === "web-factory-throw") throw new Error("synthetic_web_factory_failure");
          if (mode === "web-factory-malformed") return {};
          const server = f.makeServer("web", mode === "web-bind" ? "bind-failure"
            : mode === "web-timeout" ? "bind-timeout" : "success");
          if (mode === "web-abort") {
            const listen = server.listen.bind(server);
            server.listen = (options, callback) => { controller.abort(); return listen(options, callback); };
          }
          return server;
        }) as never });
      const starting = host.start({ configuration: f.configuration, port: 3210, nativeHttps: f.tls, handler, assets, signal: controller.signal });
      if (mode === "worker-late-abort") {
        while (!f.trace.includes("worker-open")) await new Promise(resolve => setImmediate(resolve));
        controller.abort(); release!({ status: () => ({ accepting: true }), async close() { workerCloses++; f.trace.push("late-worker-close"); } });
      }
      const expected = mode.endsWith("factory-malformed") ? "private_task_host_cleanup_uncertain"
        : mode === "worker-throw" || mode === "worker-timeout" ? "private_task_startup_cleanup_uncertain"
        : mode.startsWith("worker") || mode === "install-throw" ? "private_task_startup_prerequisites_failed"
        : "private_task_host_start_failed";
      await assert.rejects(starting, { message: expected });
      if (mode === "worker-timeout") {
        release!({ status: () => ({ accepting: true }), async close() { workerCloses++; f.trace.push("late-worker-close"); } });
        while (workerCloses === 0) await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(producerCloses, 1); assert.equal(workerCloses,
        mode === "worker-throw" ? 0 : 1);
      for (const pool of f.pools.values()) assert.equal(pool.closes(), 1);
      const expectedServers = mode.startsWith("worker") || mode === "install-throw" || mode.startsWith("native-factory") ? 0
        : mode.startsWith("native-") || mode.startsWith("web-factory") ? 1 : 2;
      assert.equal(f.servers.length, expectedServers);
      assert.ok(expectedServers === 0 || f.servers.every(server => server.closeCount === 1));
    });
});

test("cleanup failures remain explicit while every other owned component is still drained", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario(); let producerCloses = 0, workerCloses = 0;
  const host = createPrivateTaskHost({ clock: f.lifecycle.f.clock, openDatabase: f.openDatabase, install() {},
    prepareNativeSubmission: async () => ({ async enqueueInSession() { throw new Error("inert"); },
      async recoverUnsentInSession() { return false; }, async close() { producerCloses++; } }),
    startNativeWorker: async () => ({ status: () => ({ accepting: true }), async close() {
      workerCloses++; throw new Error("synthetic_worker_close_failure");
    } }),
    createNativeServer: (() => f.makeServer("native")) as never,
    createServer: (() => f.makeServer("web", "bind-failure")) as never });
  await assert.rejects(host.start({ configuration: f.configuration, port: 3210, nativeHttps: f.tls, handler, assets }),
    { message: "private_task_host_cleanup_uncertain" });
  assert.equal(workerCloses, 1); assert.equal(producerCloses, 1); assert.equal(f.servers.length, 2);
  assert.ok(f.servers.every(server => server.closeCount === 1));
  for (const pool of f.pools.values()) assert.equal(pool.closes(), 1);
});

test("host lifecycle aborts one start, drains it once and removes signal handlers", async t => {
  const fixture = await privateAgentTaskCompositionFixture(); t.after(fixture.close);
  const f = fixture.scenario(); let workerCloses = 0;
  const signals = new EventEmitter();
  const host = createPrivateTaskHost({ clock: f.lifecycle.f.clock, openDatabase: f.openDatabase, install() {},
    prepareNativeSubmission: async () => ({ async enqueueInSession() { throw new Error("inert"); },
      async recoverUnsentInSession() { return false; }, async close() {} }),
    startNativeWorker: async () => ({ status: () => ({ accepting: true }), async close() { workerCloses++; } }),
    createNativeServer: (() => f.makeServer("native")) as never, createServer: (() => f.makeServer("web")) as never });
  const lifecycle = startPrivateHostLifecycle({ signals, start: signal => host.start({
    configuration: f.configuration, port: 3210, nativeHttps: f.tls, handler, assets, signal,
  }) });
  const runtime = await lifecycle.ready;
  assert.equal(runtime.isReady(), true); assert.equal(signals.listenerCount("SIGTERM"), 1);
  signals.emit("SIGTERM"); signals.emit("SIGINT");
  assert.deepEqual(await lifecycle.completed, { status: "closed" });
  assert.equal(workerCloses, 1); assert.equal(runtime.isReady(), false);
  assert.equal(signals.listenerCount("SIGTERM"), 0); assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.deepEqual(await lifecycle.stop(), { status: "closed" });
});

test("operator assembly drives the real production startup boundary with the captured configuration", async () => {
  const { settings, trusted } = operatorConfigurationScenario("minimal");
  const captured = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  // Drive the captured value directly through the production startup boundary
  // (validatePrivateTaskStartupConfiguration is what host.start calls before
  // resource acquisition). The captured value MUST pass without re-substitution
  // or field remapping — it is a real PrivateTaskStartupConfiguration that
  // `createPrivateTaskHost.start` accepts as-is.
  const validated = validatePrivateTaskStartupConfiguration(captured.configuration);
  assert.equal(validated.web.tenantId, "tenant:operator-synthetic");
  assert.equal(validated.database.username, "coordinator_test");
  assert.equal(validated.nativeQueue, true);
  assert.equal(validated.sessions!.nodes.length, 1);
  assert.equal(validated.codex, undefined);
  assert.equal(captured.port, 3210);

  // The captured configuration and every nested object the trusted inputs
  // contributed must be deep-frozen. The production task host has already
  // accepted the configuration above; freezing every nested layer ensures
  // post-assembly mutation of trusted inputs cannot leak in and that the
  // captured value remains immutable for the lifetime of the host.
  assert.ok(Object.isFrozen(captured), "captured return value must be frozen");
  assert.ok(Object.isFrozen(captured.configuration), "captured.configuration must be frozen");
  assert.ok(Object.isFrozen(captured.configuration.web), "captured.configuration.web must be frozen");
  assert.ok(Object.isFrozen(captured.configuration.coordinator), "captured.configuration.coordinator must be frozen");
  assert.ok(Object.isFrozen(captured.configuration.coordinator.approvals!.store),
    "captured approval store must be frozen");
  assert.ok(Object.isFrozen(captured.configuration.coordinator.sessions!),
    "captured sessions must be frozen");
  assert.ok(Object.isFrozen(captured.configuration.coordinator.planning),
    "captured planning must be frozen");
  assert.ok(Object.isFrozen(captured.configuration.coordinator.routes),
    "captured routes must be frozen");
  assert.ok(Object.isFrozen(captured.configuration.coordinator.approvals!.enrollments),
    "captured approval enrollments must be frozen");
  if (captured.configuration.coordinator.quality) {
    assert.ok(Object.isFrozen(captured.configuration.coordinator.quality),
      "captured quality must be frozen");
  }
  if (captured.configuration.coordinator.evidence) {
    assert.ok(Object.isFrozen(captured.configuration.coordinator.evidence),
      "captured evidence must be frozen");
  }

  // Mutating the captured configuration itself must fail (every nested layer
  // is frozen). The captured value is the actual host input, and the host
  // can rely on its contents being immutable from the moment assembly returns.
  assert.throws(() => {
    (captured.configuration.web as Record<string, unknown>).tenantId = "tenant:MUTATE-CAPTURED";
  }, /Cannot assign to read only property/);
  assert.throws(() => {
    (captured.configuration.coordinator.approvals!.store as unknown as Record<string, unknown>).acceptInSession = () => "mutated";
  }, /Cannot assign to read only property/);
  assert.throws(() => {
    (captured as { port: number }).port = 9999;
  }, /Cannot assign to read only property/);
  // Deep-nested mutation must also fail. The captured configuration includes
  // multi-level nested database-role values; mutation of any deep-nested
  // property must fail because deepFreeze has frozen every nested layer.
  assert.throws(() => {
    (captured.configuration.coordinator.database as unknown as Record<string, unknown>).username = "mutated-db-user";
  }, /Cannot assign to read only property/);
  assert.throws(() => {
    (captured.configuration.coordinator.sessions!.database as unknown as Record<string, unknown>).username = "mutated-session-user";
  }, /Cannot assign to read only property/);
  assert.throws(() => {
    (captured.configuration.web.tasks as Record<string, unknown>).harnessIntegrityKey =
      new Uint8Array(32).fill(99);
  }, /Cannot assign to read only property/);
});

test("frozen approval-store capture binds methods to the original trusted receiver", async () => {
  const { settings, trusted } = operatorConfigurationScenario("minimal");
  const composed = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  const captured = composed.configuration.coordinator.approvals!.store as unknown as Record<string, unknown>;
  // The captured shape is frozen and exposes exactly the trusted methods.
  assert.ok(Object.isFrozen(captured));
  assert.equal(typeof captured.acceptInSession, "function");
  assert.equal(typeof captured.readInSession, "function");
  assert.equal(typeof captured.receiveDeliveryReceipt, "function");
  // Mutate the same assembled value (NOT a different scenario) by replacing one
  // method on the captured store — this must NOT be possible because the
  // captured object is frozen.
  assert.throws(() => {
    (captured as Record<string, unknown>).acceptInSession = () => "mutated";
  }, /Cannot assign to read only property/);
  // Likewise, mutate the ORIGINAL trusted store after assembly and assert the
  // captured store still routes to the original behavior. The captured methods
  // must execute against the ORIGINAL receiver — not against a later swap of
  // a property on a reference copied by reference.
  const store = trusted.approvalStore as Record<string, unknown>;
  const replacementAccept = async () => "replacement";
  store.acceptInSession = replacementAccept as unknown as (...args: never[]) => unknown;
  // Captured store should still route to the ORIGINAL implementation.
  // Since the original acceptInSession is an inert async, it returns undefined.
  // The replacement returns the string "replacement". Distinguish by that.
  const capturedResult = await (captured.acceptInSession as (...args: never[]) => Promise<unknown>)();
  assert.notEqual(capturedResult, "replacement",
    "captured acceptInSession must not be the caller's post-assembly replacement");
  assert.equal(capturedResult, undefined,
    "captured acceptInSession must remain bound to the original receiver");
  // The replacement on the trusted store must still be callable via the
  // trusted reference (sanity check that we did mutate it).
  const directResult = await (store.acceptInSession as (...args: never[]) => Promise<unknown>)();
  assert.equal(directResult, "replacement");
});

test("session sign is bound to the original trusted sessions receiver", async () => {
  const { settings, trusted } = operatorConfigurationScenario("minimal");
  // The synthetic sign function reads `this.signKey` to produce its signature,
  // so the captured bind to the trusted receiver is structurally required.
  // Attach a synthetic signKey to the receiver before assembly so the test
  // can distinguish the ORIGINAL signature from a later replacement.
  (trusted.sessions as unknown as { signKey: Uint8Array }).signKey = new Uint8Array(32).fill(91);
  const composed = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  const capturedSign = composed.configuration.coordinator.sessions!.sign;
  // Mutate the trusted sessions object's signKey to a recognisable replacement.
  const originalSessions = trusted.sessions as unknown as { sign: (frame: unknown) => Promise<{ signature: string }>; nodes: unknown[]; signKey: Uint8Array };
  const originalNodesRef = originalSessions.nodes;
  const originalSignKeyRef = originalSessions.signKey;
  const replacementSign = async (frame: unknown) => ({ ...(frame as object), signature: "replacement" });
  originalSessions.sign = replacementSign;
  // The captured sign MUST still produce the ORIGINAL behavior — `signature: "synthetic:91"`
  // — because it was bound to the original receiver at capture time.
  const out = await (capturedSign as (frame: unknown) => Promise<{ signature: string }>)({ kind: "frame" });
  assert.equal(out.signature, "synthetic:91",
    "captured sign must execute against the original trusted receiver");
  // Sanity: the trusted reference still routes to the replacement.
  const trustedOut = await (originalSessions.sign as (frame: unknown) => Promise<{ signature: string }>)({ kind: "frame" });
  assert.equal(trustedOut.signature, "replacement");
  // And the original nodes array reference must NOT have been mutated by the
  // captured sign's signature binding — captured sign should not have modified
  // the underlying array, only added a synthetic signature to a returned object.
  assert.equal(originalSessions.nodes, originalNodesRef);
  assert.equal(originalSessions.signKey, originalSignKeyRef);
});

test("captured sign is structurally bound to the original trusted receiver (regression: bind cannot be removed)", async () => {
  const { settings, trusted } = operatorConfigurationScenario("minimal");
  (trusted.sessions as unknown as { signKey: Uint8Array }).signKey = new Uint8Array(32).fill(91);
  const composed = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  const capturedSign = composed.configuration.coordinator.sessions!.sign as (frame: unknown) => Promise<{ signature: string }>;
  // Sanity: the synthetic sign function reads `this.signKey`, so the bind to
  // the original trusted receiver is structurally required. The captured
  // function MUST produce the ORIGINAL signature (`synthetic:91`).
  const baseline = await capturedSign({ kind: "frame" });
  assert.equal(baseline.signature, "synthetic:91");
  // A receiver-dependent sign cannot tolerate a non-function reference. If
  // the production bind to the trusted receiver were removed, calling
  // `capturedSign(...)` would resolve `this` to undefined (or the module
  // global under sloppy mode) and reading `this.signKey` would throw. This
  // test asserts the bind is in place by calling `.call` with a deliberately
  // wrong receiver — the captured function MUST ignore the override and
  // route through the bound original receiver. A non-bound function would
  // either throw or return a signature derived from the override.
  const overrideReceiver = { signKey: new Uint8Array(32).fill(99) } as unknown as { signKey: Uint8Array };
  const out = await capturedSign.call(overrideReceiver, { kind: "frame" });
  assert.equal(out.signature, "synthetic:91",
    "captured sign must ignore call-site receiver overrides; only the bound original receiver is authoritative");
  // Sanity: the trusted receiver is still the original reference and still
  // readable through it (the bind is the captured function's `this`, not a
  // clone of the receiver's properties).
  const receiverNow = (trusted.sessions as unknown as { signKey: Uint8Array }).signKey;
  assert.equal(receiverNow[0], 91, "trusted receiver signKey unchanged after captured call");
});

test("idea runtime database password and majorVersion must match the declared role", () => {
  // The trusted runtime's password and majorVersion must agree with the declared
  // runtime role. A drift here is a silent configuration mismatch — the trusted
  // runtime would attempt to connect with credentials the declared role does
  // not authorize (or a server version it does not target), and downstream
  // evidence would be issued under a role the operator never recorded. The
  // assembler refuses before any of that can happen. The current Postgres
  // contract pins majorVersion to the literal 17, so the test stays honest
  // about the supported target.
  const ideaKey = new Uint8Array(32).fill(21);
  const buildBase = (overrides: { trustedPassword: string }) => {
    const { settings, trusted } = operatorConfigurationScenario("minimal");
    settings.features.idea = true;
    settings.databaseRoles.ideaCreation = {
      host: "127.0.0.1", port: 5433, database: "controlroomtest",
      username: "idea_creation_match", password: "declared-secret", majorVersion: 17,
    };
    settings.databaseRoles.ideaRuntime = {
      host: "127.0.0.1", port: 5433, database: "controlroomtest",
      username: "idea_runtime_match", password: "declared-secret", majorVersion: 17,
    };
    const webWithIdea = { ...(trusted.web as Record<string, unknown>),
      ideaProjects: { integrityKey: ideaKey } } as unknown as typeof trusted.web;
    const participant = (suffix: string) => ({
      participantId: `participant:${suffix}`,
      identityDigest: `sha256:${"1".repeat(64)}`,
      displayName: `Participant ${suffix}`,
      perspective: (suffix === "a" ? "skeptic" : "customer") as "skeptic" | "customer",
      harness: "hermes" as const,
      modelClass: "synthetic_participant",
      platform: "linux" as const,
      sourceMode: "injected_only" as const,
      liveConnected: false as const,
      canDispatch: false as const,
    });
    const newTrusted = { ...trusted, web: webWithIdea };
    newTrusted.idea = {
      creation: { integrityKey: ideaKey, participants: [participant("a"), participant("b"), participant("c")] },
      runtime: {
        database: {
          host: "127.0.0.1", port: 5433, database: "controlroomtest",
          username: "idea_runtime_match", password: overrides.trustedPassword, majorVersion: 17,
        },
        close: async () => {},
        runtime: {
          resolve: () => undefined,
          driver: { mode: "hermes_bot_mode_filtered", invoke: async () => undefined },
          evidenceAuthority: { verify: async () => undefined },
          admissionAuthority: { consume: async () => undefined },
        },
      },
    };
    return { settings, trusted: newTrusted };
  };

  // Password drift between declared and trusted refuses before return.
  assert.throws(() => {
    const { settings, trusted } = buildBase({ trustedPassword: "trusted-different" });
    assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  }, /idea_runtime_role_mismatch:password/);

  // A matching legacy runtime can still be represented by the isolated
  // operator fixture, but the production startup boundary must refuse it.
  // Idea Lab now plans ordinary tasks instead of directly contacting a
  // provider from the web process.
  const match = buildBase({ trustedPassword: "declared-secret" });
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(match.settings, match.trusted),
    /agent_task_operator_config_invalid:production_gate_refused/);
});

test("matching legacy Idea runtime is refused by the production startup gate", async () => {
  const { settings, trusted } = operatorConfigurationScenario("minimal");
  // Build an otherwise matching legacy runtime. This proves the refusal is
  // policy-driven, rather than caused by a malformed role or participant.
  const ideaKey = new Uint8Array(32).fill(21);
  const webWithIdea = { ...(trusted.web as Record<string, unknown>),
    ideaProjects: { integrityKey: ideaKey } } as unknown as typeof trusted.web;
  const participant = (suffix: string) => ({
    participantId: `participant:${suffix}`,
    identityDigest: `sha256:${"1".repeat(64)}`,
    displayName: `Participant ${suffix}`,
    perspective: (suffix === "a" ? "skeptic" : "customer") as "skeptic" | "customer",
    harness: "hermes" as const,
    modelClass: "synthetic_participant",
    platform: "linux" as const,
    sourceMode: "injected_only" as const,
    liveConnected: false as const,
    canDispatch: false as const,
  });
  settings.features.idea = true;
  settings.databaseRoles.ideaCreation = {
    host: "127.0.0.1", port: 5433, database: "controlroomtest",
    username: "idea_creation_match", password: "shared-secret", majorVersion: 17,
  };
  settings.databaseRoles.ideaRuntime = {
    host: "127.0.0.1", port: 5433, database: "controlroomtest",
    username: "idea_runtime_match", password: "shared-secret", majorVersion: 17,
  };
  const newTrusted = { ...trusted, web: webWithIdea };
  newTrusted.idea = {
    creation: { integrityKey: ideaKey, participants: [participant("a"), participant("b"), participant("c")] },
    runtime: {
      database: {
        host: "127.0.0.1", port: 5433, database: "controlroomtest",
        username: "idea_runtime_match", password: "shared-secret", majorVersion: 17,
      },
      close: async () => {},
      runtime: {
        resolve: () => undefined,
        driver: { mode: "hermes_bot_mode_filtered", invoke: async () => undefined },
        evidenceAuthority: { verify: async () => undefined },
        admissionAuthority: { consume: async () => undefined },
      },
    },
  };
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(settings, newTrusted),
    /agent_task_operator_config_invalid:production_gate_refused/);
});

test("direct Idea runtime is refused by the lower-level production assembly before any resource is read", () => {
  // This deliberately omits every other lifecycle field. The guard must run
  // first, so an accidental alternate bootstrap cannot validate or acquire a
  // pool before refusing the deprecated direct-provider path.
  assert.throws(() => createTaskCoordinatorLifecycle({ ideaRuntime: {} } as TaskCoordinatorConfiguration),
    /task_coordinator_config_invalid/);
});

test("idea runtime database must match the declared ideaRuntime role", async () => {
  const { settings, trusted } = operatorConfigurationScenario("minimal");
  // Enable idea (the runtime is supplied via trusted.idea.runtime, not via a feature flag).
  settings.features.idea = true;
  settings.databaseRoles.ideaRuntime = {
    host: "127.0.0.1", port: 5433, database: "controlroomtest",
    username: "idea_runtime_declared", password: "synthetic", majorVersion: 17,
  };
  settings.databaseRoles.ideaCreation = {
    host: "127.0.0.1", port: 5433, database: "controlroomtest",
    username: "idea_creation", password: "synthetic", majorVersion: 17,
  };
  trusted.idea = {
    creation: { integrityKey: new Uint8Array(32).fill(21), participants: [
      { participantId: "p1", displayName: "P1", descriptionDigest: "d1", policyDigest: "d1", weight: 1 },
      { participantId: "p2", displayName: "P2", descriptionDigest: "d2", policyDigest: "d2", weight: 1 },
      { participantId: "p3", displayName: "P3", descriptionDigest: "d3", policyDigest: "d3", weight: 1 },
    ] },
    runtime: {
      database: {
        host: "127.0.0.1", port: 5433, database: "controlroomtest",
        username: "idea_runtime_WRONG", password: "synthetic", majorVersion: 17,
      },
      close: async () => {},
      runtime: {
        resolve: () => undefined,
        driver: { mode: "hermes_bot_mode_filtered", invoke: async () => undefined },
        evidenceAuthority: { verify: async () => undefined },
        admissionAuthority: { consume: async () => undefined },
      },
    },
  };
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(settings, trusted),
    /agent_task_operator_config_invalid:idea_runtime_role_mismatch/);
});

test("idea runtime database mismatch against the declared role refuses even when the trusted database is otherwise valid", async () => {
  const { settings, trusted } = operatorConfigurationScenario("minimal");
  settings.features.idea = true;
  settings.databaseRoles.ideaRuntime = {
    host: "127.0.0.1", port: 5433, database: "controlroomtest",
    username: "idea_runtime_declared", password: "synthetic", majorVersion: 17,
  };
  settings.databaseRoles.ideaCreation = {
    host: "127.0.0.1", port: 5433, database: "controlroomtest",
    username: "idea_creation", password: "synthetic", majorVersion: 17,
  };
  trusted.idea = {
    creation: { integrityKey: new Uint8Array(32).fill(21), participants: [
      { participantId: "p1", displayName: "P1", descriptionDigest: "d1", policyDigest: "d1", weight: 1 },
      { participantId: "p2", displayName: "P2", descriptionDigest: "d2", policyDigest: "d2", weight: 1 },
      { participantId: "p3", displayName: "P3", descriptionDigest: "d3", policyDigest: "d3", weight: 1 },
    ] },
    runtime: {
      database: {
        host: "127.0.0.1", port: 5433, database: "controlroomtest",
        username: "idea_runtime_OTHER", password: "synthetic", majorVersion: 17,
      },
      close: async () => {},
      runtime: {
        resolve: () => undefined,
        driver: { mode: "hermes_bot_mode_filtered", invoke: async () => undefined },
        evidenceAuthority: { verify: async () => undefined },
        admissionAuthority: { consume: async () => undefined },
      },
    },
  };
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(settings, trusted),
    /idea_runtime_role_mismatch:declared/);
});

test("operator assembly builds the minimal queue/session/native composition through the production gate", async () => {
  const { settings, trusted } = operatorConfigurationScenario("minimal");
  const composed = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  assert.equal(composed.configuration.web.tenantId, "tenant:operator-synthetic");
  assert.equal(composed.configuration.coordinator.database.username, "coordinator_test");
  assert.equal(composed.configuration.coordinator.nativeQueue, true);
  assert.equal(composed.configuration.coordinator.sessions!.nodes.length, 1);
  assert.equal(composed.configuration.coordinator.codex, undefined);
  assert.equal(composed.configuration.coordinator.codexResultReturn, undefined);
  assert.equal(composed.configuration.artifactStorage, undefined);
  assert.equal(composed.configuration.news, undefined);
  assert.ok(Object.isFrozen(composed));
  assert.ok(Object.isFrozen(composed.configuration));
  assert.equal(composed.port, 3210);
});

test("operator assembly builds the full artifact/result/review/Codex composition", async () => {
  const { settings, trusted } = operatorConfigurationScenario("full");
  const composed = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  assert.equal(composed.configuration.coordinator.nativeQueueRecovery, true);
  assert.equal(composed.configuration.coordinator.revisionPlanning, true);
  assert.equal(composed.configuration.coordinator.queueWorker!.concurrency, 2);
  assert.equal(composed.configuration.coordinator.codex!.enrollments.length, 1);
  assert.equal(
    (composed.configuration.coordinator.codexResultReturn as { qualificationReceipt: { body: { nodeId: string } } })
      .qualificationReceipt.body.nodeId,
    "node:operator-codex");
  assert.equal(composed.configuration.coordinator.nativeHttp!.origin, "https://machine.example.test");
  assert.ok(composed.configuration.artifactStorage !== undefined);
  assert.equal(composed.configuration.coordinator.sessions!.nodes.length, 2);
});

test("generic operator refuses structural, proxied, and mutable remote materializers", () => {
  const { settings, trusted } = operatorConfigurationScenario("full");
  const features = settings.features as unknown as Record<string, boolean>;
  features.remoteControllerWorker = true;
  const materializer: { marker: string; prepare(): Promise<Readonly<{ prepared: string }>>;
    transmit(): Promise<Readonly<{ kind: "transmitted" | "mutated" }>> } = {
    marker: "captured",
    async prepare() { return Object.freeze({ prepared: this.marker }); },
    async transmit() { return Object.freeze({ kind: "transmitted" as const }); },
  };
  const structural = { materializer, startsWork: false, grantsExecutionAuthority: false };
  for (const forged of [structural, { ...structural }, new Proxy(structural, {}), Object.freeze(structural)]) {
    (trusted as unknown as { remoteControllerWorker: unknown }).remoteControllerWorker = forged;
    assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(settings, trusted), /remoteControllerWorker_invalid/);
  }
  materializer.prepare = async function () { return Object.freeze({ prepared: "mutated" }); };
  materializer.transmit = async function () { return Object.freeze({ kind: "mutated" as const }); };
  (trusted as unknown as { remoteControllerWorker: unknown }).remoteControllerWorker = structural;
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(settings, trusted), /remoteControllerWorker_invalid/);
  const ordinaryInput = operatorConfigurationScenario("full");
  const ordinary = assemblePrivateAgentTaskOperatorConfiguration(ordinaryInput.settings, ordinaryInput.trusted);
  assert.throws(() => validatePrivateTaskStartupConfiguration({ ...ordinary.configuration, coordinator: {
    ...ordinary.configuration.coordinator, remoteControllerWorker: structural as never,
  } }), /private_task_startup_config_invalid/,
  "a caller cannot bypass generic assembly by supplying a structural materializer to startup");

  const missing = operatorConfigurationScenario("full");
  (missing.settings.features as unknown as Record<string, boolean>).remoteControllerWorker = true;
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(missing.settings, missing.trusted),
    /missing_trusted_input:remoteControllerWorker/);

  const unexpected = operatorConfigurationScenario("full");
  (unexpected.trusted as unknown as { remoteControllerWorker: unknown }).remoteControllerWorker = { materializer: materializer as never };
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(unexpected.settings, unexpected.trusted),
    /unexpected_trusted_input:remoteControllerWorker/);

  const noQueue = operatorConfigurationScenario("full");
  const noQueueFeatures = noQueue.settings.features as unknown as Record<string, boolean>;
  noQueueFeatures.remoteControllerWorker = true;
  noQueueFeatures.queueWorker = false;
  delete (noQueue.settings.databaseRoles as unknown as Record<string, unknown>).queueWorker;
  (noQueue.trusted as unknown as { remoteControllerWorker: unknown }).remoteControllerWorker = { materializer: materializer as never };
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(noQueue.settings, noQueue.trusted),
    /feature_chain:remoteControllerWorker_requires_nativeQueue_and_queueWorker/);
});

test("generic readiness alone cannot admit an installation-owned local Hermes executor", () => {
  const { settings, trusted } = operatorConfigurationScenario("full");
  settings.features = { ...settings.features, sessions: false, codex: false, codexResultReturn: false,
    nativeHttp: false, hermes021Local: true };
  trusted.sessions = undefined;
  trusted.codex = undefined;
  trusted.codexResultReturn = undefined;
  trusted.nativeHttp = undefined;
  const topologyRoute = { kind: "local" as const, workerId: "worker:local-hermes", adapterId: "connector:hermes-021-macos-local-v1",
    adapterRevision: "00570550" };
  const topology = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("operator-local-db"),
    schedulerAuthorityDigest: sha256Digest("operator-local-scheduler"), currentRoutes: [topologyRoute], requestedRoutes: [topologyRoute] });
  const backupRestore = localBackupRestoreProof(topology.planDigest);
  const codexCustody = createCodexMacosCustodyReadinessV1({ planDigest: topology.planDigest, proofs: [
    { proof: "suspended_executable_identity", state: "passed", evidenceDigest: sha256Digest("operator-local-suspended") },
    { proof: "protected_private_state_handle", state: "passed", evidenceDigest: sha256Digest("operator-local-private-state") },
  ] });
  const supervisor = createLocalSupervisorReadinessV1({ planDigest: topology.planDigest, proofs: [
    { proof: "private_configuration_custody", state: "passed", evidenceDigest: sha256Digest("operator-local-custody") },
    { proof: "restricted_launch_definition", state: "passed", evidenceDigest: sha256Digest("operator-local-launch") },
    { proof: "restart_and_drain_procedure", state: "passed", evidenceDigest: sha256Digest("operator-local-restart") },
    { proof: "upgrade_and_rollback_procedure", state: "passed", evidenceDigest: sha256Digest("operator-local-rollback") },
  ] });
  trusted.web = { ...(trusted.web as object), installationTopologyPlan: topology,
    installationReadiness: createInstallationReadinessV1({ planDigest: topology.planDigest, proofs: [
      { proof: "backup_restore", state: "passed", evidenceDigest: backupRestore.proofDigest },
      { proof: "local_owner_qualification", state: "passed", evidenceDigest: sha256Digest("operator-local-text") },
      { proof: "local_runner_bridge", state: "passed", evidenceDigest: sha256Digest("operator-local-runner") },
    ] }), codexMacosCustodyReadiness: codexCustody, localSupervisorReadiness: supervisor } as typeof trusted.web;
  trusted.localBackupRestoreReadiness = backupRestore;
  let delivered = 0;
  trusted.hermes021Local = { deliver: async function () { delivered++; } };
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(settings, trusted),
    /missing_trusted_input:hermes021LocalStartupReverification/);
  assert.equal(delivered, 0, "assembly must not start Hermes");
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(
    { ...settings, features: { ...settings.features, hermes021Local: false } }, trusted),
  /unexpected_trusted_input:hermes021Local/);
  const unrelatedTopology = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("other-db"),
    schedulerAuthorityDigest: sha256Digest("operator-local-scheduler"), currentRoutes: [topologyRoute], requestedRoutes: [topologyRoute] });
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(settings, { ...trusted,
    localBackupRestoreReadiness: localBackupRestoreProof(unrelatedTopology.planDigest) }),
  /hermes021Local_backup_restore_proof_invalid/);
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(settings,
    { ...trusted, web: { ...(trusted.web as object), localSupervisorReadiness: undefined } }),
  /hermes021Local_supervisor_not_ready/);
});

test("operator assembly refuses a local Hermes callback until its local proof set is recorded", () => {
  const { settings, trusted } = operatorConfigurationScenario("full");
  settings.features = { ...settings.features, sessions: false, codex: false, codexResultReturn: false,
    nativeHttp: false, hermes021Local: true };
  trusted.sessions = undefined;
  trusted.codex = undefined;
  trusted.codexResultReturn = undefined;
  trusted.nativeHttp = undefined;
  trusted.hermes021Local = { async deliver() {} };
  trusted.localBackupRestoreReadiness = localBackupRestoreProof(sha256Digest("not-a-plan"));
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(settings, trusted),
    /hermes021Local_installation_proof_missing/);
  const topologyRoute = { kind: "local" as const, workerId: "worker:local-hermes", adapterId: "connector:hermes-021-macos-local-v1",
    adapterRevision: "00570550" };
  const topology = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("operator-local-db"),
    schedulerAuthorityDigest: sha256Digest("operator-local-scheduler"), currentRoutes: [topologyRoute], requestedRoutes: [topologyRoute] });
  trusted.web = { ...(trusted.web as object), installationTopologyPlan: topology,
    installationReadiness: createInstallationReadinessV1({ planDigest: topology.planDigest, proofs: [
      { proof: "backup_restore", state: "passed", evidenceDigest: sha256Digest("operator-local-backup") },
      { proof: "local_owner_qualification", state: "passed", evidenceDigest: sha256Digest("operator-local-text") },
      { proof: "local_runner_bridge", state: "not_started" },
    ] }) } as typeof trusted.web;
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(settings, trusted),
    /hermes021Local_installation_not_ready/);
});

test("operator assembly refuses a bare local Claude callback even when legacy readiness proofs exist", () => {
  const { settings, trusted } = operatorConfigurationScenario("full");
  settings.features = { ...settings.features, sessions: false, codex: false, codexResultReturn: false,
    nativeHttp: false, claudeCodeLocal: true };
  trusted.sessions = undefined;
  trusted.codex = undefined;
  trusted.codexResultReturn = undefined;
  trusted.nativeHttp = undefined;
  const route = { kind: "local" as const, workerId: "worker:local-claude",
    adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1, adapterRevision: "source-123" };
  const topology = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("operator-claude-db"),
    schedulerAuthorityDigest: sha256Digest("operator-claude-scheduler"), currentRoutes: [route], requestedRoutes: [route] });
  const backupRestore = localBackupRestoreProof(topology.planDigest);
  const supervisor = createLocalSupervisorReadinessV1({ planDigest: topology.planDigest, proofs: [
    { proof: "private_configuration_custody", state: "passed", evidenceDigest: sha256Digest("claude-custody") },
    { proof: "restricted_launch_definition", state: "passed", evidenceDigest: sha256Digest("claude-launch") },
    { proof: "restart_and_drain_procedure", state: "passed", evidenceDigest: sha256Digest("claude-restart") },
    { proof: "upgrade_and_rollback_procedure", state: "passed", evidenceDigest: sha256Digest("claude-rollback") },
  ] });
  const processReadiness = createClaudeCodeLocalProcessReadinessV1({ planDigest: topology.planDigest, proofs: [
    { proof: "installed_process_identity", state: "passed", evidenceDigest: sha256Digest("claude-identity") },
    { proof: "permission_boundary", state: "passed", evidenceDigest: sha256Digest("claude-permission") },
    { proof: "cancellation_and_restart_recovery", state: "passed", evidenceDigest: sha256Digest("claude-recovery") },
  ] });
  trusted.web = { ...(trusted.web as object), installationTopologyPlan: topology,
    installationReadiness: createInstallationReadinessV1({ planDigest: topology.planDigest, proofs: [
      { proof: "backup_restore", state: "passed", evidenceDigest: backupRestore.proofDigest },
    ] }), localSupervisorReadiness: supervisor, claudeCodeLocalProcessReadiness: processReadiness } as typeof trusted.web;
  trusted.localBackupRestoreReadiness = backupRestore;
  let delivered = 0;
  trusted.claudeCodeLocal = { deliver: async () => { delivered++; } };
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(settings, trusted), /claudeCodeLocal_invalid/);
  assert.equal(delivered, 0, "assembly cannot start Claude");
});

test("website-only settings cannot enter the operator assembler", async () => {
  const { settings, trusted } = operatorConfigurationScenario("minimal");
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(
    { ...settings, handler: async () => new Response("browser") }, trusted),
  /agent_task_operator_config_invalid:settings_invalid/);
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(settings,
    { ...trusted, web: { ...(trusted.web as object), planning: {} } }),
  /agent_task_operator_config_invalid:website_setting_rejected:planning/);
});

test("operator port accepts only integers, never strings, paths or urls", async () => {
  const { settings, trusted } = operatorConfigurationScenario("minimal");
  for (const port of ["3210", "/socket/agent-tasks.sock", "https://machine.example.test:3210", 0, 70_000, Number.NaN]) {
    assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration({ ...settings, port }, trusted),
      /agent_task_operator_config_invalid:settings_invalid/, `port=${String(port)}`);
  }
});

test("every operator missing dependency and mismatch class refuses before return", async () => {
  const cases: Array<{ name: string; mutate: (s: ReturnType<typeof operatorConfigurationScenario>) => void; match: RegExp }> = [
    { name: "tenant", mutate: s => { s.settings.tenantId = "tenant:other"; }, match: /tenant_mismatch/ },
    { name: "missing sessions input", mutate: s => { s.trusted.sessions = undefined; }, match: /missing_trusted_input:sessions/ },
    { name: "unexpected codex input", mutate: s => { (s.trusted as Record<string, unknown>).codex = {}; }, match: /unexpected_trusted_input:codex/ },
    { name: "recovery without queue", mutate: s => { s.settings.features.nativeQueue = false; s.settings.features.nativeQueueRecovery = true; }, match: /feature_chain/ },
    { name: "sessions without evidence", mutate: s => { s.settings.features.evidence = false; s.trusted.evidence = undefined; }, match: /feature_chain/ },
    { name: "role reuse", mutate: s => { s.settings.databaseRoles.sessions = { ...s.settings.databaseRoles.sessions!, username: "coordinator_test" }; }, match: /database_role_reuse/ },
    { name: "role host drift", mutate: s => { s.settings.databaseRoles.sessions = { ...s.settings.databaseRoles.sessions!, host: "127.0.0.2" }; }, match: /database_role_mismatch/ },
    { name: "missing evidence role", mutate: s => { s.settings.databaseRoles.evidence = undefined; }, match: /missing_database_role:evidence/ },
    { name: "approval store", mutate: s => { (s.trusted.approvalStore as Record<string, unknown>).readInSession = undefined; }, match: /approval_store_invalid/ },
    { name: "downstream gate", mutate: s => { (s.trusted.web as Record<string, unknown>).origin = "http://control.example.test"; }, match: /production_gate_refused/ },
  ];
  for (const entry of cases) {
    const scenario = operatorConfigurationScenario("minimal");
    let calls = 0;
    const store = scenario.trusted.approvalStore as Record<string, unknown>;
    for (const name of ["acceptInSession", "readInSession", "receiveDeliveryReceipt"]) {
      const fn = store[name] as () => Promise<unknown>;
      store[name] = async () => { calls++; return fn(); };
    }
    entry.mutate(scenario);
    assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(scenario.settings, scenario.trusted), entry.match, entry.name);
    assert.equal(calls, 0, `${entry.name} must not invoke trusted callbacks before refusing`);
  }
});

test("disabled operator components are never constructed from supplied inputs", async () => {
  const { settings, trusted } = operatorConfigurationScenario("minimal");
  const composed = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  assert.equal(composed.configuration.coordinator.nativeQueueRecovery, undefined);
  assert.equal(composed.configuration.coordinator.queueWorker, undefined);
  assert.equal(composed.configuration.coordinator.nativeHttp, undefined);
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(settings,
    { ...trusted, nativeHttp: { origin: "https://machine.example.test", peers: [], isPeerCurrent: () => true } }),
  /agent_task_operator_config_invalid:unexpected_trusted_input:nativeHttp/);
});

test("repeated operator construction is independent and post-assembly mutation cannot leak in", async () => {
  const first = operatorConfigurationScenario("minimal");
  const a = assemblePrivateAgentTaskOperatorConfiguration(first.settings, first.trusted);
  const second = operatorConfigurationScenario("minimal");
  const b = assemblePrivateAgentTaskOperatorConfiguration(second.settings, second.trusted);
  const norm = (c: typeof a) => ({ db: c.configuration.coordinator.database.username, queue: c.configuration.coordinator.nativeQueue,
    sessions: c.configuration.coordinator.sessions!.nodes.map(node => node.nodeId),
    qkey: [...c.configuration.coordinator.quality!.integrityKey],
    frozen: Object.isFrozen(c) && Object.isFrozen(c.configuration) });
  assert.deepEqual(norm(a), norm(b));
  second.trusted.quality!.integrityKey.fill(9);
  second.settings.port = 9999;
  assert.notEqual(a.configuration.coordinator.quality!.integrityKey[0], 9);
  assert.deepEqual([...a.configuration.coordinator.quality!.integrityKey], [...first.trusted.quality!.integrityKey]);
});

test("transition admission material is copied into private coordinator assembly and never the web profile", () => {
  const { settings, trusted } = operatorConfigurationScenario("minimal");
  const key = new Uint8Array(32).fill(73);
  trusted.installationTransitionAdmission = { integrityKey: key,
    workers: trusted.routes.map(route => ({ nodeId: route.nodeId, workerId: `worker:${route.nodeId.slice(5)}` })) };
  const captured = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted).configuration;
  assert.deepEqual([...captured.coordinator.installationTransitionAdmission!.integrityKey], [...key]);
  assert.equal("installationTransitionAdmission" in captured.web, false);
  key.fill(9);
  assert.equal(captured.coordinator.installationTransitionAdmission!.integrityKey[0], 73);
});

test("the operator assembler performs no environment, filesystem or network access", async () => {
  const source = await readFile(new URL("../src/web/v1/private-agent-task-operator-configuration.ts", import.meta.url), "utf8");
  for (const token of ["node:", "process.", "globalThis", "fetch(", "XMLHttpRequest", "child_process", "require("])
    assert.ok(!source.includes(token), `forbidden direct platform access: ${token}`);
  const { settings, trusted } = operatorConfigurationScenario("minimal");
  const before = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  process.env.CONTROL_ROOM_OPERATOR_SYNTHETIC = "mutated";
  const after = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  delete process.env.CONTROL_ROOM_OPERATOR_SYNTHETIC;
  assert.deepEqual(after.configuration.coordinator.database, before.configuration.coordinator.database);
  assert.deepEqual([...after.configuration.coordinator.quality!.integrityKey],
    [...before.configuration.coordinator.quality!.integrityKey]);
});

test("byte mutation of the original web harness integrity key after assembly does not leak into the captured web profile", () => {
  const { settings, trusted } = operatorConfigurationScenario("full");
  const web = trusted.web as unknown as {
    tasks: { harnessIntegrityKey: Uint8Array };
    [key: string]: unknown;
  };
  const originalFirstByte = web.tasks.harnessIntegrityKey[0];
  const captured = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  const capturedKey = captured.configuration.coordinator.quality!.harnessIntegrityKey;
  const capturedFirstByte = capturedKey[0];
  // Mutate the caller's original key bytes and the trusted-web reference AFTER
  // assembly; the captured configuration's key bytes must not change.
  web.tasks.harnessIntegrityKey.fill(99, 0, 1);
  web.tasks = { ...web.tasks, harnessIntegrityKey: Uint8Array.from([0xaa, 0xbb, 0xcc]) };
  assert.equal(capturedKey[0], capturedFirstByte,
    "captured harness integrity key byte must not change after caller mutation of the original buffer");
  assert.equal(capturedKey[0], originalFirstByte,
    "captured harness integrity key byte must equal the original at assembly time");
  assert.equal(web.tasks.harnessIntegrityKey[0], 0xaa,
    "sanity: caller mutation took effect on the trusted reference");
  assert.notEqual(capturedKey, web.tasks.harnessIntegrityKey,
    "the captured key must not be the caller's Uint8Array reference");
});

test("mutable nested object under a shallow-frozen caller input is detached into the captured configuration", () => {
  // The host provider may pre-emptively Object.freeze the trusted.web it hands
  // to the assembler; the assembler must still produce a captured profile that
  // cannot be reached through the caller's input. Simulate the shallow-freeze
  // pattern (the producer froze the top object but didn't recurse into a
  // nested object that still owns a mutable integrity key buffer) and prove
  // the assembler produces a fresh graph, not a reference.
  const { settings, trusted } = operatorConfigurationScenario("full");
  const web = trusted.web as unknown as {
    tasks: { harnessIntegrityKey: Uint8Array };
    [key: string]: unknown;
  };
  // Shallow-freeze the parent only — leave nested objects and Uint8Array
  // buffers fully mutable.
  Object.freeze(web.tasks as object);
  const captured = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  const capturedFirst = captured.configuration.coordinator.quality!.harnessIntegrityKey[0];
  // Mutate through the caller-facing surface. The captured value must not
  // observe any of these mutations.
  web.tasks.harnessIntegrityKey.fill(0x77, 0, 1);
  assert.equal(captured.configuration.coordinator.quality!.harnessIntegrityKey[0], capturedFirst,
    "captured key byte must not change under a shallow-frozen caller input");
});

test("idea runtime database majorVersion mismatch refuses with idea_runtime_role_mismatch:major_version", () => {
  // Build a matching runtime then declare the same role with one majorVersion
  // off. The assembler must refuse before the production gate sees it.
  const { settings, trusted } = operatorConfigurationScenario("full");
  const features = settings.features as unknown as Record<string, boolean>;
  if (!features.idea) features.idea = true;
  const roles = settings.databaseRoles as unknown as Record<string, unknown>;
  const coordinator = roles.coordinator as { host: string; port: number; database: string; username: string;
    password: Uint8Array; majorVersion: 17 };
  const runtimeUsername = "idea_runtime_major_role";
  // Declared role and runtime database agree on host/port/database/username/password;
  // the only drift is majorVersion. That must refuse with the version-specific
  // code, not with the generic declared or password check.
  roles.ideaRuntime = { host: coordinator.host, port: coordinator.port, database: coordinator.database,
    username: runtimeUsername, password: coordinator.password, majorVersion: 16 as unknown as 17 };
  (trusted as unknown as { idea: unknown }).idea = {
    creation: { integrityKey: new Uint8Array(32), participants: [] },
    runtime: { database: { host: coordinator.host, port: coordinator.port, database: coordinator.database,
      username: runtimeUsername, password: coordinator.password, majorVersion: 17 as 17 } },
    driver: { mode: "hermes_bot_mode_filtered" }, harness: "hermes",
  };
  assert.throws(
    () => assemblePrivateAgentTaskOperatorConfiguration(settings, trusted),
    /idea_runtime_role_mismatch:major_version/);
});

test("byte mutation of a non-plain web tasks object after assembly does not leak into configuration.web.tasks.harnessIntegrityKey", () => {
  // The production gate accepts any structurally valid tasks object,
  // including one with a non-Object.prototype prototype. deepDetach's
  // prototype short-circuit would otherwise return the caller's tasks
  // object as-is, leaving the caller's Uint8Array reachable through the
  // returned configuration. captureWebTasks reads the supported fields
  // by name and byte-copies every binary integrity key, so post-assembly
  // mutation of the original buffer must not change the captured key.
  class TrustedWebTasks {
    harnessIntegrityKey: Uint8Array;
    results: { integrityKey: Uint8Array; storageClass: "local"; storage: object };
    reviews: { integrityKey: Uint8Array; checkpoints: object };
    constructor(key: Uint8Array, results: { integrityKey: Uint8Array; storageClass: "local"; storage: object },
      reviews: { integrityKey: Uint8Array; checkpoints: object }) {
      this.harnessIntegrityKey = key; this.results = results; this.reviews = reviews;
    }
  }
  const { settings, trusted } = operatorConfigurationScenario("full");
  // Use the helper's own harness key as the starting point so the production
  // gate's quality/review checks pass; we mutate the bytes AFTER assembly
  // to prove the captured configuration is detached.
  if (!trusted.web.tasks) throw new Error("test setup: trusted.web.tasks is required");
  const originalKey = new Uint8Array(trusted.web.tasks.harnessIntegrityKey);
  const web = trusted.web as unknown as { tasks: { results: { integrityKey: Uint8Array; storageClass: "local";
    storage: object }; reviews: { integrityKey: Uint8Array; checkpoints: object } } };
  (trusted as unknown as { web: { tasks: unknown } }).web.tasks =
    new TrustedWebTasks(originalKey, web.tasks.results, web.tasks.reviews);
  const captured = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  if (!captured.configuration.web.tasks) throw new Error("captured web.tasks is required");
  const capturedKey = captured.configuration.web.tasks.harnessIntegrityKey;
  const originalFirstByte = capturedKey[0];
  // Mutate the caller's original buffer after assembly. The captured
  // configuration's key bytes must not change.
  originalKey.fill(0x77, 0, 1);
  (trusted.web as unknown as { tasks: TrustedWebTasks }).tasks.harnessIntegrityKey.fill(0x99, 0, 1);
  assert.equal(capturedKey[0], originalFirstByte,
    "captured web.tasks.harnessIntegrityKey byte must equal the original at assembly time");
  assert.notEqual(capturedKey, (trusted.web as unknown as { tasks: TrustedWebTasks }).tasks.harnessIntegrityKey,
    "captured key must not be the caller's Uint8Array reference");
  assert.notEqual((trusted.web as unknown as { tasks: TrustedWebTasks }).tasks.harnessIntegrityKey[0], originalFirstByte,
    "sanity: caller mutation took effect on the trusted reference");
});

test("mutable nested child under a non-plain shallow-frozen web tasks object is detached into configuration.web.tasks.harnessIntegrityKey", () => {
  // Round-5 second case from the reviewer: an accepted non-plain tasks
  // object whose parent is shallow-frozen still owns a mutable integrity
  // key buffer. captureWebTasks must read the supported field by name
  // (not by recursion through the prototype) and byte-copy it, so the
  // captured configuration's key is independent of the caller's.
  class TrustedWebTasks {
    harnessIntegrityKey: Uint8Array;
    results: { integrityKey: Uint8Array; storageClass: "local"; storage: object };
    reviews: { integrityKey: Uint8Array; checkpoints: object };
    constructor(key: Uint8Array, results: { integrityKey: Uint8Array; storageClass: "local"; storage: object },
      reviews: { integrityKey: Uint8Array; checkpoints: object }) {
      this.harnessIntegrityKey = key; this.results = results; this.reviews = reviews;
    }
  }
  const { settings, trusted } = operatorConfigurationScenario("full");
  if (!trusted.web.tasks) throw new Error("test setup: trusted.web.tasks is required");
  const originalKey = new Uint8Array(trusted.web.tasks.harnessIntegrityKey);
  const web = trusted.web as unknown as { tasks: { results: { integrityKey: Uint8Array; storageClass: "local";
    storage: object }; reviews: { integrityKey: Uint8Array; checkpoints: object } } };
  const tasksInstance = new TrustedWebTasks(originalKey, web.tasks.results, web.tasks.reviews);
  Object.freeze(tasksInstance); // shallow-freeze the caller-owned object
  (trusted as unknown as { web: { tasks: unknown } }).web.tasks = tasksInstance;
  const captured = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  if (!captured.configuration.web.tasks) throw new Error("captured web.tasks is required");
  const capturedKey = captured.configuration.web.tasks.harnessIntegrityKey;
  const originalFirstByte = capturedKey[0];
  // Even though the parent is shallow-frozen, the buffer inside it is
  // still mutable. Mutate through the caller; the captured key must not
  // change.
  originalKey.fill(0x55, 0, 1);
  assert.equal(capturedKey[0], originalFirstByte,
    "captured web.tasks.harnessIntegrityKey byte must not change after caller mutation of the original buffer under a non-plain shallow-frozen tasks input");
  assert.notEqual(originalKey[0], capturedKey[0],
    "sanity: caller mutation took effect on the trusted buffer; captured key is detached");
});
