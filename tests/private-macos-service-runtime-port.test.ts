import assert from "node:assert/strict";
import test from "node:test";
import { createMacosLocalServicePackageV1 } from "../src/harness/v1/macos-local-service-package";
import { sha256Digest } from "../src/security/canonical-digest";
import { MACOS_SERVICE_OWNER_ACTION_SIMULATION_V1, macosServiceIdentityDigestV1 } from
  "../src/installer/v1/macos-service-owner-action";
import { PRIVATE_MACOS_SERVICE_LABEL_V1 } from "../src/installer/v1/private-macos-service-owner-runner";
import { PRIVATE_MACOS_SERVICE_NATIVE_PORT_V1, createPrivateMacosServiceToolAdapterV1 } from
  "../src/installer/v1/private-macos-service-tool-adapter";
import { PRIVATE_MACOS_SERVICE_RUNTIME_AUTHORIZATION_V1, PRIVATE_MACOS_SERVICE_RUNTIME_HOST_V1, PRIVATE_MACOS_SERVICE_RUNTIME_PORT_V1,
  PRIVATE_MACOS_SERVICE_RUNTIME_RECEIPT_V1, createPrivateMacosServiceRuntimePortV1,
  type PrivateMacosServiceRuntimeAuthorizationContextV1, type PrivateMacosServiceRuntimeHostRequestV1,
  type PrivateMacosServiceRuntimeHostV1 } from
  "../src/installer/v1/private-macos-service-runtime-port";

const d = (value: unknown) => sha256Digest(value);
const ownerUid = 501;
const ownerHome = "/Users/owner";
const launchAgentPath = `${ownerHome}/Library/LaunchAgents/${PRIVATE_MACOS_SERVICE_LABEL_V1}.plist`;
const releaseDigest = d("release");
const serviceDefinition = "reviewed plist bytes";
const definitionDigest = d(serviceDefinition);
const parentIdentityDigest = d("parent");
const publishedIdentityDigest = d("published-definition");
const serviceIdentityDigest = d("service");
const lifecycleDigest = d("lifecycle");

type State = "not_installed" | "stopped" | "running" | "unknown";

