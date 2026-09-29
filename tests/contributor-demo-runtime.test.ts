import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import test from "node:test";
import { createContributorDemoRuntime } from "../src/contributor-demo/runtime";
import { createContributorDemoHttp } from "../src/contributor-demo/http";
import { createContributorDemoBrowserClient } from "../src/contributor-demo/browser-client";
import { loadContributorHistory, unrecordedContributorFeedback } from "../src/contributor-demo/history-view";
import { createTaskBrowserClient } from "../src/web/v1/task-browser-client";
import { createLocalPilotBrowserTransportV1 } from "../src/local-pilot/v1/browser-transport";
import { createLocalPilotControlRoomClientV1 } from "../src/local-pilot/v1/control-room-browser-client";
import { createContributorDemoNodeHandler, createPrivateNodeHandler } from "../src/web/v1/private-node-handler";
import { applyReadValidator } from "../src/web/v1/private-read-validator";
import { nodeExchange } from "./helpers/web-node";
import {
  buildProtectedProjectCatalogHighWaterV1,
  buildProtectedProjectCatalogV1,
  buildProjectWorkspaceVerifiedOwnerSessionV1,
  InMemoryProjectWorkspaceCatalogHighWaterStoreV1,
  ProjectWorkspaceOwnerReadScopeAuthorityV1,
  ProjectWorkspaceProtectedCatalogAuthorityV1,
} from "../src/project-workspace/v1/catalog-session";
import { ProjectWorkspaceContractErrorV1 } from "../src/project-workspace/v1/errors";
import type { SecurityStore } from "../src/security";

const scopeFixtureTenantId = "tenant:scope-fixture";
const scopeFixtureWorkspaceId = "workspace:scope-fixture";
const scopeFixtureProjectId = "project:scope-fixture";
const scopeFixtureCatalogId = "catalog:scope-fixture";
const scopeFixtureSourceIdentityDigest = `sha256:${"ab".repeat(32)}`;
const scopeFixtureNow = "2026-09-29T16:00:00.000Z";

function scopeFixtureKeys() {
  return { catalogKey: new Uint8Array(32).fill(7), highWaterKey: new Uint8Array(32).fill(11) };
}

function buildScopeFixtureCatalog(recordedAt: string, catalogState: "active" | "revoked", entryStates: ("active" | "revoked")[]) {
  const suffixes = ["", "-b", "-c", "-d"];
  return buildProtectedProjectCatalogV1({
    contractVersion: "control-room-project-workspace-catalog/v1",
    catalogId: scopeFixtureCatalogId,
    tenantId: scopeFixtureTenantId,
    revision: 1,
    previousCatalogDigest: null,
    state: catalogState,
    sourceKind: "protected_server_catalog",
    sourceIdentityDigest: scopeFixtureSourceIdentityDigest,
    recordedAt,
    entries: entryStates.map((state, index) => ({
      tenantId: scopeFixtureTenantId,
      workspaceId: scopeFixtureWorkspaceId,
      projectId: `${scopeFixtureProjectId}${suffixes[index] ?? `-x${index}`}`,
      projectType: "contributor-demo",
      state,
      recordedAt,
    })),
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  }, scopeFixtureKeys().catalogKey);
}

function buildScopeFixtureCheckpoint(catalog: ReturnType<typeof buildScopeFixtureCatalog>, recordedAt: string) {
  return buildProtectedProjectCatalogHighWaterV1({
    catalog,
    checkpointId: "checkpoint:scope-fixture-1",
    recordedAt,
  }, scopeFixtureKeys().catalogKey, scopeFixtureKeys().highWaterKey);
}

function buildScopeFixtureSession(tenantId: string, authenticatedAt: string, expiresAt: string) {
  return buildProjectWorkspaceVerifiedOwnerSessionV1({
    contractVersion: "control-room-project-workspace-owner-session/v1",
    tenantId,
    provider: "owner-session",
    subject: "owner:ci-runner",
    sessionIdDigest: `sha256:${"cd".repeat(32)}`,
    authenticatedAt,
    expiresAt,
    readOnly: true,
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  });
}

function buildScopeFixtureAuthorities(options: {
  catalog: ReturnType<typeof buildScopeFixtureCatalog>;
  checkpoint: ReturnType<typeof buildScopeFixtureCheckpoint>;
  session: ReturnType<typeof buildScopeFixtureSession>;
  tamperCheckpoint?: (value: ReturnType<typeof buildScopeFixtureCheckpoint>) => void;
  readCheckpointDirectly?: boolean;
}) {
  const keys = scopeFixtureKeys();
  const highWater = options.tamperCheckpoint || options.readCheckpointDirectly
    ? {
      read: async () => {
        const copy = structuredClone(options.checkpoint);
        options.tamperCheckpoint?.(copy);
        return copy;
      },
    }
    : (() => {
      const store = new InMemoryProjectWorkspaceCatalogHighWaterStoreV1(keys.highWaterKey, { testOnly: true });
      store.apply(options.checkpoint);
      return store;
    })();
  const catalogAuthority = new ProjectWorkspaceProtectedCatalogAuthorityV1(
    { read: async () => options.catalog },
    highWater,
    { catalogId: scopeFixtureCatalogId, tenantId: scopeFixtureTenantId, sourceIdentityDigest: scopeFixtureSourceIdentityDigest },
    keys.catalogKey,
    keys.highWaterKey,
  );
  const security = { authorizeRead: async () => ({ identityId: "owner:ci-runner", expiresAt: "2026-09-29T16:10:00.000Z" }) };
  return new ProjectWorkspaceOwnerReadScopeAuthorityV1(
    { verify: async () => options.session },
    catalogAuthority,
    security as unknown as SecurityStore,
  );
}

