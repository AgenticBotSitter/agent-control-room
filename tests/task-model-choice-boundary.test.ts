import assert from "node:assert/strict";
import test from "node:test";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { sha256Digest } from "../src/security";
import { createTaskHttpHandler } from "../src/web/v1/task-http";
import { captureTaskModelCatalogV1 } from "../src/web/v1/task-model-selection";
import { WebTaskService } from "../src/web/v1/task-service";
import { now, origin, request, token, trust } from "./helpers/web-foundation";
import { taskDraft, taskFixture } from "./helpers/web-task";

const catalog = captureTaskModelCatalogV1([
  { kind: "codex", policy: { models: ["gpt-build"], defaultModel: "gpt-build",
    efforts: ["medium", "high"], defaultEffort: "medium" } },
  { kind: "claude-code", policy: { models: ["sonnet"], defaultModel: "sonnet",
    efforts: ["high"], defaultEffort: "high" } },
  { kind: "hermes", policy: { profiles: [{ name: "build", provider: "provider-one", model: "model-one" }],
    defaultProfile: "build", efforts: ["default"], defaultEffort: "default" } },
]);

function service(f: Awaited<ReturnType<typeof taskFixture>>) {
  return new WebTaskService(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, () => now,
    { modelCatalog: catalog });
}

test("task HTTP refuses unlisted models and efforts before creating any task", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const handler = createTaskHttpHandler({ origin, trust, service: service(f), clock: () => now });
  for (const [key, choice] of [["model-choice-unlisted-001", { model: "not-enabled", effort: "high" }],
    ["model-choice-effort-001", { model: "gpt-build", effort: "max" }]] as const) {
    const response = await handler(request(f.path, "POST", { ...taskDraft, ...choice }, key));
    assert.equal(response.status, 400);
  }
  assert.equal((await f.client.query("SELECT id FROM control_jobs")).rows.length, 0);
  assert.equal((await f.client.query("SELECT job_id FROM control_task_model_selections")).rows.length, 0);
});

test("a listed task choice survives a reconstructed service", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const first = service(f);
  const saved = await first.propose(f.identity, f.project.projectId,
    { ...taskDraft, model: "gpt-build", effort: "high" }, "model-choice-restart-001");
  const restarted = service(f);
  const detail = await restarted.detail(f.identity, f.project.projectId, saved.receipt.jobId);
  assert.deepEqual(detail.modelSelection, { workerKind: null, selectionKey: "gpt-build", model: null, effort: "high",
    provider: null, profile: null, inheritedFromJobId: null });
});

test("another project-scoped owner cannot set or see the first owner's task choice", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const tasks = service(f);
  const saved = await tasks.propose(f.identity, f.project.projectId,
    { ...taskDraft, model: "gpt-build", effort: "high" }, "model-choice-owner-one-001");
  const stamp = new Date(now).toISOString();
  await f.client.query(`INSERT INTO control_identities
    (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,'tenant:web','human','Second owner',$2,$3,'active',$4,$4)`,
  ["identity:web:second", trust.issuer, sha256Digest({ provider: trust.issuer, subject: "second-owner" }), stamp]);
  const ownerGrant = (await f.client.query<{ allowed_actions: string[]; risk_ceiling: string }>(
    "SELECT allowed_actions,risk_ceiling FROM control_role_grants WHERE tenant_id='tenant:web' AND identity_id='identity:web' AND role_key='owner'"
  )).rows[0]!;
  await f.client.query(`INSERT INTO control_role_grants
    (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES($1,'tenant:web',$2,'owner',$3::jsonb,$4::jsonb,$5,false,false,$6,$6)`,
  ["grant:web:second", "identity:web:second", JSON.stringify(ownerGrant.allowed_actions), JSON.stringify(["project:second"]),
    ownerGrant.risk_ceiling, stamp]);
  const secondJwt = token({ sub: "second-owner" });
  const secondIdentity = createAccessVerifier(trust)(request("/", "GET", undefined, "unused-request-key", secondJwt), now);
  await assert.rejects(() => tasks.detail(secondIdentity, f.project.projectId, saved.receipt.jobId),
    (error: unknown) => error instanceof Error && error.message === "access_denied");
  await assert.rejects(() => tasks.propose(secondIdentity, f.project.projectId,
    { ...taskDraft, model: "sonnet", effort: "high" }, "model-choice-owner-two-001"),
  (error: unknown) => error instanceof Error && error.message === "access_denied");
  assert.equal((await f.client.query("SELECT job_id FROM control_task_model_selections")).rows.length, 1);
});
