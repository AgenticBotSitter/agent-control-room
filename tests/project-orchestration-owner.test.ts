import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest, type AuthenticatedPrincipal } from "../src/security";
import { createProjectOrchestrationBrowserClient } from "../src/web/v1/project-orchestration-browser-client";
import { createProjectOrchestrationOwnerAdapterV1, InMemoryProjectOrchestrationStoreV1,
  type ProjectOrchestrationAccessPortV1 } from "../src/web/v1/project-orchestration-owner";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import type { IntakeCoordinatorResultV1 } from "../src/work-intake/v1/intake-coordinator";
import type { WorkBatchQueueCatalogV1 } from "../src/work-intake/v1/queue-catalog";
import { createProjectOrchestrationHttpHandlerV1 } from "../src/web/v1/project-orchestration-http";
import type { LocalOwnerSessionServiceV1 } from "../src/web/v1/local-owner-session";
import type { ProjectOrchestrationOwnerPortV1 } from "../src/web/v1/project-orchestration-owner";
import { PROJECT_ORCHESTRATION_DESCRIPTION_LIMIT_V1 } from "../src/web/v1/project-orchestration-wire";

const tenantId = "tenant:test", projectId = "project:test", batchId = "batch:test", revisionDigest = `sha256:${"a".repeat(64)}`;
const identity: VerifiedWebIdentity = { provider: "https://access.invalid", subject: "owner", tokenDigest: `sha256:${"b".repeat(64)}`,
  issuedAt: "2026-09-29T10:00:00.000Z", expiresAt: "2026-09-29T12:00:00.000Z",
  verificationExpiresAt: "2026-09-29T12:00:00.000Z" };
const agent: AuthenticatedPrincipal = { tenantId, identityId: "identity:chief", actorType: "agent",
  authenticatedAt: "2026-09-29T10:00:00.000Z", expiresAt: "2026-09-29T12:00:00.000Z" };
const catalog = [{ workerId: "worker:chief", workerKind: "codex" as const, nodeId: "node:chief",
  modelPolicy: { models: ["model:plan"], defaultModel: "model:plan", efforts: ["high" as const], defaultEffort: "high" as const } }];
/** A hermes worker with profiles, the branch whose effort 0201's CHECK refuses as a
 * stored 'default'. Its options must therefore carry a NULL effort. */
const hermesCatalog: WorkBatchQueueCatalogV1 = [{ workerId: "worker:hermes", workerKind: "hermes",
  nodeId: "node:hermes",
  modelPolicy: { profiles: [{ name: "profile:one", provider: "provider:one", model: "model:one" }],
    defaultProfile: "profile:one", efforts: ["default"], defaultEffort: "default" } }];
const proposal = { schema: "control-room.work-batch-proposal/v1" as const, projectId,
  tasks: [{ localId: "plan", title: "Plan it", instructions: "Prepare the bounded plan.", requiredCapability: "code.change",
    role: "builder" as const, acceptanceCriteria: "The plan is complete.", acceptanceTests: "Review the plan." }], edges: [] };
const receipt = { schema: "control-room.work-batch-receipt/v1" as const, batchId, projectId, state: "proposed" as const,
  proposalDigest: sha256Digest(proposal), revision: 1 as const, replayed: false, startsWork: false as const,
  grantsExecutionAuthority: false as const };

type FixtureOptions = Readonly<{ result?: IntakeCoordinatorResultV1; batchState?: "proposed" | "not_proposed";
  describeAvailable?: boolean; withDismissals?: boolean; queueCatalog?: WorkBatchQueueCatalogV1;
  access?: ProjectOrchestrationAccessPortV1 }>;

