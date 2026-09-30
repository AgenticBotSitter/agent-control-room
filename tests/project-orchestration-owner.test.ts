import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest, type AuthenticatedPrincipal } from "../src/security";
import { createProjectOrchestrationBrowserClient } from "../src/web/v1/project-orchestration-browser-client";
import { createProjectOrchestrationOwnerAdapterV1, InMemoryProjectOrchestrationStoreV1 } from
  "../src/web/v1/project-orchestration-owner";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import type { IntakeCoordinatorResultV1 } from "../src/work-intake/v1/intake-coordinator";
import { createProjectOrchestrationHttpHandlerV1 } from "../src/web/v1/project-orchestration-http";
import type { LocalOwnerSessionServiceV1 } from "../src/web/v1/local-owner-session";
import type { ProjectOrchestrationOwnerPortV1 } from "../src/web/v1/project-orchestration-owner";

const tenantId = "tenant:test", projectId = "project:test", batchId = "batch:test", revisionDigest = `sha256:${"a".repeat(64)}`;
const identity: VerifiedWebIdentity = { provider: "https://access.invalid", subject: "owner", tokenDigest: `sha256:${"b".repeat(64)}`,
  issuedAt: "2026-09-29T10:00:00.000Z", expiresAt: "2026-09-29T12:00:00.000Z",
  verificationExpiresAt: "2026-09-29T12:00:00.000Z" };
const agent: AuthenticatedPrincipal = { tenantId, identityId: "identity:chief", actorType: "agent",
  authenticatedAt: "2026-09-29T10:00:00.000Z", expiresAt: "2026-09-29T12:00:00.000Z" };
const catalog = [{ workerId: "worker:chief", workerKind: "codex" as const, nodeId: "node:chief",
  modelPolicy: { models: ["model:plan"], defaultModel: "model:plan", efforts: ["high" as const], defaultEffort: "high" as const } }];
const proposal = { schema: "control-room.work-batch-proposal/v1" as const, projectId,
  tasks: [{ localId: "plan", title: "Plan it", instructions: "Prepare the bounded plan.", requiredCapability: "code.change",
    role: "builder" as const, acceptanceCriteria: "The plan is complete.", acceptanceTests: "Review the plan." }], edges: [] };
const receipt = { schema: "control-room.work-batch-receipt/v1" as const, batchId, projectId, state: "proposed" as const,
  proposalDigest: sha256Digest(proposal), revision: 1 as const, replayed: false, startsWork: false as const,
  grantsExecutionAuthority: false as const };

function fixture(result: IntakeCoordinatorResultV1 = { status: "submitted", submission: receipt, flagsByLocalId: {},
  startsWork: false, grantsExecutionAuthority: false }, batchState: "proposed" | "not_proposed" = "proposed") {
  const store = new InMemoryProjectOrchestrationStoreV1(tenantId), calls: string[] = [];
  const coordinator = { async coordinateInitial(input: { idempotencyKey: string }) { calls.push(input.idempotencyKey); return result; },
    ownerPrefill: store.prefillForOwner.bind(store) };
  const service = createProjectOrchestrationOwnerAdapterV1({ tenantId, coordinatorPrincipal: agent,
    coordinator, store, queueCatalog: catalog, clock: () => Date.parse("2026-09-29T11:00:00.000Z"),
    access: { async owner() { return { tenantId, ownerIdentityId: "identity:owner" }; } },
    batches: { async read() { return { revision: 2, revisionDigest, state: batchState }; } } });
  return { store, service, calls };
}

test("owner settings choose an exact catalog bot/model or none with optimistic conflict refusal", async () => {
  const f = fixture(), initial = await f.service.readSettings(identity, projectId);
  assert.equal(initial.choice.mode, "none"); assert.equal(initial.options.length, 1);
  const selected = await f.service.saveSettings(identity, projectId, { expectedVersion: 0, choice: { mode: "selected",
    workerId: "worker:chief", workerKind: "codex", modelKey: "model:plan", effort: "high" } });
  assert.equal(selected.version, 1); assert.equal((await f.store.read(projectId))?.workerId, "worker:chief");
  await assert.rejects(f.service.saveSettings(identity, projectId, { expectedVersion: 0, choice: { mode: "none" } }), /conflict/);
  await assert.rejects(f.service.saveSettings(identity, projectId, { expectedVersion: 1, choice: { mode: "selected",
    workerId: "worker:unknown", workerKind: "codex", modelKey: "model:plan", effort: "high" } }), /invalid_request/);
  const none = await f.service.saveSettings(identity, projectId, { expectedVersion: 1, choice: { mode: "none" } });
  assert.equal(none.choice.mode, "none"); assert.equal(await f.store.read(projectId), null);
});

