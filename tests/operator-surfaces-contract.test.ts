import assert from "node:assert/strict";
import test from "node:test";
import { OPERATOR_SURFACES_CONTRACT_V1, actionInboxItemSchemaV1, ownerFocusCommandSchemaV1, parseOperatorSurfaceSnapshotV1 } from "../src/operator-surfaces/v1";

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
    fleet: [{ workerId: "worker:1", platform: "macos", state: "degraded", stateReasonCode: "telemetry_stale", lastObservedAt: now, availableSlots: 0, totalSlots: 2, capabilityState: "verified", telemetryState: "stale" }],
    bottlenecks: [{ resourceKey: "gpu:local", utilizationPercent: 100, blockedWorkItemIds: ["work:1"], explanation: "Declared capacity is fully reserved." }],
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
