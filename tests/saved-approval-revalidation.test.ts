import test from "node:test";
import assert from "node:assert/strict";
import { binding } from "./hermes-native-fixture";
import { sha256Digest } from "../src/security";
import type { DatabaseClient } from "../src/persistence/database";
import { TaskAssignmentCoordinator } from "../src/web/v1/task-assignment-coordinator";
import { readFile } from "node:fs/promises";
import { canonicalApprovalStorageFixture as fixture } from "./helpers/canonical-approval-storage";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const prepare = (f: Fixture, coordinator = f.coordinator, digest = sha256Digest(f.packet)) =>
  coordinator.prepareStoredNativeDispatch(...f.args, digest, f.abort.signal);

test("saved signatures revalidate from canonical state without changing evidence or dispatching", async t => {
  const f = await fixture(); t.after(f.close); await f.save();
  const before = (await f.db.query("SELECT * FROM control_outbox")).rows;
  const value = await prepare(f);
  assert.equal(value.packetDigest, sha256Digest(f.packet)); assert.deepEqual(value.request.approval, f.packet.approval);
  assert.deepEqual(value.recoveryPermission, f.packet.recovery); assert.deepEqual(value.start, f.prepared.start);
  assert.equal(value.evidence, "revalidated_signed_snapshot"); assert.equal(value.startsWork, false);
  assert.equal(value.grantsExecutionAuthority, false); assert.equal("assertFresh" in value, false);
  assert.equal("prepareStoredNativeDispatch" in f.coordinator.webOperation(), false);
  assert.deepEqual((await f.db.query("SELECT * FROM control_outbox")).rows, before); assert.equal(await f.count(), 1);
});

test("missing or different saved packet cannot be substituted by a historical receipt", async t => {
  const f = await fixture(); t.after(f.close); await assert.rejects(prepare(f)); await f.save();
  await assert.rejects(prepare(f, f.coordinator, sha256Digest("different")));
  const receipt = await f.coordinator.readNativeApproval(...f.args);
  await assert.rejects(prepare(f, f.coordinator, receipt as unknown as string));
});

test("history survives expiry and closed pins but dispatch preparation cannot", async t => {
  for (const mode of ["expiry", "pins"] as const) await t.test(mode, async t => {
    const f = await fixture(); t.after(f.close); await f.save();
    if (mode === "expiry") f.setNow(f.prepared.start.deadline); else f.approvals.close();
    assert.ok(await f.coordinator.readNativeApproval(...f.args)); await assert.rejects(prepare(f));
  });
});

test("current owner access and active project remain necessary after a successful save", async t => {
  for (const mode of ["owner", "project"] as const) await t.test(mode, async t => {
    const f = await fixture(); t.after(f.close); await f.save();
    if (mode === "owner") await f.db.query("UPDATE control_role_grants SET role_key='operator' WHERE tenant_id=$1", [binding.tenantId]);
    else await f.db.query("UPDATE control_manual_project_heads SET lifecycle='completed' WHERE tenant_id=$1", [binding.tenantId]);
    await assert.rejects(prepare(f));
  });
});

test("commit-time trust change, cancellation and expiry invalidate prepared delivery material", async t => {
  for (const mode of ["trust", "abort", "expiry"] as const) await t.test(mode, async t => {
    const f = await fixture(); t.after(f.close); await f.save();
    const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(async tx => {
      const value = await work(tx);
      if (mode === "trust") await f.native.revoke();
      else if (mode === "abort") f.abort.abort(); else f.setNow(f.prepared.start.deadline);
      return value;
    }, check) };
    await assert.rejects(prepare(f, f.create(db))); assert.equal(await f.count(), 1);
  });
});

test("tampered packet integrity fails even when its lookup scope matches", async t => {
  const f = await fixture(); t.after(f.close); await f.save();
  const db: DatabaseClient = { ...f.db, transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(tx => work({
    async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      return sql.startsWith("SELECT tenant_id,project_id,job_id,attempt_id,record,auth_tag")
        ? { rows: result.rows.map(row => Object.assign({}, row, { auth_tag: "hmac-sha256:" + "0".repeat(64) })) } : result;
    },
  }), check) };
  await assert.rejects(prepare(f, f.create(db)));
});

test("changed configured enrollment and retired node key cannot reuse saved permission", async t => {
  const f = await fixture(); t.after(f.close); await f.save();
  const changed = new TaskAssignmentCoordinator(f.db, f.scope, f.planner, [f.route], f.clock,
    [{ enrollment: { ...f.prepared.enrollment, model: "different-model" }, nodeClass: "personal-compute" }], f.store);
  await assert.rejects(prepare(f, changed));
  await f.db.query("UPDATE control_node_keys SET state='retired' WHERE tenant_id=$1 AND node_id=$2", [binding.tenantId, binding.nodeId]);
  await assert.rejects(prepare(f));
});

test("restricted coordinator can revalidate and returned snapshots cannot mutate saved evidence", async t => {
  const f = await fixture(); t.after(f.close); await f.save();
  await f.raw.exec(await readFile("db/roles/task_coordinator_roles.sql", "utf8"));
  await f.raw.exec("SET ROLE control_room_task_coordinator");
  try {
    const value = await prepare(f); value.request.approval!.signature = "A".repeat(86);
    value.start.prompt = "mutated copy"; value.enrollment.model = "mutated copy";
    const next = await prepare(f); assert.deepEqual(next.request.approval, f.packet.approval);
    assert.deepEqual(next.start, f.prepared.start); assert.deepEqual(next.enrollment, f.prepared.enrollment);
  } finally { await f.raw.exec("RESET ROLE"); }
});
