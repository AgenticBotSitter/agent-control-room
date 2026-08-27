import assert from "node:assert/strict";
import test from "node:test";
import { reconcileServiceV1 } from "../src/services/v1";

const base = { serviceId: "service.worker", observedAt: "2026-08-27T00:00:00.000Z", freshUntil: "2026-08-27T00:05:00.000Z", now: "2026-08-27T00:01:00.000Z" };

test("CR6D reconciles fresh desired and observed service state without inventing an effect", () => {
  assert.deepEqual(reconcileServiceV1({ ...base, desiredState: "running", observedState: "running" }), {
    serviceState: "active", incidentAction: "none", explanation: "Declared desired state and fresh observed state agree.",
  });
  assert.deepEqual(reconcileServiceV1({ ...base, desiredState: "running", observedState: "degraded" }), {
    serviceState: "degraded", incidentAction: "open_or_update", correlationKey: "service:service.worker:service_degraded", severity: "warning", safeReasonCode: "service_degraded", explanation: "Fresh evidence requires a correlated service incident projection.",
  });
});

test("CR6D correlates repeated evidence and resolves only after matching recovery evidence", () => {
  const incident = { id: "incident.service.worker", correlationKey: "service:service.worker:service_not_running" };
  assert.equal(reconcileServiceV1({ ...base, desiredState: "running", observedState: "stopped", existingIncident: incident })?.incidentAction, "open_or_update");
  assert.deepEqual(reconcileServiceV1({ ...base, desiredState: "running", observedState: "running", existingIncident: incident }), {
    serviceState: "active", incidentAction: "resolve", correlationKey: incident.correlationKey, explanation: "Declared desired state and fresh observed state agree; the correlated incident may be resolved.",
  });
});

test("CR6D stale, paused, and retired observations stay visible as safe projections", () => {
  assert.equal(reconcileServiceV1({ ...base, desiredState: "running", observedState: "running", now: "2026-08-27T00:06:00.000Z" })?.safeReasonCode, "observation_stale");
  assert.equal(reconcileServiceV1({ ...base, desiredState: "paused", observedState: "running" })?.safeReasonCode, "running_while_paused");
  assert.equal(reconcileServiceV1({ ...base, desiredState: "retired", observedState: "running" })?.safeReasonCode, "running_while_retired");
});

test("CR6D malformed reconciliation evidence fails closed", () => {
  assert.equal(reconcileServiceV1({ ...base, serviceId: "not safe", desiredState: "running", observedState: "running" }), undefined);
  assert.equal(reconcileServiceV1({ ...base, desiredState: "running", observedState: "running", freshUntil: "not-a-date" }), undefined);
});