function fixture(options: FixtureOptions = {}) {
  const result = options.result ?? { status: "submitted", submission: receipt, flagsByLocalId: {},
    startsWork: false, grantsExecutionAuthority: false } as IntakeCoordinatorResultV1;
  const store = new InMemoryProjectOrchestrationStoreV1(tenantId), calls: string[] = [];
  const coordinator = { async coordinateInitial(input: { idempotencyKey: string }) {
    calls.push(input.idempotencyKey); return result; },
    ownerPrefill: store.prefillForOwner.bind(store) };
  // The in-memory double's own dismissal takes the same binding the port declares:
  // the suggestion id and the revision it was bound to.
  const dismissals = options.withDismissals ? { async record(input: Readonly<{ suggestionId: string;
    baseRevision: number }>) { store.dismiss({ tenantId, projectId, batchId, suggestionId: input.suggestionId,
      expectedRevision: input.baseRevision }); } } : undefined;
  const service = createProjectOrchestrationOwnerAdapterV1({ tenantId, coordinatorPrincipal: agent,
    coordinator, store, queueCatalog: options.queueCatalog ?? catalog, describeAvailable: options.describeAvailable ?? true,
    ...(dismissals ? { dismissals } : {}),
    clock: () => Date.parse("2026-09-29T11:00:00.000Z"),
    access: options.access ?? { async owner() { return { tenantId, ownerIdentityId: "identity:owner" }; } },
    batches: { async read() { return { revision: 2, revisionDigest, state: options.batchState ?? "proposed" }; } } });
  return { store, service, calls, dismissals };
}

const seedSuggestion = (store: InMemoryProjectOrchestrationStoreV1, requestKey: string,
  revision = 2, digest = revisionDigest) => store.append({ tenantId, projectId, batchId, requestKey, baseRevision: revision,
  baseRevisionDigest: digest, proposerIdentityId: "identity:chief", proposal,
  proposalDigest: sha256Digest(proposal), flagsByLocalId: {}, createdAt: "2026-09-29T11:00:00.000Z" });

test("owner settings choose an exact catalog bot/model or none with optimistic conflict refusal", async () => {
  const f = fixture(), initial = await f.service.readSettings(identity, projectId);
  assert.equal(initial.choice.mode, "none"); assert.equal(initial.options.length, 1);
  assert.equal(initial.choiceStale, false); assert.equal(initial.describeAvailable, true);
  assert.equal(initial.dismissAvailable, false);
  const selected = await f.service.saveSettings(identity, projectId, { expectedVersion: 0, choice: { mode: "selected",
    workerId: "worker:chief", workerKind: "codex", modelKey: "model:plan", effort: "high" } });
  assert.equal(selected.version, 1); assert.equal((await f.store.read(projectId))?.workerId, "worker:chief");
  await assert.rejects(f.service.saveSettings(identity, projectId, { expectedVersion: 0, choice: { mode: "none" } }), /conflict/);
  await assert.rejects(f.service.saveSettings(identity, projectId, { expectedVersion: 1, choice: { mode: "selected",
    workerId: "worker:unknown", workerKind: "codex", modelKey: "model:plan", effort: "high" } }), /invalid_request/);
  const none = await f.service.saveSettings(identity, projectId, { expectedVersion: 1, choice: { mode: "none" } });
  assert.equal(none.choice.mode, "none"); assert.equal(await f.store.read(projectId), null);
});

/** F1: 0201's CHECK refuses a stored 'default'. A hermes-profile option must
 * therefore offer a NULL effort, and the exact-catalog check must compare on that
 * same NULL -- otherwise the owner is offered a selection the database rejects. */
test("a hermes profile option carries a null effort 0201 will accept, and 'default' is refused", async () => {
  const f = fixture({ queueCatalog: hermesCatalog });
  const initial = await f.service.readSettings(identity, projectId);
  assert.deepEqual(initial.options.map(option => [option.modelKey, option.effort]), [["profile:one", null]]);
  const saved = await f.service.saveSettings(identity, projectId, { expectedVersion: 0, choice: { mode: "selected",
    workerId: "worker:hermes", workerKind: "hermes", modelKey: "profile:one", effort: null } });
  assert.equal(saved.choice.mode === "selected" && saved.choice.effort, null);
  // The coordinator's own read sees the same selection, with NO effort field at all:
  // NULL means the catalog decides, and resolveWorkBatchQueueWorkerV1 is told so.
  const selection = await f.store.read(projectId);
  assert.equal(selection?.effort, undefined);
  await assert.rejects(f.service.saveSettings(identity, projectId, { expectedVersion: 1,
    choice: { mode: "selected", workerId: "worker:hermes", workerKind: "hermes", modelKey: "profile:one",
      effort: "high" } }), /invalid_request/);
  await assert.rejects(f.service.saveSettings(identity, projectId, { expectedVersion: 1,
    choice: { mode: "selected", workerId: "worker:hermes", workerKind: "hermes", modelKey: "profile:one",
      effort: "default" as never } }), /invalid_request/);
});

