import assert from "node:assert/strict";
import test from "node:test";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { captureMacLocalAdapterRegistryV1, deliverMacLocalAdapterV1,
  type MacLocalAdapterRegistryV1 } from "../src/harness/v1/mac-local-adapter-registry";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";
import { LOCAL_ADAPTER_IDS_V1 } from "../src/harness/v1/local-adapter-installation";
import { sha256Digest } from "../src/security/canonical-digest";

const at = "2026-09-24T20:00:00.000Z";
const enablement = Object.freeze({ schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local" as const, nodeId: "mac-1" as const,
  workers: [
    { workerId: "worker:codex", kind: "codex" as const, executablePath: "/Applications/Codex", recordedVersion: "codex test" },
    { workerId: "worker:hermes", kind: "hermes-021" as const, executablePath: "/usr/local/bin/hermes", recordedVersion: "hermes test" },
    { workerId: "worker:claude", kind: "claude-code" as const, executablePath: "/usr/local/bin/claude", recordedVersion: "claude test" },
  ],
});
function packet(harness: keyof typeof LOCAL_ADAPTER_IDS_V1, revision = "revision:test") {
  const workerId = `worker:${harness}`;
  return createControllerWorkerDeliveryV1({ identity: { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test",
    attemptId: "attempt:test", runId: "run:test", nodeId: "mac-1" }, worker: { workerId, adapterId: LOCAL_ADAPTER_IDS_V1[harness], adapterRevision: revision },
  input: { prompt: "Return a bounded text response", instructions: "No tools" }, authorityDigest: sha256Digest("authority"),
  connectorProfileDigest: sha256Digest(harness), acceptanceProfileId: "profile:test", acceptanceProfileDigest: sha256Digest("acceptance"),
  issuedAt: at, expiresAt: "2026-09-24T20:05:00.000Z" });
}
function fixture() {
  const calls: string[] = [];
  const adapters: MacLocalAdapterRegistryV1["adapters"] = {};
  for (const harness of Object.keys(LOCAL_ADAPTER_IDS_V1) as Array<keyof typeof LOCAL_ADAPTER_IDS_V1>) adapters[harness] = {
    workerId: `worker:${harness}`, adapterId: LOCAL_ADAPTER_IDS_V1[harness], adapterRevision: "revision:test",
    async deliver(delivery) { calls.push(delivery.worker.workerId); return { harness, state: "delegated" as const }; },
  };
  return { registry: { enablement, adapters }, calls };
}

test("captures only pinned enabled worker callbacks and calls the exact selected adapter", async () => {
  const f = fixture(), value = captureMacLocalAdapterRegistryV1(f.registry);
  assert.equal(Object.isFrozen(value), true);
  const delivery = packet("claude");
  assert.deepEqual(await deliverMacLocalAdapterV1(value, delivery, { kind: "local", workerId: "worker:claude" }, at),
    { harness: "claude", state: "delegated" });
  assert.deepEqual(f.calls, ["worker:claude"]);
});

test("refuses a redirect, stale revision, remote route, unknown enabled worker, or pre-cancel before any adapter callback", async () => {
  const f = fixture(), delivery = packet("codex");
  const cases: Array<[unknown, unknown, AbortSignal | undefined]> = [
    [delivery, { kind: "local", workerId: "worker:claude" }, undefined],
    [packet("codex", "revision:stale"), { kind: "local", workerId: "worker:codex" }, undefined],
    [delivery, { kind: "remote", workerId: "worker:codex" }, undefined],
    [{ ...delivery, worker: { ...delivery.worker, workerId: "worker:unknown" } }, { kind: "local", workerId: "worker:unknown" }, undefined],
    [delivery, { kind: "local", workerId: "worker:codex" }, AbortSignal.abort()],
  ];
  for (const [packetValue, route, signal] of cases) await assert.rejects(deliverMacLocalAdapterV1(f.registry, packetValue, route, at, signal),
    /mac_local_adapter_registry_unavailable|controller worker delivery binding mismatch/);
  assert.deepEqual(f.calls, []);
});

test("refuses a callback not bound to a pinned enabled worker", () => {
  const f = fixture();
  assert.throws(() => captureMacLocalAdapterRegistryV1({ ...f.registry, adapters: { codex: {
    ...f.registry.adapters.codex!, workerId: "worker:claude" } } }), /mac_local_adapter_registry_unavailable/);
  assert.throws(() => captureMacLocalAdapterRegistryV1({ ...f.registry, adapters: { codex: {
    ...f.registry.adapters.codex!, adapterId: "adapter:wrong" } } }), /mac_local_adapter_registry_unavailable/);
});