function validScopeFixtureNow(): ReturnType<typeof buildScopeFixtureAuthorities> {
  const catalog = buildScopeFixtureCatalog("2026-09-29T15:58:00.000Z", "active", ["active"]);
  return buildScopeFixtureAuthorities({
    catalog,
    checkpoint: buildScopeFixtureCheckpoint(catalog, "2026-09-29T15:59:00.000Z"),
    session: buildScopeFixtureSession(scopeFixtureTenantId, "2026-09-29T15:59:30.000Z", "2026-09-29T16:09:30.000Z"),
  });
}

async function rejectsWithProjectWorkspaceCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) =>
    error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === code);
}

test("project-workspace scope authority: happy path authorizes a valid owner session against a checkpointed catalog", async () => {
  const scope = await validScopeFixtureNow().authorize({ credential: "credential:unused", projectId: scopeFixtureProjectId, now: scopeFixtureNow });
  assert.deepEqual(
    { tenantId: scope.tenantId, workspaceId: scope.workspaceId, projectId: scope.projectId },
    { tenantId: scopeFixtureTenantId, workspaceId: scopeFixtureWorkspaceId, projectId: scopeFixtureProjectId },
  );
  const catalog = buildScopeFixtureCatalog("2026-09-29T15:58:00.000Z", "active", ["active"]);
  const checkpoint = buildScopeFixtureCheckpoint(catalog, "2026-09-29T15:59:00.000Z");
  assert.equal(scope.catalogId, scopeFixtureCatalogId);
  assert.equal(scope.catalogRevision, 1);
  assert.equal(scope.catalogDigest, catalog.catalogDigest);
  assert.equal(scope.catalogCheckpointDigest, checkpoint.checkpointDigest);
  const session = buildScopeFixtureSession(scopeFixtureTenantId, "2026-09-29T15:59:30.000Z", "2026-09-29T16:09:30.000Z");
  assert.equal(scope.sessionDigest, session.sessionDigest);
  assert.equal(scope.actorId, "owner:ci-runner");
  assert.equal(scope.grantedAt, scopeFixtureNow);
});

test("project-workspace scope authority: expired owner session is rejected with authentication_required", async () => {
  const catalog = buildScopeFixtureCatalog("2026-09-29T15:58:00.000Z", "active", ["active"]);
  const authority = buildScopeFixtureAuthorities({
    catalog,
    checkpoint: buildScopeFixtureCheckpoint(catalog, "2026-09-29T15:59:00.000Z"),
    session: buildScopeFixtureSession(scopeFixtureTenantId, "2026-09-29T15:40:00.000Z", "2026-09-29T15:50:00.000Z"),
  });
  await rejectsWithProjectWorkspaceCode(
    authority.authorize({ credential: "credential:unused", projectId: scopeFixtureProjectId, now: scopeFixtureNow }),
    "authentication_required",
  );
});

