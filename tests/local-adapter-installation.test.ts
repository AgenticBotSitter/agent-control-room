import assert from "node:assert/strict";
import test from "node:test";
import { captureLocalAdapterInstallationPortsV1, deliverPreparedLocalAdapterV1,
  LOCAL_ADAPTER_IDS_V1, type LocalAdapterInstallationPortsV1 } from "../src/harness/v1/local-adapter-installation";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { sha256Digest } from "../src/security/canonical-digest";
import { assemblePrivateAgentTaskOperatorConfiguration } from "../src/web/v1/private-agent-task-operator-configuration";
import { validatePrivateTaskStartupConfiguration } from "../src/web/v1/private-task-startup";
import { operatorConfigurationScenario } from "./helpers/private-agent-task-operator-configuration";

const time = "2026-09-20T12:00:00.000Z";
function fixture() {
  let calls = 0;
  const ports: LocalAdapterInstallationPortsV1 = {};
  for (const harness of Object.keys(LOCAL_ADAPTER_IDS_V1) as Array<keyof typeof LOCAL_ADAPTER_IDS_V1>) {
    Object.defineProperty(ports, harness, { enumerable: true, configurable: true, value: {
      workerId: `worker:${harness}`, adapterId: LOCAL_ADAPTER_IDS_V1[harness], adapterRevision: "revision:source",
      state: "source_only", async deliver() { calls++; throw new Error("must_not_call"); },
    } });
  }
  return { ports, calls: () => calls };
}
function packet(harness: keyof typeof LOCAL_ADAPTER_IDS_V1) {
  return createControllerWorkerDeliveryV1({
    identity: { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test", attemptId: "attempt:test",
      runId: "run:test", nodeId: "node:test" },
    worker: { workerId: `worker:${harness}`, adapterId: LOCAL_ADAPTER_IDS_V1[harness], adapterRevision: "revision:source" },
    input: { prompt: "Review the supplied text", instructions: "Return text only" },
    authorityDigest: sha256Digest("authority"), connectorProfileDigest: sha256Digest(harness),
    acceptanceProfileId: "profile:test", acceptanceProfileDigest: sha256Digest("acceptance"),
    issuedAt: time, expiresAt: "2026-09-20T12:05:00.000Z",
  });
}

test("operator and startup preserve three optional inert compositions without adding an enabled worker", () => {
  const x = fixture();
  const { settings, trusted } = operatorConfigurationScenario("minimal");
  const ordinary = assemblePrivateAgentTaskOperatorConfiguration(settings, trusted);
  assert.equal(ordinary.configuration.preparedLocalAdapters, undefined);
  const composed = assemblePrivateAgentTaskOperatorConfiguration(settings, { ...trusted, preparedLocalAdapters: x.ports });
  const captured = validatePrivateTaskStartupConfiguration(composed.configuration);
  assert.deepEqual(Object.keys(captured.preparedLocalAdapters!), ["hermes", "codex", "claude"]);
  assert.equal(captured.queueWorker, undefined);
  assert.equal(captured.hermes021Local, undefined);
  assert.equal(captured.nativeQueue, ordinary.configuration.coordinator.nativeQueue);
  for (const port of Object.values(captured.preparedLocalAdapters!)) {
    assert.equal(port.state, "source_only");
    assert.equal(Object.isFrozen(port), true);
  }
  const original = x.ports.codex!.deliver;
  Object.defineProperty(x.ports.codex!, "deliver", { value: async () => { throw new Error("replacement"); } });
  assert.notEqual(captured.preparedLocalAdapters!.codex!.deliver, x.ports.codex!.deliver);
  assert.notEqual(captured.preparedLocalAdapters!.codex!.deliver, original, "method is captured with its receiver");
  assert.equal(x.calls(), 0);
});

test("the same canonical packet boundary refuses absent, wrong and unqualified adapters before any callback", async () => {
  const x = fixture();
  for (const harness of Object.keys(LOCAL_ADAPTER_IDS_V1) as Array<keyof typeof LOCAL_ADAPTER_IDS_V1>) {
    const delivery = packet(harness), route = { kind: "local" as const, workerId: delivery.worker.workerId };
    for (const ports of [undefined, {}, x.ports]) {
      await assert.rejects(deliverPreparedLocalAdapterV1(ports, delivery, route, time), /local_adapter_installation_unavailable/);
    }
    await assert.rejects(deliverPreparedLocalAdapterV1(x.ports, delivery, { ...route, workerId: "worker:wrong" }, time), /unavailable/);
    await assert.rejects(deliverPreparedLocalAdapterV1(x.ports, delivery, { ...route, kind: "remote", nodeId: "node:test" }, time));
  }
  assert.equal(x.calls(), 0);
});

test("unknown adapters, duplicate identities and fabricated qualification cannot become prepared ports", () => {
  const x = fixture();
  for (const invalid of [
    { unknown: x.ports.hermes },
    { toString: x.ports.hermes },
    { codex: x.ports.hermes },
    { ...x.ports, claude: { ...x.ports.claude, workerId: x.ports.hermes!.workerId } },
    { codex: { ...x.ports.codex, state: "qualified" } },
    { codex: { ...x.ports.codex, enabled: true } },
    { codex: { ...x.ports.codex, deliver: undefined } },
  ]) assert.throws(() => captureLocalAdapterInstallationPortsV1(invalid as LocalAdapterInstallationPortsV1));
  assert.equal(x.calls(), 0);
});