function fixture(initial: State = "not_installed",
  mode: "normal" | "throw-start" | "fail-start" | "bad-receipt" | "deny" | "unknown-after-effect"
    | "slow-auth" | "slow-start" | "slow-health" | "bad-health" | "bad-health-digest" | "hanging-cleanup" = "normal",
  hooks: Readonly<{ afterStop?: () => void; beforeStart?: () => Promise<void>;
    healthAborted?: () => void; cleanupAborted?: () => void }> = {}) {
  let state = initial;
  let definitionIdentity: string | null = initial === "not_installed" ? null : publishedIdentityDigest;
  const calls: PrivateMacosServiceRuntimeHostRequestV1[] = [];
  const mutations: string[] = [];
  const authorizations: string[] = [];
  let cleanupCalls = 0;
  const host: PrivateMacosServiceRuntimeHostV1 = {
    schema: PRIVATE_MACOS_SERVICE_RUNTIME_HOST_V1,
    async perform(request) {
      calls.push(request);
      if (request.operation === "inspect_service_status" && mode === "unknown-after-effect" && mutations.length > 0) {
        return receipt(request, "succeeded", "unknown", definitionIdentity);
      }
      if (request.operation === "install_service_definition") {
        if (state !== "not_installed") return receipt(request, "failed_before_effect", state, definitionIdentity);
        definitionIdentity = publishedIdentityDigest; state = "stopped"; mutations.push("install");
      } else if (request.operation === "start_service") {
        await hooks.beforeStart?.();
        if (mode === "slow-start") {
          await new Promise(resolve => setTimeout(resolve, 30));
          if (request.signal.aborted) throw new Error("cancelled by deadline");
        }
        if (mode === "throw-start") throw new Error("private process detail");
        if (mode === "fail-start") return receipt(request, "failed_before_effect", state, definitionIdentity);
        if (state !== "stopped") return receipt(request, "failed_before_effect", state, definitionIdentity);
        state = "running"; mutations.push("start");
      } else if (request.operation === "stop_service") {
        if (state !== "running") return receipt(request, "failed_before_effect", state, definitionIdentity);
        state = "stopped"; mutations.push("stop");
        hooks.afterStop?.();
      }
      const result = receipt(request, "succeeded", state, definitionIdentity);
      return mode === "bad-receipt" ? { ...result, launchctlTarget: "system/changed" } : result;
    },
    async observeHealth(request) {
      if (mode === "slow-health") {
        await new Promise<void>(resolve => request.signal.addEventListener("abort", () => {
          hooks.healthAborted?.(); resolve();
        }, { once: true }));
      }
      return mode === "bad-health" ? { state, healthObservationDigest: d("bad-health"), extra: true }
        : mode === "bad-health-digest" ? { state, healthObservationDigest: "not-a-digest" }
        : { state, healthObservationDigest: d(`health:${state}`) };
    },
    async cleanup(cleanupSignal) {
      cleanupCalls += 1;
      if (mode === "hanging-cleanup") {
        cleanupSignal.addEventListener("abort", () => { hooks.cleanupAborted?.(); }, { once: true });
        await new Promise<void>(() => {});
      }
      return { outcome: "confirmed" };
    },
  };
  const port = createPrivateMacosServiceRuntimePortV1({ ownerUid, ownerHome, releaseDigest,
    serviceDefinitionDigest: definitionDigest, expectedDefinitionParentIdentityDigest: parentIdentityDigest,
    expectedDefinitionIdentityDigest: definitionIdentity, serviceIdentityDigest,
    topologyPlanDigest: d("topology"), databaseAuthorityDigest: d("database"),
    protectedDataBindingDigest: d("protected"), supervisorReadinessDigest: d("supervisor"), host,
    async authorizeControl(context: PrivateMacosServiceRuntimeAuthorizationContextV1) {
      authorizations.push(context.action);
      if (mode === "deny") throw new Error("owner refused");
      if (mode === "slow-auth") await new Promise(resolve => setTimeout(resolve, 30));
      return { schema: PRIVATE_MACOS_SERVICE_RUNTIME_AUTHORIZATION_V1, action: context.action,
        operationId: context.operationId, requestDigest: context.requestDigest, authorized: true as const };
    } });
  return { port, calls, mutations, authorizations, cleanupCalls: () => cleanupCalls, state: () => state };
}

function receipt(request: PrivateMacosServiceRuntimeHostRequestV1,
  outcome: "succeeded" | "failed_before_effect", state: State, definitionIdentityDigest: string | null) {
  return { schema: PRIVATE_MACOS_SERVICE_RUNTIME_RECEIPT_V1, operation: request.operation, outcome,
    ownerUid: request.ownerUid, launchctlDomain: request.launchctlDomain, launchctlTarget: request.launchctlTarget,
    label: request.label, launchAgentPath: request.launchAgentPath, requestDigest: request.requestDigest,
    lifecycleDigest: request.lifecycleDigest, releaseDigest: request.releaseDigest,
    serviceDefinitionDigest: request.serviceDefinitionDigest,
    definitionParentIdentityDigest: request.expectedDefinitionParentIdentityDigest,
    definitionIdentityDigest, serviceIdentityDigest: request.expectedServiceIdentityDigest, state } as const;
}

function control(action: "status" | "start" | "stop" | "restart", operationId = `operation-${action}-0001`) {
  return { schema: PRIVATE_MACOS_SERVICE_RUNTIME_PORT_V1, action, operationId, lifecycleDigest,
    deadlineUnixMs: Date.now() + 20_000, signal: new AbortController().signal } as const;
}

function nativeRequest(operation: "verify_supervisor_readiness" | "verify_release" | "verify_service_definition"
  | "install_service_definition" | "start_service" | "verify_service_health", expectedIdentity: string | null,
serviceDefinition?: string) {
  return { schema: PRIVATE_MACOS_SERVICE_NATIVE_PORT_V1, operation, label: PRIVATE_MACOS_SERVICE_LABEL_V1,
    launchAgentPath, lifecycleDigest, requestDigest: d(`native:${operation}`), releaseDigest,
    serviceDefinitionDigest: definitionDigest, expectedDefinitionParentIdentityDigest: parentIdentityDigest,
    expectedDefinitionIdentityDigest: expectedIdentity, expectedServiceIdentityDigest: serviceIdentityDigest,
    ...(serviceDefinition === undefined ? {} : { serviceDefinition }), deadlineUnixMs: Date.now() + 20_000,
    signal: new AbortController().signal } as const;
}

