import assert from "node:assert/strict";
import test from "node:test";
import { FleetGatewayStoreV1, InMemoryFleetToolCapabilityEvidenceV1,
  type FleetWorkerPrincipalV1 } from "../src/fleet/v1";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

function database(): DatabaseClient {
  const session = { query: async () => ({ rows: [], rowCount: 0 }) } as DatabaseSession;
  return { query: session.query,
    transaction: async work => work(session),
    transactionWithPreCommitCheck: async (work, check) => { const value = await work(session); await check(); return value; } };
}

const principal: FleetWorkerPrincipalV1 = Object.freeze({
  tenantId: "tenant:tool-evidence",
  workerId: `fleet-worker:${"a".repeat(32)}`,
  nodeId: `node:fleet:${"a".repeat(32)}`,
  identityId: `identity:fleet:${"a".repeat(32)}`,
  workerKind: "tool",
  displayName: "Local tools",
  projectIds: Object.freeze(["project:one"]),
  capabilities: Object.freeze(["owner.approved"]),
  maxConcurrent: 2,
  credentialId: `fleet-credential:${"b".repeat(32)}`,
  credentialExpiresAt: "2030-01-01T00:00:00.000Z",
});

test("heartbeat stores adapter names as evidence without widening the authenticated capability ceiling", async () => {
  const evidence = new InMemoryFleetToolCapabilityEvidenceV1();
  const store = new FleetGatewayStoreV1(database(), { tenantId: principal.tenantId, toolCapabilityEvidence: evidence,
    operationsMode: async () => "running", clock: () => Date.parse("2026-09-29T12:00:00.000Z") });
  // `sessionId` is required by 0215: presence is session-fenced, so a check-in
  // with no session cannot declare a state. This test is about the CAPABILITY
  // evidence and the ceiling it must not widen, and it sends a well-formed
  // session alongside the capabilities so it is exercising that, not the refusal.
  const result = await store.heartbeat(principal, { connectorVersion: "0.3.0", platform: "macos",
    sessionId: `fleet-session:${"a".repeat(32)}`, adapterCapabilities: ["tool.whisper", "gpu.metal"] });
  assert.deepEqual(result.capabilities, ["owner.approved"]);
  assert.equal(result.claimsAllowed, true);
  assert.deepEqual(evidence.latest(principal.workerId), {
    tenantId: principal.tenantId,
    workerId: principal.workerId,
    observedAt: "2026-09-29T12:00:00.000Z",
    phase: "heartbeat",
    connectorVersion: "0.3.0",
    platform: "macos",
    capabilities: ["gpu.metal", "tool.whisper"],
  });
});

test("malformed or duplicate observed capabilities are refused", async () => {
  const store = new FleetGatewayStoreV1(database(), { tenantId: principal.tenantId,
    operationsMode: async () => "running" });
  // Each carries a valid sessionId, so the ONLY reason these can be refused is
  // the capability list itself. Without one they would be refused earlier for a
  // missing session and would pass while testing nothing about capabilities.
  await assert.rejects(store.heartbeat(principal, { connectorVersion: "0.3.0", platform: "macos",
    sessionId: `fleet-session:${"b".repeat(32)}`, adapterCapabilities: ["tool.whisper", "tool.whisper"] }),
  /fleet_invalid/u);
  await assert.rejects(store.heartbeat(principal, { connectorVersion: "0.3.0", platform: "macos",
    sessionId: `fleet-session:${"c".repeat(32)}`, adapterCapabilities: ["/bin/sh"] }), /fleet_invalid/u);
});
