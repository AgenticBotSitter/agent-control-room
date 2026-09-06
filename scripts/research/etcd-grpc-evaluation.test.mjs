import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { boundedCheckpointCall, CheckpointCallError } from '../../src/completion-gate/v1/bounded-checkpoint-call.ts';
import { parseEtcdCheckpointRecord } from '../../src/completion-gate/v1/etcd-checkpoint-record.ts';

const root = process.env.CR_ETCD_EVAL_ROOT;
assert.ok(root, 'Set CR_ETCD_EVAL_ROOT to the logged evaluation directory');
const require = createRequire(`${root}/package.json`);
const grpc = require('@grpc/grpc-js');
const loader = require('@grpc/proto-loader');
const definitions = loader.loadSync(`${root}/node_modules/etcd3/proto/rpc.proto`, {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true,
});
const { KV } = grpc.loadPackageDefinition(definitions).etcdserverpb;

function fixture() {
  const calls = [];
  let closed = 0;
  const channel = {
    close() { closed++; },
    createCall(method, deadline) {
      const entry = { method, deadline, cancellations: [] };
      calls.push(entry);
      return {
        start(_metadata, listener) { entry.listener = listener; },
        startRead() {},
        halfClose() {},
        sendMessageWithContext(_context, bytes) { entry.request = bytes; },
        cancelWithStatus(code, details) {
          entry.cancellations.push(code);
          entry.listener.onReceiveStatus({ code, details, metadata: new grpc.Metadata() });
        },
      };
    },
  };
  // Channel override means no real channel, resolver, socket or credential access.
  const client = new KV('offline.invalid', grpc.credentials.createInsecure(), {
    channelOverride: channel, 'grpc.enable_retries': 0,
  });
  return { client, calls, closed: () => closed };
}

test('generated transaction exposes per-call cancel without closing another request', () => {
  const f = fixture();
  try {
    const results = [];
    const deadline = Date.now() + 1000;
    const first = f.client.txn({}, { deadline }, (error) => results.push(error.code));
    f.client.txn({}, { deadline }, (error) => results.push(error?.code ?? 'ok'));
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].deadline, deadline);
    assert.equal(f.calls[0].method, '/etcdserverpb.KV/Txn');
    first.cancel();
    assert.deepEqual(results, [grpc.status.CANCELLED]);
    assert.deepEqual(f.calls[1].cancellations, []);
    f.calls[1].listener.onReceiveMessage(KV.service.Txn.responseSerialize({ succeeded: true }));
    f.calls[1].listener.onReceiveStatus({ code: grpc.status.OK, metadata: new grpc.Metadata() });
    assert.deepEqual(results, [grpc.status.CANCELLED, 'ok']);
    assert.equal(f.closed(), 0);
  } finally { f.client.close(); }
  assert.equal(f.closed(), 1);
});

test('generated wrapper does not reissue an invalid-auth status', () => {
  const f = fixture();
  try {
    let result;
    f.client.txn({}, { deadline: Date.now() + 1000 }, (error) => { result = error; });
    f.calls[0].listener.onReceiveStatus({
      code: grpc.status.UNAUTHENTICATED, details: 'etcdserver: invalid auth token',
      metadata: new grpc.Metadata(),
    });
    assert.equal(result.code, grpc.status.UNAUTHENTICATED);
    assert.equal(f.calls.length, 1);
  } finally { f.client.close(); }
});

test('upstream transaction codec preserves uint64 identity and byte comparisons', () => {
  const wire = KV.service.Txn;
  const key = Buffer.from('synthetic-checkpoint');
  const request = wire.requestDeserialize(wire.requestSerialize({
    compare: [{ key, target: 'VALUE', result: 'EQUAL', value: Buffer.from('prior') }],
    success: [{ request_put: { key, value: Buffer.from('next') } }],
  }));
  assert.deepEqual(request.compare[0].key, key);
  assert.equal(request.compare[0].value.toString(), 'prior');
  assert.equal(request.success[0].request_put.value.toString(), 'next');
  const decoded = wire.responseDeserialize(wire.responseSerialize({
    header: { cluster_id: '18446744073709551615', revision: '9007199254740993' },
    succeeded: false,
  }));
  assert.equal(decoded.header.cluster_id, '18446744073709551615');
  assert.equal(decoded.header.revision, '9007199254740993');
  assert.equal(decoded.succeeded, false);
});

test('Control Room abort reaches actual generated unary cancellation', async () => {
  const f = fixture();
  const controller = new AbortController();
  try {
    const pending = boundedCheckpointCall({ signal: controller.signal, timeoutMs: 1000,
      dispatch: (deadline, callback) => f.client.txn({}, { deadline }, callback),
    });
    controller.abort();
    await assert.rejects(pending, (error) => error instanceof CheckpointCallError && error.outcome === 'uncertain');
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].cancellations, [grpc.status.CANCELLED]);
    assert.equal(f.closed(), 0);
  } finally { f.client.close(); }
});

test('checkpoint record parser accepts actual upstream Range decoding', () => {
  const binding = { key: Buffer.from('synthetic/checkpoint'), scope: 'completion-gate:synthetic',
    clusterId: '18446744073709551615', createRevision: '9007199254740993' };
  const checkpoint = { schema: 'control-room-rollback-checkpoint/v1', scope: binding.scope,
    revision: 1, recordCount: 0, stateDigest: `sha256:${'a'.repeat(64)}`,
    stateAuthTag: `hmac-sha256:${'b'.repeat(64)}` };
  const codec = KV.service.Range;
  const response = codec.responseDeserialize(codec.responseSerialize({
    header: { cluster_id: binding.clusterId, revision: binding.createRevision }, count: '1',
    kvs: [{ key: binding.key, value: Buffer.from(JSON.stringify(checkpoint)),
      create_revision: binding.createRevision, mod_revision: binding.createRevision, version: '1' }],
  }));
  assert.deepEqual(parseEtcdCheckpointRecord(response, binding).checkpoint, checkpoint);
});
