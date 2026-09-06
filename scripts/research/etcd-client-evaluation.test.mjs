import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// Isolated, explicitly supplied package; no client constructor or network connection.
const root = process.env.CR_ETCD_EVAL_ROOT;
assert.ok(root, 'Set CR_ETCD_EVAL_ROOT to the logged evaluation directory');
const require = createRequire(`${root}/package.json`);
const { ConnectionPool } = require('etcd3/lib/connection-pool');
const { EtcdInvalidAuthTokenError } = require('etcd3/lib/errors');

function poolFor(txn) {
  const pool = Object.create(ConnectionPool.prototype);
  pool.globalPolicy = { execute: (work) => work() };
  pool.shuffledHosts = function* () {};
  pool.withConnection = async (_service, work) => work({ client: { txn }, metadata: {} });
  pool.authenticator = { invalidateMetadata() {} };
  return pool;
}

test('unary wrapper preserves deadline but does not expose call cancellation', async () => {
  let reply;
  let cancellations = 0;
  const deadline = Date.now() + 1000;
  const pool = poolFor((_payload, _metadata, options, callback) => {
    assert.equal(options.deadline, deadline);
    reply = callback;
    return { cancel() { cancellations++; } };
  });
  const pending = pool.exec('KV', 'txn', {}, { deadline });
  assert.equal(typeof pending.cancel, 'undefined');
  reply(null, { succeeded: true });
  assert.deepEqual(await pending, { succeeded: true });
  assert.equal(cancellations, 0);
});

test('invalid auth token reissues unary call despite pass-through global policy', async () => {
  let calls = 0;
  const pool = poolFor((_payload, _metadata, _options, reply) => {
    calls++;
    if (calls === 1) reply(new EtcdInvalidAuthTokenError('synthetic invalid token'));
    else reply(null, { succeeded: true });
  });
  assert.deepEqual(await pool.exec('KV', 'txn', {}), { succeeded: true });
  assert.equal(calls, 2);
});
