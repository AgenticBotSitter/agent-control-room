import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { buildOperatorSurfaceSnapshotV1, filterActionInboxV1, OPERATOR_SURFACES_CONTRACT_V1, actionInboxItemSchemaV1, OperatorSurfaceStoreV1, ownerFocusCommandSchemaV1, parseOperatorSurfaceSnapshotV1, projectOwnerFocusForSchedulerV1 } from "../src/operator-surfaces/v1";
import { adaptPglite } from "../src/persistence/database";

const now = "2026-08-27T12:00:00.000Z";
const item = {
  id: "attention:1", tenantId: "tenant:1", projectId: "project:1", workItemId: "work:1", kind: "incident" as const, state: "open" as const,
  requestedAction: "Review the incident evidence", reasonCode: "service_degraded", blockedWorkItemIds: ["work:1"],
  legalResponses: [
    { id: "response:inspect", kind: "open_source" as const, label: "Open evidence", requiresConfirmation: false, available: true },
    { id: "response:approve", kind: "approve_exact_operation" as const, label: "Approve exact operation", requiresConfirmation: true, available: false, unavailableReasonCode: "approval_not_issued" },
  ], evidence: [{ id: "incident:1", kind: "incident" as const, observedAt: now }], createdAt: now, deliveryState: "delivered" as const,
};

test("CR6E Action Inbox exposes the required safe attention facts", () => {
  assert.deepEqual(actionInboxItemSchemaV1.parse(item).blockedWorkItemIds, ["work:1"]);
  assert.equal(actionInboxItemSchemaV1.safeParse({ ...item, legalResponses: [{ ...item.legalResponses[1], requiresConfirmation: false }] }).success, false);
  assert.equal(actionInboxItemSchemaV1.safeParse({ ...item, legalResponses: [{ ...item.legalResponses[1], unavailableReasonCode: undefined }] }).success, false);
  assert.equal(actionInboxItemSchemaV1.safeParse({ ...item, state: "expired", expiresAt: undefined }).success, false);
});

test("CR6E snapshot is tenant-bound, bounded, and rejects unsafe display material", () => {
  const snapshot = parseOperatorSurfaceSnapshotV1({
    contractVersion: OPERATOR_SURFACES_CONTRACT_V1, tenantId: "tenant:1", generatedAt: now,
    fleet: [{ workerId: "worker:1", platform: "macos", state: "degraded", stateReasonCode: "telemetry_stale", lastObservedAt: now, capacityState: "reported", availableSlots: 0, totalSlots: 2, capabilityState: "verified", telemetryState: "stale" }],
    bottlenecks: [{ resourceKey: "gpu:local", utilizationPercent: 100, blockedWorkItemIds: ["work:1"], explanation: "Declared capacity is fully reserved." }],
    activeWork: [{ jobId: "job:1", projectId: "project:1", state: "running", jobType: "synthetic:render", priority: 80, requiredCapability: "capability:render", updatedAt: now }],
    serviceIncidents: [{ id: "incident:1", serviceId: "service:1", severity: "warning", state: "open", reasonCode: "service_degraded", remedyCode: "inspect_service", openedAt: now, lastObservedAt: now }],
    actionInbox: [item], ownerFocus: [{ id: "focus:1", tenantId: "tenant:1", projectId: "project:1", level: "today", reason: "Owner wants visibility", createdAt: now }],
  });
  assert.equal(snapshot.actionInbox[0]?.requestedAction, "Review the incident evidence");
  assert.throws(() => parseOperatorSurfaceSnapshotV1({ ...snapshot, actionInbox: [{ ...item, requestedAction: "Bearer secret-token-value" }] }));
  assert.throws(() => parseOperatorSurfaceSnapshotV1({ ...snapshot, actionInbox: [{ ...item, tenantId: "tenant:other" }] }));
});

test("CR6E Owner Focus records intent only and cannot smuggle a scheduling override", () => {
  const command = { contractVersion: OPERATOR_SURFACES_CONTRACT_V1, commandId: "command:1", tenantId: "tenant:1", operation: "set_owner_focus" as const, projectId: "project:1", idempotencyKey: "idempotency-key-001", requestedAt: now, level: "p0" as const, reason: "Needs owner attention" };
  assert.equal(ownerFocusCommandSchemaV1.parse(command).operation, "set_owner_focus");
  assert.equal(ownerFocusCommandSchemaV1.safeParse({ ...command, operation: "clear_owner_focus", level: undefined, reason: undefined, workerId: "worker:1" }).success, false);
  assert.equal(ownerFocusCommandSchemaV1.safeParse({ ...command, operation: "clear_owner_focus" }).success, false);
  assert.equal(ownerFocusCommandSchemaV1.safeParse({ ...command, reservationId: "reservation:1" }).success, false);
});

