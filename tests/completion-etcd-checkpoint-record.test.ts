import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEtcdCheckpointRecord } from "../src/completion-gate/v1/etcd-checkpoint-record";
import { ROLLBACK_CHECKPOINT_SCHEMA_V1, rollbackCheckpointDigestV1 } from "../src/security/rollback-checkpoint";
import { parseEtcdCheckpointAdvanceReceipt, prepareEtcdCheckpointAdvance } from "../src/completion-gate/v1/etcd-checkpoint-advance";
import { createEtcdCheckpointAccess } from "../src/completion-gate/v1/etcd-checkpoint-access";
import { createEtcdCompletionCheckpointStoreV1 } from "../src/completion-gate/v1/etcd-checkpoint-store";
import { stageAsyncCompletionCheckpoint } from "../src/completion-gate/v1/async-staged-checkpoint";

const binding = { clusterId: "18446744073709551615", createRevision: "9007199254740993",
  key: Buffer.from("synthetic/checkpoint"), scope: "completion-gate:synthetic" };
const checkpoint = { schema: ROLLBACK_CHECKPOINT_SCHEMA_V1, scope: binding.scope, revision: 1,
  recordCount: 0, stateDigest: `sha256:${"a".repeat(64)}`, stateAuthTag: `hmac-sha256:${"b".repeat(64)}` };
function fixture() {
  return { header: { cluster_id: binding.clusterId, revision: "9007199254740995" }, count: "1", more: false,
    kvs: [{ key: Buffer.from(binding.key), value: Buffer.from(JSON.stringify(checkpoint)),
      create_revision: binding.createRevision, mod_revision: "9007199254740994", version: "1", lease: "0" }] };
}

test("completion checkpoint port rejects scope changes, initialization and cancelled calls before transport", async () => {
  let calls = 0;
  const options = { binding: { ...binding, key: Buffer.from(binding.key) }, timeoutMs: 1000,
    range: () => { calls++; throw new Error("unexpected transport"); },
    txn: () => { calls++; throw new Error("unexpected transport"); } };
  const store = createEtcdCompletionCheckpointStoreV1(options);
  options.binding.scope = "completion-gate:changed";
  options.binding.key.fill(0);
  await assert.rejects(async () => store.read(options.binding.scope), /scope_invalid/);
  await assert.rejects(async () => store.initialize(checkpoint), /provisioning_required/);
  await assert.rejects(async () => store.advance(rollbackCheckpointDigestV1(checkpoint), { ...checkpoint, scope: options.binding.scope }), /scope_invalid/);
  await assert.rejects(async () => store.advance("invalid", { ...checkpoint, revision: 2 }), /digest_invalid/);
  await assert.rejects(async () => store.read(binding.scope, AbortSignal.abort()));
  await assert.rejects(async () => store.advance(rollbackCheckpointDigestV1(checkpoint), { ...checkpoint, revision: 2 }, AbortSignal.abort()));
  assert.equal(calls, 0);
  assert.throws(() => createEtcdCompletionCheckpointStoreV1({ ...options, binding: { ...binding, scope: "other:scope" } }), /scope_invalid/);
});

test("async completion staging uses the exact-key CAS port and never writes before flush", async () => {
  let ranges = 0, writes = 0;
  const next = { ...checkpoint, revision: 2, recordCount: 1 };
  const store = createEtcdCompletionCheckpointStoreV1({ binding, timeoutMs: 1000,
    range(request, _deadline, callback) {
      ranges++; assert.deepEqual(request.key, binding.key); assert.equal(request.serializable, false);
      callback(null, fixture()); return { cancel() {} };
    },
    txn(request, _deadline, callback) {
      writes++;
      assert.deepEqual(request, prepareEtcdCheckpointAdvance({ response: fixture(), binding,
        expectedDigest: rollbackCheckpointDigestV1(checkpoint), next }));
      callback(null, { header: { cluster_id: binding.clusterId, revision: "9007199254740996" }, succeeded: true,
        responses: [{ response: "response_put", response_put: {} }] });
      return { cancel() {} };
    },
  });
  const stage = stageAsyncCompletionCheckpoint(store, "synthetic");
  assert.deepEqual(await stage.checkpoints.read(binding.scope), checkpoint);
  await stage.checkpoints.advance(rollbackCheckpointDigestV1(checkpoint), next);
  assert.equal(ranges, 1); assert.equal(writes, 0);
  await stage.flush();
  assert.equal(ranges, 2); assert.equal(writes, 1);
  await assert.rejects(stage.flush()); assert.equal(writes, 1);
});

