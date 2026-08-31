import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { CanonicalStore } from "../src/persistence/canonical-store.ts";
import { adaptPglite } from "../src/persistence/database.ts";
import {
  ReadyFrontierContractErrorV1,
  ReadyFrontierMaterializationServiceV1,
  ReadyFrontierSimulationStoreV1,
  ReadyFrontierStandingPolicyStoreV1,
  buildReadyFrontierMaterializationRequestFixtureV1,
  buildReadyFrontierMaterializationV1,
  buildReadyFrontierRepositoryFixtureEvaluationV1,
  buildReadyFrontierStandingPolicyV1,
  buildReadyFrontierStandingPolicyFixtureV1,
  parseReadyFrontierMaterializationV1,
  parseReadyFrontierStandingPolicyV1,
  persistReadyFrontierMaterializationV1,
  projectReadyFrontierAutomationV1,
  readyFrontierRepositoryFixtureEvaluationKeyV1,
  readyFrontierRepositoryFixtureStandingPolicyKeyV1,
  type ReadyFrontierStandingPolicyV1,
} from "../src/ready-frontier/v1/index.ts";
import { InMemoryRollbackCheckpointStoreV1 } from "../src/security/index.ts";
import { observedProxy } from "./proxy-test-helper.ts";

const code = (safeCode: ReadyFrontierContractErrorV1["safeCode"]) => (error: unknown) =>
  error instanceof ReadyFrontierContractErrorV1 && error.safeCode === safeCode;
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function resources() {
  const directory = mkdtempSync(join(tmpdir(), "cr11b-auto-020-")); chmodSync(directory, 0o700);
  const evaluationKey = readyFrontierRepositoryFixtureEvaluationKeyV1(), policyKey = readyFrontierRepositoryFixtureStandingPolicyKeyV1();
  const evaluationCheckpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const policyCheckpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const evaluations = new ReadyFrontierSimulationStoreV1(join(directory, "evaluations.sqlite"), "tenant.owner", evaluationKey, evaluationCheckpoints);
  const policies = new ReadyFrontierStandingPolicyStoreV1(join(directory, "policies.sqlite"), "tenant.owner", "workspace.control-room", policyKey, policyCheckpoints);
  return { directory, evaluationKey, policyKey, evaluationCheckpoints, policyCheckpoints, evaluations, policies };
}
async function database() {
  const db = new PGlite();
  for (const file of readdirSync(resolve("db/migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(resolve("db/migrations", file), "utf8"));
  }
  await db.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)", ["tenant.owner", "Owner"]); return db;
}
function close(resource: ReturnType<typeof resources>): void {
  try { resource.evaluations.closeDatabase(); } catch { /* already closed */ }
  try { resource.policies.closeDatabase(); } catch { /* already closed */ }
  resource.evaluationKey.fill(0); resource.policyKey.fill(0); rmSync(resource.directory, { recursive: true, force: true });
}
function lifecycle(policy: ReadyFrontierStandingPolicyV1, input: { action: "revise" | "suspend" | "revoke";
  state: "active" | "suspended" | "revoked"; revision: number; recordedAt: string }, key: Uint8Array) {
  return buildReadyFrontierStandingPolicyFixtureV1(key, { policyId: policy.policyId, revision: input.revision,
    previousPolicyDigest: policy.policyDigest, action: input.action, state: input.state, recordedAt: input.recordedAt,
    effectiveAt: input.recordedAt, expiresAt: "2026-08-31T17:00:00.000Z" });
}

test("CR11B-AUTO-020 standing policy is exact, authenticated, simulation-only, and non-authorizing", () => {
  const key = readyFrontierRepositoryFixtureStandingPolicyKeyV1();
  try {
    const policy = buildReadyFrontierStandingPolicyFixtureV1(key);
    assert.deepEqual({ state: policy.state, scope: policy.activationScope, production: policy.productionOwnerAuthenticationVerified,
      proposedOnly: policy.materializesProposedWorkOnly, readyReview: policy.requiresSeparateReadyReview,
      approval: policy.permitsAutomaticApproval, ready: policy.permitsReadyTransition, schedule: policy.permitsScheduling,
      lease: policy.permitsClaimOrLease, dispatch: policy.permitsDispatchOrExecution, provider: policy.permitsProviderContact,
      agent: policy.permitsAgentMessage, github: policy.permitsGitHubMutation, effect: policy.permitsExternalEffects },
    { state: "active", scope: "repository_simulation", production: false, proposedOnly: true, readyReview: true,
      approval: false, ready: false, schedule: false, lease: false, dispatch: false, provider: false, agent: false, github: false, effect: false });
    assert.deepEqual(parseReadyFrontierStandingPolicyV1(policy, key), policy);
    assert.throws(() => parseReadyFrontierStandingPolicyV1(policy, new Uint8Array(32).fill(0x77)), code("digest_mismatch"));
    const tampered = clone(policy); tampered.projectPolicies[0]!.enabled = false;
    assert.throws(() => parseReadyFrontierStandingPolicyV1(tampered, key), code("digest_mismatch"));
  } finally { key.fill(0); }
});

test("CR11B-AUTO-020 policy lifecycle is replay-safe, restart-safe, suspendable, and terminally revocable", () => {
  const resource = resources(), path = join(resource.directory, "policies.sqlite");
  try {
    const active = buildReadyFrontierStandingPolicyFixtureV1(resource.policyKey);
    assert.equal(resource.policies.recordPolicy(active).replayed, false);
    assert.equal(resource.policies.recordPolicy(active).replayed, true);
    const suspended = lifecycle(active, { action: "suspend", state: "suspended", revision: 2, recordedAt: "2026-08-30T18:04:00.000Z" }, resource.policyKey);
    resource.policies.recordPolicy(suspended);
    const revoked = lifecycle(suspended, { action: "revoke", state: "revoked", revision: 3, recordedAt: "2026-08-30T18:05:00.000Z" }, resource.policyKey);
    resource.policies.recordPolicy(revoked); assert.equal(resource.policies.latestPolicy(active.policyId)?.state, "revoked");
    const illegal = lifecycle(revoked, { action: "revise", state: "active", revision: 4, recordedAt: "2026-08-30T18:06:00.000Z" }, resource.policyKey);
    assert.throws(() => resource.policies.recordPolicy(illegal), code("replay_drift"));
    resource.policies.closeDatabase();
    const restarted = new ReadyFrontierStandingPolicyStoreV1(path, "tenant.owner", "workspace.control-room", resource.policyKey, resource.policyCheckpoints);
    assert.deepEqual(restarted.listPolicies(), [active, suspended, revoked]); restarted.closeDatabase();
  } finally {
    try { resource.evaluations.closeDatabase(); } catch { /* closed */ }
    resource.evaluationKey.fill(0); resource.policyKey.fill(0); rmSync(resource.directory, { recursive: true, force: true });
  }
});

test("CR11B-AUTO-020 policy store rejects foreign scope and complete database rollback", () => {
  const resource = resources(), path = join(resource.directory, "policies.sqlite"), backup = join(resource.directory, "policy-backup.sqlite");
  try {
    copyFileSync(path, backup); chmodSync(backup, 0o600);
    const active = buildReadyFrontierStandingPolicyFixtureV1(resource.policyKey);
    const { policyCeilingDigest: _ceiling, policyDigest: _digest, policyAuthTag: _tag, ...base } = active;
    void _ceiling; void _digest; void _tag;
    const foreign = buildReadyFrontierStandingPolicyV1({ ...base, tenantId: "tenant.foreign" }, resource.policyKey);
    assert.throws(() => resource.policies.recordPolicy(foreign), code("scope_mismatch"));
    resource.policies.recordPolicy(active); resource.policies.closeDatabase(); copyFileSync(backup, path); chmodSync(path, 0o600);
    assert.throws(() => new ReadyFrontierStandingPolicyStoreV1(path, "tenant.owner", "workspace.control-room",
      resource.policyKey, resource.policyCheckpoints), code("integrity_failed"));
  } finally {
    try { resource.evaluations.closeDatabase(); } catch { /* closed */ }
    resource.evaluationKey.fill(0); resource.policyKey.fill(0); rmSync(resource.directory, { recursive: true, force: true });
  }
});

test("CR11B-AUTO-020 materializes one exact proposal as an atomic non-runnable canonical bundle", async () => {
  const resource = resources(), db = await database();
  try {
    const evaluation = buildReadyFrontierRepositoryFixtureEvaluationV1(); resource.evaluations.recordEvaluation(evaluation);
    const policy = buildReadyFrontierStandingPolicyFixtureV1(resource.policyKey); resource.policies.recordPolicy(policy);
    const canonical = new CanonicalStore(adaptPglite(db));
    const service = new ReadyFrontierMaterializationServiceV1(resource.evaluations, resource.policies, canonical,
      resource.evaluationKey, resource.policyKey);
    const request = buildReadyFrontierMaterializationRequestFixtureV1(evaluation, policy);
    const first = await service.materialize(request), replay = await service.materialize(request); service.close();
    assert.equal(first.replayed, false); assert.equal(replay.replayed, true);
    assert.deepEqual(parseReadyFrontierMaterializationV1(first.receipt, resource.evaluationKey), first.receipt);
    assert.throws(() => parseReadyFrontierMaterializationV1(first.receipt, new Uint8Array(32).fill(0x75)), code("digest_mismatch"));
    const tamperedReceipt = clone(first.receipt); tamperedReceipt.actionInbox.requestedAction = "Changed after authentication";
    assert.throws(() => parseReadyFrontierMaterializationV1(tamperedReceipt, resource.evaluationKey), code("digest_mismatch"));
    assert.deepEqual({ request: first.receipt.request.state, workflow: first.receipt.workflow.state, job: first.receipt.job.state,
      attempts: first.receipt.createsAttempt, leases: first.receipt.createsLease, approval: first.receipt.createsApproval,
      schedule: first.receipt.createsSchedule, dispatch: first.receipt.dispatchState, provider: first.receipt.contactsProvider,
      agent: first.receipt.messagesAgent, github: first.receipt.mutatesGitHub, effects: first.receipt.grantsExternalEffect,
      network: first.receipt.job.authority.networkPolicy, cost: first.receipt.job.authority.maxCostUsd },
    { request: "draft", workflow: "proposed", job: "proposed", attempts: false, leases: false, approval: false,
      schedule: false, dispatch: "not_requested", provider: false, agent: false, github: false, effects: false,
      network: "none", cost: 0 });
    const counts = await db.query<Record<string, string>>(`SELECT
      (SELECT count(*) FROM control_requests)::text requests, (SELECT count(*) FROM control_workflows)::text workflows,
      (SELECT count(*) FROM control_jobs)::text jobs, (SELECT count(*) FROM control_action_inbox)::text inbox,
      (SELECT count(*) FROM control_attempts)::text attempts, (SELECT count(*) FROM control_leases)::text leases,
      (SELECT count(*) FROM control_approvals)::text approvals, (SELECT count(*) FROM control_effect_intents)::text effects,
      (SELECT count(*) FROM control_schedules)::text schedules, (SELECT count(*) FROM control_outbox)::text outbox`);
    assert.deepEqual(counts.rows[0], { requests: "1", workflows: "1", jobs: "1", inbox: "1", attempts: "0", leases: "0",
      approvals: "0", effects: "0", schedules: "0", outbox: "0" });
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-020 stale, suspended, narrowed, and superseded policy truth fails before canonical mutation", async () => {
  for (const mode of ["stale", "suspended", "denied", "superseded"] as const) {
    const resource = resources(), db = await database();
    try {
      const evaluation = buildReadyFrontierRepositoryFixtureEvaluationV1(); resource.evaluations.recordEvaluation(evaluation);
      const active = buildReadyFrontierStandingPolicyFixtureV1(resource.policyKey); resource.policies.recordPolicy(active);
      let selected = active, request = buildReadyFrontierMaterializationRequestFixtureV1(evaluation, active);
      if (mode === "stale") request = { ...request, materializedAt: "2026-08-30T19:03:00.000Z", authorityExpiresAt: "2026-08-30T20:00:00.000Z" };
      if (mode === "suspended") { selected = lifecycle(active, { action: "suspend", state: "suspended", revision: 2,
        recordedAt: "2026-08-30T18:02:40.000Z" }, resource.policyKey); resource.policies.recordPolicy(selected);
        request = { ...request, standingPolicyRevision: selected.revision, standingPolicyDigest: selected.policyDigest }; }
      if (mode === "denied") {
        const { policyCeilingDigest: _ceiling, policyDigest: _digest, policyAuthTag: _tag, ...base } = active; void _ceiling; void _digest; void _tag;
        selected = buildReadyFrontierStandingPolicyV1({ ...base,
          revision: 2, previousPolicyDigest: active.policyDigest, action: "revise", recordedAt: "2026-08-30T18:02:40.000Z",
          effectiveAt: "2026-08-30T18:02:40.000Z", projectPolicies: active.projectPolicies.map((item) =>
            item.projectId === evaluation.proposals[0]!.projectId ? { ...item, enabled: false } : item) }, resource.policyKey);
        resource.policies.recordPolicy(selected); request = { ...request, standingPolicyRevision: 2, standingPolicyDigest: selected.policyDigest };
      }
      if (mode === "superseded") { selected = lifecycle(active, { action: "revise", state: "active", revision: 2,
        recordedAt: "2026-08-30T18:02:40.000Z" }, resource.policyKey); resource.policies.recordPolicy(selected); }
      const service = new ReadyFrontierMaterializationServiceV1(resource.evaluations, resource.policies,
        new CanonicalStore(adaptPglite(db)), resource.evaluationKey, resource.policyKey);
      await assert.rejects(() => service.materialize(request), code(mode === "stale" ? "stale_proposal"
        : mode === "denied" ? "policy_denied" : "policy_inactive")); service.close();
      const counts = await db.query<{ count: string }>("SELECT count(*)::text count FROM control_jobs"); assert.equal(counts.rows[0]?.count, "0");
    } finally { await db.close(); close(resource); }
  }
});

test("CR11B-AUTO-020 a forced Action Inbox conflict rolls back every new canonical work record", async () => {
  const resource = resources(), db = await database();
  try {
    const evaluation = buildReadyFrontierRepositoryFixtureEvaluationV1(), policy = buildReadyFrontierStandingPolicyFixtureV1(resource.policyKey);
    const request = buildReadyFrontierMaterializationRequestFixtureV1(evaluation, policy);
    const receipt = buildReadyFrontierMaterializationV1({ request, evaluation, standingPolicy: policy }, resource.evaluationKey, resource.policyKey);
    const collision = { ...receipt.actionInbox, requestedAction: "Conflicting record" };
    await db.query(`INSERT INTO control_action_inbox(id,tenant_id,project_id,work_item_id,kind,state,delivery_state,created_at,expires_at,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [collision.id, collision.tenantId, collision.projectId,
      collision.workItemId, collision.kind, collision.state, collision.deliveryState, collision.createdAt, null, JSON.stringify(collision)]);
    await assert.rejects(persistReadyFrontierMaterializationV1({ canonicalStore: new CanonicalStore(adaptPglite(db)), receipt,
      integrityKey: resource.evaluationKey }), /attention conflict/);
    const counts = await db.query<Record<string, string>>(`SELECT (SELECT count(*) FROM control_requests)::text requests,
      (SELECT count(*) FROM control_workflows)::text workflows, (SELECT count(*) FROM control_jobs)::text jobs,
      (SELECT count(*) FROM control_action_inbox)::text inbox`);
    assert.deepEqual(counts.rows[0], { requests: "0", workflows: "0", jobs: "0", inbox: "1" });
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-020 changed policy cannot rematerialize an existing proposal under different lineage", async () => {
  const resource = resources(), db = await database();
  try {
    const evaluation = buildReadyFrontierRepositoryFixtureEvaluationV1(); resource.evaluations.recordEvaluation(evaluation);
    const firstPolicy = buildReadyFrontierStandingPolicyFixtureV1(resource.policyKey); resource.policies.recordPolicy(firstPolicy);
    const canonical = new CanonicalStore(adaptPglite(db));
    let service = new ReadyFrontierMaterializationServiceV1(resource.evaluations, resource.policies, canonical, resource.evaluationKey, resource.policyKey);
    await service.materialize(buildReadyFrontierMaterializationRequestFixtureV1(evaluation, firstPolicy)); service.close();
    const revised = lifecycle(firstPolicy, { action: "revise", state: "active", revision: 2, recordedAt: "2026-08-30T18:04:00.000Z" }, resource.policyKey);
    resource.policies.recordPolicy(revised);
    const changed = { ...buildReadyFrontierMaterializationRequestFixtureV1(evaluation, revised), requestedAt: "2026-08-30T18:04:30.000Z",
      materializedAt: "2026-08-30T18:05:00.000Z" };
    service = new ReadyFrontierMaterializationServiceV1(resource.evaluations, resource.policies, canonical, resource.evaluationKey, resource.policyKey);
    await assert.rejects(() => service.materialize(changed), /replay conflict/); service.close();
    const count = await db.query<{ count: string }>("SELECT count(*)::text count FROM control_jobs"); assert.equal(count.rows[0]?.count, "1");
  } finally { await db.close(); close(resource); }
});

test("CR11B-AUTO-020 automation projection is useful, safe, and contains no operator authority", () => {
  const evaluationKey = readyFrontierRepositoryFixtureEvaluationKeyV1(), policyKey = readyFrontierRepositoryFixtureStandingPolicyKeyV1();
  try {
    const evaluation = buildReadyFrontierRepositoryFixtureEvaluationV1(), policy = buildReadyFrontierStandingPolicyFixtureV1(policyKey);
    const request = buildReadyFrontierMaterializationRequestFixtureV1(evaluation, policy);
    const receipt = buildReadyFrontierMaterializationV1({ request, evaluation, standingPolicy: policy }, evaluationKey, policyKey);
    const projection = projectReadyFrontierAutomationV1({ evaluation, standingPolicy: policy, receipts: [receipt],
      observedAt: request.materializedAt, evaluationIntegrityKey: evaluationKey, policyIntegrityKey: policyKey });
    assert.equal(projection.standingPolicyState, "repository_fixture_active"); assert.equal(projection.productionPolicyState, "not_enrolled");
    assert.equal(projection.projects.flatMap((project) => project.proposals).filter((item) => item.materializationState === "materialized_proposed").length, 1);
    assert.deepEqual({ enroll: projection.canEnrollProductionPolicy, materialize: projection.canMaterializeFromView,
      approve: projection.canApprove, ready: projection.canReady, schedule: projection.canSchedule,
      lease: projection.canClaimOrLease, dispatch: projection.canDispatchOrExecute },
    { enroll: false, materialize: false, approve: false, ready: false, schedule: false, lease: false, dispatch: false });
    const json = JSON.stringify(projection);
    for (const forbidden of ["objective", "intentDigest", "ownerActorDigest", "ownerAuthenticationEvidenceDigest", "policyAuthTag",
      "proposalAuthTag", "credential", "private locator"]) assert.equal(json.includes(forbidden), false);
  } finally { evaluationKey.fill(0); policyKey.fill(0); }
});

test("CR11B-AUTO-020 exact boundaries reject accessors and Proxies without executing behavior", () => {
  const evaluationKey = readyFrontierRepositoryFixtureEvaluationKeyV1(), policyKey = readyFrontierRepositoryFixtureStandingPolicyKeyV1();
  try {
    const evaluation = buildReadyFrontierRepositoryFixtureEvaluationV1(), policy = buildReadyFrontierStandingPolicyFixtureV1(policyKey);
    const request = buildReadyFrontierMaterializationRequestFixtureV1(evaluation, policy);
    const proxied = observedProxy({ request, evaluation, standingPolicy: policy }, "throwing");
    assert.throws(() => buildReadyFrontierMaterializationV1(proxied.value, evaluationKey, policyKey), code("invalid_input"));
    assert.equal(proxied.trapCount(), 0);
    let getters = 0; const hostile = { request, evaluation, standingPolicy: policy };
    Object.defineProperty(hostile, "request", { enumerable: true, get() { getters += 1; return request; } });
    assert.throws(() => buildReadyFrontierMaterializationV1(hostile, evaluationKey, policyKey), code("invalid_input")); assert.equal(getters, 0);
  } finally { evaluationKey.fill(0); policyKey.fill(0); }
});

test("CR11B-AUTO-020 service contains no timer, provider, network, scheduler, agent-message, or GitHub client", () => {
  const source = ["materialization-service.ts", "materialization.ts", "standing-policy-store.ts"].map((file) =>
    readFileSync(new URL(`../src/ready-frontier/v1/${file}`, import.meta.url), "utf8")).join("\n");
  for (const forbidden of ["node:net", "node:http", "node:https", "child_process", "fetch(", "setInterval(", "setTimeout(",
    "ScheduleStore", "ApprovalStore", "LeaseStore", "providerClient", "sendMessage(", "createIssue(", "dispatch(", "execute("]) {
    assert.equal(source.includes(forbidden), false);
  }
});