test("describe maps proposal, failure, stop and bad input without granting authority", async () => {
  const proposed = fixture();
  const value = await proposed.service.describe(identity, projectId, { description: "Prepare a launch plan" }, "request:test-0001");
  assert.equal(value.status, "proposal"); assert.equal(value.startsWork, false);
  if (value.status === "proposal") assert.equal(value.href, "/projects/project%3Atest/pipelines/batch%3Atest");
  assert.deepEqual(proposed.calls, ["request:test-0001"]);
  await assert.rejects(proposed.service.describe(identity, projectId, { description: "" }, "request:test-0002"), /invalid_request/);
  assert.equal((await proposed.service.describe(identity, projectId, { description: "x".repeat(16_000) },
    "request:test-limit")).status, "proposal");
  await assert.rejects(proposed.service.describe(identity, projectId, { description: "x".repeat(16_001) },
    "request:test-over-limit"), /invalid_request/);
  await assert.rejects(proposed.service.describe(identity, projectId, { description: "valid" }, "short"), /invalid_request/);
  const failed = await fixture({ status: "planner_failed", reasonCode: "planner_run_failed", failureCount: 1,
    startsWork: false, grantsExecutionAuthority: false }).service.describe(identity, projectId,
    { description: "Prepare it" }, "request:test-0003");
  assert.deepEqual(failed.status === "failed" ? [failed.needsYou, failed.message.includes("Needs-you")] : [], [true, true]);
  const stopped = await fixture({ status: "stopped", startsWork: false, grantsExecutionAuthority: false }).service.describe(
    identity, projectId, { description: "Prepare it" }, "request:test-0004");
  assert.equal(stopped.status, "stopped");
});

test("suggestion use only returns an immutable prefill; dismiss removes its card and stale use refuses", async () => {
  const f = fixture();
  await f.store.append({ tenantId, projectId, batchId, requestKey: "resplit:test", baseRevision: 2,
    baseRevisionDigest: revisionDigest, proposerIdentityId: "identity:chief", proposal,
    proposalDigest: sha256Digest(proposal), flagsByLocalId: {}, createdAt: "2026-09-29T11:00:00.000Z" });
  await f.store.append({ tenantId, projectId, batchId, requestKey: "resplit:stale", baseRevision: 1,
    baseRevisionDigest: `sha256:${"c".repeat(64)}`, proposerIdentityId: "identity:chief", proposal,
    proposalDigest: sha256Digest(proposal), flagsByLocalId: {}, createdAt: "2026-09-29T10:00:00.000Z" });
  const page = await f.service.listSuggestions(identity, projectId, batchId) as { suggestions: Array<{ suggestionId: string }> };
  assert.equal(page.suggestions.length, 1);
  const suggestionId = page.suggestions[0]!.suggestionId;
  const prefill = await f.service.useSuggestion(identity, projectId, batchId, suggestionId, 2);
  assert.equal(prefill.savesRevision, false); assert.equal(prefill.startsWork, false);
  assert.equal(Object.isFrozen(prefill.proposal.tasks), true);
  await assert.rejects(f.service.useSuggestion(identity, projectId, batchId, "suggestion:missing", 2), /not_found/);
  await assert.rejects(f.service.useSuggestion(identity, projectId, batchId, suggestionId, 1), /conflict/);
  await f.service.dismissSuggestion(identity, projectId, batchId, suggestionId, 2);
  const empty = await f.service.listSuggestions(identity, projectId, batchId) as { suggestions: unknown[] };
  assert.equal(empty.suggestions.length, 0);
  await assert.rejects(f.service.useSuggestion(identity, projectId, batchId, suggestionId, 2), /owner_required/);
  const decided = fixture(undefined, "not_proposed");
  await decided.store.append({ tenantId, projectId, batchId, requestKey: "resplit:decided", baseRevision: 2,
    baseRevisionDigest: revisionDigest, proposerIdentityId: "identity:chief", proposal,
    proposalDigest: sha256Digest(proposal), flagsByLocalId: {}, createdAt: "2026-09-29T11:00:00.000Z" });
  const decidedPage = await decided.service.listSuggestions(identity, projectId, batchId) as { suggestions: unknown[] };
  assert.equal(decidedPage.suggestions.length, 0);
});

test("a burst of 40 owner requests stays bounded to 40 coordinator calls and returns exact links", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 40 }, (_, index) => f.service.describe(identity, projectId,
    { description: `Prepare bounded job ${index}` }, `request:burst-${String(index).padStart(4, "0")}`)));
  assert.equal(f.calls.length, 40); assert.equal(results.every(result => result.status === "proposal"), true);
});

