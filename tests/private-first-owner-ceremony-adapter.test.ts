import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createPrivateFirstOwnerCeremonyAdapterV1 } from
  "../src/installer/v1/private-first-owner-ceremony-adapter";
import type { DatabaseClient } from "../src/persistence/database";
import { PRIVATE_FIRST_OWNER_INSTALLATION_BINDING_V1, type PrivateFirstOwnerRunnerContextV1 } from
  "../src/installer/v1/private-first-owner-runner";
import type { FirstOwnerActionRequestV1 } from "../src/installer/v1/first-owner-action-transaction";
import { sha256Digest } from "../src/security/canonical-digest";
import type { LinuxUnixOwnerBootstrapControlAttemptV1, OwnerBootstrapCeremonyV1 } from
  "../src/web/v1/owner-bootstrap-ceremony";

const d = (value: unknown) => sha256Digest(value);

function fixture(options: { completion?: unknown; row?: Record<string, unknown>; close?: () => Promise<void>;
  route?: () => Promise<Response> } = {}) {
  const expectedOwnerSubjectDigest = d("expected-owner");
  const request: FirstOwnerActionRequestV1 = Object.freeze({
    schema: "control-room.first-owner-action-request/v1", installationPlanDigest: d("plan"),
    installationPlanRevision: 4, releaseDigest: d("release"), databaseAuthorityOutcomeDigest: d("database"),
    preparationDigest: d("preparation"), expectedOwnerSubjectDigest, initialOwnerState: "empty",
    initialOwnerProofDigest: d("empty"), operation: "arm_existing_owner_bootstrap_ceremony",
    performsEffect: false, acceptsAssertion: false, acceptsOneTimeCode: false, createsOwner: false,
    opensDatabase: false, startsListener: false,
  });
  const binding = Object.freeze({ schema: PRIVATE_FIRST_OWNER_INSTALLATION_BINDING_V1,
    installationId: "local-installation-one", installationPlanDigest: request.installationPlanDigest,
    installationPlanRevision: request.installationPlanRevision, releaseDigest: request.releaseDigest,
    databaseAuthorityOutcomeDigest: request.databaseAuthorityOutcomeDigest, expectedOwnerSubjectDigest });
  const controller = new AbortController();
  const context: PrivateFirstOwnerRunnerContextV1 = Object.freeze({ request,
    requestDigest: sha256Digest({ purpose: "first-owner-action-request/v1", request }), binding,
    signal: controller.signal });
  const owner = Object.freeze({ databaseName: "control_room", tenantId: "tenant:local",
    workspaceId: "workspace:local", tenantDisplayName: "Local tenant", workspaceDisplayName: "Local workspace",
    identityId: "identity:owner", grantId: "grant:owner", displayName: "First owner", expectedOwnerSubjectDigest });
  const completion = options.completion ?? { schema: "control-room.owner-bootstrap-complete/v1",
    ownerCreated: true, normalApplicationAvailable: true, physicalGatewayAcceptanceComplete: false };
  const row = { database_name: owner.databaseName, tenant_id: owner.tenantId,
    tenant_display_name: owner.tenantDisplayName, workspace_id: owner.workspaceId,
    workspace_tenant_id: owner.tenantId, workspace_display_name: owner.workspaceDisplayName,
    identity_id: owner.identityId, identity_tenant_id: owner.tenantId, actor_type: "human",
    identity_display_name: owner.displayName, auth_provider: "https://issuer.example",
    auth_subject_digest: owner.expectedOwnerSubjectDigest, identity_state: "active", grant_id: owner.grantId,
    grant_tenant_id: owner.tenantId, grant_identity_id: owner.identityId, role_key: "owner",
    allowed_actions: ["*"], project_ids: ["*"], risk_ceiling: "critical", allow_external_effects: true,
    require_strong_factor: false, expires_at: null, revoked_at: null, identity_count: "1", workspace_count: "1",
    grant_count: "1", owner_grant_count: "1",
    ...options.row };
  const calls: string[] = [];
  let bootstrapOnly = true;
  const ceremony: OwnerBootstrapCeremonyV1 = {
    isBootstrapOnly: () => bootstrapOnly,
    async arm() { calls.push("arm"); return { schema: "control-room.owner-bootstrap-arm/v1", armed: true,
      expiresAt: "2099-01-01T00:00:00.000Z", listenerStarted: false,
      physicalPeerQualificationComplete: false }; },
    async route() { calls.push("route"); if (options.route) return options.route(); bootstrapOnly = false;
      return Response.json(completion, { status: 201 }); },
    async close() { calls.push("close"); await options.close?.(); },
  };
  const database: Pick<DatabaseClient, "query"> = { async query<T>(statement: string, params?: unknown[]) {
    calls.push("query"); assert.match(statement, /control_identities/u);
    assert.deepEqual(params, [owner.tenantId, owner.workspaceId, owner.identityId, owner.grantId,
      owner.expectedOwnerSubjectDigest]); return { rows: [row as T] };
  } };
  const attempt = { transport: "unix", platform: "linux" } as LinuxUnixOwnerBootstrapControlAttemptV1;
  const adapter = createPrivateFirstOwnerCeremonyAdapterV1({ binding, owner, database, ceremony,
    async acquireOwnerAttendedControlAttempt(received) { calls.push("acquire"); assert.equal(received, context); return attempt; },
    cleanupDeadlineMs: 25 });
  return { adapter, binding, context, controller, owner, row, calls, ceremony, database };
}

