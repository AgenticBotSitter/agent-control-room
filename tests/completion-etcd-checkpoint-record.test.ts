import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEtcdCheckpointRecord } from "../src/completion-gate/v1/etcd-checkpoint-record";
import { ROLLBACK_CHECKPOINT_SCHEMA_V1 } from "../src/security/rollback-checkpoint";

const binding = { clusterId: "18446744073709551615", createRevision: "9007199254740993",
  key: Buffer.from("synthetic/checkpoint"), scope: "completion-gate:synthetic" };
const checkpoint = { schema: ROLLBACK_CHECKPOINT_SCHEMA_V1, scope: binding.scope, revision: 1,
  recordCount: 0, stateDigest: `sha256:${"a".repeat(64)}`, stateAuthTag: `hmac-sha256:${"b".repeat(64)}` };
function fixture() {
  return { header: { cluster_id: binding.clusterId, revision: "9007199254740995" }, count: "1", more: false,
    kvs: [{ key: Buffer.from(binding.key), value: Buffer.from(JSON.stringify(checkpoint)),
      create_revision: binding.createRevision, mod_revision: "9007199254740994", version: "1", lease: "0" }] };
}

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
