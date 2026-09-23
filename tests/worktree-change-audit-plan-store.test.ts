import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { CodexWorkspaceManagerV1 } from "../src/harness/codex-v1/workspace";
import { createManagedWorktreeChangeAuditAuthorityV1 } from "../src/harness/v1/worktree-change-audit-authority";
import { createControllerWorkerDeliveryV1, type ControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { persistControllerWorkerDeliveryReceiptV1 } from "../src/harness/v1/controller-worker-delivery-receipt-store";
import { persistManagedWorktreeChangeAuditPlanV1 } from "../src/harness/v1/worktree-change-audit-plan-store";
import { sha256Digest } from "../src/security";
import { at, nativeTaskFixture, registration } from "./native-task-fixture";
import { binding, input } from "./hermes-native-fixture";

const key = new Uint8Array(32).fill(53);
const revision = "a".repeat(40);
const packet = (): ControllerWorkerDeliveryV1 => createControllerWorkerDeliveryV1({
  identity: { tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId,
    attemptId: binding.attemptId, runId: registration.id, nodeId: binding.nodeId },
  worker: { workerId: "worker:codex", adapterId: "connector:codex-fixture", adapterRevision: "0000001" },
  input: { prompt: input.prompt, instructions: input.instructions }, authorityDigest: sha256Digest("authority"),
  connectorProfileDigest: sha256Digest("profile"), acceptanceProfileId: "profile:one",
  acceptanceProfileDigest: sha256Digest("acceptance"), issuedAt: at(1000), expiresAt: at(120_000),
});
const receipt = (delivery: ControllerWorkerDeliveryV1, disposition: "accepted" | "rejected" = "accepted") => {
  const material = { schema: "control-room.controller-worker-delivery-receipt/v1" as const,
    deliveryId: delivery.deliveryId, deliveryDigest: delivery.deliveryDigest, workerId: delivery.worker.workerId,
    route: { kind: "local" as const, workerId: delivery.worker.workerId }, receivedAt: at(2000),
    disposition, startsWork: false as const, grantsExecutionAuthority: false as const };
  return { ...material, receiptDigest: sha256Digest(material) };
};
function manager() {
  return new CodexWorkspaceManagerV1({
    inspectExisting: async path => ({ realPath: path, device: "1", inode: path === "/fixture/repo" ? "2" : path === "/fixture/work" ? "3" : "4" }),
    createDetachedWorktree: async ({ repositoryRealPath, checkoutPath, revision: headRevision }) => ({ realPath: checkoutPath, repositoryRealPath, headRevision, device: "1", inode: "4" }),
    removeWorktree: async () => {},
  });
}

async function provisionRun(f: Awaited<ReturnType<typeof nativeTaskFixture>>) {
  await f.db.query(`INSERT INTO control_harness_runs
    (id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,native_session_key_digest,
     parent_run_id,revision_of_run_id,state,last_sequence,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
    VALUES($1,$2,$3,$4,$5,$6,'connector:codex-fixture','codex',$7,NULL,NULL,'discovered',0,$8,$9,'{}'::jsonb,$10,$10,$10)`,
  [registration.id, binding.tenantId, binding.projectId, binding.jobId, binding.attemptId, binding.nodeId,
    sha256Digest("audit-plan-native-session"), sha256Digest("audit-plan-run"),
    `hmac-sha256:${"a".repeat(64)}`, at(0)]);
}

test("only an authenticated controller delivery plus active manager lease can persist an audit plan", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const delivery = packet();
  await provisionRun(f);
  await f.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, key, delivery, receipt(delivery), at(3000)));
  const workspace = manager();
  const lease = await workspace.prepare({ runId: registration.id, repositoryRoot: "/fixture/repo", workspaceRoot: "/fixture/work", revision });
  const authority = createManagedWorktreeChangeAuditAuthorityV1({ workspaceManager: workspace,
    allowedPaths: ["src/**"], maximumChangedFiles: 3, maximumChangedBytes: 4096 });
  await assert.rejects(f.db.transaction(tx => persistManagedWorktreeChangeAuditPlanV1(tx, key, {
    delivery: delivery.identity, lease, authority, recordedAt: at(1500) })), /worktree_change_audit_plan_unavailable/);
  const first = await f.db.transaction(tx => persistManagedWorktreeChangeAuditPlanV1(tx, key, {
    delivery: delivery.identity, lease, authority, recordedAt: at(4000) }));
  assert.equal(first.replayed, false);
  assert.deepEqual(first.plan.allowedPaths, ["src/**"]);
  assert.equal(first.startsWork, false);
  const replay = await f.db.transaction(tx => persistManagedWorktreeChangeAuditPlanV1(tx, key, {
    delivery: delivery.identity, lease, authority, recordedAt: at(4000) }));
  assert.equal(replay.replayed, true);
  const stored = await f.db.query<{ count: string }>("SELECT count(*)::text AS count FROM control_worktree_change_audit_plans");
  assert.equal(stored.rows[0]?.count, "1");
});

