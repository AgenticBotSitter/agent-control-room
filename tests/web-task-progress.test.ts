import assert from "node:assert/strict";
import test from "node:test";
import { nativeTaskFixture, registration, observation, at } from "./native-task-fixture";
import { instant, binding, nativeRunId, enrollment } from "./hermes-native-fixture";
import { SecurityStore } from "../src/security/security-store";
import { sha256Digest } from "../src/security";
import { WebTaskService } from "../src/web/v1/task-service";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { token, request, trust } from "./helpers/web-foundation";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskDetailPanel } from "../private-app/app/task-panels";

async function fixture() {
  const f = await nativeTaskFixture(), scope = { tenantId: "tenant:test", workspaceId: "workspace:test" };
  await f.db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:test','tenant:test','Task fixture')");
  await new SecurityStore(f.db).bootstrapOwner({ tenantId: scope.tenantId, provider: trust.issuer, subject: "test-owner",
    identityId: "identity:test", grantId: "grant:test", displayName: "Synthetic owner", verifiedAt: at(-60_000), expiresAt: at(600_000), now: at() });
  const adapterId = `adapter:manual:${sha256Digest(scope).slice(7, 39)}`;
  await f.db.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,'tenant:test','control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [adapterId]);
  await f.db.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
    normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES('project:test','tenant:test','workspace:test',$1,'project:test','1','Native task project','Synthetic evidence',
    'planned','manual_project_active','healthy','control_room_native',$2,'{}'::jsonb,$2)`, [adapterId, at()]);
  await f.db.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES('tenant:test','project:test','active',1,$1,$1)`, [at()]);
  const identity = createAccessVerifier({ ...trust, validUntilMs: instant + 3600_000 })(request(undefined, undefined, undefined, undefined,
    token({ iat: instant / 1000 - 60, exp: instant / 1000 + 600 })), instant + 2000);
  const tasks = new WebTaskService(f.db, scope, () => instant + 2000, { harnessIntegrityKey: new Uint8Array(32).fill(17) });
  return { ...f, tasks, identity, scope };
}

test("signed native completion reaches the private task view without becoming job completion or result approval", async t => {
  const f = await fixture(); t.after(f.close); await f.runs.create(registration);
  const body = observation({ version: 8, state: "completed", observedAt: instant + 2000, resultText: "Private synthetic result content",
    usage: { inputTokens: 0, outputTokens: 12, totalTokens: 12, costUsd: null, provenance: "upstream_reported",
      cachedInputTokens: null, reasoningTokens: null, calls: null, hardCostLimitEnforced: false } });
  await f.service.ingest(JSON.stringify(f.frame(body)), f.options(at(2000)));
  const detail = await f.tasks.detail(f.identity, binding.projectId, binding.jobId);
  assert.equal(detail.task.state, "leased"); assert.equal(detail.attempts[0].state, "leased");
  const run = detail.attempts[0].runs[0]; assert.equal(run.state, "succeeded"); assert.equal(run.nativeState, "completed");
  assert.equal(run.resultClaim?.verified, false); assert.equal(run.usage?.inputTokens, 0); assert.equal(run.usage?.costUsd, null);
  assert.equal(detail.review, "not_connected"); assert.equal(detail.artifacts, "not_connected");
  const serialized = JSON.stringify(detail);
  for (const privateValue of [nativeRunId, binding.sessionId, "Private synthetic result content", enrollment.connectionId,
    enrollment.profilePolicyDigest, "node:test", "credential:test"]) assert.equal(serialized.includes(privateValue), false, privateValue);
});

test("cancellation preserves unknown start and usage while missing configuration stays distinct from no evidence", async t => {
  const f = await fixture(); t.after(f.close); await f.runs.create(registration);
  await f.runs.recordNativeSnapshot(binding.tenantId, binding.nodeId, observation({ state: "cancelled" }));
  const detail = await f.tasks.detail(f.identity, binding.projectId, binding.jobId);
  assert.equal(detail.attempts[0].runs[0].cancellation, "reported");
  assert.equal(detail.attempts[0].runs[0].firstObservedExecutionAt, null); assert.equal(detail.attempts[0].runs[0].usage, null);
  const unavailable = await new WebTaskService(f.db, f.scope, () => instant + 2000).detail(f.identity, binding.projectId, binding.jobId);
  assert.equal(unavailable.progressSource, "not_configured"); assert.equal(unavailable.attempts.length, 1);
  assert.deepEqual(unavailable.attempts[0].runs, []);
});

test("bounded recent timeline comes from verified history and old observations are explicitly stale", async t => {
  const f = await fixture(); t.after(f.close); await f.runs.create(registration);
  for (let i = 0; i < 53; i++) await f.runs.recordNativeSnapshot(binding.tenantId, binding.nodeId,
    observation({ state: "running", version: i + 3, observedAt: instant + 1000 + i }));
  const detail = await new WebTaskService(f.db, f.scope, () => instant + 130_000, { harnessIntegrityKey: new Uint8Array(32).fill(17) })
    .detail(f.identity, binding.projectId, binding.jobId);
  const run = detail.attempts[0].runs[0]; assert.equal(run.timeline.length, 50); assert.equal(run.earlierObservationsOmitted, true);
  assert.equal(run.stale, true); assert.equal(run.timeline.at(-1)?.version, 55);
});

test("wrong integrity material and changed stored run metadata never become an unverified success view", async t => {
  const f = await fixture(); t.after(f.close); await f.runs.create(registration);
  await assert.rejects(new WebTaskService(f.db, f.scope, () => instant + 2000, { harnessIntegrityKey: new Uint8Array(32).fill(18) })
    .detail(f.identity, binding.projectId, binding.jobId), /integrity/);
  await f.db.query("UPDATE control_harness_runs SET state='succeeded' WHERE id='run:test'");
  await assert.rejects(f.tasks.detail(f.identity, binding.projectId, binding.jobId), /integrity/);
});

for (const availability of ["offline", "expired"] as const) test(`fresh ${availability} native observation prominently labels retained running state as unavailable`, async t => {
  const f = await fixture(); t.after(f.close); await f.runs.create(registration);
  await f.runs.recordNativeSnapshot(binding.tenantId, binding.nodeId, observation({ state: "running", availability }));
  const detail = await f.tasks.detail(f.identity, binding.projectId, binding.jobId);
  const run = detail.attempts[0].runs[0]; assert.equal(run.state, "disconnected"); assert.equal(run.stale, false);
  assert.equal(run.availability, availability);
  const html = renderToStaticMarkup(createElement(TaskDetailPanel, { detail }));
  assert.match(html, /<h4>hermes · Agent progress is not current<\/h4>/);
  assert.match(html, new RegExp(`Availability: ${availability}`)); assert.match(html, /Last reported state: Agent working/);
  assert.match(html, /Last observed/); assert.doesNotMatch(html, /Last received|<h4>hermes · Agent working<\/h4>/);
});