async function complete(f: ReturnType<typeof fixture>, request = new Request("https://control.example/api/v1/owner-bootstrap", {
  method: "POST", headers: { "x-private-assertion": "raw-secret-assertion", "content-type": "application/json" },
  body: JSON.stringify({ code: "raw-one-time-code" }) })) {
  const running = f.adapter.runRetainedOwnerBootstrapCeremony(f.context);
  await new Promise(resolve => setTimeout(resolve, 0));
  const response = await f.adapter.route(request);
  assert.equal(response?.status, 201);
  return running;
}

test("the retained ceremony completion and exact authoritative owner become one bounded digest proof", async () => {
  const f = fixture(), completion = await complete(f);
  const ceremonyOutcomeDigest = sha256Digest({ purpose: "private-first-owner-ceremony-outcome/v1",
    installationId: f.binding.installationId, requestDigest: f.context.requestDigest, completion });
  const evidence = await f.adapter.verifyExistingOwner(Object.freeze({ ...f.context, ceremonyOutcomeDigest }));
  assert.equal(evidence.ownerState, "existing"); assert.equal(evidence.expectedOwnerSubjectDigest, f.owner.expectedOwnerSubjectDigest);
  assert.match(evidence.ownerProofDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(evidence), /raw-secret|one-time|assertion|code/i);
  const cleanup = await f.adapter.cleanupRetainedOwnerBootstrapCeremony(Object.freeze({ ...f.context,
    scope: "retained_owner_bootstrap_ceremony" as const, signal: new AbortController().signal }));
  assert.equal(cleanup.outcome, "confirmed");
  assert.deepEqual(f.calls, ["acquire", "arm", "route", "query", "close"]);
});

test("callable identities are captured before asynchronous owner attendance and route handling", async () => {
  const f = fixture(); let substituted = false;
  f.ceremony.arm = async () => { substituted = true; throw new Error("replacement"); };
  f.ceremony.route = async () => { substituted = true; throw new Error("replacement"); };
  f.ceremony.close = async () => { substituted = true; };
  f.ceremony.isBootstrapOnly = () => { substituted = true; return true; };
  f.database.query = async <T>() => { substituted = true; return { rows: [] as T[] }; };
  const completion = await complete(f);
  const ceremonyOutcomeDigest = sha256Digest({ purpose: "private-first-owner-ceremony-outcome/v1",
    installationId: f.binding.installationId, requestDigest: f.context.requestDigest, completion });
  await f.adapter.verifyExistingOwner({ ...f.context, ceremonyOutcomeDigest });
  await f.adapter.cleanupRetainedOwnerBootstrapCeremony({ ...f.context,
    scope: "retained_owner_bootstrap_ceremony", signal: new AbortController().signal });
  assert.equal(substituted, false);
});

test("changed owner, grant, count, database, subject, or ceremony binding is rejected", async () => {
  for (const changed of [{ identity_state: "suspended" }, { auth_subject_digest: d("other") },
    { role_key: "operator" }, { allowed_actions: ["read"] }, { identity_count: "2" },
    { workspace_count: "2" }, { grant_count: "2" }, { owner_grant_count: "2" }, { database_name: "other" },
    { workspace_tenant_id: "tenant:other" },
    { revoked_at: "2026-01-01T00:00:00.000Z" }]) {
    const f = fixture({ row: changed }); const completion = await complete(f);
    const ceremonyOutcomeDigest = sha256Digest({ purpose: "private-first-owner-ceremony-outcome/v1",
      installationId: f.binding.installationId, requestDigest: f.context.requestDigest, completion });
    await assert.rejects(f.adapter.verifyExistingOwner({ ...f.context, ceremonyOutcomeDigest }), error => {
      assert.equal((error as Error).message, "private_first_owner_ceremony_adapter_uncertain");
      assert.equal((error as Error).stack, undefined); return true;
    });
  }
  const f = fixture(); await complete(f);
  await assert.rejects(f.adapter.verifyExistingOwner({ ...f.context, ceremonyOutcomeDigest: d("wrong") }), /uncertain/);
});