/** F4: a stored selection the catalog no longer holds is reported as stale, not
 * as `none`. The owner is told what is stored and that it cannot be used. */
test("a stored selection the catalog no longer holds reads back as stale, not as none", async () => {
  const f = fixture();
  await f.store.saveSettings({ tenantId, projectId, expectedVersion: 0, choice: { mode: "selected",
    workerId: "worker:removed", workerKind: "codex", modelKey: "model:plan", effort: "high" } });
  const stale = await f.service.readSettings(identity, projectId);
  assert.equal(stale.choiceStale, true);
  assert.equal(stale.choice.mode, "selected", "the stored choice is reported verbatim, not silently replaced");
  // A fresh selection on a live catalog is not stale.
  const live = await fixture();
  await live.store.saveSettings({ tenantId, projectId, expectedVersion: 0, choice: { mode: "selected",
    workerId: "worker:chief", workerKind: "codex", modelKey: "model:plan", effort: "high" } });
  assert.equal((await live.service.readSettings(identity, projectId)).choiceStale, false);
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
  const failed = await fixture({ result: { status: "planner_failed", reasonCode: "planner_run_failed", failureCount: 1,
    startsWork: false, grantsExecutionAuthority: false } }).service.describe(identity, projectId,
    { description: "Prepare it" }, "request:test-0003");
  assert.deepEqual(failed.status === "failed" ? [failed.needsYou, failed.message.includes("Needs-you")] : [], [true, true]);
  const stopped = await fixture({ result: { status: "stopped", startsWork: false, grantsExecutionAuthority: false } }).service
    .describe(identity, projectId, { description: "Prepare it" }, "request:test-0004");
  assert.equal(stopped.status, "stopped");
});

/** F3: `allowance_refused` is the status every describe returns until S7b lands, so
 * it must name the cause. The catch-all copy ("check the wording") is advice that
 * cannot possibly help for an allowance that is not configured. */
test("an allowance refusal names the cause and is announced, not the catch-all", async () => {
  for (const [reasonCode, expected] of [
    ["planner_allowance_not_configured", /No planning allowance is configured/],
    ["allowance_exhausted", /used its planning allowance/]] as const) {
    const f = fixture({ result: { status: "allowance_refused", reasonCode, startsWork: false,
      grantsExecutionAuthority: false } });
    const value = await f.service.describe(identity, projectId, { description: "Prepare it" }, "request:allowance-0001");
    assert.equal(value.status, "refused");
    if (value.status !== "refused") throw new Error("unreachable");
    assert.equal(value.allowanceRefused, true, "an allowance refusal is announced");
    assert.match(value.message, expected);
    assert.doesNotMatch(value.message, /Check the wording/, "the allowance copy is not the catch-all's");
  }
  // A non-allowance refusal keeps the catch-all and is NOT announced as a budget
  // problem, so the owner is not told about an allowance that is fine.
  const other = await fixture({ result: { status: "refused", reasonCode: "planner_reply_capability_invalid",
    startsWork: false, grantsExecutionAuthority: false } }).service.describe(identity, projectId,
    { description: "Prepare it" }, "request:refused-0001");
  assert.equal(other.status, "refused");
  if (other.status !== "refused") throw new Error("unreachable");
  assert.equal(other.allowanceRefused, false);
  assert.match(other.message, /Check the wording/);
});

/** F6: with no planner host, describe is refused as unavailable rather than run
 * and failing. The stored choice still reads and saves, so nothing is lost. */
test("without a composed planner, describe is not_found and settings still work", async () => {
  const f = fixture({ describeAvailable: false });
  const settings = await f.service.readSettings(identity, projectId);
  assert.equal(settings.describeAvailable, false);
  const saved = await f.service.saveSettings(identity, projectId, { expectedVersion: 0, choice: { mode: "selected",
    workerId: "worker:chief", workerKind: "codex", modelKey: "model:plan", effort: "high" } });
  assert.equal(saved.version, 1);
  await assert.rejects(f.service.describe(identity, projectId, { description: "Prepare it" }, "request:noplanner-0001"),
    /not_found/);
  assert.deepEqual(f.calls, [], "the coordinator is never reached without a planner host");
});

