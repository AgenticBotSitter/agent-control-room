import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { CodexWorkspaceManagerV1 } from "../src/harness/codex-v1/workspace";
import { createManagedWorktreeChangeAuditAuthorityV1 } from "../src/harness/v1/worktree-change-audit-authority";
import { createControllerWorkerDeliveryV1, type ControllerWorkerDeliveryV1 } from "../src/harness/v1/controller-worker-delivery";
import { persistControllerWorkerDeliveryReceiptV1 } from "../src/harness/v1/controller-worker-delivery-receipt-store";
import { persistManagedWorktreeChangeAuditPlanV1 } from "../src/harness/v1/worktree-change-audit-plan-store";
import { persistResultBoundWorktreeChangeAuditRecordV1 } from "../src/harness/v1/worktree-change-audit-record-store";
import { createWorktreeChangeAuditEvidenceV1 } from "../src/harness/v1/worktree-change-audit";
import { buildTaskResultManifestV1 } from "../src/artifacts/v1/durable-result-publication";
import { durableResultArtifactIdV1, durableResultReceiptTagV1 } from "../src/artifacts/v1/durable-result-receipt";
import { sha256Digest } from "../src/security";
import { at, nativeTaskFixture, registration } from "./native-task-fixture";
import { binding, input } from "./hermes-native-fixture";

