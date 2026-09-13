import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { CODEX_SOURCE_TESTED_RESULT_CONTRACT_V1,
  projectSourceTestedCodexCompletedTurnV1 } from '../src/harness/codex-v1/completed-turn';

const binding = { threadId: 'thread:fixture', turnId: 'turn:fixture' };
const raw = (items: unknown[], status = 'completed') => JSON.stringify({ thread: {
  id: binding.threadId, turns: [{ id: binding.turnId, status, items }],
} });
const project = (items: unknown[]) => projectSourceTestedCodexCompletedTurnV1({ ...binding, rawResult: raw(items) });

test('source-tested contract cannot be mistaken for canonical evidence', () => {
  assert.equal(CODEX_SOURCE_TESTED_RESULT_CONTRACT_V1.exactPackageQualified, false);
  assert.equal(CODEX_SOURCE_TESTED_RESULT_CONTRACT_V1.canonicalPublicationAllowed, false);
  assert.equal(CODEX_SOURCE_TESTED_RESULT_CONTRACT_V1.maximumResultBytes, 65_536);
});

test('projects the last eligible agent message without normalizing exact bytes', () => {
  const result = project([
    { type: 'userMessage', id: 'item:user', text: 'do not copy' },
    { type: 'agentMessage', id: 'item:commentary', phase: 'commentary', text: 'working' },
    { type: 'reasoning', id: 'item:reasoning', text: 'private reasoning' },
    { type: 'agentMessage', id: 'item:old', text: 'older answer' },
    { type: 'agentMessage', id: 'item:final', phase: 'final_answer', text: '  exact result\n' },
    { type: 'commandExecution', id: 'item:tool', text: 'tempting tool output' },
  ]);
  assert.equal(result.text, '  exact result\n');
  assert.equal(result.itemId, 'item:final');
  assert.equal(result.phase, 'final_answer');
  assert.equal(result.contentHash, `sha256:${createHash('sha256').update(Buffer.from(result.text)).digest('hex')}`);
  assert.equal(result.sizeBytes, Buffer.byteLength(result.text));
  assert.equal(result.exactPackageQualified, false);
  assert.equal(result.canonicalPublicationAllowed, false);
  assert.equal(result.completionVerified, false);
});

test('last result wins while trailing commentary never wins', () => {
  assert.equal(project([{ type: 'agentMessage', id: 'item:first', text: 'first' },
    { type: 'agentMessage', id: 'item:last', text: 'last' }]).text, 'last');
  assert.equal(project([{ type: 'agentMessage', id: 'item:final', phase: 'final_answer', text: 'final' },
    { type: 'agentMessage', id: 'item:comment', phase: 'commentary', text: 'after' }]).text, 'final');
});

test('repeat projection is deterministic and changed bytes change identity', () => {
  const first = project([{ type: 'agentMessage', id: 'item:final', text: 'same' }]);
  const replay = project([{ type: 'agentMessage', id: 'item:final', text: 'same' }]);
  const changed = project([{ type: 'agentMessage', id: 'item:final', text: 'different' }]);
  assert.deepEqual(replay, first);
  assert.notEqual(changed.contentHash, first.contentHash);
  assert.notEqual(changed.projectionDigest, first.projectionDigest);
});

test('refuses non-completed, missing and foreign turns', () => {
  for (const status of ['inProgress', 'failed', 'interrupted']) assert.throws(() =>
    projectSourceTestedCodexCompletedTurnV1({ ...binding, rawResult: raw([
      { type: 'agentMessage', id: 'item:final', text: 'not eligible' }], status) }), /projection_unavailable/);
  assert.throws(() => projectSourceTestedCodexCompletedTurnV1({ ...binding,
    rawResult: JSON.stringify({ thread: { id: binding.threadId, turns: [] } }) }), /projection_unavailable/);
  assert.throws(() => projectSourceTestedCodexCompletedTurnV1({ ...binding,
    rawResult: JSON.stringify({ thread: { id: 'thread:foreign', turns: [{ id: binding.turnId,
      status: 'completed', items: [{ type: 'agentMessage', id: 'item:final', text: 'foreign' }] }] } }) }), /projection_unavailable/);
});

test('refuses duplicate identities and malformed agent messages', () => {
  const turn = { id: binding.turnId, status: 'completed', items: [{ type: 'agentMessage', id: 'item:final', text: 'x' }] };
  assert.throws(() => projectSourceTestedCodexCompletedTurnV1({ ...binding,
    rawResult: JSON.stringify({ thread: { id: binding.threadId, turns: [turn, turn] } }) }), /projection_unavailable/);
  for (const items of [
    [{ type: 'agentMessage', id: 'item:same', text: 'one' }, { type: 'reasoning', id: 'item:same', text: 'two' }],
    [{ type: 'agentMessage', id: 'item:final', text: 4 }],
    [{ type: 'agentMessage', id: 'item:final', phase: 'unknown', text: 'x' }],
    [{ type: 'agentMessage', id: '', text: 'x' }],
  ]) assert.throws(() => project(items), /projection_unavailable/);
});

test('refuses absent, commentary-only, empty and malformed Unicode results', () => {
  for (const items of [
    [{ type: 'reasoning', id: 'item:reasoning', text: 'not output' }],
    [{ type: 'agentMessage', id: 'item:comment', phase: 'commentary', text: 'not final' }],
    [{ type: 'agentMessage', id: 'item:final', text: '' }],
    [{ type: 'agentMessage', id: 'item:final', text: ' \n\t ' }],
    [{ type: 'agentMessage', id: 'item:final', text: '\ud800' }],
    [{ type: 'agentMessage', id: 'item:final', text: '\udc00' }],
  ]) assert.throws(() => project(items), /projection_unavailable/);
});

test('accepts exactly 65,536 UTF-8 bytes and refuses one more', () => {
  assert.equal(project([{ type: 'agentMessage', id: 'item:final', text: 'x'.repeat(65_536) }]).sizeBytes, 65_536);
  assert.throws(() => project([{ type: 'agentMessage', id: 'item:final', text: 'x'.repeat(65_537) }]), /projection_unavailable/);
});

test('refuses oversized reads, item floods and selected secrets', () => {
  assert.throws(() => projectSourceTestedCodexCompletedTurnV1({ ...binding,
    rawResult: JSON.stringify({ thread: { id: binding.threadId, turns: [{ id: binding.turnId,
      status: 'completed', items: [{ type: 'agentMessage', id: 'item:final', text: 'x' }], padding: 'x'.repeat(262_144) }] } })
  }), /projection_unavailable/);
  assert.throws(() => project(Array.from({ length: 1_025 }, (_, index) => ({ type: 'reasoning', id: `item:${index}` }))), /projection_unavailable/);
  assert.throws(() => project([{ type: 'agentMessage', id: 'item:final',
    text: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature' }]), /projection_unavailable/);
});

test('never copies secret-like text from ignored non-agent items', () => {
  const result = project([{ type: 'reasoning', id: 'item:private', text: 'Authorization: Bearer private-private-private' },
    { type: 'agentMessage', id: 'item:final', text: 'safe result' }]);
  assert.equal(result.text, 'safe result');
  assert.doesNotMatch(JSON.stringify(result), /private-private/);
});