test("a rejected delivery receipt can never become a persisted worktree audit plan", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const delivery = packet();
  await provisionRun(f);
  await f.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, key, delivery, receipt(delivery, "rejected"), at(3000)));
  const workspace = manager();
  const lease = await workspace.prepare({ runId: registration.id, repositoryRoot: "/fixture/repo", workspaceRoot: "/fixture/work", revision });
  const authority = createManagedWorktreeChangeAuditAuthorityV1({ workspaceManager: workspace,
    allowedPaths: ["src/**"], maximumChangedFiles: 3, maximumChangedBytes: 4096 });
  await assert.rejects(f.db.transaction(tx => persistManagedWorktreeChangeAuditPlanV1(tx, key, {
    delivery: delivery.identity, lease, authority, recordedAt: at(4000) })), /worktree_change_audit_plan_unavailable/);
  const rows = await f.db.query<{ count: string }>("SELECT count(*)::text AS count FROM control_worktree_change_audit_plans");
  assert.equal(rows.rows[0]?.count, "0");
});

test("a worker cannot register an audit plan from a missing delivery or inactive lease", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const delivery = packet(), workspace = manager();
  const lease = await workspace.prepare({ runId: registration.id, repositoryRoot: "/fixture/repo", workspaceRoot: "/fixture/work", revision });
  const authority = createManagedWorktreeChangeAuditAuthorityV1({ workspaceManager: workspace,
    allowedPaths: ["src/**"], maximumChangedFiles: 3, maximumChangedBytes: 4096 });
  await assert.rejects(f.db.transaction(tx => persistManagedWorktreeChangeAuditPlanV1(tx, key, {
    delivery: delivery.identity, lease, authority, recordedAt: at(4000) })), /worktree_change_audit_plan_unavailable/);
  await f.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, key, delivery, receipt(delivery), at(3000)));
  await workspace.cleanup(lease);
  await assert.rejects(f.db.transaction(tx => persistManagedWorktreeChangeAuditPlanV1(tx, key, {
    delivery: delivery.identity, lease, authority, recordedAt: at(4000) })), /not active/);
});

test("only the evidence role can persist raw audit plans; private web cannot read them", async t => {
  const f = await nativeTaskFixture(); t.after(f.close);
  const delivery = packet(); await provisionRun(f);
  await f.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, key, delivery, receipt(delivery), at(3000)));
  await f.raw.exec(await readFile("db/roles/native_evidence_roles.sql", "utf8"));
  await f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await f.raw.exec(`CREATE ROLE audit_evidence_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE audit_web_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_native_evidence TO audit_evidence_test;
    GRANT control_room_private_web TO audit_web_test`);
  const workspace = manager();
  const lease = await workspace.prepare({ runId: registration.id, repositoryRoot: "/fixture/repo", workspaceRoot: "/fixture/work", revision });
  const authority = createManagedWorktreeChangeAuditAuthorityV1({ workspaceManager: workspace,
    allowedPaths: ["src/**"], maximumChangedFiles: 3, maximumChangedBytes: 4096 });
  await f.db.transaction(async tx => {
    await tx.query("SET LOCAL SESSION AUTHORIZATION audit_evidence_test");
    const saved = await persistManagedWorktreeChangeAuditPlanV1(tx, key, {
      delivery: delivery.identity, lease, authority, recordedAt: at(4000) });
    assert.equal(saved.replayed, false);
  });
  await assert.rejects(f.db.transaction(async tx => {
    await tx.query("SET LOCAL SESSION AUTHORIZATION audit_web_test");
    await tx.query("SELECT record FROM control_worktree_change_audit_plans");
  }));
});
