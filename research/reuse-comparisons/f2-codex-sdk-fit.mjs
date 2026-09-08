// Actual SDK Thread parser + actual Control Room decoder/result projector.
// Execution port is synthetic. Never construct Codex/CodexExec or spawn a process.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeCodexJsonLineV1 } from '../../src/harness/codex-v1/decoder.ts';
import { projectCodexRunResultV1 } from '../../src/harness/codex-v1/result.ts';
const root = process.argv[2];
assert.match(root ?? '', /^\/private\/tmp\/cr-compare-f2\.[A-Za-z0-9]+$/);
assert.equal(createHash('sha512').update(await readFile(join(root, 'codex-sdk.tgz'))).digest('hex'), 'cf4acdf16310c70107607a4327228767034d52d33fd69767c662a8a48277a8c099cb20deb2d688852183674bf44528e6f9112e8dc17235df79a16b3bf335a046');
assert.equal(createHash('sha256').update(await readFile(join(root, 'package/dist/index.js'))).digest('hex'), 'd62ed107033bdba802b283c77d875e4bec3deb2704a910bb7e3f95059473b16f');
const { Thread } = await import(pathToFileURL(join(root, 'package/dist/index.js')));
const threadId = '11111111-1111-4111-8111-111111111111';
const frames = [
  { type: 'thread.started', thread_id: threadId },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'fixture-message', type: 'agent_message', text: 'Disposable research result' } },
  { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 } },
];
const calls = [];
const make = (events, id = null) => new Thread({ async *run(args) { calls.push(args); for (const event of events) yield typeof event === 'string' ? event : JSON.stringify(event); } }, {}, { sandboxMode: 'read-only', networkAccessEnabled: false }, id);
const project = async thread => {
  const events = []; let finalTextDigest;
  const { events: stream } = await thread.runStreamed('Synthetic input only');
  for await (const frame of stream) {
    const decoded = decodeCodexJsonLineV1(JSON.stringify(frame), { tenantId: 'tenant:fixture', nodeId: 'node:fixture', runId: 'run:fixture', sequence: events.length + 1, occurredAt: '2026-09-08T00:00:00.000Z' });
    events.push(...decoded.events);
    finalTextDigest = decoded.finalTextDigest ?? finalTextDigest;
  }
  return projectCodexRunResultV1({ tenantId: 'tenant:fixture', runId: 'run:fixture', events, finalTextDigest });
};
const checks = [];
const native = make(frames);
const result = await project(native);
assert.equal(result.terminalState, 'succeeded');
assert.equal(result.usage.inputTokens, 10);
assert.equal(result.usage.outputTokens, 4);
// Existing protocol hashes canonical JSON, including string quotes, not raw text.
assert.equal(result.finalTextDigest, `sha256:${createHash('sha256').update(JSON.stringify('Disposable research result')).digest('hex')}`);
assert.equal(native.id, threadId);
checks.push('actual SDK stream crosses current decoder and scoped result projector');
await native.run('second synthetic turn');
assert.equal(calls.at(-1).threadId, threadId);
checks.push('observed thread ID is passed into subsequent synthetic execution');
const truncated = frames.slice(0, -1);
assert.equal((await make(truncated).run('fixture')).usage, null);
await assert.rejects(project(make(truncated)), /missing terminal state/);
checks.push('SDK EOF returns partial result; current projector refuses missing terminal evidence');
await assert.rejects(make(['not-json']).run('fixture'), /Failed to parse/);
checks.push('actual SDK malformed event parsing fails');
await assert.rejects(make([{ type: 'turn.failed', error: { message: 'synthetic failure' } }]).run('fixture'), /synthetic failure/);
checks.push('actual SDK turn failure surfaces');
await assert.rejects(project(make([...frames, frames.at(-1)])), /after terminal state/);
checks.push('current result projector rejects duplicate terminal after SDK stream parsing');
await assert.rejects(project(make([{ type: 'thread.started', thread_id: 'untrusted-label' }, ...frames.slice(1)])));
checks.push('current decoder validates native thread identity beyond SDK assignment');
const controller = new AbortController(); controller.abort();
await make([]).run('fixture', { signal: controller.signal });
assert.equal(calls.at(-1).signal, controller.signal);
checks.push('abort signal forwards to synthetic execution port; cancellation NOT qualified');
console.log(JSON.stringify({ sdk: '0.153.4', checks, scope: 'actual parser and application projection; synthetic execution port; no SDK transport/native runtime/credentials', nativeCalls: 0 }, null, 2));
