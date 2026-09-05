import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { taskAssignmentFixture } from "./helpers/task-assignment";
import { nativeLeaseEvidenceFixture } from "./helpers/native-lease-evidence";
import { binding, enrollment, instant } from "./hermes-native-fixture";
import { TaskAssignmentCoordinator } from "../src/web/v1/task-assignment-coordinator";
import { NativeApprovalPacketStore } from "../src/web/v1/native-approval-packet-store";
import { PinnedApprovalTrustStore } from "../src/node-policy/v1/pinned-approval-trust";
import { signArtifact, computeArtifactBodyDigest } from "../src/node-policy/v1/crypto";
import { sha256Digest } from "../src/security";
import type { DatabaseClient } from "../src/persistence/database";

async function fixture() {
  const f = await taskAssignmentFixture(), native = await nativeLeaseEvidenceFixture(); await f.assign();
  let now = instant + 9000; const clock = () => now, keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const pin = { keyId: "approval-key:storage", algorithm: "ed25519", spki,
    fingerprint: `sha256:${createHash("sha256").update(Buffer.from(spki, "base64url")).digest("hex")}` };
  const approvals = new PinnedApprovalTrustStore({ schema: "control-room.owner-approval-pins/v1",
    tenantId: binding.tenantId, nodeId: binding.nodeId, nodeClass: "personal-compute", validFrom: instant,
    validUntil: enrollment.validUntil, keys: [pin] }, { security: native.trust, clock });
  const store = new NativeApprovalPacketStore(new Uint8Array(32).fill(75), [{ approvals, security: native.trust }], clock);
  const create = (db: DatabaseClient = f.db) => new TaskAssignmentCoordinator(db, f.scope, f.planner, [f.route], clock,
    [{ enrollment, nodeClass: "personal-compute" }], store);
  const coordinator = create(), args = [f.identity, binding.projectId, f.prepared.receipt.jobId, f.prepared.receipt.inputDigest] as const;
  const prepared = await coordinator.prepareNativeApproval(...args);
  const sign = <T extends object>(body: T) => signArtifact({ ...body, bodyDigest: computeArtifactBodyDigest(body) }, keys.privateKey);
  const packet = { schema: "control-room.native-task-approval-packet/v1" as const,
    approval: sign({ ...native.startConfig.request.approval.body, approvalKeyId: pin.keyId,
      jobId: prepared.request.jobId, attemptId: prepared.request.attemptId, operationDigest: prepared.request.operationDigest,
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(prepared.start.deadline).toISOString() }),
    recovery: sign({ schema: "control-room.native-run-recovery-permission/v1", bindingDigest: sha256Digest(prepared.binding),
      approvalKeyId: pin.keyId, issuedAt: now, expiresAt: prepared.start.deadline + 120_000,
      operations: ["status", "stop"], nonce: "synthetic-storage-nonce" }) };
  const abort = new AbortController();
  const save = (value: unknown = packet, c = coordinator) => c.storeNativeApproval(...args, value, abort.signal);
  return { ...f, native, approvals, prepared, packet, abort, sign, save, create, args, coordinator,
    setNow: (value: number) => { now = value; }, count: async () => (await f.db.query("SELECT * FROM control_native_approval_packets")).rows.length,
    close: async () => { approvals.close(); await native.close(); await f.close(); } };
}

test("owner saves exact signed packet once; replay preserves receipt without dispatch", async t => {
  const f = await fixture(); t.after(f.close);
  const before = (await f.db.query("SELECT * FROM control_outbox")).rows;
  const saved = await f.save(); assert.equal(saved.replayed, false); assert.equal(saved.startsWork, false);
  f.setNow(instant + 10_000);
  assert.deepEqual(await f.save(), { ...saved, replayed: true }); assert.equal(await f.count(), 1);
  assert.equal("storeNativeApproval" in f.coordinator.webOperation(), false);
  assert.deepEqual((await f.db.query("SELECT * FROM control_outbox")).rows, before);
  assert.equal((await f.db.query("SELECT * FROM control_approvals")).rows.length, 0);
});

test("invalid signature, wrong task and conflicting signed packet cannot be stored", async t => {
  const f = await fixture(); t.after(f.close);
  const invalid = structuredClone(f.packet); invalid.approval.signature = "A".repeat(86);
  await assert.rejects(f.save(invalid)); assert.equal(await f.count(), 0);
  await assert.rejects(f.save({ ...f.packet, recovery: f.sign({ ...f.packet.recovery.body, bindingDigest: sha256Digest("other") }) }));
  await f.save();
  await assert.rejects(f.save({ ...f.packet, recovery: f.sign({ ...f.packet.recovery.body, nonce: "different-signed-nonce" }) }));
  assert.equal(await f.count(), 1);
});

test("current owner and reservation remain required even for packet replay", async t => {
  const f = await fixture(); t.after(f.close); await f.save(); f.setNow(f.prepared.start.deadline);
  await assert.rejects(f.save());
  const g = await fixture(); t.after(g.close);
  await g.db.query("UPDATE control_role_grants SET role_key='operator' WHERE tenant_id=$1", [binding.tenantId]);
  await assert.rejects(g.save()); assert.equal(await g.count(), 0);
});

test("commit-time cancellation and trust revocation roll back packet evidence", async t => {
  for (const mode of ["abort", "trust", "expiry"] as const) await t.test(mode, async t => {
    const f = await fixture(); t.after(f.close);
    const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(async tx => {
      const result = await work(tx);
      if (mode === "abort") f.abort.abort();
      else if (mode === "trust") await f.native.revoke();
      else f.setNow(f.prepared.start.deadline);
      return result;
    }, check) };
    await assert.rejects(f.save(f.packet, f.create(db))); assert.equal(await f.count(), 0);
  });
});

test("stored evidence is append-only and tampered readback cannot replay", async t => {
  const f = await fixture(); t.after(f.close); await f.save();
  for (const sql of ["UPDATE control_native_approval_packets SET record=record", "DELETE FROM control_native_approval_packets", "TRUNCATE control_native_approval_packets"])
    await assert.rejects(f.db.query(sql));
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      return sql.startsWith("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag")
        ? { rows: result.rows.map(row => Object.assign({}, row, { auth_tag: "hmac-sha256:" + "0".repeat(64) })) } : result;
    },
  }), check) };
  await assert.rejects(f.save(f.packet, f.create(db)));
});

test("coordinator role can save while private web cannot read or insert packet evidence", async t => {
  const f = await fixture(); t.after(f.close);
  await f.raw.exec(await readFile("db/roles/task_coordinator_roles.sql", "utf8"));
  await f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await f.raw.exec("SET ROLE control_room_task_coordinator");
  try { assert.equal((await f.save()).replayed, false); } finally { await f.raw.exec("RESET ROLE"); }
  await f.raw.exec("SET ROLE control_room_private_web");
  try {
    await assert.rejects(f.db.query("SELECT * FROM control_native_approval_packets"));
    await assert.rejects(f.save());
  } finally { await f.raw.exec("RESET ROLE"); }
  assert.equal(await f.count(), 1);
});

test("packet input is copied before asynchronous canonical reads", async t => {
  const f = await fixture(); t.after(f.close);
  const packet = structuredClone(f.packet), expected = sha256Digest(packet);
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => {
    packet.approval.signature = "A".repeat(86);
    return f.db.transactionWithPreCommitCheck(work, check);
  } };
  assert.equal((await f.save(packet, f.create(db))).packetDigest, expected);
});