test("project-workspace scope authority: stale catalog behind the checkpoint is rejected with catalog_rollback", async () => {
  const keys = scopeFixtureKeys();
  const first = buildProtectedProjectCatalogV1({
    contractVersion: "control-room-project-workspace-catalog/v1",
    catalogId: scopeFixtureCatalogId,
    tenantId: scopeFixtureTenantId,
    revision: 1,
    previousCatalogDigest: null,
    state: "active",
    sourceKind: "protected_server_catalog",
    sourceIdentityDigest: scopeFixtureSourceIdentityDigest,
    recordedAt: "2026-09-29T15:55:00.000Z",
    entries: [{
      tenantId: scopeFixtureTenantId,
      workspaceId: scopeFixtureWorkspaceId,
      projectId: scopeFixtureProjectId,
      projectType: "contributor-demo",
      state: "active",
      recordedAt: "2026-09-29T15:55:00.000Z",
    }],
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  }, keys.catalogKey);
  const firstCheckpoint = buildProtectedProjectCatalogHighWaterV1({
    catalog: first,
    checkpointId: "checkpoint:scope-fixture-1",
    recordedAt: "2026-09-29T15:55:00.000Z",
  }, keys.catalogKey, keys.highWaterKey);
  const second = buildProtectedProjectCatalogV1({
    contractVersion: "control-room-project-workspace-catalog/v1",
    catalogId: scopeFixtureCatalogId,
    tenantId: scopeFixtureTenantId,
    revision: 2,
    previousCatalogDigest: first.catalogDigest,
    state: "active",
    sourceKind: "protected_server_catalog",
    sourceIdentityDigest: scopeFixtureSourceIdentityDigest,
    recordedAt: "2026-09-29T15:57:00.000Z",
    entries: [{
      tenantId: scopeFixtureTenantId,
      workspaceId: scopeFixtureWorkspaceId,
      projectId: scopeFixtureProjectId,
      projectType: "contributor-demo",
      state: "active",
      recordedAt: "2026-09-29T15:55:00.000Z",
    }],
    grantsApproval: false,
    grantsNetworkAuthority: false,
    grantsCommandAuthority: false,
    grantsLeaseAuthority: false,
    grantsExecutionAuthority: false,
  }, keys.catalogKey);
  const secondCheckpoint = buildProtectedProjectCatalogHighWaterV1({
    catalog: second,
    prior: firstCheckpoint,
    checkpointId: "checkpoint:scope-fixture-2",
    recordedAt: "2026-09-29T15:57:00.000Z",
  }, keys.catalogKey, keys.highWaterKey);
  assert.ok(Date.parse(first.recordedAt) < Date.parse(secondCheckpoint.recordedAt),
    "the stale catalog really is recorded before the checkpoint");
  const authority = buildScopeFixtureAuthorities({
    catalog: first,
    checkpoint: secondCheckpoint,
    session: buildScopeFixtureSession(scopeFixtureTenantId, "2026-09-29T15:59:30.000Z", "2026-09-29T16:09:30.000Z"),
    readCheckpointDirectly: true,
  });
  await rejectsWithProjectWorkspaceCode(
    authority.authorize({ credential: "credential:unused", projectId: scopeFixtureProjectId, now: scopeFixtureNow }),
    "catalog_rollback",
  );
});

test("project-workspace scope authority: tampered catalog digest is rejected with integrity_failed", async () => {
  const catalog = buildScopeFixtureCatalog("2026-09-29T15:58:00.000Z", "active", ["active"]);
  const tampered = structuredClone(catalog);
  tampered.entries[0]!.projectId = "project:scope-tampered";
  assert.notEqual(tampered.entries[0]!.projectId, catalog.entries[0]!.projectId);
  const authority = buildScopeFixtureAuthorities({
    catalog: tampered,
    checkpoint: buildScopeFixtureCheckpoint(catalog, "2026-09-29T15:59:00.000Z"),
    session: buildScopeFixtureSession(scopeFixtureTenantId, "2026-09-29T15:59:30.000Z", "2026-09-29T16:09:30.000Z"),
  });
  await rejectsWithProjectWorkspaceCode(
    authority.authorize({ credential: "credential:unused", projectId: scopeFixtureProjectId, now: scopeFixtureNow }),
    "integrity_failed",
  );
});

test("project-workspace scope authority: tampered checkpoint digest is rejected with integrity_failed", async () => {
  const catalog = buildScopeFixtureCatalog("2026-09-29T15:58:00.000Z", "active", ["active"]);
  const authority = buildScopeFixtureAuthorities({
    catalog,
    checkpoint: buildScopeFixtureCheckpoint(catalog, "2026-09-29T15:59:00.000Z"),
    session: buildScopeFixtureSession(scopeFixtureTenantId, "2026-09-29T15:59:30.000Z", "2026-09-29T16:09:30.000Z"),
    tamperCheckpoint: (copy) => { copy.projects[0]!.projectId = "project:scope-tampered"; },
  });
  await rejectsWithProjectWorkspaceCode(
    authority.authorize({ credential: "credential:unused", projectId: scopeFixtureProjectId, now: scopeFixtureNow }),
    "integrity_failed",
  );
});

test("project-workspace scope authority: session tenant mismatch is rejected with scope_mismatch", async () => {
  const catalog = buildScopeFixtureCatalog("2026-09-29T15:58:00.000Z", "active", ["active"]);
  const authority = buildScopeFixtureAuthorities({
    catalog,
    checkpoint: buildScopeFixtureCheckpoint(catalog, "2026-09-29T15:59:00.000Z"),
    session: buildScopeFixtureSession("tenant:other-fixture", "2026-09-29T15:59:30.000Z", "2026-09-29T16:09:30.000Z"),
  });
  await rejectsWithProjectWorkspaceCode(
    authority.authorize({ credential: "credential:unused", projectId: scopeFixtureProjectId, now: scopeFixtureNow }),
    "scope_mismatch",
  );
});

