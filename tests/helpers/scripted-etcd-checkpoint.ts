import assert from "node:assert/strict";
import { createEtcdCompletionCheckpointStoreV1 } from "../../src/completion-gate/v1/etcd-checkpoint-store";
import { parseRollbackCheckpointV1, type RollbackCheckpointV1 } from "../../src/security/rollback-checkpoint";

/** Test-only scripted RPC peer, not etcd qualification or durable storage.
 * Implements the exact requested comparisons so tests cannot accept every CAS.
 * Provisioning is an explicit seed from a separate test-only bootstrap step.
 */
export function scriptedEtcdCheckpoint(initial: RollbackCheckpointV1) {
  const binding = { clusterId: "17", createRevision: "1", key: Buffer.from("test/completion-checkpoint"), scope: initial.scope };
  let bytes = Buffer.from(JSON.stringify(parseRollbackCheckpointV1(initial))), revision = 1, version = 1;
  let reads = 0, writes = 0, loseNextReply = false;
  const open = () => createEtcdCompletionCheckpointStoreV1({ binding, timeoutMs: 1000,
    range(request, _deadline, callback) {
      reads++; assert.deepEqual(request.key, binding.key); assert.equal(request.serializable, false);
      callback(null, { header: { cluster_id: binding.clusterId, revision: String(revision) }, count: "1", more: false,
        kvs: [{ key: Buffer.from(binding.key), value: Buffer.from(bytes), create_revision: "1", mod_revision: String(revision), version: String(version), lease: "0" }] });
      return { cancel() {} };
    },
    txn(request, _deadline, callback) {
      assert.deepEqual(request.compare, [
        { key: binding.key, result: 0, target: 1, create_revision: "1" },
        { key: binding.key, result: 0, target: 2, mod_revision: String(revision) },
        { key: binding.key, result: 0, target: 3, value: bytes },
        { key: binding.key, result: 0, target: 4, lease: "0" },
      ]);
      assert.deepEqual(request.failure, []); assert.equal(request.success.length, 1);
      const put = request.success[0].request_put;
      assert.deepEqual(put.key, binding.key); assert.equal(put.lease, "0");
      const next = parseRollbackCheckpointV1(JSON.parse(put.value.toString()));
      assert.equal(next.scope, initial.scope);
      assert.equal(next.revision, parseRollbackCheckpointV1(JSON.parse(bytes.toString())).revision + 1);
      bytes = Buffer.from(put.value); revision++; version++; writes++;
      if (loseNextReply) { loseNextReply = false; callback(new Error("scripted lost acknowledgement")); }
      else callback(null, { header: { cluster_id: binding.clusterId, revision: String(revision) }, succeeded: true,
        responses: [{ response: "response_put", response_put: {} }] });
      return { cancel() {} };
    },
  });
  return { open, stats: () => ({ reads, writes }), loseNextWriteReply: () => { loseNextReply = true; },
    checkpoint: () => parseRollbackCheckpointV1(JSON.parse(bytes.toString())) };
}
