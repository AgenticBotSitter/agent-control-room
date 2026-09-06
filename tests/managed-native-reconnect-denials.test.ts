import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseSession } from "../src/persistence/database";
import { sha256Digest } from "../src/security";
import { currentSignal, managedNativeSessionFixture } from "./helpers/managed-native-session";

type Fixture = Awaited<ReturnType<typeof managedNativeSessionFixture>>;
type Connection = Awaited<ReturnType<Fixture["attach"]>>;

async function recordedRecoveryFixture() {
  const x = await managedNativeSessionFixture();
  try {
    await x.verify();
    const original = await x.attach(); await x.handshake(original);
    const native = await x.dispatch(original);
    const registration = await x.receiver.register(x.request, currentSignal());
    assert.equal(registration.replayed, false);
    const fresh = await x.attach(); await x.handshake(fresh);
    assert.notEqual(JSON.parse(original.hello).connectionId, JSON.parse(fresh.hello).connectionId);
    assert.equal(original.peer.state.closes, 1);
    return { x, original, native, registration, fresh };
  } catch (error) { await x.close(); throw error; }
}

function expectReadOnly(x: Fixture, from: number) {
  assert.equal(x.observed.slice(from).some(row => /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(row.sql)), false);
}

function interceptRecoveryRead(x: Fixture, mode: "missing-envelope" | "tampered-receipt" | "missing-run" | "tampered-run" | "missing-lease") {
  const transaction = x.evidenceDb.transactionWithPreCommitCheck.bind(x.evidenceDb);
  x.evidenceDb.transactionWithPreCommitCheck = (work, check) => transaction(async tx => {
    const wrapped: DatabaseSession = { async query<T>(sql: string, params?: unknown[]) {
      const result = await tx.query<T>(sql, params);
      const mutable = result as unknown as { rows: Record<string, unknown>[] };
      if (mode === "missing-envelope" && sql.includes("FROM control_native_delivery_envelopes")) mutable.rows = [];
      if (mode === "tampered-receipt" && sql.includes("FROM control_native_delivery_receipts"))
        mutable.rows = mutable.rows.map(row => ({ ...row, auth_tag: "tampered" }));
      if (mode === "missing-run" && sql.includes("FROM control_harness_runs r")) mutable.rows = [];
      if (mode === "tampered-run" && sql.includes("FROM control_harness_runs r"))
        mutable.rows = mutable.rows.map(row => ({ ...row, run_auth_tag: "tampered" }));
      if (mode === "missing-lease" && sql.includes("FOR SHARE OF j,a,l")) mutable.rows = [];
      return result;
    } };
    return work(wrapped);
  }, check);
}

async function recover(x: Fixture, connection: Connection) {
  return connection.handle.recover(x.request, currentSignal());
}

test("recorded delivery recovery grants observation only and cannot reopen stage or transmit", async t => {
  for (const operation of ["stage", "transmit"] as const) await t.test(operation, async t => {
    const { x, fresh } = await recordedRecoveryFixture(); t.after(x.close);
    const counts = await x.counts(), states = await x.states(), calls = [...x.local.calls];
    const observed = x.observed.length, sends = fresh.peer.state.sends;
    assert.deepEqual(await recover(x, fresh), { recovered: true, grantsExecutionAuthority: false });
    assert.equal(fresh.peer.state.sends, sends); expectReadOnly(x, observed);
    if (operation === "stage")
      await assert.rejects(fresh.handle.stage(x.f.identity, x.task, currentSignal()), { message: "native_session_operation_uncertain" });
    else await assert.rejects(fresh.handle.transmit(x.f.identity, x.task, currentSignal()), { message: "native_session_operation_uncertain" });
    assert.deepEqual(await x.counts(), counts); assert.deepEqual(await x.states(), states);
    assert.deepEqual(x.local.calls, calls); assert.equal(fresh.peer.state.sends, sends); assert.equal(fresh.peer.state.closes, 1);
  });
});

test("missing or tampered delivery, run or historical lease proof denies recovery without writes", async t => {
  for (const mode of ["missing-envelope", "tampered-receipt", "missing-run", "tampered-run", "missing-lease"] as const)
    await t.test(mode, async t => {
      const { x, fresh } = await recordedRecoveryFixture(); t.after(x.close);
      const counts = await x.counts(), states = await x.states(), calls = [...x.local.calls];
      const observed = x.observed.length, sends = fresh.peer.state.sends;
      interceptRecoveryRead(x, mode);
      await assert.rejects(recover(x, fresh), { message: "native_session_operation_uncertain" });
      expectReadOnly(x, observed); assert.deepEqual(await x.counts(), counts); assert.deepEqual(await x.states(), states);
      assert.deepEqual(x.local.calls, calls); assert.equal(fresh.peer.state.sends, sends); assert.equal(fresh.peer.state.closes, 1);
    });
});