/** M9/M10: the adapter refuses a coordinator principal that is not an agent of
 * this tenant, and refuses an access result that names another tenant. */
test("construction refuses a human or foreign-tenant coordinator principal, and a cross-tenant access result", async () => {
  assert.throws(() => createProjectOrchestrationOwnerAdapterV1({ tenantId, coordinatorPrincipal: { ...agent,
    actorType: "human" as const }, coordinator: { async coordinateInitial() { throw new Error("zzz"); },
    ownerPrefill: () => { throw new Error("zzz"); } },
    store: new InMemoryProjectOrchestrationStoreV1(tenantId), queueCatalog: catalog, describeAvailable: true,
    access: { async owner() { return { tenantId, ownerIdentityId: "identity:owner" }; } },
    batches: { async read() { return { revision: 2, revisionDigest, state: "proposed" }; } } }),
    /project_orchestration_configuration_invalid/);
  assert.throws(() => createProjectOrchestrationOwnerAdapterV1({ tenantId, coordinatorPrincipal: { ...agent,
    tenantId: "tenant:other" }, coordinator: { async coordinateInitial() { throw new Error("zzz"); },
    ownerPrefill: () => { throw new Error("zzz"); } },
    store: new InMemoryProjectOrchestrationStoreV1(tenantId), queueCatalog: catalog, describeAvailable: true,
    access: { async owner() { return { tenantId, ownerIdentityId: "identity:owner" }; } },
    batches: { async read() { return { revision: 2, revisionDigest, state: "proposed" }; } } }),
    /project_orchestration_configuration_invalid/);
  // A cross-tenant access result is refused on every operation, not just a write.
  const foreign = fixture({ access: { async owner() { return { tenantId: "tenant:other", ownerIdentityId: "identity:owner" }; } } });
  await assert.rejects(foreign.service.readSettings(identity, projectId), /access_denied/);
  await assert.rejects(foreign.service.saveSettings(identity, projectId, { expectedVersion: 0, choice: { mode: "none" } }),
    /access_denied/);
  await assert.rejects(foreign.service.describe(identity, projectId, { description: "x" }, "request:foreign-0001"),
    /access_denied/);
  await assert.rejects(foreign.service.listSuggestions(identity, projectId, batchId), /access_denied/);
  await assert.rejects(foreign.service.useSuggestion(identity, projectId, batchId, "suggestion:1", 2), /access_denied/);
  await assert.rejects(foreign.service.dismissSuggestion(identity, projectId, batchId, "suggestion:1", 2), /access_denied/);
});

test("suggestion use only returns an immutable prefill; stale use refuses and a decided batch shows none", async () => {
  const f = fixture({ withDismissals: true });
  const current = await seedSuggestion(f.store, "resplit:test");
  await seedSuggestion(f.store, "resplit:stale", 1, `sha256:${"c".repeat(64)}`);
  const page = await f.service.listSuggestions(identity, projectId, batchId) as { suggestions: Array<{ suggestionId: string }> };
  assert.equal(page.suggestions.length, 1);
  const suggestionId = page.suggestions[0]!.suggestionId;
  const prefill = await f.service.useSuggestion(identity, projectId, batchId, suggestionId, 2);
  assert.equal(prefill.savesRevision, false); assert.equal(prefill.startsWork, false);
  assert.equal(Object.isFrozen(prefill.proposal.tasks), true);
  await assert.rejects(f.service.useSuggestion(identity, projectId, batchId, "suggestion:missing", 2), /not_found/);
  await assert.rejects(f.service.useSuggestion(identity, projectId, batchId, suggestionId, 1), /conflict/);
  const decided = fixture({ batchState: "not_proposed", withDismissals: true });
  await seedSuggestion(decided.store, "resplit:decided");
  const decidedPage = await decided.service.listSuggestions(identity, projectId, batchId) as { suggestions: unknown[] };
  assert.equal(decidedPage.suggestions.length, 0);
  assert.ok(current);
});

/** M8: the prefill is a deep clone of a FROZEN stored proposal. Mutating what the
 * caller received must not reach the store, and the stored object must not be
 * reachable in mutable form at all. */
