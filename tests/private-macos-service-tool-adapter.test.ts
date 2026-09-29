import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createMacosLocalServicePackageV1 } from "../src/harness/v1/macos-local-service-package";
import { MACOS_SERVICE_OWNER_ACTION_SIMULATION_V1,
  macosServiceIdentityDigestV1 } from "../src/installer/v1/macos-service-owner-action";
import { PRIVATE_MACOS_SERVICE_FINAL_OBSERVATION_V1, PRIVATE_MACOS_SERVICE_LABEL_V1,
  PRIVATE_MACOS_SERVICE_TOOL_V1, type PrivateMacosServiceToolRequestV1 } from
  "../src/installer/v1/private-macos-service-owner-runner";
import { PRIVATE_MACOS_SERVICE_NATIVE_PORT_V1, PRIVATE_MACOS_SERVICE_NATIVE_RECEIPT_V1,
  createPrivateMacosServiceToolAdapterV1, type PrivateMacosServiceNativePortV1,
  type PrivateMacosServiceNativeStepRequestV1 } from
  "../src/installer/v1/private-macos-service-tool-adapter";
import { sha256Digest } from "../src/security/canonical-digest";

const d = (value: unknown) => sha256Digest(value);
const lifecycleDigest = d("lifecycle"), releaseDigest = d("release"), requestDigest = d("request");
const ownerHome = "/Users/owner";
const launchAgentPath = `${ownerHome}/Library/LaunchAgents/${PRIVATE_MACOS_SERVICE_LABEL_V1}.plist`;
const parentIdentityDigest = d("launch-agents-directory-identity");
const servicePackageInput = Object.freeze({ label: PRIVATE_MACOS_SERVICE_LABEL_V1,
  nodePath: "/reviewed/node/bin/node", launcherPath: "/reviewed/releases/v1/run.mjs",
  configurationPath: "/reviewed/protected/config.mjs", workingDirectory: "/reviewed/releases/v1",
  standardOutPath: "/reviewed/protected/service.out.log", standardErrorPath: "/reviewed/protected/service.err.log" });
const serviceIdentityDigest = macosServiceIdentityDigestV1(servicePackageInput);
const package_ = createMacosLocalServicePackageV1(servicePackageInput);
const operations = ["verify_supervisor_readiness", "verify_release", "verify_service_definition",
  "install_service_definition", "start_service", "verify_service_health"] as const;

function fixture() {
  const calls: string[] = [];
  const nativePort: PrivateMacosServiceNativePortV1 = {
    schema: PRIVATE_MACOS_SERVICE_NATIVE_PORT_V1,
    async performStep(request: PrivateMacosServiceNativeStepRequestV1) {
      calls.push(request.operation);
      return { schema: PRIVATE_MACOS_SERVICE_NATIVE_RECEIPT_V1, operation: request.operation,
        outcome: "succeeded" as const, label: request.label, launchAgentPath: request.launchAgentPath,
        requestDigest: request.requestDigest, lifecycleDigest: request.lifecycleDigest, releaseDigest: request.releaseDigest,
        serviceDefinitionDigest: request.serviceDefinitionDigest,
        definitionParentIdentityDigest: request.expectedDefinitionParentIdentityDigest,
        definitionIdentityDigest: request.operation === "install_service_definition"
          ? d("installed-definition-identity") : request.expectedDefinitionIdentityDigest,
        serviceIdentityDigest: request.expectedServiceIdentityDigest };
    },
    async observeInstalledService(request: any) {
      calls.push("observe");
      return { schema: PRIVATE_MACOS_SERVICE_FINAL_OBSERVATION_V1, requestDigest: request.requestDigest,
        lifecycleDigest: request.lifecycleDigest, installedServiceDefinitionDigest: request.expectedServiceDefinitionDigest,
        serviceObservation: { state: "running" } };
    },
    async cleanup() { calls.push("cleanup"); return { outcome: "confirmed" as const }; },
  };
  const tool = createPrivateMacosServiceToolAdapterV1({ lifecycleDigest, releaseDigest,
    expectedLaunchAgentsDirectoryIdentityDigest: parentIdentityDigest,
    servicePackageInput, ownerHome, launchAgentPath, nativePort });
  return { calls, nativePort, tool };
}

function request(index: number): PrivateMacosServiceToolRequestV1 {
  const operation = operations[index]!;
  return { schema: PRIVATE_MACOS_SERVICE_TOOL_V1, requestDigest, deadlineUnixMs: Date.now() + 10_000,
    step: { schema: MACOS_SERVICE_OWNER_ACTION_SIMULATION_V1, lifecycleDigest, action: "install", phase: "primary",
      operation, kind: index === 3 ? "administrative_write" : index === 4 ? "service_transition" : "read",
      timeoutSeconds: index === 4 ? 120 : 30, label: PRIVATE_MACOS_SERVICE_LABEL_V1,
      ...(index === 3 ? { serviceDefinition: package_ } : {}) } };
}

