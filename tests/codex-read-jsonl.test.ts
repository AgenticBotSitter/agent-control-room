import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexReadJsonl } from '../src/harness/codex-v1/read-jsonl';

const make = () => createCodexReadJsonl({ threadId: 'thread:fixture', turnId: 'turn:fixture' });
const ready = () => {
  const session = make(); assert.equal(JSON.parse(session.initialize()).method, 'initialize');
  assert.deepEqual(session.receive('{"id":1,"result":{}}'), { kind: 'initialized' });
  assert.equal(JSON.parse(session.initialized()).method, 'initialized');
  assert.deepEqual(JSON.parse(session.read()), { id: 2, method: 'thread/read', params: { threadId: 'thread:fixture', includeTurns: true } });
  return session;
};
test('one-shot JSONL profile correlates an exact read and exposes no execution method', () => {
  const session = ready();
  assert.deepEqual(Object.keys(session).sort(), ['disconnect', 'initialize', 'initialized', 'read', 'receive']);
  assert.deepEqual(session.receive('{"method":"unrelated","params":{"text":"private"}}'), { kind: 'ignored_notification' });
  const response = session.receive(JSON.stringify({ id: 2, result: { thread: { id: 'thread:fixture',
    turns: [{ id: 'turn:fixture', status: 'completed' }] } } }));
  assert.equal(response.kind, 'observation');
  if (response.kind === 'observation') assert.equal(response.observation.completionVerified, false);
  assert.throws(() => session.read());
});
test('bad correlation, server requests, error replies and disconnect are terminal', () => {
  for (const line of ['{"id":1,"result":{}}', '{"id":2,"method":"command/exec","params":{}}',
    '{"id":2,"error":{"code":1,"message":"private"}}', '{"id":2,"result":{},"jsonrpc":"2.0"}',
    '{', '{}\n', 'x'.repeat(262145)]) {
    const session = ready();
    assert.throws(() => session.receive(line), /codex_read_session_unavailable/);
    assert.throws(() => session.initialize());
  }
  const session = ready(); assert.equal(session.disconnect().hadPendingRead, true);
  assert.throws(() => session.receive('{"id":2,"result":{}}'));
  const unordered = make(); assert.throws(() => unordered.read()); assert.throws(() => unordered.initialize());
  const flood = ready();
  for (let n = 0; n < 64; n++) flood.receive('{"method":"ignored"}');
  assert.throws(() => flood.receive('{"method":"ignored"}'));
});