test("arm evidence, malformed terminal responses, abort, replay, and hanging cleanup never become success", async () => {
  const malformed = fixture({ completion: { schema: "control-room.owner-bootstrap-complete/v1", ownerCreated: true,
    normalApplicationAvailable: true, physicalGatewayAcceptanceComplete: false, assertion: "leak" } });
  await assert.rejects(complete(malformed), /uncertain/);

  const aborted = fixture(); aborted.controller.abort();
  await assert.rejects(aborted.adapter.runRetainedOwnerBootstrapCeremony(aborted.context), /uncertain/);

  const replay = fixture(); await complete(replay);
  await assert.rejects(replay.adapter.runRetainedOwnerBootstrapCeremony(replay.context), /uncertain/);

  const hanging = fixture({ close: () => new Promise<void>(() => {}) }); await complete(hanging);
  const started = Date.now();
  await assert.rejects(hanging.adapter.cleanupRetainedOwnerBootstrapCeremony({ ...hanging.context,
    scope: "retained_owner_bootstrap_ceremony", signal: new AbortController().signal }), /uncertain/);
  assert.ok(Date.now() - started < 500);
});

test("a request that returns after cleanup cannot report owner-bootstrap success", async () => {
  let entered!: () => void, releaseRoute!: () => void;
  const routeEntered = new Promise<void>(resolve => { entered = resolve; });
  const routeReleased = new Promise<void>(resolve => { releaseRoute = resolve; });
  const f = fixture({ route: async () => {
    entered(); await routeReleased;
    return Response.json({ schema: "control-room.owner-bootstrap-complete/v1", ownerCreated: true,
      normalApplicationAvailable: true, physicalGatewayAcceptanceComplete: false }, { status: 201 });
  } });

  const running = f.adapter.runRetainedOwnerBootstrapCeremony(f.context);
  await new Promise(resolve => setTimeout(resolve, 0));
  const response = f.adapter.route(new Request("https://control.example/api/v1/owner-bootstrap", { method: "POST" }));
  await routeEntered;
  const cleanup = await f.adapter.cleanupRetainedOwnerBootstrapCeremony({ ...f.context,
    scope: "retained_owner_bootstrap_ceremony", signal: new AbortController().signal });
  releaseRoute();
  assert.equal((await response)?.status, 503);
  assert.equal(cleanup.outcome, "confirmed");
  await assert.rejects(running, /uncertain/);
});

test("cleanup during response-body parsing cannot turn a late success or parse failure into 201", async () => {
  for (const body of [JSON.stringify({ schema: "control-room.owner-bootstrap-complete/v1", ownerCreated: true,
    normalApplicationAvailable: true, physicalGatewayAcceptanceComplete: false }), "not-json"]) {
    let opened!: () => void, closeBody!: () => void, emitted = false;
    const bodyOpened = new Promise<void>(resolve => { opened = resolve; });
    const bodyClosed = new Promise<void>(resolve => { closeBody = resolve; });
    const f = fixture({ route: async () => new Response(new ReadableStream<Uint8Array>({ pull(stream) {
      if (emitted) return; emitted = true; stream.enqueue(new TextEncoder().encode(body)); opened();
      return bodyClosed.then(() => stream.close());
    } }, { highWaterMark: 0 }), { status: 201, headers: { "content-type": "application/json" } }) });
    const running = f.adapter.runRetainedOwnerBootstrapCeremony(f.context);
    await new Promise(resolve => setTimeout(resolve, 0));
    const response = f.adapter.route(new Request("https://control.example/api/v1/owner-bootstrap", { method: "POST" }));
    await bodyOpened;
    const cleanup = await f.adapter.cleanupRetainedOwnerBootstrapCeremony({ ...f.context,
      scope: "retained_owner_bootstrap_ceremony", signal: new AbortController().signal });
    closeBody();
    const returned = await response;
    assert.equal(returned?.status, 503);
    assert.deepEqual(await returned?.json(), { error: "owner_bootstrap_unavailable" });
    assert.equal(cleanup.outcome, "confirmed");
    await assert.rejects(running, /uncertain/);
  }
});

test("the adapter is source-only and creates no second listener, authentication, identity, or receipt system", async () => {
  const source = await readFile("src/installer/v1/private-first-owner-ceremony-adapter.ts", "utf8");
  assert.doesNotMatch(source, /from "node:(?:fs|net|http|child_process)"|createServer|listen\(|INSERT INTO|UPDATE |DELETE FROM/iu);
  assert.match(source, /OwnerBootstrapCeremonyV1/);
  assert.match(source, /PrivateOwnerBootstrapConfiguration/);
  assert.match(source, /SELECT current_database\(\)/u);
});
