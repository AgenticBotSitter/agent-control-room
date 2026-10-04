// Per-project settings (Cook stream W3b): eligible worker kinds, a concurrency cap, and defaults.
// The production-login tests run on the same PGlite-plus-real-role-files harness
// (`taskStartupFixture`) that work-batch-assignment-gate.test.ts already trusts for this exact
// purpose: `SET LOCAL SESSION AUTHORIZATION web_test|coordinator_test` after applying the real
// `private_web_roles.sql`/`task_coordinator_roles.sql`, so a missing or wrong GRANT on
// control_project_settings fails here exactly as it would in production.
import assert from "node:assert/strict";
import test from "node:test";
import { WebProjectService } from "../src/web/v1/project-service";
import { TaskAssignmentCoordinator } from "../src/web/v1/task-assignment-coordinator";
import { createAccessVerifier, WebAccessError } from "../src/web/v1/access-verifier";
import { sha256Digest } from "../src/security";
import { binding, instant } from "./hermes-native-fixture";
import { request, token, trust } from "./helpers/web-foundation";
import { taskDraft } from "./helpers/web-task";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { taskStartupFixture } from "./helpers/task-startup";

test("the owner can read and save project settings on the production web login; an operator cannot", async t => {
  // The extra operator identity/grant is seeded on the plain fixture's own admin connection,
  // before the role files are applied and the connection is switched to the restricted
  // web_test/coordinator_test logins -- taskStartupFixture's own role setup runs on the same
  // underlying session and leaves no admin-equivalent access behind for a raw insert afterward.
  const base = await taskAssignmentFixture();
  const identityAt = new Date(instant + 9000).toISOString();
  await base.db.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:settings-operator',$1,'human','Settings-test operator',$2,$3,'active',$4,$4)`,
    [binding.tenantId, trust.issuer, sha256Digest({ provider: trust.issuer, subject: "settings-operator" }), identityAt]);
  await base.db.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES('grant:settings-operator',$1,'identity:settings-operator','operator',$2::jsonb,$3::jsonb,'low',false,false,$4,$4)`,
    [binding.tenantId, JSON.stringify(["*"]), JSON.stringify([binding.projectId]), identityAt]);

  const f = await taskStartupFixture(base); t.after(f.close);
  const projects = new WebProjectService(f.web.client, f.scope, () => instant + 9000);
  const initial = await projects.readSettings(f.identity, binding.projectId);
  assert.deepEqual(initial, { projectId: binding.projectId, version: 0, eligibleWorkerKinds: null,
    maxConcurrentTasks: null, defaultWorkerKind: null, defaultModel: null, defaultEffort: null, updatedAt: initial.updatedAt });

  const operatorJwt = token({ sub: "settings-operator", iat: instant / 1000 - 60, exp: instant / 1000 + 600 });
  const operator = createAccessVerifier(f.accessTrust)(request(undefined, undefined, undefined, undefined, operatorJwt), instant + 9000);
  await assert.rejects(projects.updateSettings(operator, binding.projectId, { expectedVersion: 0,
    eligibleWorkerKinds: ["hermes"], maxConcurrentTasks: null, defaultWorkerKind: null, defaultModel: null, defaultEffort: null }),
    (error: unknown) => error instanceof WebAccessError && error.code === "access_denied",
    "only the owner role may save project settings, matching tasks.assign's ownerRequired=true convention");

  const saved = await projects.updateSettings(f.identity, binding.projectId, { expectedVersion: 0,
    eligibleWorkerKinds: ["hermes"], maxConcurrentTasks: 2, defaultWorkerKind: "hermes", defaultModel: "space-bunny-free", defaultEffort: "medium" });
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.eligibleWorkerKinds, ["hermes"]);
  assert.equal(saved.maxConcurrentTasks, 2);
  const reread = await projects.readSettings(f.identity, binding.projectId);
  assert.deepEqual(reread, saved);
  await assert.rejects(projects.updateSettings(f.identity, binding.projectId, { expectedVersion: 0,
    eligibleWorkerKinds: null, maxConcurrentTasks: null, defaultWorkerKind: null, defaultModel: null, defaultEffort: null }),
    (error: unknown) => error instanceof WebAccessError && error.code === "conflict",
    "a stale expectedVersion must be refused, not silently overwritten");
});

test("assignment refuses a worker kind the project's settings do not list as eligible, on the production coordinator login", async t => {
  const f = await taskStartupFixture(); t.after(f.close);
  const projects = new WebProjectService(f.web.client, f.scope, () => instant + 9000);
  await projects.updateSettings(f.identity, binding.projectId, { expectedVersion: 0,
    eligibleWorkerKinds: ["codex", "claude-code"], maxConcurrentTasks: null, defaultWorkerKind: null, defaultModel: null, defaultEffort: null });

  const productionGate = new TaskAssignmentCoordinator(f.coordinator.client, f.scope, f.planner, [f.route], () => instant + 9000);
  await assert.rejects(productionGate.assign(f.identity, binding.projectId, f.prepared.receipt.jobId, binding.nodeId, f.prepared.receipt.inputDigest),
    (error: unknown) => (error as { code?: string }).code === "conflict",
    "the fixture's route is a hermes capability, which this project's eligibility list excludes");

  const widened = await projects.updateSettings(f.identity, binding.projectId, { expectedVersion: 1,
    eligibleWorkerKinds: ["codex", "claude-code", "hermes"], maxConcurrentTasks: null, defaultWorkerKind: null, defaultModel: null, defaultEffort: null });
  assert.equal(widened.version, 2);
  const assigned = await productionGate.assign(f.identity, binding.projectId, f.prepared.receipt.jobId, binding.nodeId, f.prepared.receipt.inputDigest);
  assert.equal(assigned.receipt.leaseCurrent, true, "once hermes is eligible, the same route can claim the task");
});

test("assignment refuses once the project's concurrency cap is reached, on the production coordinator login", async t => {
  // Both tasks are proposed and planned on the plain fixture's admin connection, before
  // taskStartupFixture switches to the restricted production logins -- proposing/planning is not
  // what this test is proving, and (per the earlier eligibility test's own admin-insert ordering)
  // this PGlite harness does not cleanly restore role state for further admin writes once a
  // restricted-login transaction has run. Each plan digest is exactly sha256Digest({title,
  // instructions}), the same value WebTaskService.propose() records as job.inputDigest
  // (task-service.ts:344). Disjoint file scopes keep this test about the concurrency cap, not
  // scope overlap.
  const base = await taskAssignmentFixture();
  const firstDraft = { title: "A first, disjoint task", instructions: taskDraft.instructions, scopes: [{ kind: "file" as const, path: "src/settings-concurrency-a.ts" }] };
  const firstSource = await base.tasks.propose(base.identity, binding.projectId, firstDraft, "settings-concurrency-source-a");
  const firstPlanned = await base.planner.plan(base.identity, binding.projectId, firstSource.receipt.jobId,
    sha256Digest({ title: firstDraft.title, instructions: firstDraft.instructions }));
  const secondDraft = { title: "A second, disjoint task", instructions: taskDraft.instructions, scopes: [{ kind: "file" as const, path: "src/settings-concurrency-b.ts" }] };
  const secondSource = await base.tasks.propose(base.identity, binding.projectId, secondDraft, "settings-concurrency-source-b");
  const secondPlanned = await base.planner.plan(base.identity, binding.projectId, secondSource.receipt.jobId,
    sha256Digest({ title: secondDraft.title, instructions: secondDraft.instructions }));

  const started = await taskStartupFixture(base); t.after(started.close);
  const projects = new WebProjectService(started.web.client, started.scope, () => instant + 9000);
  // The shared fixture seeds one pre-existing active lease of its own ("job:test"/"lease:test",
  // used by other files' renewal/expiry tests) in this same project. The cap is set to 2 to
  // account for it: baseline (1) + this test's first task (2) is already at the cap.
  await projects.updateSettings(started.identity, binding.projectId, { expectedVersion: 0,
    eligibleWorkerKinds: null, maxConcurrentTasks: 2, defaultWorkerKind: null, defaultModel: null, defaultEffort: null });

  const productionGate = new TaskAssignmentCoordinator(started.coordinator.client, started.scope, started.planner, [started.route], () => instant + 9000);
  const first = await productionGate.assign(started.identity, binding.projectId, firstPlanned.receipt.jobId, binding.nodeId, firstPlanned.receipt.inputDigest);
  assert.equal(first.receipt.leaseCurrent, true);
  await assert.rejects(productionGate.assign(started.identity, binding.projectId, secondPlanned.receipt.jobId, binding.nodeId, secondPlanned.receipt.inputDigest),
    (error: unknown) => (error as { code?: string }).code === "conflict",
    "the project's cap of 2 concurrent tasks is already held by the fixture's baseline lease plus this test's first assignment");

  await productionGate.revoke(started.identity, binding.projectId, firstPlanned.receipt.jobId, firstPlanned.receipt.inputDigest);
  const second = await productionGate.assign(started.identity, binding.projectId, secondPlanned.receipt.jobId, binding.nodeId, secondPlanned.receipt.inputDigest);
  assert.equal(second.receipt.leaseCurrent, true, "releasing the first task's lease frees the project's concurrency slot for the second");
});