test("construction is inert and preflight is read-only with honest owner-login semantics", async () => {
  const f = fixture("stopped");
  assert.equal(f.calls.length, 0);
  const result = await f.port.preflight({ lifecycleDigest, deadlineUnixMs: Date.now() + 20_000,
    signal: new AbortController().signal });
  assert.equal(result.ready, true); assert.equal(result.state, "stopped");
  assert.equal(result.startsService, false); assert.equal(result.performsWrite, false);
  assert.equal(result.returnsAtOwnerLogin, true); assert.equal(result.availableBeforeOwnerLogin, false);
  assert.deepEqual(f.mutations, []);
  assert.deepEqual(f.calls.map(call => call.operation), ["inspect_service_status"]);
});

test("the fixed initial-install port publishes once, starts once and returns bound health evidence", async () => {
  const f = fixture();
  for (const operation of ["verify_supervisor_readiness", "verify_release", "verify_service_definition"] as const) {
    const result = await f.port.nativePort.performStep(nativeRequest(operation, null));
    assert.equal(result.outcome, "succeeded");
  }
  const installed = await f.port.nativePort.performStep(nativeRequest("install_service_definition", null, serviceDefinition));
  assert.equal(installed.definitionIdentityDigest, publishedIdentityDigest);
  assert.equal((await f.port.nativePort.performStep(nativeRequest("start_service", publishedIdentityDigest))).outcome, "succeeded");
  assert.equal((await f.port.nativePort.performStep(nativeRequest("verify_service_health", publishedIdentityDigest))).outcome, "succeeded");
  const final = await f.port.nativePort.observeInstalledService({ schema: "control-room.private-macos-service-tool/v1",
    operation: "observe_installed_service", requestDigest: d("native:verify_service_health"), lifecycleDigest,
    label: PRIVATE_MACOS_SERVICE_LABEL_V1, expectedReleaseDigest: releaseDigest,
    expectedServiceIdentityDigest: serviceIdentityDigest, expectedServiceDefinitionDigest: definitionDigest,
    deadlineUnixMs: Date.now() + 20_000 }, new AbortController().signal) as Record<string, unknown>;
  assert.equal((final.serviceObservation as { state: string }).state, "running");
  assert.deepEqual(f.mutations, ["install", "start"]);
  assert.equal(await f.port.nativePort.cleanup(new AbortController().signal).then(value => value.outcome), "confirmed");
  assert.equal(f.cleanupCalls(), 1);
});