test("project-workspace scope authority: revoked catalog and revoked entry are rejected with catalog_revoked", async () => {
  const revokedCatalog = buildScopeFixtureCatalog("2026-09-29T15:58:00.000Z", "revoked", ["revoked"]);
  const revokedCatalogAuthority = buildScopeFixtureAuthorities({
    catalog: revokedCatalog,
    checkpoint: buildScopeFixtureCheckpoint(revokedCatalog, "2026-09-29T15:59:00.000Z"),
    session: buildScopeFixtureSession(scopeFixtureTenantId, "2026-09-29T15:59:30.000Z", "2026-09-29T16:09:30.000Z"),
  });
  await rejectsWithProjectWorkspaceCode(
    revokedCatalogAuthority.authorize({ credential: "credential:unused", projectId: scopeFixtureProjectId, now: scopeFixtureNow }),
    "catalog_revoked",
  );
  await rejectsWithProjectWorkspaceCode(
    revokedCatalogAuthority.authorize({ credential: "credential:unused", projectId: "project:scope-absent", now: scopeFixtureNow }),
    "catalog_revoked",
  );
  const revokedEntryCatalog = buildScopeFixtureCatalog("2026-09-29T15:58:00.000Z", "active", ["active", "revoked"]);
  const revokedEntryAuthority = buildScopeFixtureAuthorities({
    catalog: revokedEntryCatalog,
    checkpoint: buildScopeFixtureCheckpoint(revokedEntryCatalog, "2026-09-29T15:59:00.000Z"),
    session: buildScopeFixtureSession(scopeFixtureTenantId, "2026-09-29T15:59:30.000Z", "2026-09-29T16:09:30.000Z"),
  });
  await rejectsWithProjectWorkspaceCode(
    revokedEntryAuthority.authorize({ credential: "credential:unused", projectId: `${scopeFixtureProjectId}-b`, now: scopeFixtureNow }),
    "catalog_revoked",
  );
});

test("disposable demo uses real local authentication and project/task services, then removes its data", async t => {
  const demo = await createContributorDemoRuntime(process.cwd());
  t.after(() => demo.close());
  assert.equal(demo.simulationOnly, true);
  assert.ok(isAbsolute(demo.dataDir));
  assert.ok((await stat(demo.dataDir)).isDirectory());
  const request = (method: "GET" | "POST", cookie?: string) => new Request(`${demo.origin}/local-preview`, {
    method, headers: { ...(method === "POST" ? { origin: demo.origin } : {}), ...(cookie ? { cookie } : {}) },
  });
  await assert.rejects(demo.runtime.projectTasks.listProjects(request("GET")), /authentication_required/);
  await assert.rejects(demo.runtime.ownerSession.issue(request("POST"), "incorrect-code-01234567890123456789"), /invalid_owner_code/);
  const issued = await demo.runtime.ownerSession.issue(request("POST"), demo.ownerCode);
  const cookie = issued.cookie.split(";")[0]!;
  await assert.rejects(demo.runtime.ownerSession.issue(request("POST"), demo.ownerCode), /owner_code_consumed/);
  const project = await demo.runtime.projectTasks.createProject(request("POST", cookie), {
    title: "Contributor demo", summary: "Disposable synthetic project",
  }, "contributor-demo-project-001");
  const proposed = await demo.runtime.projectTasks.proposeTask(request("POST", cookie), project.project.projectId, {
    title: "Compare options", instructions: "Synthetic comparison only; do not run an agent.",
  }, "contributor-demo-task-001");
  assert.equal(proposed.receipt.startsWork, false);
  const detail = await demo.runtime.projectTasks.getTask(request("GET", cookie), project.project.projectId, proposed.receipt.jobId);
  assert.equal(detail.task.state, "proposed");
  assert.deepEqual(detail.attempts, []);
  await assert.rejects(demo.simulate(request("GET", cookie), project.project.projectId, proposed.receipt.jobId));
  await assert.rejects(demo.simulate(request("POST"), project.project.projectId, proposed.receipt.jobId));
  const [simulation, replay] = await Promise.all([
    demo.simulate(request("POST", cookie), project.project.projectId, proposed.receipt.jobId),
    demo.simulate(request("POST", cookie), project.project.projectId, proposed.receipt.jobId),
  ]);
  assert.deepEqual(replay, simulation);
  assert.equal(simulation.simulationOnly, true);
  assert.equal(simulation.grantsExecutionAuthority, false);
  const result = await demo.runtime.projectTasks.getSyntheticResult(request("GET", cookie),
    project.project.projectId, proposed.receipt.jobId, simulation.artifactId);
  assert.match(result.text, /SIMULATED RESULT/);
  assert.match(result.text, /Compare options/);
  assert.equal(result.untrustedContent, true);
  const revisionInput = { parentArtifactId: simulation.artifactId, feedback: "Add a short summary." };
  assert.equal((await demo.simulationHistory(request("GET", cookie), project.project.projectId, proposed.receipt.jobId)).entries.length, 1);
  const [revision, repeatedRevision] = await Promise.all([
    demo.simulate(request("POST", cookie), project.project.projectId, proposed.receipt.jobId, revisionInput),
    demo.simulate(request("POST", cookie), project.project.projectId, proposed.receipt.jobId, revisionInput),
  ]);
  assert.deepEqual(repeatedRevision, revision); assert.notEqual(revision.artifactId, simulation.artifactId);
  const revisedResult = await demo.runtime.projectTasks.getSyntheticResult(request("GET", cookie),
    project.project.projectId, proposed.receipt.jobId, revision.artifactId);
  assert.match(revisedResult.text, /REVISED SAMPLE/); assert.match(revisedResult.text, /Add a short summary/);
  assert.match(revisedResult.text, /no agent performed/);
  const history = await demo.simulationHistory(request("GET", cookie), project.project.projectId, proposed.receipt.jobId);
  assert.deepEqual(history.entries, [
    { parentArtifactId: null, feedback: null, state: "succeeded", artifactId: simulation.artifactId },
    { parentArtifactId: simulation.artifactId, feedback: revisionInput.feedback, state: "succeeded", artifactId: revision.artifactId },
  ]);
  history.entries.length = 0;
  assert.equal((await demo.simulationHistory(request("GET", cookie), project.project.projectId, proposed.receipt.jobId)).entries.length, 2);
  await assert.rejects(demo.simulationHistory(request("GET"), project.project.projectId, proposed.receipt.jobId));
  assert.equal((await demo.runtime.projectTasks.getSyntheticResult(request("GET", cookie),
    project.project.projectId, proposed.receipt.jobId, simulation.artifactId)).text, result.text);
  await assert.rejects(demo.simulate(request("POST", cookie), project.project.projectId, proposed.receipt.jobId,
    { ...revisionInput, feedback: "Replace the previous request." }), /revision_conflict/);
  await assert.rejects(demo.simulate(request("POST", cookie), project.project.projectId, proposed.receipt.jobId,
    { ...revisionInput, parentArtifactId: "artifact:missing" }), /parent_unavailable/);
  await assert.rejects(demo.simulate(request("POST", cookie), project.project.projectId, proposed.receipt.jobId,
    { ...revisionInput, feedback: " " }));
  const anotherTask = await demo.runtime.projectTasks.proposeTask(request("POST", cookie), project.project.projectId,
    { title: "Another task", instructions: "Separate task scope." }, "contributor-demo-task-002");
  await assert.rejects(demo.simulate(request("POST", cookie), project.project.projectId, anotherTask.receipt.jobId, revisionInput),
    /parent_unavailable/);
  const other = await demo.runtime.projectTasks.createProject(request("POST", cookie), {
    title: "Other demo project", summary: "Separate scope",
  }, "contributor-demo-project-002");
  await assert.rejects(demo.simulate(request("POST", cookie), other.project.projectId, proposed.receipt.jobId));
  await assert.rejects(demo.simulationHistory(request("GET", cookie), other.project.projectId, proposed.receipt.jobId));
  await assert.rejects(demo.runtime.projectTasks.getSyntheticResult(request("GET", cookie),
    other.project.projectId, proposed.receipt.jobId, simulation.artifactId));
  const after = await demo.runtime.projectTasks.getTask(request("GET", cookie), project.project.projectId, proposed.receipt.jobId);
  assert.equal(after.task.state, "proposed");
  assert.deepEqual(after.attempts, []);
  const first = demo.close();
  assert.equal(demo.close(), first);
  await first;
  await assert.rejects(demo.simulate(request("POST", cookie), project.project.projectId, proposed.receipt.jobId));
  await assert.rejects(stat(demo.dataDir), { code: "ENOENT" });
});