test("missing or uncertain external checkpoint never becomes initialization or automatic retry", async () => {
  let ranges = 0, writes = 0;
  const store = createEtcdCompletionCheckpointStoreV1({ binding, timeoutMs: 1000,
    range(_request, _deadline, callback) { ranges++; callback(null, fixture()); return { cancel() {} }; },
    txn(_request, _deadline, callback) { writes++; callback(new Error("response lost")); return { cancel() {} }; },
  });
  await assert.rejects(async () => store.advance(rollbackCheckpointDigestV1(checkpoint), { ...checkpoint, revision: 2 }));
  assert.equal(ranges, 1); assert.equal(writes, 1);
  const missing = createEtcdCompletionCheckpointStoreV1({ binding, timeoutMs: 1000,
    range(_request, _deadline, callback) { callback(null, { ...fixture(), count: "0", kvs: [] }); return { cancel() {} }; },
    txn() { throw new Error("must not dispatch"); },
  });
  await assert.rejects(async () => missing.read(binding.scope), /record_unavailable/);
});

test("exact record retains large revisions and copies original CAS bytes", () => {
  const response = fixture();
  const result = parseEtcdCheckpointRecord(response, binding);
  assert.deepEqual(result.checkpoint, checkpoint);
  assert.equal(result.modRevision, "9007199254740994");
  assert.deepEqual(result.value, response.kvs[0].value);
  response.kvs[0].value.fill(0);
  assert.equal(JSON.parse(result.value.toString()).scope, binding.scope);
});

test("missing, multiple, truncated, leased, replaced or wrong-scope records fail", () => {
  const mutations: ((value: ReturnType<typeof fixture>) => void)[] = [
    v => { v.kvs = []; v.count = "0"; },
    v => { v.kvs.push(v.kvs[0]); v.count = "2"; },
    v => { v.more = true; },
    v => { v.kvs[0].lease = "3"; },
    v => { v.header.cluster_id = "7"; },
    v => { v.kvs[0].create_revision = "9007199254740994"; },
    v => { v.kvs[0].key = Buffer.from("other/key"); },
    v => { v.kvs[0].value = Buffer.from(JSON.stringify({ ...checkpoint, scope: "other:scope" })); },
    v => { v.kvs[0].value = Buffer.from([0xff]); },
    v => { v.kvs[0].value = Buffer.alloc(4097); },
    v => { v.kvs[0].mod_revision = "1"; },
    v => { v.kvs[0].mod_revision = "9007199254740996"; },
    v => { v.kvs[0].version = "0"; },
    v => { v.header.cluster_id = "18446744073709551616"; },
    v => { v.header.revision = "9223372036854775808"; },
    v => { v.header.revision = "09007199254740995"; },
  ];
  for (const mutate of mutations) {
    const response = fixture(); mutate(response);
    assert.throws(() => parseEtcdCheckpointRecord(response, binding), /^Error: checkpoint_record_unavailable$/);
  }
});

test("invalid trusted generation is never learned from a response", () => {
  for (const createRevision of ["0", "1", "9007199254740993.0"]) {
    assert.throws(() => parseEtcdCheckpointRecord(fixture(), { ...binding, createRevision }));
  }
});

test("advance compares exact original bytes, generation, revision and lease with no failure write", () => {
  const response = fixture();
  response.kvs[0].value = Buffer.from(JSON.stringify(checkpoint, null, 2));
  const request = prepareEtcdCheckpointAdvance({ response, binding,
    expectedDigest: rollbackCheckpointDigestV1(checkpoint), next: { ...checkpoint, revision: 2 } });
  assert.deepEqual(request.compare.map(item => item.target), [1, 2, 3, 4]);
  assert.ok(request.compare.every(item => item.result === 0 && item.key.equals(binding.key)));
  assert.deepEqual(request.compare[2].value, response.kvs[0].value);
  assert.equal(request.compare[0].create_revision, binding.createRevision);
  assert.equal(request.compare[1].mod_revision, response.kvs[0].mod_revision);
  assert.equal(request.compare[3].lease, "0");
  assert.equal(request.success.length, 1);
  assert.deepEqual(request.failure, []);
  response.kvs[0].value.fill(0);
  assert.equal(JSON.parse(request.compare[2].value!.toString()).revision, 1);
  assert.equal(JSON.parse(request.success[0].request_put.value.toString()).revision, 2);
});

test("advance refuses stale digest, wrong scope, skipped and repeated revisions", () => {
  const expectedDigest = rollbackCheckpointDigestV1(checkpoint);
  const base = { response: fixture(), binding, expectedDigest, next: { ...checkpoint, revision: 2 } };
  const variants = [
    { ...base, expectedDigest: `sha256:${"c".repeat(64)}` },
    { ...base, next: { ...base.next, scope: "other:scope" } },
    { ...base, next: { ...base.next, revision: 1 } },
    { ...base, next: { ...base.next, revision: 3 } },
  ];
  for (const input of variants) assert.throws(() => prepareEtcdCheckpointAdvance(input), /^Error: checkpoint_advance_unavailable$/);
});

