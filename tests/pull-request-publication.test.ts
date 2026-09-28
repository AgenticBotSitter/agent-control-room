import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexWorkspaceManagerV1 } from "../src/harness/codex-v1/workspace";
import type { ObservableGitWorkspacePort } from "../src/harness/codex-v1/git-workspace-port";
import { createControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { createControllerDeliveryWorktreeChangeAuditPlanV1,
  createWorktreeChangeAuditEvidenceV1 } from "../src/harness/v1/worktree-change-audit";
import { createAuthenticatedModelSelectionV1, createAuthenticatedPublicationDeliveryV1, createPullRequestOpenPortV1,
  createPullRequestPublicationPlanV1, createPullRequestPublisherV1,
  type DurablePullRequestPublicationStoreV1, verifyPullRequestPublicationEvidenceV1 }
  from "../src/harness/v1/pull-request-publication";
import { canonicalJson, sha256Digest } from "../src/security";
import { composeBuildStagePullRequestPublicationV1 }
  from "../src/harness/codex-v1/build-stage-pull-request-publication";
import { createManagedWorktreeChangeAuditAuthorityV1 }
  from "../src/harness/v1/worktree-change-audit-authority";
import { SqliteBridgeJournal } from "../src/node-bridge/journal";
import { SqlitePullRequestPublicationStoreV1 }
  from "../src/harness/codex-v1/sqlite-pull-request-publication-store";

const key = new Uint8Array(32).fill(71), base = "a".repeat(40), head = "b".repeat(40);
const repositoryUrl = "https://example.invalid/controller/repository";
const publicationContent = { title: "Bounded change", body: "Retained evidence." };
const retainedResultDigest = sha256Digest("retained-build-result");
const delivery = createControllerWorkerDeliveryV1({ identity: { tenantId: "tenant:test", projectId: "project:test",
  jobId: "job:test", attemptId: "attempt:test", runId: "run:test", nodeId: "node:test" },
worker: { workerId: "worker:builder", adapterId: "adapter:test", adapterRevision: "1234567" },
input: { prompt: "Build one bounded change.", instructions: "Commit the result." },
authorityDigest: sha256Digest("authority"), connectorProfileDigest: sha256Digest("profile"),
acceptanceProfileId: "profile:test", acceptanceProfileDigest: sha256Digest("acceptance"),
issuedAt: "2026-09-27T00:00:00.000Z", expiresAt: "2026-09-27T01:00:00.000Z" });

class MemoryStore implements DurablePullRequestPublicationStoreV1 {
  readonly rows = new Map<string, unknown>();
  failReplace = false;
  async load(id: string) { return structuredClone(this.rows.get(id)); }
  async reserve(id: string, value: unknown) { if (this.rows.has(id)) return "exists" as const;
    this.rows.set(id, structuredClone(value)); return "reserved" as const; }
  async replace(id: string, expected: unknown, value: unknown) {
    if (this.failReplace || canonicalJson(this.rows.get(id)) !== canonicalJson(expected)) return false;
    this.rows.set(id, structuredClone(value)); return true;
  }
}

async function fixture() {
  const repository = "/fixture/repository", workspace = "/fixture/workspaces";
  const identities = { repository: { realPath: repository, device: "1", inode: "2" },
    workspace: { realPath: workspace, device: "1", inode: "3" },
    commonGit: { realPath: `${repository}/.git`, device: "1", inode: "4" } };
  let checkout = "";
  const port: ObservableGitWorkspacePort = {
    async inspectRootIdentities() { return structuredClone(identities); },
    async observeCheckout() { return { state: "preserve" }; },
    async inspectExisting(path) { if (path === repository) return identities.repository;
      if (path === workspace) return identities.workspace;
      return { realPath: path, device: "1", inode: "5" }; },
    async createDetachedWorktree(input) { checkout = input.checkoutPath; return { realPath: checkout,
      repositoryRealPath: repository, headRevision: input.revision, device: "1", inode: "5" }; },
    async removeWorktree() {},
  };
  const manager = new CodexWorkspaceManagerV1(port);
  const lease = await manager.prepare({ deliveryDigest: delivery.deliveryDigest, runId: delivery.identity.runId,
    repositoryRoot: repository, workspaceRoot: workspace, revision: base });
  const auditPlan = createControllerDeliveryWorktreeChangeAuditPlanV1({ delivery, lease,
    allowedPaths: ["src/**"], maximumChangedFiles: 2, maximumChangedBytes: 1024 });
  const auditAuthority = createManagedWorktreeChangeAuditAuthorityV1({ workspaceManager: manager,
    allowedPaths: ["src/**"], maximumChangedFiles: 2, maximumChangedBytes: 1024 });
  const auditEvidence = createWorktreeChangeAuditEvidenceV1(auditPlan, { baseRevision: base, headRevision: head,
    changes: [{ path: "src/change.ts", kind: "modified", bytes: 8, contentDigest: sha256Digest("content") }] });
  const authenticatedModelSelection = createAuthenticatedModelSelectionV1(key, delivery,
    { workerId: "worker:builder", model: "model:builder", effort: "high" });
  const authenticatedDelivery = createAuthenticatedPublicationDeliveryV1(key, delivery);
  const runGit = async (_cwd: string, args: readonly string[]) => Buffer.from(args.includes("status") ? "" : `${head}\n`);
  const plan = await createPullRequestPublicationPlanV1({ integrityKey: key, workspaceManager: manager,
    workspacePort: port, authenticatedDelivery, lease, auditAuthority, auditPlan, auditEvidence, authenticatedModelSelection,
    retainedResultDigest, repositoryUrl, publicationContent, runGit });
  return { manager, port, lease, auditAuthority, auditPlan, auditEvidence,
    authenticatedDelivery, authenticatedModelSelection, runGit, plan };
}

test("authenticated plan and durable result bind URL, exact commit, model and unknown usage across restart", async () => {
  const f = await fixture(), store = new MemoryStore(); let calls = 0;
  const port = createPullRequestOpenPortV1(async input => { calls++; assert.equal(input.commitDigest, head);
    return { status: "opened", url: `${repositoryUrl}/pull/17`, observedCommit: head }; });
  const first = await createPullRequestPublisherV1({ integrityKey: key, plan: f.plan,
    publicationContent, port, store, assertCurrent: () => {} }).publish();
  assert.equal(first.status, "published");
  if (first.status !== "published") return;
  assert.equal(first.evidence.usage, "unknown"); assert.equal(first.evidence.commitDigest, head);
  assert.deepEqual(first.evidence.modelSelection, { workerId: "worker:builder", model: "model:builder", effort: "high" });
  assert.deepEqual(verifyPullRequestPublicationEvidenceV1(first.evidence, f.plan, key), first.evidence);
  const restarted = createPullRequestPublisherV1({ integrityKey: key, plan: f.plan,
    publicationContent, port: createPullRequestOpenPortV1(async () => { calls++; throw new Error("must_not_open"); }),
    store, assertCurrent: () => {} });
  assert.deepEqual(await restarted.publish(), first);
  assert.equal(calls, 1);
});

test("pending intent survives ambiguous effect and success-before-record crash without reopening", async () => {
  for (const mode of ["throw", "lost-record"] as const) {
    const f = await fixture(), store = new MemoryStore(); let calls = 0;
    if (mode === "lost-record") store.failReplace = true;
    const publisher = createPullRequestPublisherV1({ integrityKey: key, plan: f.plan,
      publicationContent, port: createPullRequestOpenPortV1(async () => { calls++; if (mode === "throw") throw new Error("response_lost");
        return { status: "opened", url: `${repositoryUrl}/pull/18`, observedCommit: head }; }), store,
      assertCurrent: () => {} });
    assert.deepEqual(await publisher.publish(), { status: "reconciliation_required" });
    store.failReplace = false;
    const restarted = createPullRequestPublisherV1({ integrityKey: key, plan: f.plan,
      publicationContent, port: createPullRequestOpenPortV1(async () => { calls++; return { status: "ambiguous" }; }),
      store, assertCurrent: () => {} });
    assert.deepEqual(await restarted.publish(), { status: "reconciliation_required" });
    assert.equal(calls, 1);
  }
});

test("authority loss after durable reservation prevents the open effect and burns retry", async () => {
  const f = await fixture(), backing = new MemoryStore(); let current = true, calls = 0;
  const store: DurablePullRequestPublicationStoreV1 = {
    load: id => backing.load(id),
    async reserve(id, value) { const result = await backing.reserve(id, value); current = false; return result; },
    replace: (id, expected, value) => backing.replace(id, expected, value),
  };
  const publisher = createPullRequestPublisherV1({ integrityKey: key, plan: f.plan, publicationContent,
    port: createPullRequestOpenPortV1(async () => { calls++; return { status: "ambiguous" }; }), store,
    assertCurrent: () => { if (!current) throw new Error("revoked"); } });
  await assert.rejects(publisher.publish(), /revoked/);
  assert.equal(calls, 0);
  const replay = createPullRequestPublisherV1({ integrityKey: key, plan: f.plan, publicationContent,
    port: createPullRequestOpenPortV1(async () => { calls++; return { status: "ambiguous" }; }), store,
    assertCurrent: () => {} });
  assert.deepEqual(await replay.publish(), { status: "reconciliation_required" });
  assert.equal(calls, 0);
});

test("tampered plan/model and prototype, non-enumerable, or symbol capability forgeries are refused", async () => {
  const f = await fixture(), store = new MemoryStore();
  assert.throws(() => createPullRequestPublisherV1({ integrityKey: key,
    plan: { ...f.plan, commitDigest: "c".repeat(40) }, publicationContent,
    port: createPullRequestOpenPortV1(async () => ({ status: "ambiguous" })), store,
    assertCurrent: () => {} }), /unavailable/);
  const symbol = Symbol("merge"), forged = Object.create({ merge() {} });
  Object.defineProperty(forged, "open", { value: () => ({ status: "ambiguous" }), enumerable: false });
  Object.defineProperty(forged, symbol, { value: () => undefined });
  assert.throws(() => createPullRequestPublisherV1({ integrityKey: key, plan: f.plan,
    publicationContent, port: forged, store, assertCurrent: () => {} } as never), /unavailable/);
  assert.throws(() => createPullRequestPublisherV1({ integrityKey: key, plan: f.plan,
    publicationContent: { ...publicationContent, body: "substituted" },
    port: createPullRequestOpenPortV1(async () => ({ status: "ambiguous" })), store,
    assertCurrent: () => {} }), /unavailable/);
  await assert.rejects(createPullRequestPublicationPlanV1({ integrityKey: key, workspaceManager: f.manager,
    workspacePort: f.port, authenticatedDelivery: f.authenticatedDelivery, lease: f.lease,
    auditAuthority: f.auditAuthority, auditPlan: f.auditPlan, auditEvidence: f.auditEvidence,
    authenticatedModelSelection: { ...f.authenticatedModelSelection,
      modelSelection: { ...f.authenticatedModelSelection.modelSelection, model: "substituted" } },
    retainedResultDigest, repositoryUrl, publicationContent, runGit: f.runGit }), /unavailable/);
});

test("a clean intervening commit cannot reuse an earlier change inventory", async () => {
  const f = await fixture();
  await assert.rejects(createPullRequestPublicationPlanV1({ integrityKey: key, workspaceManager: f.manager,
    workspacePort: f.port, authenticatedDelivery: f.authenticatedDelivery, lease: f.lease,
    auditAuthority: f.auditAuthority, auditPlan: f.auditPlan, auditEvidence: f.auditEvidence,
    authenticatedModelSelection: f.authenticatedModelSelection, retainedResultDigest, repositoryUrl, publicationContent,
    runGit: async (_cwd, args) => Buffer.from(args.includes("status") ? "" : `${"c".repeat(40)}\n`) }),
  /unavailable/);
});

test("a recomputed digest cannot forge the retained pull request URL", async () => {
  const f = await fixture(), store = new MemoryStore();
  const published = await createPullRequestPublisherV1({ integrityKey: key, plan: f.plan, publicationContent,
    port: createPullRequestOpenPortV1(async () => ({ status: "opened", url: `${repositoryUrl}/pull/21`,
      observedCommit: head })), store, assertCurrent: () => {} }).publish();
  assert.equal(published.status, "published");
  if (published.status !== "published") return;
  const { evidenceDigest: _digest, authenticationTag, ...material } = published.evidence;
  const forged = { ...material, url: `${repositoryUrl}/pull/22` };
  assert.throws(() => verifyPullRequestPublicationEvidenceV1({ ...forged,
    evidenceDigest: sha256Digest(forged), authenticationTag }, f.plan, key), /unavailable/);
});

test("SQLite retains the exact published result across a real journal restart without reopening", async t => {
  const root = await mkdtemp(join(tmpdir(), "acr-s6-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "bridge.sqlite"), f = await fixture(); let calls = 0;
  let journal = new SqliteBridgeJournal(path);
  let store = new SqlitePullRequestPublicationStoreV1(journal);
  const first = await createPullRequestPublisherV1({ integrityKey: key, plan: f.plan, publicationContent,
    port: createPullRequestOpenPortV1(async () => { calls++; return { status: "opened",
      url: `${repositoryUrl}/pull/23`, observedCommit: head }; }), store, assertCurrent: () => {} }).publish();
  assert.equal(first.status, "published");
  assert.ok(store.retainedForDelivery(delivery.deliveryDigest));
  journal.close();

  journal = new SqliteBridgeJournal(path);
  store = new SqlitePullRequestPublicationStoreV1(journal);
  const replay = await createPullRequestPublisherV1({ integrityKey: key, plan: f.plan, publicationContent,
    port: createPullRequestOpenPortV1(async () => { calls++; throw new Error("must_not_reopen"); }), store,
    assertCurrent: () => {} }).publish();
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
  assert.ok(store.retainedForDelivery(delivery.deliveryDigest));
  journal.close();
});

test("SQLite restart after a lost publication response stays reconciliation-only", async t => {
  const root = await mkdtemp(join(tmpdir(), "acr-s6-publication-ambiguous-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "bridge.sqlite"), f = await fixture(); let calls = 0;
  let journal = new SqliteBridgeJournal(path);
  let store = new SqlitePullRequestPublicationStoreV1(journal);
  const first = await createPullRequestPublisherV1({ integrityKey: key, plan: f.plan, publicationContent,
    port: createPullRequestOpenPortV1(async () => { calls++; throw new Error("lost_response"); }), store,
    assertCurrent: () => {} }).publish();
  assert.deepEqual(first, { status: "reconciliation_required" });
  journal.close();

  journal = new SqliteBridgeJournal(path);
  store = new SqlitePullRequestPublicationStoreV1(journal);
  const replay = await createPullRequestPublisherV1({ integrityKey: key, plan: f.plan, publicationContent,
    port: createPullRequestOpenPortV1(async () => { calls++; return { status: "ambiguous" }; }), store,
    assertCurrent: () => {} }).publish();
  assert.deepEqual(replay, { status: "reconciliation_required" });
  assert.equal(calls, 1);
  journal.close();
});

test("build-stage composition inventories the committed tree and retains publication evidence", async () => {
  const f = await fixture(), store = new MemoryStore();
  const git = async (_cwd: string, args: readonly string[]) => {
    if (args.includes("status")) return Buffer.from("");
    if (args.includes("diff")) return Buffer.from("M\0src/change.ts\0");
    if (args.includes("cat-file") && args.includes("-s")) return Buffer.from("8\n");
    if (args.includes("cat-file") && args.includes("blob")) return Buffer.from("content\n");
    if (args.includes("--verify")) return Buffer.from(`${"c".repeat(40)}\n`);
    return Buffer.from(`${head}\n`);
  };
  const material = { deliveryDigest: delivery.deliveryDigest, stageKind: "build" as const, retainedResultDigest,
    modelSelection: { workerId: "worker:builder", model: "model:builder", effort: "high" },
    repositoryUrl, ...publicationContent };
  const current = { ...material, authorityDigest: sha256Digest(material) };
  const composed = await composeBuildStagePullRequestPublicationV1({ integrityKey: key,
    workspaceManager: f.manager, workspacePort: f.port, delivery, lease: f.lease,
    auditPlan: f.auditPlan, auditAuthority: f.auditAuthority,
    publicationAuthority: { current: () => current, assertCurrent: value => assert.deepEqual(value, current) },
    runGit: git, store, openPullRequest: async () => ({ status: "opened",
      url: `${repositoryUrl}/pull/19`, observedCommit: head }) });
  assert.equal(composed.auditEvidence.changes.length, 1);
  const published = await composed.publish();
  assert.equal(published.status, "published");
});
