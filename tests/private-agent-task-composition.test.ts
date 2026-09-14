import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CODEX_APP_SERVER_CAPABILITY, CODEX_APP_SERVER_ADAPTER,
  CODEX_DELIVERY_FEATURE } from "../src/harness/codex-v1/delivery-contract";
import { CODEX_RESULT_RETURN_FEATURE_V1 } from "../src/harness/codex-v1/result-return";
import { createCodexPhysicalQualificationReceiptBodyV1 } from "../src/harness/codex-v1/result-publication-contract";
import { CODEX_APP_SERVER_READ_CONTRACT, CODEX_APP_SERVER_RESULT_CONTRACT,
  CODEX_APP_SERVER_START_CONTRACT } from "../src/harness/codex-v1/schema-contract";
import { signArtifact } from "../src/node-policy/v1/crypto";
import { sha256Digest } from "../src/security";
import { createPrivateTaskHost } from "../src/web/v1/private-task-host";
import { startPrivateHostLifecycle } from "../src/web/v1/private-host-lifecycle";
import { bindPrivateCodexResultReturnV1, validatePrivateTaskStartupConfiguration,
  type PrivateTaskStartupConfiguration } from "../src/web/v1/private-task-startup";
import { privateArtifactStorageNamespaceDigestV1 } from "../src/web/v1/private-artifact-storage";
import { instant } from "./hermes-native-fixture";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";
import { assemblePrivateAgentTaskOperatorConfiguration } from "../src/web/v1/private-agent-task-operator-configuration";
import { operatorConfigurationScenario } from "./helpers/private-agent-task-operator-configuration";

const handler = async () => new Response("synthetic");
const assets = { count: 0, digest: "synthetic", respond: () => undefined };

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

test("operator assembly builds the minimal queue/session/native composition through the production gate", async () => {
  const { settings, trusted } = operatorConfigurationScenario("minimal");
  const composed = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  assert.equal(composed.web.tenantId, "tenant:operator-synthetic");
  assert.equal(composed.database.username, "coordinator_test");
  assert.equal(composed.nativeQueue, true);
  assert.equal(composed.sessions!.nodes.length, 1);
  assert.equal(composed.codex, undefined);
  assert.equal(composed.codexResultReturn, undefined);
  assert.equal(composed.artifactStorage, undefined);
  assert.equal(composed.news, undefined);
  assert.ok(Object.isFrozen(composed));
});

test("operator assembly builds the full artifact/result/review/Codex composition", async () => {
  const { settings, trusted } = operatorConfigurationScenario("full");
  const composed = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  assert.equal(composed.nativeQueueRecovery, true);
  assert.equal(composed.revisionPlanning, true);
  assert.equal(composed.queueWorker!.concurrency, 2);
  assert.equal(composed.codex!.enrollments.length, 1);
  assert.equal(composed.codexResultReturn?.qualificationReceipt.body.nodeId, "node:operator-codex");
  assert.equal(composed.nativeHttp!.origin, "https://machine.example.test");
  assert.ok(composed.artifactStorage !== undefined);
  assert.equal(composed.sessions!.nodes.length, 2);
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
  assert.equal(composed.nativeQueueRecovery, undefined);
  assert.equal(composed.queueWorker, undefined);
  assert.equal(composed.nativeHttp, undefined);
  assert.throws(() => assemblePrivateAgentTaskOperatorConfiguration(settings,
    { ...trusted, nativeHttp: { origin: "https://machine.example.test", peers: [], isPeerCurrent: () => true } }),
  /agent_task_operator_config_invalid:unexpected_trusted_input:nativeHttp/);
});

test("repeated operator construction is independent and post-assembly mutation cannot leak in", async () => {
  const first = operatorConfigurationScenario("minimal");
  const a = assemblePrivateAgentTaskOperatorConfiguration(first.settings, first.trusted);
  const second = operatorConfigurationScenario("minimal");
  const b = assemblePrivateAgentTaskOperatorConfiguration(second.settings, second.trusted);
  const norm = (c: typeof a) => ({ db: c.database.username, queue: c.nativeQueue,
    sessions: c.sessions!.nodes.map(node => node.nodeId), qkey: [...c.quality!.integrityKey], frozen: Object.isFrozen(c) });
  assert.deepEqual(norm(a), norm(b));
  second.trusted.quality!.integrityKey.fill(9);
  second.settings.port = 9999;
  assert.notEqual(a.quality!.integrityKey[0], 9);
  assert.deepEqual([...a.quality!.integrityKey], [...first.trusted.quality!.integrityKey]);
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
  assert.deepEqual(after.database, before.database);
  assert.deepEqual([...after.quality!.integrityKey], [...before.quality!.integrityKey]);
});
