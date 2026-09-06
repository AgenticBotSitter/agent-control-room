import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { binding, instant } from "./hermes-native-fixture";
import { sha256Digest } from "../src/security";
import type { DatabaseClient } from "../src/persistence/database";
import { canonicalApprovalStorageFixture as fixture } from "./helpers/canonical-approval-storage";
import { prepareNativeOwnerApprovalMaterial } from "../src/harness/v1/native-owner-approval-material";
import { createNativeOwnerApprovalIssuer } from "../src/harness/v1/native-owner-approval-issuer";
import { describeNativeOwnerReview } from "../src/harness/v1/native-owner-review";

test("paired owner issuer releases only complete verified packets and never retries partial issuance", async t => {
  const f = await fixture(); t.after(f.close);
  const keyId = f.packet.approval.body.approvalKeyId;
  const publicKeySpki = Buffer.from((await f.approvals.resolveApprovalKey(keyId))!).toString("base64url");
  const input = { ...f.prepared, approvalKeyId: keyId, issuedAt: f.clock(), recoveryExpiresAt: f.prepared.start.deadline + 120_000,
    approvalNonce: "synthetic-paired-approval", recoveryNonce: "synthetic-paired-recovery" };
  for (const mode of ["valid", "no-consent", "revoked", "second-failed", "corrupt", "timeout", "expired"] as const) {
    let calls = 0, allowed = mode !== "no-consent", now = f.clock();
    const digests: string[] = [];
    const issuer = createNativeOwnerApprovalIssuer(input, { publicKeySpki, timeoutMs: mode === "timeout" ? 30 : 1000, clock: () => now,
      assertOwnerConsentCurrent(digest) { digests.push(digest); if (!allowed) throw new Error("synthetic denied consent"); },
      async sign(bytes) {
        calls++;
        if (mode === "timeout") return new Promise<Uint8Array>(() => {});
        if (mode === "second-failed" && calls === 2) throw new Error("synthetic uncertain second signature");
        if (mode === "revoked") allowed = false;
        if (mode === "expired") now = f.prepared.start.deadline;
        if (mode === "corrupt") return new Uint8Array(64);
        return Buffer.from(f.sign(JSON.parse(Buffer.from(bytes).toString())).signature, "base64url");
      } });
    assert.deepEqual(issuer.review, describeNativeOwnerReview(input));
    assert.equal(Object.isFrozen(issuer.review), true);
    if (mode === "valid") assert.equal((await f.save(await issuer.issue(new AbortController().signal))).startsWork, false);
    else await assert.rejects(issuer.issue(new AbortController().signal), /owner_approval_issuance_uncertain/);
    const before = calls;
    await assert.rejects(issuer.issue(new AbortController().signal), /owner_approval_issuance_uncertain/);
    assert.equal(calls, before);
    assert.equal(calls, mode === "no-consent" ? 0 : ["valid", "second-failed"].includes(mode) ? 2 : 1);
    assert.ok(digests.every(digest => digest === issuer.reviewDigest));
  }
  assert.equal(await f.count(), 1);
});

test("paired issuer refuses async consent and cannot resume after a late first signature", async t => {
  const f = await fixture(); t.after(f.close);
  const keyId = f.packet.approval.body.approvalKeyId;
  const publicKeySpki = Buffer.from((await f.approvals.resolveApprovalKey(keyId))!).toString("base64url");
  const input = { ...f.prepared, approvalKeyId: keyId, issuedAt: f.clock(), recoveryExpiresAt: f.prepared.start.deadline + 120_000,
    approvalNonce: "synthetic-late-approval", recoveryNonce: "synthetic-late-recovery" };
  let calls = 0;
  const asynchronous = createNativeOwnerApprovalIssuer(input, { publicKeySpki, timeoutMs: 1000, clock: f.clock,
    async assertOwnerConsentCurrent() { throw new Error("synthetic async refusal"); },
    async sign() { calls++; return new Uint8Array(64); } });
  await assert.rejects(asynchronous.issue(new AbortController().signal), /owner_approval_issuance_uncertain/);
  assert.equal(calls, 0);
  let release: () => void = () => { throw new Error("signing did not start"); };
  let signingSignal: AbortSignal | undefined;
  const late = createNativeOwnerApprovalIssuer(input, { publicKeySpki, timeoutMs: 30, clock: f.clock,
    assertOwnerConsentCurrent() {},
    sign(bytes, signal) {
      calls++; signingSignal = signal;
      const signature = Buffer.from(f.sign(JSON.parse(Buffer.from(bytes).toString())).signature, "base64url");
      return new Promise<Uint8Array>(resolve => { release = () => resolve(signature); });
    } });
  await assert.rejects(late.issue(new AbortController().signal), /owner_approval_issuance_uncertain/);
  assert.equal(signingSignal?.aborted, true);
  release();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 1, "late first signature must not request recovery signature");
  await assert.rejects(late.issue(new AbortController().signal), /owner_approval_issuance_uncertain/);
  assert.equal(calls, 1);
  assert.equal(await f.count(), 0);
});

test("unsigned owner material uses existing signatures and exact intake without starting work", async t => {
  const f = await fixture(); t.after(f.close);
  const input = { enrollment: f.prepared.enrollment, request: f.prepared.request, start: f.prepared.start,
    approvalKeyId: f.packet.approval.body.approvalKeyId, issuedAt: f.clock(),
    recoveryExpiresAt: f.prepared.start.deadline + 120_000,
    approvalNonce: "synthetic-owner-material", recoveryNonce: "synthetic-recovery-material" };
  const before = structuredClone(input), material = prepareNativeOwnerApprovalMaterial(input);
  const review = describeNativeOwnerReview(input);
  assert.equal(review.prompt, f.prepared.start.prompt);
  assert.equal(review.inputDigest, f.prepared.inputDigest);
  assert.equal(Object.isFrozen(review), true);
  for (const field of ["credentialRef", "canonicalDestination", "enrollment", "request", "body", "qualificationDigest"])
    assert.equal(field in review, false);
  assert.throws(() => describeNativeOwnerReview({ ...input, start: { ...input.start, prompt: "substituted task" } }));
  assert.deepEqual(input, before); assert.equal(material.signatureStatus, "unsigned");
  assert.equal(material.startsWork, false); assert.equal(material.grantsExecutionAuthority, false);
  assert.equal("signature" in material.approval, false);
  const packet = { schema: "control-room.native-task-approval-packet/v1", approval: f.sign(material.approval), recovery: f.sign(material.recovery) };
  assert.equal((await f.save(packet)).startsWork, false); assert.equal(await f.count(), 1);
  for (const changes of [
    { issuedAt: f.prepared.start.deadline }, { issuedAt: Date.parse(f.prepared.request.occurredAt) - 1 },
    { recoveryExpiresAt: f.prepared.start.deadline }, { recoveryExpiresAt: f.prepared.start.deadline + 300_001 },
    { approvalNonce: "!invalid" }, { recoveryNonce: "short" }, { approvalKeyId: "bad/key" },
    { start: { ...f.prepared.start, jobId: "job:other" } },
    { request: { ...f.prepared.request, approval: packet.approval } },
  ]) assert.throws(() => prepareNativeOwnerApprovalMaterial({ ...input, ...changes }), /native_owner_approval_material_invalid/);
  assert.equal(await f.count(), 1, "preparation and rejected material do not store or dispatch anything");
});

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
