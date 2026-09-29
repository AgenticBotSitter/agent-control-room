import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { sha256Digest } from "../src/security";
import { createTaskHttpHandler } from "../src/web/v1/task-http";
import { captureTaskModelCatalogV1, resolveTaskModelV1 } from "../src/web/v1/task-model-selection";
import { WebTaskService } from "../src/web/v1/task-service";
import { now, origin, request, token, trust } from "./helpers/web-foundation";
import { taskDraft, taskFixture, taskFixtureOnDisk } from "./helpers/web-task";

const catalog = captureTaskModelCatalogV1([
  { kind: "codex", policy: { models: ["gpt-build"], defaultModel: "gpt-build",
    efforts: ["medium", "high"], defaultEffort: "medium" } },
  { kind: "claude-code", policy: { models: ["sonnet"], defaultModel: "sonnet",
    efforts: ["high"], defaultEffort: "high" } },
  { kind: "hermes", policy: { profiles: [{ name: "build", provider: "provider-one", model: "model-one" }],
    defaultProfile: "build", efforts: ["default"], defaultEffort: "default" } },
]);

type Fixture = Awaited<ReturnType<typeof taskFixture>> | Awaited<ReturnType<typeof taskFixtureOnDisk>>;

function service(f: Fixture) {
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

test("a Hermes profile offered a non-default effort is refused before the task exists", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const handler = createTaskHttpHandler({ origin, trust, service: service(f), clock: () => now });
  for (const [key, effort] of [["model-choice-hermes-high-001", "high"], ["model-choice-hermes-low-001", "low"],
    ["model-choice-hermes-medium-001", "medium"], ["model-choice-hermes-max-001", "max"],
    ["model-choice-hermes-xhigh-001", "xhigh"], ["model-choice-hermes-default-001", "default"]] as const) {
    const response = await handler(request(f.path, "POST", { ...taskDraft, model: "build", effort }, key));
    // `default` is the one effort a Hermes profile exposes, so it is accepted.
    // Every other effort the wire can carry must be refused before the task,
    // and therefore before any stored row, exists.
    assert.equal(response.status, effort === "default" ? 201 : 400, effort);
  }
  assert.equal((await f.client.query("SELECT id FROM control_jobs")).rows.length, 1);
  assert.deepEqual((await f.client.query<{ selection_key: string; effort: string }>(
    "SELECT selection_key,effort FROM control_task_model_selections")).rows, [{ selection_key: "build", effort: "default" }]);

  // The guard itself: a named Hermes profile resolves with no effort, and any
  // effort the wire can carry other than the literal `default` refuses first.
  assert.deepEqual(resolveTaskModelV1(catalog, "hermes", { model: "build" }), { workerKind: "hermes",
    selectionKey: "build", model: "model-one", effort: "default", provider: "provider-one", profile: "build",
    usesMoreClaudeLimit: false });
  for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
    assert.throws(() => resolveTaskModelV1(catalog, "hermes", { model: "build", effort }),
      /task_model_selection_refused/, effort);
    assert.throws(() => resolveTaskModelV1(catalog, "hermes", { effort }),
      /task_model_selection_refused/, `no profile with ${effort}`);
  }
  // A catalog whose profile does offer `default` accepts exactly that one value.
  const withDefault = captureTaskModelCatalogV1([{ kind: "hermes", policy: { profiles: [{ name: "build",
    provider: "provider-one", model: "model-one" }], defaultProfile: "build", efforts: ["default"],
    defaultEffort: "default" } }]);
  assert.equal(resolveTaskModelV1(withDefault, "hermes", { model: "build", effort: "default" }).effort, "default");
  for (const effort of ["low", "high", "xhigh", "max"] as const) assert.throws(
    () => resolveTaskModelV1(withDefault, "hermes", { model: "build", effort }), /task_model_selection_refused/, effort);
});

test("a listed task choice survives a real store re-open", async t => {
  const dataDir = await mkdtemp(join(tmpdir(), "acr-model-choice-restart-"));
  const engines: { close(): Promise<void> }[] = [];
  t.after(async () => { for (const engine of engines) await engine.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }); });
  const first = await taskFixtureOnDisk(dataDir); engines.push(first.db);
  const saved = await service(first).propose(first.identity, first.project.projectId,
    { ...taskDraft, model: "gpt-build", effort: "high" }, "model-choice-restart-001");
  assert.deepEqual((await first.client.query<{ selection_key: string; model: string | null; effort: string | null;
    worker_kind: string | null }>("SELECT selection_key,model,effort,worker_kind FROM control_task_model_selections"))
    .rows, [{ selection_key: "gpt-build", model: null, effort: "high", worker_kind: null }]);
  // Close the database. Rebuilding the service on the same in-process handle
  // would prove only that there is no cache, not that the row is durable.
  await first.db.close();

  // A real restart: a new engine instance over the same data directory, a new
  // client, a new service, and a real owner-authorized read.
  const reopened = await taskFixtureOnDisk(dataDir); engines.push(reopened.db);
  assert.deepEqual((await reopened.client.query<{ selection_key: string; model: string | null; effort: string | null }>(
    "SELECT selection_key,model,effort FROM control_task_model_selections WHERE tenant_id='tenant:web' AND job_id=$1",
    [saved.receipt.jobId])).rows, [{ selection_key: "gpt-build", model: null, effort: "high" }]);
  const detail = await service(reopened).detail(reopened.identity, reopened.project.projectId, saved.receipt.jobId);
  assert.deepEqual(detail.modelSelection, { workerKind: null, selectionKey: "gpt-build", model: null, effort: "high",
    provider: null, profile: null, inheritedFromJobId: null });
  // A second close and re-open returns the identical choice, so nothing about it
  // depends on the process that first wrote it.
  await reopened.db.close();
  const again = await taskFixtureOnDisk(dataDir); engines.push(again.db);
  const repeated = await service(again).detail(again.identity, again.project.projectId, saved.receipt.jobId);
  assert.deepEqual(repeated.modelSelection, detail.modelSelection);
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