test("browser retry after a dropped response reuses the exact body and idempotency key", async () => {
  const requests: Array<{ body: BodyInit | null | undefined; key?: string }> = []; let attempt = 0;
  const transport = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ body: init?.body, key: (init?.headers as Record<string, string>)["idempotency-key"] });
    if (attempt++ === 0) throw new Error("dropped response");
    return Response.json({ status: "proposal", batchId, href: "/batch", startsWork: false,
      grantsExecutionAuthority: false });
  }) as typeof fetch;
  const client = createProjectOrchestrationBrowserClient(transport, () => "request:stable-0001");
  await assert.rejects(client.describe(projectId, "Prepare it"), /uncertain/);
  assert.equal(client.hasPendingDescription(), true);
  assert.equal((await client.retryDescription()).status, "proposal");
  assert.equal(requests[0]?.body, requests[1]?.body); assert.equal(requests[0]?.key, requests[1]?.key);
});

test("owner HTTP routes keep description, settings and suggestion gestures separate", async () => {
  const calls: string[] = [];
  const service: ProjectOrchestrationOwnerPortV1 = {
    async readSettings(_identity, value) { calls.push(`settings:read:${value}`); return fixture().service.readSettings(identity, value); },
    async saveSettings(_identity, value) { calls.push(`settings:save:${value}`); return fixture().service.readSettings(identity, value); },
    async describe(_identity, value, body, key) { calls.push(`describe:${value}:${key}:${(body as { description: string }).description}`);
      return { status: "proposal", batchId, href: "/batch", startsWork: false, grantsExecutionAuthority: false }; },
    async listSuggestions(_identity, value, batch) { calls.push(`suggestions:list:${value}:${batch}`);
      return { projectId: value, batchId: batch, suggestions: [], startsWork: false, grantsExecutionAuthority: false }; },
    async useSuggestion(_identity, value, batch, suggestionId, expectedRevision) {
      calls.push(`suggestions:use:${value}:${batch}:${suggestionId}:${expectedRevision}`);
      return { proposal, startsWork: false, grantsExecutionAuthority: false, savesRevision: false }; },
    async dismissSuggestion(_identity, value, batch, suggestionId, expectedRevision) {
      calls.push(`suggestions:dismiss:${value}:${batch}:${suggestionId}:${expectedRevision}`); },
  };
  const local = { profile: { origin: "http://127.0.0.1:3210" }, assertLocalRequest() {}, verify() { return identity; } } as unknown as LocalOwnerSessionServiceV1;
  const handle = createProjectOrchestrationHttpHandlerV1({ origin: "http://127.0.0.1:3210", service,
    localOwnerSession: local });
  const request = (path: string, method = "GET", value?: unknown, key?: string) => handle(new Request(
    `http://127.0.0.1:3210${path}`, { method, headers: { ...(value === undefined ? {} : { "content-type": "application/json" }),
      ...(key ? { "idempotency-key": key } : {}) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }));
  assert.equal((await request(`/api/v1/projects/${encodeURIComponent(projectId)}/orchestration-settings`)).status, 200);
  assert.equal((await request(`/api/v1/projects/${encodeURIComponent(projectId)}/orchestration-settings`, "POST",
    { expectedVersion: 0, choice: { mode: "none" } })).status, 200);
  assert.equal((await request(`/api/v1/projects/${encodeURIComponent(projectId)}/orchestration`, "POST",
    { description: "Prepare it" }, "request:http-0001")).status, 201);
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(batchId)}/suggestions`;
  assert.equal((await request(base)).status, 200);
  assert.equal((await request(`${base}/${encodeURIComponent("suggestion:test")}/use`, "POST", { expectedRevision: 2 })).status, 200);
  assert.equal((await request(`${base}/${encodeURIComponent("suggestion:test")}/dismiss`, "POST", { expectedRevision: 2 })).status, 204);
  assert.equal((await request(`${base}/${encodeURIComponent("suggestion:test")}/use`, "POST", { expectedRevision: 0 })).status, 400);
  assert.equal((await request(`/api/v1/projects/${encodeURIComponent(projectId)}/orchestration`)).status, 400);
  assert.deepEqual(calls, [`settings:read:${projectId}`, `settings:save:${projectId}`,
    `describe:${projectId}:request:http-0001:Prepare it`, `suggestions:list:${projectId}:${batchId}`,
    `suggestions:use:${projectId}:${batchId}:suggestion:test:2`,
    `suggestions:dismiss:${projectId}:${batchId}:suggestion:test:2`]);
});