test("demo rejects relative repository roots before allocating data", async () => {
  await assert.rejects(createContributorDemoRuntime("."), /demo_repository_root_must_be_absolute/);
});
test("history client rejects broken chains, wrong scope and operational claims", async () => {
  const root = { parentArtifactId: null, feedback: null, state: "succeeded", artifactId: "artifact:root" };
  const base = { simulationOnly: true, grantsExecutionAuthority: false, projectId: "project:demo", jobId: "job:demo", entries: [root] };
  for (const change of [{ projectId: "project:other" }, { grantsExecutionAuthority: true },
    { entries: [{ ...root, parentArtifactId: "artifact:missing" }] },
    { entries: [root, { ...root, parentArtifactId: root.artifactId, feedback: "Revise" }] },
    { entries: [root, { ...root, artifactId: "artifact:new", parentArtifactId: "artifact:wrong", feedback: "Revise" }] }]) {
    let calls = 0;
    const client = createContributorDemoBrowserClient(async () => { calls++; return Response.json({ ...base, ...change }); });
    await assert.rejects(client.history(base.projectId, base.jobId), { code: "uncertain" });
    assert.equal(calls, 1);
  }
});

test("demo Node bridge preserves local login cookies without changing the production bridge", async t => {
  const demo = await createContributorDemoRuntime(process.cwd());
  const options = { origin: demo.origin, application: { isReady: () => true, close: () => demo.close() },
    handler: createContributorDemoHttp(demo.runtime, demo.simulate),
    assets: { count: 0, digest: "synthetic-empty", respond: () => undefined } };
  assert.throws(() => createPrivateNodeHandler(options), /private_serving_config_invalid/);
  assert.throws(() => createContributorDemoNodeHandler({ ...options, origin: "http://localhost:3000" }), /demo_serving_config_invalid/);
  const bridge = createContributorDemoNodeHandler(options);
  t.after(() => bridge.close());
  async function send(input: Parameters<typeof nodeExchange>[0]) {
    const x = nodeExchange(input);
    x.input.rawHeaders[1] = "127.0.0.1:3000";
    await bridge.handle(x.input, x.output);
    return x;
  }
  const login = await send({ path: "/api/v1/local-pilot/session", method: "POST",
    headers: ["origin", demo.origin, "content-type", "application/json"],
    body: JSON.stringify({ ownerCode: demo.ownerCode }) });
  assert.equal(login.output.statusCode, 201);
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const read = { path: "/api/v1/local-pilot/workspace?resource=projects", headers: ["cookie", cookie] };
  assert.equal((await send(read)).output.statusCode, 200);
  for (const name of ["forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-for"]) {
    assert.equal((await send({ ...read, headers: [...read.headers, name, "untrusted"] })).output.statusCode, 403);
  }
  assert.equal((await send({ ...read, peer: "192.0.2.1" })).output.statusCode, 403);
  const production = createPrivateNodeHandler({ ...options, origin: "https://private.example.invalid",
    handler: () => Response.json({}, { headers: { "set-cookie": "must-not-escape=1" } }) });
  const x = nodeExchange();
  await production.handle(x.input, x.output);
  assert.equal(x.headers.has("set-cookie"), false);
  await production.close();
});