test("CR6E stores tenant-bound inbox records and replay-safe Owner Focus intent without dispatching", async () => {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((file) => file.endsWith(".sql")).sort()) await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  try {
    await raw.query(`INSERT INTO tenants(id,display_name) VALUES ('tenant:1','One'),('tenant:2','Two')`);
    const store = new OperatorSurfaceStoreV1(adaptPglite(raw));
    assert.deepEqual(await store.upsertInbox(item), { replayed: false });
    assert.deepEqual(await store.upsertInbox(item), { replayed: true });
    assert.deepEqual((await store.listInbox({ tenantId: "tenant:1", state: "open", limit: 10 })).map((entry) => entry.id), ["attention:1"]);
    assert.deepEqual(await store.listInbox({ tenantId: "tenant:2", limit: 10 }), []);
    const command = { contractVersion: OPERATOR_SURFACES_CONTRACT_V1, commandId: "command:focus:1", tenantId: "tenant:1", operation: "set_owner_focus" as const, projectId: "project:1", idempotencyKey: "idempotency-key-focus-001", requestedAt: now, level: "p0" as const, reason: "Keep the project visible" };
    const first = await store.applyAuthorizedOwnerFocus(command);
    assert.equal(first.replayed, false);
    assert.equal(first.pin?.level, "p0");
    assert.deepEqual(await store.applyAuthorizedOwnerFocus(command), { replayed: true });
    assert.deepEqual((await store.listOwnerFocus({ tenantId: "tenant:1", now })).map((pin) => pin.projectId), ["project:1"]);
    await store.applyAuthorizedOwnerFocus({ ...command, commandId: "command:focus:2", idempotencyKey: "idempotency-key-focus-002", operation: "clear_owner_focus", level: undefined, reason: undefined });
    assert.deepEqual(await store.listOwnerFocus({ tenantId: "tenant:1", now }), []);
    assert.equal((await raw.query<{ count: number }>(`SELECT count(*)::int AS count FROM control_outbox`)).rows[0]?.count, 0);
  } finally { await raw.close(); }
});

test("CR6E read projections are deterministic, keep failed delivery visible, and cannot elevate Owner Focus", () => {
  const expired = { ...item, id: "attention:expired", state: "expired" as const, expiresAt: "2026-08-27T11:00:00.000Z", deliveryState: "failed" as const };
  const openSoon = { ...item, id: "attention:soon", expiresAt: "2026-08-27T12:30:00.000Z" };
  assert.deepEqual(filterActionInboxV1([item, expired, openSoon], { now, limit: 10 })!.map((entry) => entry.id), ["attention:soon", "attention:1"]);
  assert.deepEqual(filterActionInboxV1([item, expired], { now, includeExpired: true, states: ["expired"], limit: 10 })!.map((entry) => entry.id), ["attention:expired"]);
  assert.equal(filterActionInboxV1([item], { now: "bad", limit: 10 }), undefined);
  assert.deepEqual(projectOwnerFocusForSchedulerV1([
    { id: "focus:today", tenantId: "tenant:1", projectId: "project:1", level: "today", reason: "Today", createdAt: now },
    { id: "focus:p0", tenantId: "tenant:1", projectId: "project:1", level: "p0", reason: "P0", createdAt: now },
  ], now), [{ projectId: "project:1", level: "p0", reasonCode: "owner_focus", canOverrideFairness: false, canOverrideAuthority: false, canReserveCapacity: false }]);
  const snapshot = buildOperatorSurfaceSnapshotV1({ contractVersion: OPERATOR_SURFACES_CONTRACT_V1, tenantId: "tenant:1", generatedAt: now, fleet: [], bottlenecks: [], activeWork: [], serviceIncidents: [], actionInbox: [openSoon, item], ownerFocus: [] });
  assert.deepEqual(snapshot.actionInbox.map((entry) => entry.id), ["attention:1", "attention:soon"]);
});