test("the exact frozen native view composes with the strict reviewed tool adapter", async () => {
  const servicePackageInput = Object.freeze({ label: PRIVATE_MACOS_SERVICE_LABEL_V1,
    nodePath: "/reviewed/node/bin/node", launcherPath: "/reviewed/releases/v1/run.mjs",
    configurationPath: "/reviewed/protected/config.mjs", workingDirectory: "/reviewed/releases/v1",
    standardOutPath: "/reviewed/protected/service.out.log",
    standardErrorPath: "/reviewed/protected/service.err.log" });
  const package_ = createMacosLocalServicePackageV1(servicePackageInput);
  const adapterDefinitionDigest = d(package_.plist);
  const adapterServiceIdentityDigest = macosServiceIdentityDigestV1(servicePackageInput);
  const adapterPublishedIdentityDigest = d("adapter-published-definition");
  let state: State = "not_installed", definitionIdentity: string | null = null;
  const operations: string[] = [];
  const host: PrivateMacosServiceRuntimeHostV1 = Object.freeze({
    schema: PRIVATE_MACOS_SERVICE_RUNTIME_HOST_V1,
    async perform(request) {
      operations.push(request.operation);
      if (request.operation === "install_service_definition") {
        definitionIdentity = adapterPublishedIdentityDigest; state = "stopped";
      } else if (request.operation === "start_service") state = "running";
      return { schema: PRIVATE_MACOS_SERVICE_RUNTIME_RECEIPT_V1, operation: request.operation,
        outcome: "succeeded", ownerUid: request.ownerUid, launchctlDomain: request.launchctlDomain,
        launchctlTarget: request.launchctlTarget, label: request.label, launchAgentPath: request.launchAgentPath,
        requestDigest: request.requestDigest, lifecycleDigest: request.lifecycleDigest,
        releaseDigest: request.releaseDigest, serviceDefinitionDigest: request.serviceDefinitionDigest,
        definitionParentIdentityDigest: request.expectedDefinitionParentIdentityDigest,
        definitionIdentityDigest: definitionIdentity, serviceIdentityDigest: request.expectedServiceIdentityDigest,
        state };
    },
    async observeHealth() { operations.push("observe"); return { state, healthObservationDigest: d("adapter-health") }; },
    async cleanup() { operations.push("cleanup"); return { outcome: "confirmed" }; },
  });
  const runtime = createPrivateMacosServiceRuntimePortV1({ ownerUid, ownerHome, releaseDigest,
    serviceDefinitionDigest: adapterDefinitionDigest,
    expectedDefinitionParentIdentityDigest: parentIdentityDigest, expectedDefinitionIdentityDigest: null,
    serviceIdentityDigest: adapterServiceIdentityDigest, topologyPlanDigest: d("adapter-topology"),
    databaseAuthorityDigest: d("adapter-database"), protectedDataBindingDigest: d("adapter-protected"),
    supervisorReadinessDigest: d("adapter-supervisor"), host,
    async authorizeControl() { throw new Error("not used by install adapter"); } });
  assert.equal(Object.isFrozen(runtime.nativePort), true);
  assert.deepEqual(Object.keys(runtime.nativePort), ["schema", "performStep", "observeInstalledService", "cleanup"]);
  const tool = createPrivateMacosServiceToolAdapterV1({ lifecycleDigest, releaseDigest,
    expectedLaunchAgentsDirectoryIdentityDigest: parentIdentityDigest,
    servicePackageInput, ownerHome, launchAgentPath, nativePort: runtime.nativePort });
  const installOperations = ["verify_supervisor_readiness", "verify_release", "verify_service_definition",
    "install_service_definition", "start_service", "verify_service_health"] as const;
  const operationSignal = new AbortController().signal, adapterRequestDigest = d("adapter-request");
  for (let index = 0; index < installOperations.length; index += 1) {
    const operation = installOperations[index]!;
    const result = await tool.executeStep({ schema: "control-room.private-macos-service-tool/v1",
      requestDigest: adapterRequestDigest, deadlineUnixMs: Date.now() + 20_000,
      step: { schema: MACOS_SERVICE_OWNER_ACTION_SIMULATION_V1, lifecycleDigest, action: "install", phase: "primary",
        operation, kind: index === 3 ? "administrative_write" : index === 4 ? "service_transition" : "read",
        timeoutSeconds: index === 4 ? 120 : 30, label: PRIVATE_MACOS_SERVICE_LABEL_V1,
        ...(index === 3 ? { serviceDefinition: package_ } : {}) } }, operationSignal);
    assert.deepEqual(result, { outcome: "succeeded" });
  }
  const observed = await tool.observeFinal({ schema: "control-room.private-macos-service-tool/v1",
    operation: "observe_installed_service", requestDigest: adapterRequestDigest, lifecycleDigest,
    label: PRIVATE_MACOS_SERVICE_LABEL_V1, expectedReleaseDigest: releaseDigest,
    expectedServiceIdentityDigest: adapterServiceIdentityDigest,
    expectedServiceDefinitionDigest: adapterDefinitionDigest, deadlineUnixMs: Date.now() + 20_000 }, operationSignal);
  assert.equal((observed as { schema: string }).schema, "control-room.private-macos-service-final-observation/v1");
  assert.deepEqual(await tool.cleanup(operationSignal), { outcome: "confirmed" });
  assert.deepEqual(operations, [...installOperations, "observe", "cleanup"]);
});