test("private Node bridge delivers an oversized JSON body refused by read validation", async t => {
  const body = JSON.stringify({ big: "x".repeat(1_048_577) });
  const headers = { "cache-control": "no-store", "content-type": "application/json" };
  const bridge = createPrivateNodeHandler({ origin: "https://private.example.invalid",
    application: { isReady: () => true, close: async () => {} },
    assets: { count: 0, digest: "synthetic-empty", respond: () => undefined },
    handler: async request => (await applyReadValidator(request, new Response(body, { headers }),
      "node-bridge-oversized-response", headers)).response });
  t.after(() => bridge.close());
  const exchange = nodeExchange({ path: "/api/v1/projects" });
  await bridge.handle(exchange.input, exchange.output);
  assert.equal(exchange.output.statusCode, 200);
  assert.equal(exchange.body(), body, "the bridge streams every byte of the untouched response");
});

test("simulation browser client rejects mismatched or authority-bearing receipts without retry", async () => {
  const receipt = { simulationOnly: true, grantsExecutionAuthority: false,
    artifactId: "artifact:demo:1", projectId: "project:demo:1", jobId: "job:demo:1" };
  for (const extra of [{ simulationOnly: false }, { grantsExecutionAuthority: true },
    { projectId: "project:other" }, { jobId: "job:other" }, { opaqueLocator: "not-for-browser" }]) {
    let calls = 0;
    const browser = createContributorDemoBrowserClient(async () => {
      calls++; return Response.json({ ...receipt, ...extra });
    });
    await assert.rejects(browser.simulate(receipt.projectId, receipt.jobId), { code: "uncertain" });
    assert.equal(calls, 1);
  }
});