test("is inert at construction and sends only the exact branded sequence to the captured native port", async () => {
  const f = fixture(), signal = new AbortController().signal;
  assert.deepEqual(f.calls, []);
  for (let index = 0; index < operations.length; index += 1) {
    assert.deepEqual(await f.tool.executeStep(request(index), signal), { outcome: "succeeded" });
  }
  const observed = await f.tool.observeFinal({ schema: PRIVATE_MACOS_SERVICE_TOOL_V1,
    operation: "observe_installed_service", requestDigest, lifecycleDigest, label: PRIVATE_MACOS_SERVICE_LABEL_V1,
    expectedReleaseDigest: releaseDigest, expectedServiceIdentityDigest: serviceIdentityDigest,
    expectedServiceDefinitionDigest: d(package_.plist), deadlineUnixMs: Date.now() + 10_000 }, signal);
  assert.equal((observed as { schema: string }).schema, PRIVATE_MACOS_SERVICE_FINAL_OBSERVATION_V1);
  assert.deepEqual(await f.tool.cleanup(signal), { outcome: "confirmed" });
  assert.deepEqual(f.calls, [...operations, "observe", "cleanup"]);
});

test("rejects alternate paths, labels, order, shell-like extras and ambient environment before native entry", async () => {
  for (const changed of [
    { servicePackageInput, ownerHome, launchAgentPath: "/tmp/service.plist" },
    { servicePackageInput, ownerHome: "/tmp", launchAgentPath: `/tmp/Library/LaunchAgents/${PRIVATE_MACOS_SERVICE_LABEL_V1}.plist` },
    { servicePackageInput, ownerHome: "/var/root", launchAgentPath: `/var/root/Library/LaunchAgents/${PRIVATE_MACOS_SERVICE_LABEL_V1}.plist` },
    { servicePackageInput, ownerHome, launchAgentPath: `/Library/LaunchDaemons/${PRIVATE_MACOS_SERVICE_LABEL_V1}.plist` },
    { servicePackageInput: { ...servicePackageInput, label: "xyz.agentcontrolroom.other" }, ownerHome, launchAgentPath },
  ]) assert.throws(() => createPrivateMacosServiceToolAdapterV1({ lifecycleDigest, releaseDigest,
    expectedLaunchAgentsDirectoryIdentityDigest: parentIdentityDigest,
    ...changed, nativePort: fixture().nativePort }), /_refused/u);
  const f = fixture(), signal = new AbortController().signal;
  await assert.rejects(f.tool.executeStep(request(1), signal), /_refused/u);
  await assert.rejects(f.tool.executeStep({ ...request(0), step: { ...request(0).step, timeoutSeconds: 29 } }, signal), /_refused/u);
  await assert.rejects(f.tool.executeStep({ ...request(0), step: { ...request(0).step, timeoutSeconds: 0 } }, signal), /_refused/u);
  await assert.rejects(f.tool.executeStep({ ...request(0), command: "launchctl bootstrap" } as never, signal), /_refused/u);
  await assert.rejects(f.tool.executeStep({ ...request(0), environment: { PATH: "/tmp" } } as never, signal), /_refused/u);
  assert.deepEqual(f.calls, []);
});

test("caps each native deadline by both the overall deadline and the fixed step timeout", async () => {
  const f = fixture(), forwarded: number[] = [], original = f.nativePort.performStep;
  (f.nativePort as { performStep: PrivateMacosServiceNativePortV1["performStep"] }).performStep = async value => {
    forwarded.push(value.deadlineUnixMs); return original(value);
  };
  const tool = createPrivateMacosServiceToolAdapterV1({ lifecycleDigest, releaseDigest,
    expectedLaunchAgentsDirectoryIdentityDigest: parentIdentityDigest,
    servicePackageInput, ownerHome, launchAgentPath, nativePort: f.nativePort });
  const signal = new AbortController().signal, before = Date.now();
  await tool.executeStep({ ...request(0), deadlineUnixMs: before + 120_000 }, signal);
  assert.ok(forwarded[0]! >= before + 29_000 && forwarded[0]! <= before + 30_100);
  const closeDeadline = Date.now() + 1_000;
  await tool.executeStep({ ...request(1), deadlineUnixMs: closeDeadline }, signal);
  assert.ok(forwarded[1]! <= closeDeadline && forwarded[1]! > Date.now());
});

