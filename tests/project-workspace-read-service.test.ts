import assert from "node:assert/strict";
import test from "node:test";
import { buildOperatorSurfaceSnapshotV1, OPERATOR_SURFACES_CONTRACT_V1, type OperatorSurfaceSnapshotV1 } from "../src/operator-surfaces/v1/index.ts";
import {
  ProjectWorkspaceContractErrorV1,
  ProjectWorkspaceReadServiceV1,
  parseProjectWorkspaceReadModelV1,
  type ProjectWorkspaceOperatorReadSourceV1,
} from "../src/project-workspace/v1/index.ts";

const tenantId = "tenant.owner";
const workspaceId = "workspace.alpha";
const projectId = "project.alpha";
const now = "2026-08-31T18:00:00.000Z";
const scope = { tenantId, workspaceId, projectId, actorId: "actor.owner", grantedAt: "2026-08-31T17:59:00.000Z" };

function snapshot(generatedAt = "2026-08-31T17:59:00.000Z"): OperatorSurfaceSnapshotV1 {
  return buildOperatorSurfaceSnapshotV1({
    contractVersion: OPERATOR_SURFACES_CONTRACT_V1,
    tenantId,
    generatedAt,
    fleet: [],
    bottlenecks: [],
    activeWork: [
      { jobId: "job.alpha", projectId, state: "running", jobType: "synthetic.render", priority: 80, requiredCapability: "capability.render", updatedAt: generatedAt },
      { jobId: "job.foreign", projectId: "project.foreign", state: "leased", jobType: "synthetic.write", priority: 70, requiredCapability: "capability.write", updatedAt: generatedAt },
    ],
    portfolio: [
      { projectId, workflowCount: 2, activeJobCount: 1, waitingApprovalJobCount: 0, failedJobCount: 0, lastActivityAt: generatedAt },
      { projectId: "project.foreign", workflowCount: 1, activeJobCount: 1, waitingApprovalJobCount: 0, failedJobCount: 0, lastActivityAt: generatedAt },
    ],
    services: [
      { serviceId: "service.alpha", projectId, serviceType: "service.monitor", state: "active", lastObservedAt: generatedAt },
      { serviceId: "service.foreign", projectId: "project.foreign", serviceType: "service.monitor", state: "active", lastObservedAt: generatedAt },
    ],
    schedules: [
      { scheduleId: "schedule.alpha", projectId, state: "active", scheduleType: "cron", targetType: "service_check", targetId: "service.alpha", timezone: "UTC", idempotencyWindowSeconds: 60 },
      { scheduleId: "schedule.foreign", projectId: "project.foreign", state: "active", scheduleType: "cron", targetType: "service_check", targetId: "service.foreign", timezone: "UTC", idempotencyWindowSeconds: 60 },
    ],
    serviceIncidents: [
      { id: "incident.alpha", serviceId: "service.alpha", severity: "warning", state: "open", reasonCode: "service_degraded", remedyCode: "inspect_service", openedAt: generatedAt, lastObservedAt: generatedAt },
      { id: "incident.foreign", serviceId: "service.foreign", severity: "warning", state: "open", reasonCode: "service_degraded", remedyCode: "inspect_service", openedAt: generatedAt, lastObservedAt: generatedAt },
    ],
    actionInbox: [{
      id: "attention.alpha", tenantId, projectId, kind: "review", state: "open", requestedAction: "Review current evidence", reasonCode: "review_requested",
      blockedWorkItemIds: [], legalResponses: [{ id: "response.open", kind: "open_source", label: "Open evidence", requiresConfirmation: false, available: true }],
      evidence: [{ id: "incident.alpha", kind: "incident", observedAt: generatedAt }], createdAt: generatedAt, deliveryState: "delivered",
    }],
    ownerFocus: [{ id: "focus.alpha", tenantId, projectId, level: "today", reason: "Keep visible", createdAt: generatedAt }],
  });
}

function service(sourceValue: OperatorSurfaceSnapshotV1 | (() => Promise<OperatorSurfaceSnapshotV1>) = snapshot()) {
  const source: ProjectWorkspaceOperatorReadSourceV1 = {
    read: typeof sourceValue === "function" ? sourceValue : async () => sourceValue,
  };
  return new ProjectWorkspaceReadServiceV1(source, [{ tenantId, workspaceId, projectId }]);
}

test("CR12A-PILOT-010 composes one current protected project read without foreign-project leakage", async () => {
  const result = await service().read({ scope, now });
  assert.equal(result.state, "available");
  if (result.state !== "available") return;
  assert.equal(result.model.freshness, "current");
  assert.deepEqual(result.model.activeWork.map((item) => item.jobId), ["job.alpha"]);
  assert.deepEqual(result.model.services.map((item) => item.serviceId), ["service.alpha"]);
  assert.deepEqual(result.model.schedules.map((item) => item.scheduleId), ["schedule.alpha"]);
  assert.deepEqual(result.model.serviceIncidents.map((item) => item.id), ["incident.alpha"]);
  assert.deepEqual(result.model.actionInbox.map((item) => item.id), ["attention.alpha"]);
  assert.equal(parseProjectWorkspaceReadModelV1(result.model).projectId, projectId);
  assert.equal(result.model.grantsApproval || result.model.grantsCommandAuthority || result.model.grantsExecutionAuthority, false);
});