test("the prefill is a deep clone: mutating it cannot reach the stored proposal", async () => {
  const f = fixture({ withDismissals: true });
  await seedSuggestion(f.store, "resplit:clone");
  const id = (await f.service.listSuggestions(identity, projectId, batchId) as { suggestions: Array<{ suggestionId: string }> })
    .suggestions[0]!.suggestionId;
  const first = await f.service.useSuggestion(identity, projectId, batchId, id, 2);
  // A strict-mode assignment to a frozen field would throw; the assertion below is
  // about the STORE, so read it back through a fresh use and compare content.
  assert.throws(() => { (first.proposal as { tasks: unknown[] }).tasks.push({ hacked: true }); }, TypeError);
  const second = await f.service.useSuggestion(identity, projectId, batchId, id, 2);
  assert.equal(second.proposal.tasks.length, 1, "the stored proposal still has exactly its own task");
  assert.equal(second.proposal.tasks[0]!.localId, "plan");
  // The record the store hands back is frozen too, so a caller mutating it in place
  // cannot corrupt what a later read returns.
  const stored = await f.store.listSuggestions({ tenantId, projectId, batchId });
  assert.equal(Object.isFrozen(stored[0]!.proposal.tasks[0]), true);
  assert.throws(() => { (stored[0]!.proposal.tasks as unknown[]).length = 0; }, TypeError);
});

/** M6: the dismiss path's current-state/revision check, at the adapter AND at the
 * store. Each is deleted in turn by the mutation run below. */
test("dismiss refuses a stale expected revision, and is refused entirely with no durable record", async () => {
  const f = fixture({ withDismissals: true });
  await seedSuggestion(f.store, "resplit:dismiss");
  const id = (await f.service.listSuggestions(identity, projectId, batchId) as { suggestions: Array<{ suggestionId: string }> })
    .suggestions[0]!.suggestionId;
  await assert.rejects(f.service.dismissSuggestion(identity, projectId, batchId, id, 1), /conflict/);
  assert.equal((await f.service.listSuggestions(identity, projectId, batchId) as { suggestions: unknown[] }).suggestions.length, 1,
    "a refused dismissal changes nothing");
  await f.service.dismissSuggestion(identity, projectId, batchId, id, 2);
  assert.equal((await f.service.listSuggestions(identity, projectId, batchId) as { suggestions: unknown[] }).suggestions.length, 0);
  // Without a dismissal record the gesture is refused rather than silently lost.
  const noRecord = fixture();
  await seedSuggestion(noRecord.store, "resplit:norecord");
  const noId = (await noRecord.service.listSuggestions(identity, projectId, batchId) as { suggestions: Array<{ suggestionId: string }> })
    .suggestions[0]!.suggestionId;
  assert.equal((await noRecord.service.readSettings(identity, projectId)).dismissAvailable, false);
  await assert.rejects(noRecord.service.dismissSuggestion(identity, projectId, batchId, noId, 2), /not_found/);
  assert.equal((await noRecord.service.listSuggestions(identity, projectId, batchId) as { suggestions: unknown[] }).suggestions.length, 1,
    "a refused dismissal leaves the card visible rather than pretending it is gone");
});

test("dismiss is idempotent, and use-after-dismiss is refused", async () => {
  const f = fixture({ withDismissals: true });
  await seedSuggestion(f.store, "resplit:twice");
  const id = (await f.service.listSuggestions(identity, projectId, batchId) as { suggestions: Array<{ suggestionId: string }> })
    .suggestions[0]!.suggestionId;
  await f.service.dismissSuggestion(identity, projectId, batchId, id, 2);
  await f.service.dismissSuggestion(identity, projectId, batchId, id, 2);
  await assert.rejects(f.service.useSuggestion(identity, projectId, batchId, id, 2), /owner_required/);
  assert.equal((await f.service.listSuggestions(identity, projectId, batchId) as { suggestions: unknown[] }).suggestions.length, 0);
});

/** M12/M13: a retained request may only be retried, never replaced with a
 * different description, and forgetting it sends nothing. */