test("status, start, stop and restart are bounded and exact duplicate operations do not repeat effects", async () => {
  const f = fixture("stopped");
  assert.equal((await f.port.control(control("status"))).state, "stopped");
  const start = control("start");
  const first = await f.port.control(start), replay = await f.port.control(start);
  assert.equal(first.state, "running"); assert.equal(first.replayed, false);
  assert.equal(replay.state, "running"); assert.equal(replay.replayed, true);
  assert.deepEqual(f.mutations, ["start"]);
  assert.equal((await f.port.control(control("restart"))).state, "running");
  assert.equal((await f.port.control(control("stop"))).state, "stopped");
  assert.deepEqual(f.mutations, ["start", "stop", "start", "stop"]);
  assert.deepEqual(f.authorizations, ["start", "restart", "stop"]);
});

test("concurrent exact duplicates share one operation and a changed duplicate is refused", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture("stopped");
  const original = (f.port as unknown as { control: typeof f.port.control }).control;
  // The runtime's own in-flight registry is exercised by holding the host's
  // first observation through a wrapper port with the same fixed receipt.
  const host = (f as unknown as { host?: never }).host;
  void host;
  const request = control("start", "operation-concurrent-0001");
  // Start both calls in the same turn. Host entry is synchronous before its
  // promise settles, so only the registered operation may proceed.
  const one = original(request), two = original(request);
  release(); void gate;
  const [a, b] = await Promise.all([one, two]);
  assert.equal(a.replayed, false); assert.equal(b.replayed, true);
  assert.deepEqual(f.mutations, ["start"]);
  await assert.rejects(f.port.control({ ...request, action: "stop" }), /_refused/u);
});

test("refused requests cannot mutate service state", async () => {
  const f = fixture("running");
  await assert.rejects(f.port.control(control("start")), /_refused/u);
  assert.deepEqual(f.mutations, []);
  await assert.rejects(f.port.nativePort.performStep({ ...nativeRequest("verify_release", publishedIdentityDigest),
    launchAgentPath: "/tmp/changed.plist" }), /_refused/u);
  assert.deepEqual(f.mutations, []);

  const unknown = fixture("unknown");
  await assert.rejects(unknown.port.preflight({ lifecycleDigest, deadlineUnixMs: Date.now() + 20_000,
    signal: new AbortController().signal }), /_refused/u);
  assert.deepEqual(unknown.mutations, []);

  const denied = fixture("stopped", "deny");
  await assert.rejects(denied.port.control(control("start", "operation-denied-0001")), /_refused/u);
  assert.deepEqual(denied.calls, [], "owner refusal occurs before even the service status host is entered");
  assert.deepEqual(denied.mutations, []);
});

test("a restart failure after the known stop is uncertain, is never retried and exposes no host detail", async () => {
  const f = fixture("running", "throw-start");
  const request = control("restart", "operation-restart-failure-0001");
  let caught: unknown;
  try { await f.port.control(request); } catch (error) { caught = error; }
  assert.ok(caught instanceof Error); assert.equal(caught.message, "private_macos_service_runtime_port_uncertain");
  assert.equal(caught.stack, undefined); assert.doesNotMatch(String(caught), /private process detail/u);
  assert.deepEqual(f.mutations, ["stop"]);
  await assert.rejects(f.port.control(request), /_uncertain/u);
  assert.deepEqual(f.mutations, ["stop"], "uncertain operations are not repeated");
});

test("a failed final observation after a successful mutation is uncertain and cannot repeat the effect", async () => {
  const f = fixture("stopped", "unknown-after-effect");
  const request = control("start", "operation-final-observation-0001");
  await assert.rejects(f.port.control(request), /_uncertain/u);
  assert.deepEqual(f.mutations, ["start"]);
  await assert.rejects(f.port.control(request), /_uncertain/u);
  assert.deepEqual(f.mutations, ["start"]);
});