test("CR12A-PILOT-010 preserves stale protected truth instead of presenting it as current", async () => {
  const result = await service(snapshot("2026-08-31T17:54:59.000Z")).read({ scope, now });
  assert.equal(result.state, "available");
  if (result.state === "available") assert.deepEqual([result.model.freshness, result.model.safeStatusCode], ["stale", "protected_read_stale"]);
});

test("CR12A-PILOT-010 returns honest unavailable states for missing projects and read failures", async () => {
  const empty = snapshot();
  empty.portfolio = empty.portfolio.filter((item) => item.projectId !== projectId);
  empty.activeWork = empty.activeWork.filter((item) => item.projectId !== projectId);
  empty.services = empty.services.filter((item) => item.projectId !== projectId);
  empty.schedules = empty.schedules.filter((item) => item.projectId !== projectId);
  empty.serviceIncidents = empty.serviceIncidents.filter((item) => item.id !== "incident.alpha");
  empty.actionInbox = [];
  empty.ownerFocus = [];
  assert.deepEqual(await service(buildOperatorSurfaceSnapshotV1(empty)).read({ scope, now }), { state: "unavailable", code: "project_not_found" });
  assert.deepEqual(await service(async () => { throw new Error("private failure"); }).read({ scope, now }), { state: "unavailable", code: "protected_source_unavailable" });
});

test("CR12A-PILOT-010 rejects orphaned project records rather than hiding source inconsistency", async () => {
  const inconsistent = snapshot();
  inconsistent.portfolio = inconsistent.portfolio.filter((item) => item.projectId !== projectId);
  const reader = service(buildOperatorSurfaceSnapshotV1(inconsistent));
  await assert.rejects(reader.read({ scope, now }), (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "integrity_failed");
});

test("CR12A-PILOT-010 rejects tenant, workspace, project, chronology, and expired-scope drift before source access", async () => {
  let calls = 0;
  const reader = service(async () => { calls += 1; return snapshot(); });
  for (const changed of [
    { ...scope, tenantId: "tenant.foreign" },
    { ...scope, workspaceId: "workspace.foreign" },
    { ...scope, projectId: "project.foreign" },
    { ...scope, grantedAt: "2026-08-31T18:00:01.000Z" },
    { ...scope, grantedAt: "2026-08-31T17:44:59.000Z" },
  ]) await assert.rejects(reader.read({ scope: changed, now }), ProjectWorkspaceContractErrorV1);
  assert.equal(calls, 0);
});

test("CR12A-PILOT-010 rejects tenant substitution and future source time", async () => {
  const foreign = { ...snapshot(), tenantId: "tenant.foreign" };
  await assert.rejects(service(foreign).read({ scope, now }), (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "integrity_failed");
  await assert.rejects(service(snapshot("2026-08-31T18:00:01.000Z")).read({ scope, now }), (error: unknown) => error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "integrity_failed");
});

test("CR12A-PILOT-010 rejects orphan incidents anywhere in the protected source", async () => {
  const inconsistent = snapshot();
  inconsistent.serviceIncidents.push({
    id: "incident.orphan",
    serviceId: "service.missing",
    severity: "warning",
    state: "open",
    reasonCode: "service_missing",
    remedyCode: "inspect_service",
    openedAt: inconsistent.generatedAt,
    lastObservedAt: inconsistent.generatedAt,
  });
  await assert.rejects(service(buildOperatorSurfaceSnapshotV1(inconsistent)).read({ scope, now }), (error: unknown) =>
    error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "integrity_failed");
});

test("CR12A-PILOT-010 read model rejects digest, relational, authority, and freshness forgery", async () => {
  const result = await service().read({ scope, now });
  assert.equal(result.state, "available");
  if (result.state !== "available") return;
  for (const changed of [
    { ...result.model, projectId: "project.foreign" },
    { ...result.model, grantsApproval: true },
    { ...result.model, freshness: "stale" },
    { ...result.model, activeWork: [{ ...result.model.activeWork[0]!, projectId: "project.foreign" }] },
    { ...result.model, activeWork: [{ ...result.model.activeWork[0]!, hiddenAuthority: true }] },
    { ...result.model, schedules: [{ ...result.model.schedules[0]!, targetId: "service.foreign" }] },
    { ...result.model, actionInbox: [{ ...result.model.actionInbox[0]!, evidence: [{ id: "incident.foreign", kind: "incident", observedAt: now }] }] },
    { ...result.model, portfolio: { ...result.model.portfolio, activeJobCount: 0 } },
  ]) assert.throws(() => parseProjectWorkspaceReadModelV1(changed), ProjectWorkspaceContractErrorV1);
});

test("CR12A-PILOT-010 exact boundaries reject accessors and Proxies without executing traps", async () => {
  let traps = 0;
  const proxy = new Proxy({ scope, now }, { ownKeys() { traps += 1; throw new Error("trap"); } });
  await assert.rejects(service().read(proxy), ProjectWorkspaceContractErrorV1);
  const accessor = { scope, get now() { traps += 1; return now; } };
  await assert.rejects(service().read(accessor), ProjectWorkspaceContractErrorV1);
  assert.equal(traps, 0);
});