test("a synchronous single-flight guard refuses concurrent duplicate entry", async () => {
  const f = fixture(), original = f.nativePort.performStep;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  (f.nativePort as { performStep: PrivateMacosServiceNativePortV1["performStep"] }).performStep = async value => {
    entered(); await gate; return original(value);
  };
  const tool = createPrivateMacosServiceToolAdapterV1({ lifecycleDigest, releaseDigest,
    expectedLaunchAgentsDirectoryIdentityDigest: parentIdentityDigest,
    servicePackageInput, ownerHome, launchAgentPath, nativePort: f.nativePort });
  const signal = new AbortController().signal, first = tool.executeStep(request(0), signal);
  await waiting;
  await assert.rejects(tool.executeStep(request(0), signal), /_refused/u);
  assert.deepEqual(f.calls, []);
  release();
  assert.deepEqual(await first, { outcome: "succeeded" });
  assert.deepEqual(f.calls, [operations[0]]);
});

test("abort after native step, observation or cleanup entry is uncertainty", async () => {
  {
    const f = fixture(), controller = new AbortController();
    (f.nativePort as { performStep: PrivateMacosServiceNativePortV1["performStep"] }).performStep = async nativeRequest => {
      controller.abort();
      return { schema: PRIVATE_MACOS_SERVICE_NATIVE_RECEIPT_V1, operation: nativeRequest.operation, outcome: "succeeded",
        label: nativeRequest.label, launchAgentPath: nativeRequest.launchAgentPath,
        requestDigest: nativeRequest.requestDigest, lifecycleDigest: nativeRequest.lifecycleDigest,
        releaseDigest: nativeRequest.releaseDigest, serviceDefinitionDigest: nativeRequest.serviceDefinitionDigest,
        definitionParentIdentityDigest: nativeRequest.expectedDefinitionParentIdentityDigest,
        definitionIdentityDigest: nativeRequest.expectedDefinitionIdentityDigest,
        serviceIdentityDigest: nativeRequest.expectedServiceIdentityDigest };
    };
    const tool = createPrivateMacosServiceToolAdapterV1({ lifecycleDigest, releaseDigest,
      expectedLaunchAgentsDirectoryIdentityDigest: parentIdentityDigest,
      servicePackageInput, ownerHome, launchAgentPath, nativePort: f.nativePort });
    await assert.rejects(tool.executeStep(request(0), controller.signal), /_uncertain/u);
  }
  {
    const f = fixture(), liveController = new AbortController();
    const native = { ...f.nativePort, async observeInstalledService() { liveController.abort(); return {}; } };
    const aborting = createPrivateMacosServiceToolAdapterV1({ lifecycleDigest, releaseDigest,
      expectedLaunchAgentsDirectoryIdentityDigest: parentIdentityDigest,
      servicePackageInput, ownerHome, launchAgentPath, nativePort: native });
    for (let index = 0; index < operations.length; index += 1) await aborting.executeStep(request(index), liveController.signal);
    await assert.rejects(aborting.observeFinal({ schema: PRIVATE_MACOS_SERVICE_TOOL_V1,
      operation: "observe_installed_service", requestDigest, lifecycleDigest, label: PRIVATE_MACOS_SERVICE_LABEL_V1,
      expectedReleaseDigest: releaseDigest, expectedServiceIdentityDigest: serviceIdentityDigest,
      expectedServiceDefinitionDigest: d(package_.plist), deadlineUnixMs: Date.now() + 10_000 }, liveController.signal), /_uncertain/u);
  }
  {
    const controller = new AbortController(), f = fixture();
    const native = { ...f.nativePort, async cleanup() { controller.abort(); return { outcome: "confirmed" as const }; } };
    const tool = createPrivateMacosServiceToolAdapterV1({ lifecycleDigest, releaseDigest,
      expectedLaunchAgentsDirectoryIdentityDigest: parentIdentityDigest,
      servicePackageInput, ownerHome, launchAgentPath, nativePort: native });
    await assert.rejects(tool.cleanup(controller.signal), /_uncertain/u);
  }
});