test("cancellation between restart stop and start is uncertain and never starts or retries", async () => {
  const controller = new AbortController();
  const f = fixture("running", "normal", { afterStop: () => controller.abort() });
  const request = { ...control("restart", "operation-cancelled-restart-0001"), signal: controller.signal };
  await assert.rejects(f.port.control(request), /_uncertain/u);
  assert.deepEqual(f.mutations, ["stop"]);
  await assert.rejects(f.port.control(request), /_uncertain/u);
  assert.deepEqual(f.mutations, ["stop"]);
});

test("authorization that outlives the deadline cannot reach a service effect", async () => {
  const f = fixture("stopped", "slow-auth");
  const request = { ...control("start", "operation-expired-authorization-0001"), deadlineUnixMs: Date.now() + 10 };
  await assert.rejects(f.port.control(request), /_refused/u);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.mutations, []);
});

test("a service host call that outlives the deadline is cancelled, uncertain and never repeated", async () => {
  const f = fixture("stopped", "slow-start");
  const request = { ...control("start", "operation-expired-host-0001"), deadlineUnixMs: Date.now() + 10 };
  await assert.rejects(f.port.control(request), /_uncertain/u);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.deepEqual(f.mutations, []);
  await assert.rejects(f.port.control({ ...request, deadlineUnixMs: Date.now() + 20_000 }), /_uncertain/u);
  assert.deepEqual(f.mutations, []);
});

test("a mutating control excludes a distinct native mutation until the first operation settles", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const f = fixture("stopped", "normal", { beforeStart: async () => {
    if (!first) return;
    first = false; entered(); await gate;
  } });
  const pending = f.port.control(control("start", "operation-held-control-0001"));
  await started;
  await assert.rejects(f.port.nativePort.performStep(nativeRequest("start_service", publishedIdentityDigest)), /_refused/u);
  assert.deepEqual(f.mutations, []);
  release();
  assert.equal((await pending).state, "running");
  assert.deepEqual(f.mutations, ["start"]);
});

test("malformed native receipts and cancelled cleanup are uncertainty", async () => {
  const bad = fixture("stopped", "bad-receipt");
  await assert.rejects(bad.port.control(control("status")), /_uncertain/u);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(bad.port.nativePort.cleanup(controller.signal), /_uncertain/u);
  assert.equal(bad.cleanupCalls(), 0);
});

test("health observation is deadline-bounded, aborts its host call and rejects malformed late evidence", async () => {
  let healthAborted = false;
  const slow = fixture("running", "slow-health", { healthAborted: () => { healthAborted = true; } });
  const request = { schema: "control-room.private-macos-service-tool/v1" as const,
    operation: "observe_installed_service" as const, requestDigest: d("slow-health"), lifecycleDigest,
    label: PRIVATE_MACOS_SERVICE_LABEL_V1, expectedReleaseDigest: releaseDigest,
    expectedServiceIdentityDigest: serviceIdentityDigest, expectedServiceDefinitionDigest: definitionDigest,
    deadlineUnixMs: Date.now() + 10 };
  await assert.rejects(slow.port.nativePort.observeInstalledService(request, new AbortController().signal), /_uncertain/u);
  assert.equal(healthAborted, true);

  const malformed = fixture("running", "bad-health");
  await assert.rejects(malformed.port.nativePort.observeInstalledService({ ...request,
    requestDigest: d("bad-health"), deadlineUnixMs: Date.now() + 20_000 }, new AbortController().signal), /_uncertain/u);
  const badDigest = fixture("running", "bad-health-digest");
  await assert.rejects(badDigest.port.nativePort.observeInstalledService({ ...request,
    requestDigest: d("bad-health-digest"), deadlineUnixMs: Date.now() + 20_000 }, new AbortController().signal), /_uncertain/u);
});

test("cleanup forwards cancellation to a never-settling host and does not remain pending", async () => {
  let cleanupAborted = false;
  const hanging = fixture("stopped", "hanging-cleanup", { cleanupAborted: () => { cleanupAborted = true; } });
  const controller = new AbortController();
  const pending = hanging.port.nativePort.cleanup(controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, /_uncertain/u);
  assert.equal(cleanupAborted, true);
  assert.equal(hanging.cleanupCalls(), 1);
});