test("single-Put receipt requires correct cluster and strictly newer revision", () => {
  const receipt = { header: { cluster_id: binding.clusterId, revision: "9007199254740995" },
    succeeded: true, responses: [{ response: "response_put", response_put: {} }] };
  assert.equal(parseEtcdCheckpointAdvanceReceipt(receipt, binding.clusterId, "9007199254740994"), "9007199254740995");
  const invalid = [
    { ...receipt, succeeded: false }, { ...receipt, responses: [] },
    { ...receipt, responses: [...receipt.responses, ...receipt.responses] },
    { ...receipt, header: { ...receipt.header, cluster_id: "1" } },
    { ...receipt, header: { ...receipt.header, revision: "9007199254740994" } },
    { ...receipt, header: { ...receipt.header, revision: 9007199254740996 } },
    { ...receipt, responses: [{ response: "response_range", response_range: {} }] },
    { ...receipt, responses: [{ ...receipt.responses[0], response_txn: {} }] },
    { ...receipt, responses: [{ response: "response_put", response_put: null }] },
  ];
  for (const value of invalid) assert.throws(() => parseEtcdCheckpointAdvanceReceipt(value, binding.clusterId, "9007199254740994"),
    /^Error: checkpoint_advance_uncertain$/);
});

test("access joins exact read, conditional update and receipt under one deadline", async () => {
  const deadlines: number[] = [];
  let writes = 0;
  const access = createEtcdCheckpointAccess({ binding, timeoutMs: 1000,
    range: (request, deadline, callback) => {
      deadlines.push(deadline);
      assert.deepEqual(request, { key: binding.key, limit: "1", serializable: false });
      callback(null, fixture()); return { cancel() {} };
    },
    txn: (request, deadline, callback) => {
      writes++; deadlines.push(deadline);
      assert.deepEqual(request.failure, []);
      assert.equal(JSON.parse(request.success[0].request_put.value.toString()).revision, 2);
      callback(null, { header: { cluster_id: binding.clusterId, revision: "9007199254740995" },
        succeeded: true, responses: [{ response: "response_put", response_put: {} }] });
      return { cancel() {} };
    },
  });
  await access.advance(rollbackCheckpointDigestV1(checkpoint), { ...checkpoint, revision: 2 }, new AbortController().signal);
  assert.equal(writes, 1);
  assert.ok(deadlines[1] <= deadlines[0]);
});

test("access refuses stale state before write and does not retry a failed comparison", async () => {
  for (const stale of [true, false]) {
    let writes = 0;
    const access = createEtcdCheckpointAccess({ binding, timeoutMs: 1000,
      range: (_request, _deadline, callback) => { callback(null, fixture()); return { cancel() {} }; },
      txn: (_request, _deadline, callback) => {
        writes++; callback(null, { succeeded: false, responses: [] }); return { cancel() {} };
      },
    });
    await assert.rejects(access.advance(stale ? "stale" : rollbackCheckpointDigestV1(checkpoint),
      { ...checkpoint, revision: 2 }, new AbortController().signal));
    assert.equal(writes, stale ? 0 : 1);
  }
});

test("canceled access cannot proceed from a late read into write", async () => {
  const controller = new AbortController();
  let writes = 0;
  let cancels = 0;
  const access = createEtcdCheckpointAccess({ binding, timeoutMs: 1000,
    range: (_request, _deadline, callback) => {
      controller.abort(); callback(null, fixture()); return { cancel() { cancels++; } };
    },
    txn: () => { writes++; return { cancel() {} }; },
  });
  await assert.rejects(access.advance(rollbackCheckpointDigestV1(checkpoint), { ...checkpoint, revision: 2 }, controller.signal));
  assert.equal(writes, 0); assert.equal(cancels, 1);
});

test("documented limitation: unchanged identity cannot detect a same-domain snapshot rollback", () => {
  const oldResponse = fixture();
  const older = parseEtcdCheckpointRecord(oldResponse, binding).checkpoint;
  const newer = { ...checkpoint, revision: 2, recordCount: 1 };
  // A current database can detect an old anchor by digest mismatch.
  assert.notEqual(rollbackCheckpointDigestV1(older), rollbackCheckpointDigestV1(newer));
  // If BOTH database and anchor are restored, their old digests match. Static
  // cluster/key identity is not an independent high-water mark. This passing
  // diagnostic demonstrates a missing deployment guarantee, not restore safety.
  assert.equal(rollbackCheckpointDigestV1(older), rollbackCheckpointDigestV1(checkpoint));
});