test("demo HTTP composes protected login and project routes without operational endpoints", async t => {
  const demo = await createContributorDemoRuntime(process.cwd());
  t.after(() => demo.close());
  const handle = createContributorDemoHttp(demo.runtime, demo.simulate, demo.simulationHistory);
  const session = `${demo.origin}/api/v1/local-pilot/session`;
  const workspace = `${demo.origin}/api/v1/local-pilot/workspace`;
  assert.equal((await handle(new Request(session))).status, 401);
  assert.equal((await handle(new Request(`${workspace}?resource=projects`))).status, 401);
  const login = () => new Request(session, { method: "POST", headers: {
    origin: demo.origin, "content-type": "application/json",
  }, body: JSON.stringify({ ownerCode: demo.ownerCode }) });
  for (const body of [{ ownerCode: "x".repeat(513) }, { ownerCode: demo.ownerCode, extra: true }]) {
    assert.equal((await handle(new Request(session, { method: "POST", headers: {
      origin: demo.origin, "content-type": "application/json",
    }, body: JSON.stringify(body) }))).status, 400);
  }
  const authenticated = await handle(login());
  assert.equal(authenticated.status, 201);
  assert.equal(authenticated.headers.get("cache-control"), "no-store");
  assert.equal(authenticated.headers.get("x-control-room-pilot"), "repository-fake");
  const cookie = authenticated.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal((await handle(login())).status, 409);
  assert.equal((await handle(new Request(session, { headers: { cookie } }))).status, 200);
  const create = () => new Request(workspace, { method: "POST", headers: {
    cookie, origin: demo.origin, "content-type": "application/json", "idempotency-key": "demo-http-project-0001",
  }, body: JSON.stringify({ operation: "create_project", draft: { title: "HTTP demo", summary: "Synthetic only" } }) });
  assert.equal((await handle(create())).status, 201);
  assert.equal((await handle(create())).status, 200);
  const projects = await handle(new Request(`${workspace}?resource=projects`, { headers: { cookie } }));
  assert.equal((await projects.json()).projects.length, 1);
  const projectReply = await handle(create());
  const projectId = (await projectReply.json()).project.projectId;
  const taskReply = await handle(new Request(workspace, { method: "POST", headers: {
    cookie, origin: demo.origin, "content-type": "application/json", "idempotency-key": "demo-http-task-0001",
  }, body: JSON.stringify({ operation: "propose_task", projectId,
    draft: { title: "HTTP sample", instructions: "Simulation only" } }) }));
  assert.equal(taskReply.status, 201);
  const jobId = (await taskReply.json()).receipt.jobId;
  const simulationUrl = `${demo.origin}/api/v1/contributor-demo/simulations`;
  const simulate = (extra: Record<string, unknown> = {}, authenticated = true) => new Request(simulationUrl, {
    method: "POST", headers: { ...(authenticated ? { cookie } : {}), origin: demo.origin, "content-type": "application/json" },
    body: JSON.stringify({ operation: "simulate_task", simulationOnly: true, projectId, jobId, ...extra }),
  });
  assert.equal((await handle(simulate({}, false))).status, 401);
  assert.equal((await handle(simulate({ simulationOnly: false }))).status, 400);
  assert.equal((await handle(simulate({ command: "not allowed" }))).status, 400);
  assert.equal((await createContributorDemoHttp(demo.runtime)(simulate())).status, 503);
  const simulated = await handle(simulate());
  assert.equal(simulated.status, 200);
  const receipt = await simulated.json();
  assert.deepEqual(await (await handle(simulate())).json(), receipt);
  let calls = 0, loseReply = true;
  const browser = createContributorDemoBrowserClient(async (input, init) => {
    calls++;
    assert.equal(init?.credentials, "same-origin");
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    headers.set("cookie", cookie); headers.set("origin", demo.origin);
    const response = await handle(new Request(`${demo.origin}${String(input)}`, { ...init, headers }));
    if (loseReply) { loseReply = false; throw new Error("lost response"); }
    return response;
  });
  await assert.rejects(browser.simulate(projectId, jobId), { code: "uncertain" });
  assert.equal(calls, 1);
  assert.deepEqual(await browser.simulate(projectId, jobId), receipt);
  assert.equal(calls, 2);
  const feedback = { parentArtifactId: receipt.artifactId, feedback: "Use a shorter summary." };
  loseReply = true;
  await assert.rejects(browser.simulate(projectId, jobId, feedback), { code: "uncertain" });
  const revised = await browser.simulate(projectId, jobId, feedback);
  assert.notEqual(revised.artifactId, receipt.artifactId);
  assert.deepEqual(await browser.simulate(projectId, jobId, feedback), revised);
  const revisionQuery = new URLSearchParams({ resource: "synthetic_result", projectId, jobId, artifactId: revised.artifactId });
  const revisionReply = await handle(new Request(`${workspace}?${revisionQuery}`, { headers: { cookie } }));
  assert.equal(revisionReply.status, 200);
  assert.match((await revisionReply.json()).text, /Use a shorter summary/);
  const historyUrl = `${simulationUrl}?${new URLSearchParams({ projectId, jobId })}`;
  assert.equal((await handle(new Request(historyUrl))).status, 401);
  assert.equal((await handle(new Request(`${historyUrl}&jobId=another`, { headers: { cookie } }))).status, 400);
  assert.equal((await handle(new Request(historyUrl, { headers: { cookie, origin: "https://other.example" } }))).status, 403);
  const historyResponse = await handle(new Request(historyUrl, { headers: { cookie } }));
  assert.equal(historyResponse.status, 200);
  assert.match(historyResponse.headers.get("cache-control")!, /no-store/);
  const historyBody = await historyResponse.json();
  assert.equal(historyBody.entries.length, 2);
  assert.equal(historyBody.entries[1].artifactId, revised.artifactId);
  assert.deepEqual(await browser.history(projectId, jobId), historyBody);
  const readTransport: typeof fetch = async (input, init) => {
    assert.equal(init?.method ?? "GET", "GET");
    const headers = new Headers(init?.headers); headers.set("cookie", cookie);
    return handle(new Request(`${demo.origin}${String(input)}`, { ...init, headers }));
  };
  const restored = await loadContributorHistory({ simulations: createContributorDemoBrowserClient(readTransport),
    tasks: createTaskBrowserClient(createLocalPilotBrowserTransportV1(readTransport)) }, projectId, jobId);
  assert.equal(restored.unavailable, false); assert.equal(restored.samples.length, 2);
  assert.equal(restored.samples[1].artifactId, revised.artifactId);
  assert.match(restored.samples[1].text, /Use a shorter summary/);
  const notAccepted = { parentArtifactId: revised.artifactId, feedback: "Keep this unsent draft." };
  const disconnected = createContributorDemoBrowserClient(async () => { throw new Error("request never delivered"); });
  await assert.rejects(disconnected.simulate(projectId, jobId, notAccepted), { code: "uncertain" });
  const recovered = await loadContributorHistory({ simulations: createContributorDemoBrowserClient(readTransport),
    tasks: createTaskBrowserClient(createLocalPilotBrowserTransportV1(readTransport)) }, projectId, jobId);
  assert.equal(unrecordedContributorFeedback(recovered, notAccepted), notAccepted.feedback);
  assert.equal(unrecordedContributorFeedback(recovered, feedback), undefined);
  assert.equal(recovered.samples.length, 2);
  assert.equal((await handle(simulate({ revision: { ...feedback, feedback: "x".repeat(501) } }))).status, 400);
  assert.equal((await handle(simulate({ revision: { ...feedback, command: "no" } }))).status, 400);
  const query = new URLSearchParams({ resource: "synthetic_result", projectId, jobId, artifactId: receipt.artifactId });
  const resultResponse = await handle(new Request(`${workspace}?${query}`, { headers: { cookie } }));
  assert.equal(resultResponse.status, 200);
  const result = await resultResponse.json();
  assert.equal(result.simulationOnly, true);
  assert.equal(result.grantsExecutionAuthority, false);
  assert.match(result.text, /HTTP sample/);
  assert.equal((await handle(new Request(`${workspace}?resource=projects`, {
    headers: { cookie, origin: "https://untrusted.example" },
  }))).status, 403);
  assert.equal((await handle(new Request(`${demo.origin}/api/v1/native/start`, { method: "POST" }))).status, 404);
  assert.equal((await handle(new Request(session, { method: "DELETE" }))).status, 405);
  assert.equal((await handle(new Request(`${session}?unexpected=yes`))).status, 400);
  assert.equal((await handle(new Request("http://localhost:3000/api/v1/local-pilot/session"))).status, 403);
  await demo.close();
  assert.equal((await handle(new Request(session, { headers: { cookie } }))).status, 503);
});