test("wrong input and task scope cannot select another recorded delivery", async t => {
  const patches = [{ projectId: "project:other" }, { jobId: "job:other" }, { attemptId: "attempt:other" },
    { inputDigest: sha256Digest("different reconnect input") }];
  for (const patch of patches) await t.test(JSON.stringify(patch), async t => {
    const { x, fresh } = await recordedRecoveryFixture(); t.after(x.close);
    const counts = await x.counts(), states = await x.states(), calls = [...x.local.calls];
    const observed = x.observed.length, sends = fresh.peer.state.sends;
    await assert.rejects(fresh.handle.recover({ ...x.request, ...patch }, currentSignal()),
      { message: "native_session_operation_uncertain" });
    expectReadOnly(x, observed); assert.deepEqual(await x.counts(), counts); assert.deepEqual(await x.states(), states);
    assert.deepEqual(x.local.calls, calls); assert.equal(fresh.peer.state.sends, sends); assert.equal(fresh.peer.state.closes, 1);
  });
});

test("a recovered session refuses a valid snapshot signed for the old connection", async t => {
  const x = await managedNativeSessionFixture(); t.after(x.close); await x.verify();
  const original = await x.attach(); await x.handshake(original);
  const native = await x.dispatch(original); await x.receiver.register(x.request, currentSignal());
  // Explicit synthetic producer action solely creates a valid old-connection progress frame.
  const oldWire = await native.produce("start"), counts = await x.counts(), calls = [...x.local.calls];
  const fresh = await x.attach(); await x.handshake(fresh); await recover(x, fresh);
  const protocol = await x.protocol(), observed = x.observed.length, sends = fresh.peer.state.sends;
  await assert.rejects(fresh.handle.progress(oldWire.raw, undefined, currentSignal()),
    { message: "native_session_operation_uncertain" });
  assert.deepEqual(await x.protocol(), protocol); expectReadOnly(x, observed);
  assert.deepEqual(await x.counts(), counts); assert.deepEqual(x.local.calls, calls);
  assert.equal(fresh.peer.state.sends, sends); assert.equal(fresh.peer.state.closes, 1);
});

test("a key revoked after hello and recovery denies fresh progress before replay or evidence writes", async t => {
  const { x, native, fresh } = await recordedRecoveryFixture(); t.after(x.close);
  assert.deepEqual(await recover(x, fresh), { recovered: true, grantsExecutionAuthority: false });
  // Explicit fake producer action supplies a valid body, re-enveloped by the current peer connection.
  const produced = await native.produce("start");
  await x.admin(async () => {
    await fresh.peer.bridge.publishNativeSnapshot(produced.body, new Date(x.f.clock()).toISOString());
    await x.f.db.query("UPDATE control_node_keys SET state='revoked',revoked_at=$1 WHERE tenant_id=$2 AND id=$3",
      [new Date(x.f.clock()).toISOString(), x.f.scope.tenantId, "key:test"]);
  });
  const raw = fresh.peer.incoming.shift(); assert.ok(raw);
  const protocol = await x.protocol(), counts = await x.counts(), calls = [...x.local.calls];
  const observed = x.observed.length, sends = fresh.peer.state.sends;
  await assert.rejects(fresh.handle.progress(raw, undefined, currentSignal()),
    { message: "native_session_operation_uncertain" });
  assert.deepEqual(await x.protocol(), protocol); expectReadOnly(x, observed); assert.deepEqual(await x.counts(), counts);
  assert.deepEqual(x.local.calls, calls); assert.equal(fresh.peer.state.sends, sends); assert.equal(fresh.peer.state.closes, 1);
});

test("cancellation or replacement at recovery proof precommit invalidates the exact handle", async t => {
  for (const mode of ["cancel", "replace"] as const) await t.test(mode, async t => {
    const { x, fresh } = await recordedRecoveryFixture(); t.after(x.close);
    const counts = await x.counts(), states = await x.states(), calls = [...x.local.calls];
    const observed = x.observed.length, sends = fresh.peer.state.sends;
    const transaction = x.evidenceDb.transactionWithPreCommitCheck.bind(x.evidenceDb), abort = new AbortController();
    const replacementPeer = mode === "replace" ? x.makePeer() : undefined;
    let reachedProof = false, injected = false, replacement: ReturnType<typeof x.manager.attach> | undefined;
    x.evidenceDb.transactionWithPreCommitCheck = (work, check) => transaction(async tx => {
      const wrapped: DatabaseSession = { async query<T>(sql: string, params?: unknown[]) {
        const result = await tx.query<T>(sql, params);
        if (sql.includes("FOR SHARE OF j,a,l")) reachedProof = true;
        return result;
      } };
      return work(wrapped);
    }, () => {
      if (reachedProof && !injected) {
        injected = true;
        if (mode === "cancel") abort.abort();
        else replacement = x.manager.attach(x.registration.nodeId, replacementPeer!.transport);
      }
      return check();
    });
    await assert.rejects(fresh.handle.recover(x.request, abort.signal), { message: "native_session_operation_uncertain" });
    assert.equal(reachedProof, true); assert.equal(injected, true); expectReadOnly(x, observed);
    assert.deepEqual(await x.counts(), counts); assert.deepEqual(await x.states(), states); assert.equal(fresh.peer.state.closes, 1);
    assert.deepEqual(x.local.calls, calls); assert.equal(fresh.peer.state.sends, sends);
    if (replacement) {
      const handle = await replacement;
      assert.equal(replacementPeer!.state.sends, 0);
      await assert.rejects(async () => fresh.handle.recover(x.request, currentSignal()));
      await handle.close(); assert.equal(replacementPeer!.state.closes, 1);
    }
  });
});