test("browser retry reuses the exact body and key; a different body is refused; forgetting sends nothing", async () => {
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
  await assert.rejects(client.describe(projectId, "Something else entirely"), /uncertain/);
  assert.equal((await client.retryDescription()).status, "proposal");
  assert.equal(requests[0]?.body, requests[1]?.body); assert.equal(requests[0]?.key, requests[1]?.key);

  // F8: the escape hatch releases the hold WITHOUT sending anything.
  const heldRequests: Array<BodyInit | null | undefined> = [];
  let dropped = true;
  const held = createProjectOrchestrationBrowserClient((async (_input: RequestInfo | URL, init?: RequestInit) => {
    heldRequests.push(init?.body);
    if (dropped) { dropped = false; throw new Error("dropped response"); }
    return Response.json({ status: "proposal", batchId, href: "/batch", startsWork: false,
      grantsExecutionAuthority: false });
  }) as typeof fetch, () => "request:held-0001");
  await assert.rejects(held.describe(projectId, "First attempt"), /uncertain/);
  assert.equal(heldRequests.length, 1);
  held.forgetPendingDescription();
  assert.equal(held.hasPendingDescription(), false);
  assert.equal(heldRequests.length, 1, "forgetting sends nothing");
  // A NEW description can now be started, and it is a new request, not a second
  // attempt at the old one.
  assert.equal((await held.describe(projectId, "Second attempt")).status, "proposal");
  assert.equal(heldRequests.length, 2);
  assert.notEqual(heldRequests[1], heldRequests[0]);
});