test("local Control Room reads canonical saved projections and has no operational route", async t => {
  const demo = await createContributorDemoRuntime(process.cwd());
  t.after(() => demo.close());
  const handle = createContributorDemoHttp(demo.runtime);
  const session = `${demo.origin}/api/v1/local-pilot/session`;
  const workspace = `${demo.origin}/api/v1/local-pilot/workspace`;
  const loggedIn = await handle(new Request(session, { method: "POST", headers: { origin: demo.origin, "content-type": "application/json" },
    body: JSON.stringify({ ownerCode: demo.ownerCode }) }));
  const cookie = loggedIn.headers.get("set-cookie")!.split(";")[0]!;
  const request = (method: string, resource: string, extra: Record<string, string> = {}) => new Request(`${demo.origin}/api/v1/local-pilot/workspace?${new URLSearchParams({ resource, ...extra })}`, {
    method, headers: { cookie, ...(method === "POST" ? { origin: demo.origin, "content-type": "application/json", "idempotency-key": "read-only-test" } : {}) },
    ...(method === "POST" ? { body: JSON.stringify({ operation: "start_task" }) } : {}),
  });
  const created = await demo.runtime.projectTasks.createProject(new Request(`${demo.origin}/local-preview`, { method: "POST", headers: { cookie, origin: demo.origin } }),
    { title: "Workboard", summary: "Read-only board" }, "workboard-project");
  const projectId = created.project.projectId;
  await demo.runtime.projectTasks.proposeTask(new Request(`${demo.origin}/local-preview`, { method: "POST", headers: { cookie, origin: demo.origin } }), projectId,
    { title: "Saved work", instructions: "Do not start this work." }, "workboard-task");
  for (const [resource, extra] of [["home", {}], ["overview", { projectId }], ["agents", { projectId }],
    ["attention", { projectId, mode: "inbox" }], ["attention", { projectId, mode: "reviews" }]] as const) {
    assert.equal((await handle(request("GET", resource, extra))).status, 200);
  }
  assert.equal((await handle(new Request(workspace, { method: "POST", headers: { cookie, origin: demo.origin,
    "content-type": "application/json", "idempotency-key": "unsafe-operation-test" },
  body: JSON.stringify({ operation: "start_task", projectId, approval: true, retry: true }) }))).status, 400);
  const methods: string[] = [];
  const client = createLocalPilotControlRoomClientV1(async (input, init) => {
    methods.push(init?.method ?? "GET"); const headers = new Headers(init?.headers); headers.set("cookie", cookie);
    return handle(new Request(`${demo.origin}${String(input)}`, { ...init, headers }));
  });
  assert.equal((await client.overview(projectId)).startsWork, false);
  assert.equal((await client.agents(projectId)).grantsExecutionAuthority, false);
  assert.deepEqual(methods, ["GET", "GET"]);
});