const key = new Uint8Array(32).fill(59);
const revision = "a".repeat(40);
const packet = (): ControllerWorkerDeliveryV1 => createControllerWorkerDeliveryV1({
  identity: { tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId,
    attemptId: binding.attemptId, runId: registration.id, nodeId: binding.nodeId },
  worker: { workerId: "worker:codex", adapterId: "connector:codex-fixture", adapterRevision: "0000001" },
  input: { prompt: input.prompt, instructions: input.instructions }, authorityDigest: sha256Digest("authority"),
  connectorProfileDigest: sha256Digest("profile"), acceptanceProfileId: "profile:one",
  acceptanceProfileDigest: sha256Digest("acceptance"), issuedAt: at(1000), expiresAt: at(120_000),
});
const receipt = (delivery: ControllerWorkerDeliveryV1) => {
  const material = { schema: "control-room.controller-worker-delivery-receipt/v1" as const,
    deliveryId: delivery.deliveryId, deliveryDigest: delivery.deliveryDigest, workerId: delivery.worker.workerId,
    route: { kind: "local" as const, workerId: delivery.worker.workerId }, receivedAt: at(2000),
    disposition: "accepted" as const, startsWork: false as const, grantsExecutionAuthority: false as const };
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
    sha256Digest("audit-record-native-session"), sha256Digest("audit-record-run"), `hmac-sha256:${"a".repeat(64)}`, at(0)]);
}
async function fixture(receiptOverride?: unknown) {
  const f = await nativeTaskFixture();
  const delivery = packet(); await provisionRun(f);
  await f.db.transaction(tx => persistControllerWorkerDeliveryReceiptV1(tx, key, delivery, receipt(delivery), at(3000)));
  const workspace = manager();
  const lease = await workspace.prepare({ runId: registration.id, repositoryRoot: "/fixture/repo", workspaceRoot: "/fixture/work", revision });
  const authority = createManagedWorktreeChangeAuditAuthorityV1({ workspaceManager: workspace,
    allowedPaths: ["src/**"], maximumChangedFiles: 3, maximumChangedBytes: 4096 });
  const savedPlan = await f.db.transaction(tx => persistManagedWorktreeChangeAuditPlanV1(tx, key, {
    delivery: delivery.identity, lease, authority, recordedAt: at(4000) }));
  const contentHash = sha256Digest("durable audit result"), artifactId = durableResultArtifactIdV1(contentHash);
  const manifest = buildTaskResultManifestV1({ artifactId, tenantId: binding.tenantId, projectId: binding.projectId,
    jobId: binding.jobId, attemptId: binding.attemptId, workflowId: "workflow:test", nodeId: binding.nodeId,
    contentHash, sizeBytes: 20, storageClass: "local", opaqueLocator: "opaque:fixture", createdAt: at(5000) });
  const durableReceipt = { schema: "control-room.durable-result-receipt/v1" as const, artifactId,
    tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId, attemptId: binding.attemptId,
    runId: registration.id, nodeId: binding.nodeId, harness: "codex", contentHash, sizeBytes: 20,
    manifestDigest: sha256Digest(manifest), receivedAt: at(5000), byteCheck: "matched_recorded_claim" as const,
    qualityAccepted: false as const, canonicalPublicationAllowed: false as const, completionVerified: false as const,
    releasesCapacity: false as const, grantsExecutionAuthority: false as const };
  await f.db.query(`INSERT INTO control_artifact_manifests(id,tenant_id,project_id,workflow_id,job_id,attempt_id,
    content_hash,state,version,payload,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'uploaded',0,$8::jsonb,$9,$9)`,
  [artifactId, binding.tenantId, binding.projectId, "workflow:test", binding.jobId, binding.attemptId,
    contentHash, JSON.stringify(manifest), at(5000)]);
  const storedReceipt = receiptOverride ?? durableReceipt;
  await f.db.query(`INSERT INTO control_native_artifact_receipts(tenant_id,project_id,job_id,attempt_id,run_id,artifact_id,receipt,auth_tag)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [binding.tenantId, binding.projectId, binding.jobId,
    binding.attemptId, registration.id, artifactId, JSON.stringify(storedReceipt),
    receiptOverride === undefined ? durableResultReceiptTagV1(key, durableReceipt) : `hmac-sha256:${"b".repeat(64)}`]);
  const scope = { tenantId: binding.tenantId, projectId: binding.projectId, jobId: binding.jobId,
    attemptId: binding.attemptId, runId: registration.id, artifactId };
  const evidence = createWorktreeChangeAuditEvidenceV1(savedPlan.plan, { baseRevision: revision, changes: [
    { path: "src/safe.ts", kind: "modified", bytes: 20, contentDigest: contentHash },
  ] });
  return { f, scope, evidence, savedPlan };
}

test("result-bound audit writer reads both protected authorities and exact-replays", async t => {
  const x = await fixture(); t.after(x.f.close);
  const first = await x.f.db.transaction(tx => persistResultBoundWorktreeChangeAuditRecordV1(tx, key,
    { scope: x.scope, evidence: x.evidence, recordedAt: at(6000) }));
  assert.equal(first.replayed, false);
  assert.equal(first.record.identity.artifactId, x.scope.artifactId);
  const replay = await x.f.db.transaction(tx => persistResultBoundWorktreeChangeAuditRecordV1(tx, key,
    { scope: x.scope, evidence: x.evidence, recordedAt: at(6000) }));
  assert.equal(replay.replayed, true);
  await assert.rejects(x.f.db.transaction(tx => persistResultBoundWorktreeChangeAuditRecordV1(tx, key,
    { scope: x.scope, evidence: { ...x.evidence, evidenceDigest: sha256Digest("changed") }, recordedAt: at(6000) })),
  /worktree_change_audit_record_unavailable|evidence_invalid/);
});

test("record writer refuses a missing or non-durable legacy receipt and early timestamps", async t => {
  const x = await fixture(); t.after(x.f.close);
  await assert.rejects(x.f.db.transaction(tx => persistResultBoundWorktreeChangeAuditRecordV1(tx, key,
    { scope: x.scope, evidence: x.evidence, recordedAt: at(3500) })), /worktree_change_audit_record_unavailable/);
  const bad = await fixture({ schema: "control-room.native-result-receipt/v1" }); t.after(bad.f.close);
  await assert.rejects(bad.f.db.transaction(tx => persistResultBoundWorktreeChangeAuditRecordV1(tx, key,
    { scope: bad.scope, evidence: bad.evidence, recordedAt: at(6000) })), /durable_result_receipt_unavailable/);
});

test("only the evidence role can append or read raw audit records", async t => {
  const x = await fixture(); t.after(x.f.close);
  await x.f.raw.exec(await readFile("db/roles/native_evidence_roles.sql", "utf8"));
  await x.f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await x.f.raw.exec(`CREATE ROLE audit_record_evidence_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE audit_record_web_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_native_evidence TO audit_record_evidence_test;
    GRANT control_room_private_web TO audit_record_web_test`);
  await x.f.db.transaction(async tx => {
    await tx.query("SET LOCAL SESSION AUTHORIZATION audit_record_evidence_test");
    const saved = await persistResultBoundWorktreeChangeAuditRecordV1(tx, key,
      { scope: x.scope, evidence: x.evidence, recordedAt: at(6000) });
    assert.equal(saved.replayed, false);
  });
  await assert.rejects(x.f.db.transaction(async tx => {
    await tx.query("SET LOCAL SESSION AUTHORIZATION audit_record_web_test");
    await tx.query("SELECT record FROM control_worktree_change_audit_records");
  }));
});