test("owner HTTP routes keep description, settings and suggestion gestures separate", async () => {
  const calls: string[] = [];
  const service: ProjectOrchestrationOwnerPortV1 = {
    async readSettings(_identity, value) { calls.push(`settings:read:${value}`); return fixture().service.readSettings(identity, value); },
    async saveSettings(_identity, value) { calls.push(`settings:save:${value}`); return fixture().service.readSettings(identity, value); },
    async describe(_identity, value, body, key) { calls.push(`describe:${value}:${key}:${(body as { description: string }).description}`);
      return { status: "proposal", batchId, href: "/batch", startsWork: false, grantsExecutionAuthority: false }; },
    async listSuggestions(_identity, value, batch) { calls.push(`suggestions:list:${value}:${batch}`);
      return { projectId: value, batchId: batch, suggestions: [], dismissAvailable: true, startsWork: false,
        grantsExecutionAuthority: false }; },
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
  // F7: describe is 200 for EVERY outcome, including a failure or a refusal. A 201
  // on `status: "failed"` claimed a proposal existed when none did.
  assert.equal((await request(`/api/v1/projects/${encodeURIComponent(projectId)}/orchestration`, "POST",
    { description: "Prepare it" }, "request:http-0001")).status, 200);
  const base = `/api/v1/projects/${encodeURIComponent(projectId)}/pipelines/${encodeURIComponent(batchId)}/suggestions`;
  assert.equal((await request(base)).status, 200);
  assert.equal((await request(`${base}/${encodeURIComponent("suggestion:test")}/use`, "POST", { expectedRevision: 2 })).status, 200);
  assert.equal((await request(`${base}/${encodeURIComponent("suggestion:test")}/dismiss`, "POST", { expectedRevision: 2 })).status, 204);
  assert.equal((await request(`${base}/${encodeURIComponent("suggestion:test")}/use`, "POST", { expectedRevision: 0 })).status, 400);
  // M20: only POST is allowed on the describe route.
  assert.equal((await request(`/api/v1/projects/${encodeURIComponent(projectId)}/orchestration`)).status, 400);
  assert.equal((await request(`/api/v1/projects/${encodeURIComponent(projectId)}/orchestration`, "PUT",
    { description: "Prepare it" }, "request:http-0002")).status, 400);
  assert.equal((await request(`/api/v1/projects/${encodeURIComponent(projectId)}/orchestration`, "DELETE")).status, 400);
  assert.equal((await request(`/api/v1/projects/${encodeURIComponent(projectId)}/orchestration?x=1`, "POST",
    { description: "Prepare it" }, "request:http-0003")).status, 400);
  assert.deepEqual(calls, [`settings:read:${projectId}`, `settings:save:${projectId}`,
    `describe:${projectId}:request:http-0001:Prepare it`, `suggestions:list:${projectId}:${batchId}`,
    `suggestions:use:${projectId}:${batchId}:suggestion:test:2`,
    `suggestions:dismiss:${projectId}:${batchId}:suggestion:test:2`],
    "every refused request reached no service method");
});

/** F5: the character limit and the transport limit must agree. A legal 16,000
 * character CJK description is ~48,000 bytes and was refused at the transport with
 * a 400 the browser could only render as "check the description". */
test("a 16,000-character multi-byte description reaches the coordinator, not the transport", async () => {
  // The REAL service, so the wire schema's own length bound is what refuses the
  // over-limit body. The coordinator is the counting seam: `base.calls` grows only
  // when a description survived both the transport byte bound and the wire schema.
  const base = fixture();
  const local = { profile: { origin: "http://127.0.0.1:3210" }, assertLocalRequest() {},
    verify() { return identity; } } as unknown as LocalOwnerSessionServiceV1;
  const handle = createProjectOrchestrationHttpHandlerV1({ origin: "http://127.0.0.1:3210",
    service: base.service, localOwnerSession: local });
  const countedCalls = () => base.calls.length;
  // A DISTINCT key per request, because the coordinator's single-flight refuses a
  // replay whose content differs under one key -- which is exactly right, and is
  // not what this test is about.
  let sequence = 0;
  const post = (description: string) => handle(new Request(
    `http://127.0.0.1:3210/api/v1/projects/${encodeURIComponent(projectId)}/orchestration`, { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `request:length-${++sequence}-0001` },
    body: JSON.stringify({ description }) }));
  const cjk = "あ".repeat(PROJECT_ORCHESTRATION_DESCRIPTION_LIMIT_V1);
  assert.ok(Buffer.byteLength(JSON.stringify({ description: cjk }), "utf8") > 32_768,
    "this description really does exceed the old 32,768-byte transport bound");
  assert.equal((await post(cjk)).status, 200);
  assert.equal(countedCalls(), 1, "a legal multi-byte description reached the coordinator");
  // Astral-plane text is 4 BYTES per code point but 2 UTF-16 code units, and the
  // limit counts code units -- the same unit the browser's own maxLength attribute
  // counts. A 16,000-code-point emoji string is therefore 32,000 units and IS over
  // the limit; the textarea could not have produced it. Asserting the unit here is
  // the point: the two bounds cannot disagree because they are the same unit.
  const emoji = "\u{1F642}".repeat(PROJECT_ORCHESTRATION_DESCRIPTION_LIMIT_V1);
  assert.equal(emoji.length, 2 * PROJECT_ORCHESTRATION_DESCRIPTION_LIMIT_V1, "astral text is 2 code units each");
  assert.ok(Buffer.byteLength(emoji, "utf8") > 48_000);
  assert.equal((await post(emoji)).status, 400, "over the code-unit limit, refused by the wire");
  assert.equal(countedCalls(), 1);
  // 8,000 emoji is 16,000 code units and 32,000 bytes: legal, and over the old
  // 32,768-byte body bound only once the JSON envelope is counted, which is why
  // the transport bound had to move at all.
  const legalEmoji = "\u{1F642}".repeat(PROJECT_ORCHESTRATION_DESCRIPTION_LIMIT_V1 / 2);
  assert.equal(legalEmoji.length, PROJECT_ORCHESTRATION_DESCRIPTION_LIMIT_V1);
  assert.equal((await post(legalEmoji)).status, 200);
  assert.equal(countedCalls(), 2, "a legal astral-plane description reached the coordinator");
  // One code unit past the limit is still refused, by the wire schema and not by
  // the transport, so the browser's message about length is the accurate one.
  assert.equal((await post("x".repeat(PROJECT_ORCHESTRATION_DESCRIPTION_LIMIT_V1 + 1))).status, 400);
  assert.equal(countedCalls(), 2, "an over-limit description never reaches the coordinator");
  // A body far beyond any of this is still refused, bounded rather than buffered.
  assert.equal((await post("x".repeat(200_000))).status, 400);
  assert.equal(countedCalls(), 2);
});

test("a burst of 40 owner requests stays bounded to 40 coordinator calls and returns exact links", async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 40 }, (_, index) => f.service.describe(identity, projectId,
    { description: `Prepare bounded job ${index}` }, `request:burst-${String(index).padStart(4, "0")}`)));
  assert.equal(f.calls.length, 40); assert.equal(results.every(result => result.status === "proposal"), true);
});