test("requires exact parent, definition and service identity continuity for every successful native receipt", async () => {
  {
    const f = fixture(), signal = new AbortController().signal;
    (f.nativePort as { performStep: PrivateMacosServiceNativePortV1["performStep"] }).performStep = async nativeRequest => ({ schema: PRIVATE_MACOS_SERVICE_NATIVE_RECEIPT_V1,
      operation: nativeRequest.operation, outcome: "succeeded", label: nativeRequest.label,
      launchAgentPath: nativeRequest.launchAgentPath,
      requestDigest: nativeRequest.requestDigest, lifecycleDigest: nativeRequest.lifecycleDigest,
      releaseDigest: nativeRequest.releaseDigest, serviceDefinitionDigest: nativeRequest.serviceDefinitionDigest,
      definitionParentIdentityDigest: d("substituted-parent"), definitionIdentityDigest: null,
      serviceIdentityDigest: nativeRequest.expectedServiceIdentityDigest });
    const captured = createPrivateMacosServiceToolAdapterV1({ lifecycleDigest, releaseDigest,
      expectedLaunchAgentsDirectoryIdentityDigest: parentIdentityDigest,
      servicePackageInput, ownerHome, launchAgentPath, nativePort: f.nativePort });
    await assert.rejects(captured.executeStep(request(0), signal), /_uncertain/u);
  }
  {
    const f = fixture(), signal = new AbortController().signal, original = f.nativePort.performStep;
    (f.nativePort as { performStep: PrivateMacosServiceNativePortV1["performStep"] }).performStep = async nativeRequest => {
      const result = await original(nativeRequest);
      return nativeRequest.operation === "start_service"
        ? { ...result, definitionIdentityDigest: d("substituted-definition-identity") } : result;
    };
    const captured = createPrivateMacosServiceToolAdapterV1({ lifecycleDigest, releaseDigest,
      expectedLaunchAgentsDirectoryIdentityDigest: parentIdentityDigest,
      servicePackageInput, ownerHome, launchAgentPath, nativePort: f.nativePort });
    for (let index = 0; index < 4; index += 1) await captured.executeStep(request(index), signal);
    await assert.rejects(captured.executeStep(request(4), signal), /_uncertain/u);
  }
});

test("preserves explicit pre-effect refusal and treats throws or malformed receipts as uncertainty", async () => {
  const signal = new AbortController().signal;
  for (const mode of ["failed", "throw", "malformed"] as const) {
    const f = fixture();
    (f.nativePort as { performStep: PrivateMacosServiceNativePortV1["performStep"] }).performStep = async nativeRequest => {
      if (mode === "throw") throw new Error("private native detail");
      return { schema: PRIVATE_MACOS_SERVICE_NATIVE_RECEIPT_V1, operation: nativeRequest.operation,
        outcome: mode === "failed" ? "failed_before_effect" as const : "changed" as never,
        label: nativeRequest.label, launchAgentPath: nativeRequest.launchAgentPath,
        requestDigest: nativeRequest.requestDigest, lifecycleDigest: nativeRequest.lifecycleDigest,
        releaseDigest: nativeRequest.releaseDigest, serviceDefinitionDigest: nativeRequest.serviceDefinitionDigest,
        definitionParentIdentityDigest: nativeRequest.expectedDefinitionParentIdentityDigest,
        definitionIdentityDigest: nativeRequest.expectedDefinitionIdentityDigest,
        serviceIdentityDigest: nativeRequest.expectedServiceIdentityDigest };
    };
    const tool = createPrivateMacosServiceToolAdapterV1({ lifecycleDigest, releaseDigest,
      expectedLaunchAgentsDirectoryIdentityDigest: parentIdentityDigest,
      servicePackageInput, ownerHome, launchAgentPath, nativePort: f.nativePort });
    if (mode === "failed") assert.deepEqual(await tool.executeStep(request(0), signal), { outcome: "failed_before_effect" });
    else await assert.rejects(tool.executeStep(request(0), signal), /_uncertain/u);
  }
});

test("captures native methods immutably and contains no shell, environment, filesystem or process implementation", async () => {
  const f = fixture(), original = f.nativePort.performStep;
  const tool = createPrivateMacosServiceToolAdapterV1({ lifecycleDigest, releaseDigest,
    expectedLaunchAgentsDirectoryIdentityDigest: parentIdentityDigest,
    servicePackageInput, ownerHome, launchAgentPath, nativePort: f.nativePort });
  (f.nativePort as { performStep: PrivateMacosServiceNativePortV1["performStep"] }).performStep = async () => { throw new Error("swapped"); };
  assert.deepEqual(await tool.executeStep(request(0), new AbortController().signal), { outcome: "succeeded" });
  (f.nativePort as { performStep: PrivateMacosServiceNativePortV1["performStep"] }).performStep = original;
  const source = await readFile(new URL("../src/installer/v1/private-macos-service-tool-adapter.ts", import.meta.url), "utf8");
  for (const forbidden of ["node:child_process", "node:fs", "exec(", "spawn(", "launchctl ", "process.env",
    "EnvironmentVariables", "setInterval("]) assert.equal(source.includes(forbidden), false, forbidden);
});
