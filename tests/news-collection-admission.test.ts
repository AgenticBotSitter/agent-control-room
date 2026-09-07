import assert from "node:assert/strict";
import test from "node:test";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";
import { CanonicalStore } from "../src/persistence/canonical-store";
import { DOMAIN_CONTRACT_VERSION } from "../src/domain/v1";
import { sha256Digest } from "../src/security";
import { WebNewsCollectionPlanning } from "../src/web/v1/news-collection-planning";
import { WebNewsCollectionAdmission } from "../src/web/v1/news-collection-admission";
import { WebProjectService } from "../src/web/v1/project-service";
import type { DatabaseSession } from "../src/persistence/database";
import type { AbsFeedJobReference } from "../src/persistence/pg-boss-abs-feed-worker";

async function fixture() {
  let current = now, failQueue = false, expireQueue = false;
  const f = await taskFixture(() => current), key = new Uint8Array(32).fill(67);
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web", projectId: f.project.projectId, nodeId: "node:feed", executorId: "executor:feed" };
  const template = { configuration: { tenantId: scope.tenantId, workspaceId: scope.workspaceId, projectId: scope.projectId,
    source: { sourceId: "source:feed", sourceLabel: "Example news", sourceKind: "rss", endpointUrl: "https://example.org/feed" },
    maxBytes: 10000, maxItems: 25, timeoutMs: 10000 }, executorId: scope.executorId, windowSeconds: 300 };
  const planner = new WebNewsCollectionPlanning(f.client, template, key, () => current);
  const plan = await planner.propose(f.identity, { sourceDigest: planner.sourceDigest, idempotencyKey: "admission-plan-0001" });
  const canonical = new CanonicalStore(f.client), instant = new Date(now).toISOString();
  await canonical.create({ contractVersion: DOMAIN_CONTRACT_VERSION, kind: "node", id: scope.nodeId, tenantId: scope.tenantId,
    displayName: "Disposable collector", state: "pending_enrollment", platform: "linux", architecture: "x64", identityKeyId: "key:synthetic",
    hardwareFingerprint: sha256Digest("hardware"), softwareFingerprint: sha256Digest("software"), policyVersion: "1.0.0",
    minimumProtocolVersion: "control-room-node/v1", version: 0, createdAt: instant, updatedAt: instant });
  await canonical.transition({ tenantId: scope.tenantId, kind: "node", entityId: scope.nodeId, expectedVersion: 0, toState: "active",
    transitionId: "transition:feed-node-active", idempotencyKey: "feed-node-active-001", actor: { actorId: "identity:web", actorType: "human" },
    occurredAt: instant, recordPatch: { enrolledAt: instant } });
  await f.client.query("CREATE TABLE synthetic_feed_queue(reference jsonb NOT NULL)");
  const submission = { async enqueueInSession(tx: DatabaseSession, reference: AbsFeedJobReference) {
    await tx.query("INSERT INTO synthetic_feed_queue VALUES($1)", [reference]);
    if (expireQueue) current += 61_000; if (failQueue) throw new Error("synthetic queue failure");
  } };
  const service = new WebNewsCollectionAdmission(f.client, scope, key, submission, () => current);
  return { ...f, scope, key, plan, service, submission, clock: () => current, setTime: (value: number) => { current = value; },
    failQueue: () => { failQueue = true; }, expireQueue: () => { expireQueue = true; },
    args: { jobId: plan.jobId, inputDigest: plan.inputDigest } };
}
test("owner approval, assignment, effect authorization and queue entry commit once", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const results = await Promise.all([f.service.approve(f.identity, f.args), f.service.approve(f.identity, f.args)]);
  assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
  assert.equal(results[0].effectId, results[1].effectId); assert.equal(results[0].effectState, "authorized");
  for (const table of ["control_attempts", "control_leases", "control_approvals", "control_effect_intents", "control_approval_consumptions", "synthetic_feed_queue"])
    assert.equal((await f.client.query(`SELECT * FROM ${table}`)).rows.length, 1);
  assert.equal((await f.client.query("SELECT state FROM control_jobs WHERE id=$1", [f.plan.jobId])).rows[0].state, "leased");
  assert.equal((await f.client.query("SELECT * FROM audit_events WHERE action='tasks.approve'")).rows.length, 1);
  await f.client.query("DELETE FROM synthetic_feed_queue");
  assert.equal((await f.service.approve(f.identity, f.args)).replayed, true);
  assert.equal((await f.client.query("SELECT * FROM synthetic_feed_queue")).rows.length, 0);
});
test("revoked owners, non-owner roles, paused projects and extra input cannot admit", async t => {
  for (const mode of ["revoked", "operator", "paused", "extra"]) await t.test(mode, async () => {
    const f = await fixture();
    try {
      if (mode === "revoked") await f.client.query("UPDATE control_role_grants SET revoked_at=$1 WHERE id='grant:web'", [new Date(now).toISOString()]);
      if (mode === "operator") await f.client.query("UPDATE control_role_grants SET role_key='operator' WHERE id='grant:web'");
      if (mode === "paused") await new WebProjectService(f.client, { tenantId: f.scope.tenantId, workspaceId: f.scope.workspaceId }, f.clock)
        .transition(f.identity, f.scope.projectId, { lifecycle: "paused", expectedVersion: f.project.version }, "pause-feed-admission-001");
      await assert.rejects(f.service.approve(f.identity, mode === "extra" ? { ...f.args, endpointUrl: "https://other.example.org/feed" } : f.args));
      assert.equal((await f.client.query("SELECT * FROM synthetic_feed_queue")).rows.length, 0);
      assert.equal((await f.client.query("SELECT state FROM control_jobs WHERE id=$1", [f.plan.jobId])).rows[0].state, "proposed");
    } finally { await f.db.close(); }
  });
});
test("failed queue write or elapsed admission deadline rolls back all admission records", async t => {
  for (const mode of ["queue", "deadline"]) await t.test(mode, async () => {
    const f = await fixture();
    try {
      if (mode === "queue") f.failQueue(); else f.expireQueue();
      await assert.rejects(f.service.approve(f.identity, f.args));
      for (const table of ["control_attempts", "control_leases", "control_approvals", "control_effect_intents", "control_approval_consumptions", "control_policy_decisions", "synthetic_feed_queue"])
        assert.equal((await f.client.query(`SELECT * FROM ${table}`)).rows.length, 0);
      assert.equal((await f.client.query("SELECT state FROM control_jobs WHERE id=$1", [f.plan.jobId])).rows[0].state, "proposed");
    } finally { await f.db.close(); }
  });
});
test("separate external-effect grant expiring during enqueue rolls back admission", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  let enqueued = false;
  await f.client.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at,expires_at)
    SELECT 'grant:feed-external',tenant_id,identity_id,role_key,'["approval.decide","effect.authorize"]'::jsonb,
      project_ids,risk_ceiling,true,false,created_at,updated_at,$1 FROM control_role_grants WHERE id='grant:web'`, [new Date(now + 10_000).toISOString()]);
  await f.client.query("UPDATE control_role_grants SET allow_external_effects=false WHERE id='grant:web'");
  const service = new WebNewsCollectionAdmission(f.client, f.scope, f.key, {
    async enqueueInSession(tx, reference) { await f.submission.enqueueInSession(tx, reference); enqueued = true; f.setTime(now + 11_000); }
  }, f.clock);
  await assert.rejects(service.approve(f.identity, f.args));
  assert.equal(enqueued, true);
  for (const table of ["control_attempts", "control_leases", "control_approvals", "control_effect_intents", "control_approval_consumptions", "control_policy_decisions", "synthetic_feed_queue"])
    assert.equal((await f.client.query(`SELECT * FROM ${table}`)).rows.length, 0);
  assert.equal((await f.client.query("SELECT state FROM control_jobs WHERE id=$1", [f.plan.jobId])).rows[0].state, "proposed");
});
test("changed plan, wrong executor, inactive node and external-effect denial cannot authorize", async t => {
  for (const mode of ["digest", "executor", "node", "effects", "expired"]) await t.test(mode, async () => {
    const f = await fixture();
    try {
      let service = f.service, args = f.args;
      if (mode === "digest") args = { ...args, inputDigest: sha256Digest("changed") };
      if (mode === "executor") service = new WebNewsCollectionAdmission(f.client, { ...f.scope, executorId: "executor:other" }, f.key, f.submission, f.clock);
      if (mode === "node") await f.client.query("UPDATE control_nodes SET state='offline',payload=jsonb_set(payload,'{state}','\"offline\"') WHERE id=$1", [f.scope.nodeId]);
      if (mode === "effects") await f.client.query("UPDATE control_role_grants SET allow_external_effects=false WHERE id='grant:web'");
      if (mode === "expired") f.setTime(now + 241_000);
      await assert.rejects(service.approve(f.identity, args));
      assert.equal((await f.client.query("SELECT * FROM synthetic_feed_queue")).rows.length, 0);
      assert.equal((await f.client.query("SELECT state FROM control_jobs WHERE id=$1", [f.plan.jobId])).rows[0].state, "proposed");
    } finally { await f.db.close(); }
  });
});
