import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { runHandoff, parseHandoff, parseHandoffCommand } from '../scripts/review-handoff-controller.mjs';
import { readWorkerInbox, renderWorkerInbox } from '../scripts/public-worker-inbox.mjs';
import { parseClaimPacket } from '../scripts/automatic-claim-controller.mjs';

const sha = 'a'.repeat(40);
const repository = 'example/project';
const NOW = 1_700_000_000_000;
// Production issue body: exactly one work packet. The accepted claim binds its
// hash, so the handoff's current-authority gate can be exercised against a real
// packet rather than a marker-only stub.
const PACKET = Object.freeze({ target: 'main', base: sha, writeScopes: ['src/owned-scope.ts'],
  dependencies: [], checks: ['pnpm check'], risk: 'low', effects: 'none', leaseHours: 1 });
const PACKET_BODY = `Work packet.\n\n<!-- acr-public-work:v1 ${JSON.stringify(PACKET)}\n-->`;
const PACKET_HASH = createHash('sha256').update(JSON.stringify(PACKET)).digest('hex');
const claimMarker = accepted => [
  `<!-- agent-control-room-claim:v2 issue=1 request=9 actor=builder worker=worker-01 -->`,
  `<!-- agent-control-room-claim:v3 issue=1 request=9 actor=builder worker=worker-01 packet=${PACKET_HASH} accepted=${accepted} -->`,
];
function fixture() {
  const issue = { number: 1, state: 'open', labels: ['status:working', 'platform:any'], body: PACKET_BODY };
  const prIssue = { number: 2, state: 'open', labels: ['help wanted'] };
  const pr = { state: 'open', body: 'Control-Room-Issue: 1', head: { sha }, user: { login: 'builder' }, base: { repo: { full_name: repository } } };
  const comments = [{ id: 10, user: { login: 'github-actions[bot]', type: 'Bot' },
    body: `CLAIM ACCEPTED — worker\n${claimMarker(NOW).join('\n')}` }];
  let id = 20;
  const mutations = [];
  let fault;
  let onGet;
  const api = async (method, path, body) => {
    const number = Number(/comments\/(\d+)/.exec(path)?.[1]);
    if (method === 'GET') {
      if (path.includes('/comments?') && onGet) await onGet(method, path);
      if (path.includes('/comments?')) return structuredClone(comments);
      if (number) return structuredClone(comments.find(c => c.id === number));
      if (path.includes('/pulls/')) return structuredClone(pr);
      return structuredClone(path.endsWith('/1') ? issue : prIssue);
    }
    mutations.push({ method, path, body });
    if (fault?.before && fault.matches(method, path)) { const f = fault; fault = undefined; f.change?.(); throw new Error('offline'); }
    let result;
    if (method === 'POST' && path.endsWith('/comments')) { result = { id: ++id, user: { login: 'github-actions[bot]', type: 'Bot' }, body: body.body }; comments.push(result); }
    if (method === 'POST' && path.endsWith('/labels')) { result = path.includes('/issues/1/') ? issue : prIssue; result.labels = [...new Set([...result.labels, ...body.labels])]; }
    if (method === 'DELETE') { result = path.includes('/issues/1/') ? issue : prIssue; result.labels = result.labels.filter(label => label !== decodeURIComponent(path.split('/').at(-1))); }
    if (method === 'PATCH') { result = comments.find(c => c.id === number); result.body = body.body; }
    if (method === 'PUT') { result = path.includes('/issues/1/') ? issue : prIssue; result.labels = body.labels; }
    if (fault && fault.matches(method, path)) { const f = fault; fault = undefined; f.change?.(); throw new Error('reply-lost'); }
    return structuredClone(result);
  };
  const eventFor = (command, actor = 'builder', previousId = 0, instruction, options = {}) => {
    const workerId = options.workerId ?? 'worker-01';
    const claimWorkerLine = options.claimWorkerId ? `claim-worker-id: ${options.claimWorkerId}\n` : '';
    const comment = { id: ++id, user: { login: actor }, issue_url: `https://api.github.com/repos/${repository}/issues/1`,
      html_url: `https://github.com/${repository}/issues/1#issuecomment-${id}`,
      body: `HANDOFF ${command}\nworker-id: ${workerId}\n${claimWorkerLine}pr: 2\nhead: ${options.head ?? pr.head.sha}\nprevious: ${previousId}${instruction ? `\n\n${instruction}` : ''}` };
    comments.push(comment);
    return { action: 'created', sender: { login: actor }, issue: { number: 1 }, comment };
  };
  // Production runs on the wall clock; the fixture pins `now` so the one-hour
  // lease is deterministic and expiry is testable without waiting.
  const run = event => runHandoff({ event, repository, api, maintainers: ['reviewer'], now: NOW });
  return { issue, prIssue, pr, comments, mutations, run, eventFor,
    setFault(value) { fault = value; },
    onRead(value) { onGet = value; } };
}

test('full submission, corrections, acknowledgment, revision, acceptance cycle', async () => {
  const f = fixture();
  let result = await f.run(f.eventFor('submit'));
  assert.equal(result.state, 'in-review');
  result = await f.run(f.eventFor('changes', 'reviewer', result.commentId));
  assert.equal(result.state, 'changes-required');
  await assert.rejects(f.run(f.eventFor('resubmit', 'builder', result.commentId)), /transition_invalid/);
  result = await f.run(f.eventFor('acknowledge', 'builder', result.commentId));
  assert.equal(parseHandoff(f.comments.find(c => c.id === result.commentId)).acknowledged, true);
  f.pr.head.sha = 'b'.repeat(40);
  result = await f.run(f.eventFor('resubmit', 'builder', result.commentId));
  assert.equal(result.state, 're-review');
  result = await f.run(f.eventFor('accept', 'reviewer', result.commentId));
  assert.equal(result.action, 'integrator');
  assert.deepEqual(f.issue.labels, ['platform:any', 'status:re-review', 'action:integrator']);
  assert.equal(f.issue.state, 'open');
});

test('worker can acknowledge the reviewed commit after pushing and resubmit only the current commit', async () => {
  const f = fixture();
  let result = await f.run(f.eventFor('submit'));
  result = await f.run(f.eventFor('changes', 'reviewer', result.commentId));
  f.pr.head.sha = 'b'.repeat(40);
  const before = f.mutations.length;
  await assert.rejects(f.run(f.eventFor('acknowledge', 'builder', result.commentId)), /review_head_changed/);
  await assert.rejects(f.run(f.eventFor('acknowledge', 'outsider', result.commentId, undefined, { head: sha })), /authority_denied/);
  assert.equal(f.mutations.length, before);
  result = await f.run(f.eventFor('acknowledge', 'builder', result.commentId, undefined, { head: sha }));
  const acknowledged = parseHandoff(f.comments.find(c => c.id === result.commentId));
  assert.equal(acknowledged.head, sha);
  assert.equal(acknowledged.acknowledged, true);
  const afterAcknowledgment = f.mutations.length;
  await assert.rejects(f.run(f.eventFor('resubmit', 'builder', result.commentId, undefined, { head: sha })), /target_changed/);
  assert.equal(f.mutations.length, afterAcknowledgment);
  result = await f.run(f.eventFor('resubmit', 'builder', result.commentId));
  assert.equal(result.state, 're-review');
  assert.equal(parseHandoff(f.comments.find(c => c.id === result.commentId)).head, f.pr.head.sha);
  const afterResubmit = f.mutations.length;
  await assert.rejects(f.run(f.eventFor('accept', 'reviewer', result.commentId, undefined, { head: sha })), /target_changed/);
  assert.equal(f.mutations.length, afterResubmit);
  result = await f.run(f.eventFor('accept', 'reviewer', result.commentId));
  assert.equal(result.action, 'integrator');
});

test('a changed submission can refresh review but cannot bypass authority or an accepted decision', async () => {
  const f = fixture();
  let result = await f.run(f.eventFor('submit'));
  const originalId = result.commentId;
  f.pr.head.sha = 'b'.repeat(40);
  const before = f.mutations.length;
  await assert.rejects(f.run(f.eventFor('resubmit', 'outsider', result.commentId)), /authority_denied/);
  await assert.rejects(f.run(f.eventFor('resubmit', 'builder', result.commentId, undefined, { head: sha })), /target_changed/);
  await assert.rejects(f.run(f.eventFor('accept', 'reviewer', result.commentId)), /review_head_changed/);
  assert.equal(f.mutations.length, before);
  result = await f.run(f.eventFor('resubmit', 'builder', result.commentId, 'Updated test registration; review this exact head.'));
  assert.equal(result.state, 're-review');
  assert.equal(result.action, 'reviewer');
  assert.equal(parseHandoff(f.comments.find(c => c.id === result.commentId)).head, f.pr.head.sha);
  await assert.rejects(f.run(f.eventFor('resubmit', 'builder', originalId)), /predecessor_changed/);
  result = await f.run(f.eventFor('accept', 'reviewer', result.commentId));
  f.pr.head.sha = 'c'.repeat(40);
  const acceptedMutations = f.mutations.length;
  await assert.rejects(f.run(f.eventFor('resubmit', 'builder', result.commentId)), /transition_invalid/);
  assert.equal(f.mutations.length, acceptedMutations);
});

test('a separate maintainer can accept an exact amended head with an explicit evidence note', async () => {
  const f = fixture();
  const submitted = await f.run(f.eventFor('submit'));
  f.pr.head.sha = 'b'.repeat(40);

  await assert.rejects(
    f.run(f.eventFor('accept', 'reviewer', submitted.commentId)),
    /review_head_changed/,
  );
  await assert.rejects(
    f.run(f.eventFor('accept-amendment', 'builder', submitted.commentId,
      'Documentation-only maintainer amendment reviewed at the exact new head.')),
    /authority_denied/,
  );
  assert.equal(parseHandoffCommand(
    `HANDOFF accept-amendment\nworker-id: worker-01\npr: 2\nhead: ${'b'.repeat(40)}\nprevious: ${submitted.commentId}`,
  ), undefined);

  const accepted = await f.run(f.eventFor('accept-amendment', 'reviewer', submitted.commentId,
    'Documentation-only maintainer amendment reviewed at the exact new head.'));
  assert.equal(accepted.action, 'integrator');
  const record = parseHandoff(f.comments.find(comment => comment.id === accepted.commentId));
  assert.equal(record.head, 'b'.repeat(40));
  assert.match(record.instruction, /exact new head/);
});

test('shared author cannot approve itself, even if configured maintainer', async () => {
  const f = fixture();
  const first = await f.run(f.eventFor('submit'));
  await assert.rejects(f.run(f.eventFor('accept', 'builder', first.commentId)), /authority_denied/);
  await assert.rejects(f.run(f.eventFor('acknowledge', 'outsider', first.commentId)), /authority_denied/);
});

test('separate maintainer can adopt a stranded legacy correction into the trusted controller', async () => {
  const f = fixture();
  f.issue.labels = ['platform:any', 'status:changes-required', 'action:worker'];
  f.comments.push({ id: 11, user: { login: 'builder', type: 'User' },
    body: '<!-- agent-control-room-action:v1 worker=worker-01 state=changes-required issue=1 -->' });
  const result = await f.run(f.eventFor('adopt-changes', 'reviewer', 0, 'Correct the exact four production failures listed here.',
    { claimWorkerId: 'worker-01' }));
  assert.equal(result.state, 'changes-required');
  assert.equal(result.action, 'worker');
  assert.deepEqual(f.prIssue.labels, ['help wanted', 'status:changes-required', 'action:worker']);
  const record = parseHandoff(f.comments.find(comment => comment.id === result.commentId));
  assert.equal(record.instruction, 'Correct the exact four production failures listed here.');
  const inbox = await readWorkerInbox({ workerId: 'worker-01', repository, fetchImpl: async url => ({ ok: true,
    json: async () => structuredClone(url.includes('/comments') ? f.comments : [f.issue]) }) });
  assert.equal(inbox[0].trust, 'controller-record');
  assert.equal(inbox[0].disposition, 'action');
  assert.match(renderWorkerInbox('worker-01', inbox), /Correct the exact four production failures/);
  assert.match(renderWorkerInbox('worker-01', inbox), /pull\/2/);
});

test('maintainer can adopt a legacy correction whose review predates the PR issue line', async () => {
  const f = fixture();
  f.pr.body = 'Outcome / issue: #1 — legacy contribution awaiting correction';
  f.issue.labels = ['platform:any', 'status:changes-required', 'action:worker'];
  f.comments.push({ id: 11, user: { login: 'builder', type: 'User' },
    body: '<!-- agent-control-room-action:v1 worker=worker-01 state=changes-required issue=1 -->' });
  f.comments.push({ id: 12, user: { login: 'reviewer', type: 'User' },
    body: `Maintainer re-review of PR #2 at ${sha}: correct the PR body and implementation.` });
  const result = await f.run(f.eventFor('adopt-changes', 'reviewer', 0,
    'Correct the reviewed failures and add the exact Control-Room-Issue line.', { claimWorkerId: 'worker-01' }));
  assert.equal(result.state, 'changes-required');
  assert.equal(parseHandoff(f.comments.find(comment => comment.id === result.commentId)).pr, 2);
  const acknowledged = await f.run(f.eventFor('acknowledge', 'builder', result.commentId));
  assert.equal(parseHandoff(f.comments.find(comment => comment.id === acknowledged.commentId)).acknowledged, true);
  f.pr.head.sha = 'b'.repeat(40);
  await assert.rejects(f.run(f.eventFor('resubmit', 'builder', acknowledged.commentId)), /pr_issue_mismatch/);
  f.pr.body = 'Control-Room-Issue: 1';
  const resubmitted = await f.run(f.eventFor('resubmit', 'builder', acknowledged.commentId));
  assert.equal(resubmitted.state, 're-review');
});

test('legacy adoption without a PR issue line requires one unambiguous legacy PR binding', async () => {
  const f = fixture();
  f.pr.body = 'Legacy contribution awaiting correction';
  f.issue.labels = ['platform:any', 'status:changes-required', 'action:worker'];
  f.comments.push({ id: 11, user: { login: 'builder', type: 'User' },
    body: '<!-- agent-control-room-action:v1 worker=worker-01 state=changes-required issue=1 -->' });
  await assert.rejects(f.run(f.eventFor('adopt-changes', 'reviewer', 0, 'details',
    { claimWorkerId: 'worker-01' })), /adoption_source_invalid/);
  f.pr.body = 'Closes #999';
  await assert.rejects(f.run(f.eventFor('adopt-changes', 'reviewer', 0, 'details',
    { claimWorkerId: 'worker-01' })), /adoption_source_invalid/);
  f.pr.body = 'Closes #1\nFixes #999';
  await assert.rejects(f.run(f.eventFor('adopt-changes', 'reviewer', 0, 'details',
    { claimWorkerId: 'worker-01' })), /adoption_source_invalid/);
  f.pr.body = 'Closes #1, Fixes #999';
  await assert.rejects(f.run(f.eventFor('adopt-changes', 'reviewer', 0, 'details',
    { claimWorkerId: 'worker-01' })), /adoption_source_invalid/);
  f.pr.body = 'Outcome / issue: #1; Resolves #999';
  await assert.rejects(f.run(f.eventFor('adopt-changes', 'reviewer', 0, 'details',
    { claimWorkerId: 'worker-01' })), /adoption_source_invalid/);
  f.pr.body = 'Legacy contribution awaiting correction';
  f.pr.title = 'Repair queue (issue #1) follow-up (issue #999)';
  await assert.rejects(f.run(f.eventFor('adopt-changes', 'reviewer', 0, 'details',
    { claimWorkerId: 'worker-01' })), /adoption_source_invalid/);
});

for (const legacyBinding of ['Closes #1', 'Fixes #1', 'Resolves #1', 'Outcome / issue: #1'])
  test(`legacy adoption recognizes explicit binding form: ${legacyBinding.split(' ')[0]}`, async () => {
    const f = fixture();
    f.pr.body = legacyBinding;
    f.issue.labels = ['platform:any', 'status:changes-required', 'action:worker'];
    f.comments.push({ id: 11, user: { login: 'builder', type: 'User' },
      body: '<!-- agent-control-room-action:v1 worker=worker-01 state=changes-required issue=1 -->' });
    const result = await f.run(f.eventFor('adopt-changes', 'reviewer', 0, 'details', { claimWorkerId: 'worker-01' }));
    assert.equal(result.state, 'changes-required');
  });

test('legacy outcome field ignores a later descriptive parent reference', async () => {
  const f = fixture();
  f.pr.body = 'Outcome / issue: #1 — authorized by parent #61.';
  f.pr.title = 'Legacy contribution (issue #1)';
  f.issue.labels = ['platform:any', 'status:changes-required', 'action:worker'];
  f.comments.push({ id: 11, user: { login: 'builder', type: 'User' },
    body: '<!-- agent-control-room-action:v1 worker=worker-01 state=changes-required issue=1 -->' });
  const result = await f.run(f.eventFor('adopt-changes', 'reviewer', 0, 'details', { claimWorkerId: 'worker-01' }));
  assert.equal(result.state, 'changes-required');
});

for (const acknowledgeFirst of [false, true]) test(`legacy adoption can stop safely ${acknowledgeFirst ? 'after acknowledgment' : 'immediately'}`, async () => {
  const f = fixture();
  f.pr.body = 'Closes #1';
  f.issue.labels = ['platform:any', 'status:changes-required', 'action:worker'];
  f.comments.push({ id: 11, user: { login: 'builder', type: 'User' },
    body: '<!-- agent-control-room-action:v1 worker=worker-01 state=changes-required issue=1 -->' });
  f.comments.push({ id: 12, user: { login: 'reviewer', type: 'User' },
    body: `Maintainer re-review of PR #2 at ${sha}: correct this pull request.` });
  let result = await f.run(f.eventFor('adopt-changes', 'reviewer', 0, 'Correct the reviewed failures.',
    { claimWorkerId: 'worker-01' }));
  if (acknowledgeFirst) result = await f.run(f.eventFor('acknowledge', 'builder', result.commentId));
  result = await f.run(f.eventFor('stop', 'reviewer', result.commentId));
  assert.equal(result.state, 'paused');
  result = await f.run(f.eventFor('stopped', 'builder', result.commentId));
  assert.equal(result.action, 'integrator');
});

test('maintainer can transfer a legacy correction to the worker current stable ID', async () => {
  const f = fixture();
  f.issue.labels = ['platform:any', 'status:changes-required', 'action:worker'];
  f.comments.push({ id: 11, user: { login: 'builder', type: 'User' },
    body: '<!-- agent-control-room-action:v1 worker=worker-01 state=changes-required issue=1 -->' });
  let result = await f.run(f.eventFor('adopt-changes', 'reviewer', 0, 'Fix the reviewed failures.', {
    workerId: 'worker-current-01', claimWorkerId: 'worker-01',
  }));
  const adopted = parseHandoff(f.comments.find(comment => comment.id === result.commentId));
  assert.equal(adopted.workerId, 'worker-current-01');
  assert.equal(adopted.claimWorkerId, 'worker-01');
  const inbox = workerId => readWorkerInbox({ workerId, repository, fetchImpl: async url => ({ ok: true,
    json: async () => structuredClone(url.includes('/comments') ? f.comments : [f.issue]) }) });
  assert.equal((await inbox('worker-current-01'))[0].disposition, 'action');
  assert.equal((await inbox('worker-01')).length, 0);
  result = await f.run(f.eventFor('acknowledge', 'builder', result.commentId, undefined, { workerId: 'worker-current-01' }));
  assert.equal(parseHandoff(f.comments.find(comment => comment.id === result.commentId)).acknowledged, true);
});

test('legacy correction adoption fails closed without maintainer authority, evidence, details, or exact labels', async () => {
  const make = () => {
    const f = fixture();
    f.issue.labels = ['platform:any', 'status:changes-required', 'action:worker'];
    f.comments.push({ id: 11, user: { login: 'builder', type: 'User' },
      body: '<!-- agent-control-room-action:v1 worker=worker-01 state=changes-required issue=1 -->' });
    return f;
  };
  let f = make();
  await assert.rejects(f.run(f.eventFor('adopt-changes', 'builder', 0, 'details', { claimWorkerId: 'worker-01' })), /authority_denied/);
  f = make(); f.comments.splice(1, 1);
  await assert.rejects(f.run(f.eventFor('adopt-changes', 'reviewer', 0, 'details', { claimWorkerId: 'worker-01' })), /adoption_source_invalid/);
  f = make();
  await assert.rejects(f.run(f.eventFor('adopt-changes', 'reviewer', 0, undefined,
    { claimWorkerId: 'worker-01' })), /adoption_invalid/);
  f = make(); f.issue.labels.push('status:working');
  await assert.rejects(f.run(f.eventFor('adopt-changes', 'reviewer', 0, 'details', { claimWorkerId: 'worker-01' })), /adoption_source_invalid/);
});

test('stop preserves reservation until worker acknowledges; never releases paths', async () => {
  const f = fixture();
  let result = await f.run(f.eventFor('submit'));
  result = await f.run(f.eventFor('stop', 'reviewer', result.commentId));
  assert.equal(result.state, 'paused');
  assert.equal(result.action, 'worker');
  result = await f.run(f.eventFor('stopped', 'builder', result.commentId));
  assert.equal(result.action, 'integrator');
  assert.match(f.comments[0].body, /CLAIM ACCEPTED/);
  assert.ok(!f.issue.labels.includes('status:ready'));
});

for (const kind of ['comment', 'labels', 'complete']) test(`lost ${kind} response reconciles without duplicate transition`, async () => {
  const f = fixture();
  const event = f.eventFor('submit');
  f.setFault({ matches: (m, p) => kind === 'labels' ? m === 'POST' && p.endsWith('/labels') : m === ({ comment: 'POST', complete: 'PATCH' })[kind] });
  const result = await f.run(event);
  assert.equal(result.status, 'recorded');
  const replay = await f.run(event);
  assert.equal(replay.status, 'already-recorded');
  assert.equal(f.comments.filter(c => parseHandoff(c)).length, 1);
});

test('failure between issue and PR labels leaves visible pending record and rerun recovers', async () => {
  const f = fixture();
  const event = f.eventFor('submit');
  f.setFault({ before: true, matches: (m, p) => m === 'POST' && p.includes('/issues/2/') });
  await assert.rejects(f.run(event), /offline/);
  assert.equal(parseHandoff(f.comments.at(-1)).phase, 'pending');
  assert.equal((await f.run(event)).status, 'recorded');
});

test('newer label decision is preserved during interrupted update', async () => {
  const f = fixture();
  const event = f.eventFor('submit');
  f.setFault({ before: true, matches: (m, p) => m === 'POST' && p.includes('/issues/2/'), change: () => { f.prIssue.labels = ['status:paused']; } });
  await assert.rejects(f.run(event), /labels_changed/);
  await assert.rejects(f.run(event), /labels_changed/);
  assert.deepEqual(f.prIssue.labels, ['status:paused']);
});

test('stale predecessor and changed head cannot approve a newer submission', async () => {
  const f = fixture();
  const first = await f.run(f.eventFor('submit'));
  await assert.rejects(f.run(f.eventFor('changes', 'reviewer', 0)), /predecessor_changed/);
  f.pr.head.sha = 'c'.repeat(40);
  await assert.rejects(f.run(f.eventFor('accept', 'reviewer', first.commentId)), /review_head_changed/);
});

test('wrong PR owner, closed issue and conflicting labels refuse before mutations', async () => {
  for (const mutate of [f => { f.pr.user.login = 'other'; }, f => { f.issue.state = 'closed'; }, f => { f.issue.labels.push('status:paused'); }, f => { f.prIssue.labels = ['status:paused']; }]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.run(f.eventFor('submit')));
    assert.equal(f.mutations.length, 0);
  }
});

test('edited request and malformed command do not authorize work', async () => {
  assert.equal(parseHandoffCommand('HANDOFF accept'), undefined);
  assert.equal(parseHandoffCommand(`HANDOFF submit\nworker-id: worker-01\nclaim-worker-id: old-worker-01\npr: 2\nhead: ${sha}\nprevious: 0`), undefined);
  assert.equal(parseHandoffCommand(`HANDOFF adopt-changes\nworker-id: worker-01\npr: 2\nhead: ${sha}\nprevious: 0\n\n<!-- agent-control-room-handoff:v1 {} -->`), undefined);
  assert.equal(parseHandoff({ user: { login: 'github-actions[bot]', type: 'Bot' },
    body: `<!-- agent-control-room-handoff:v1 ${JSON.stringify({ issue: 1, requestId: 2, workerId: 'worker-01',
      claimWorkerId: '../invalid', head: sha })} -->` }), undefined);
  const f = fixture();
  const event = structuredClone(f.eventFor('submit'));
  f.comments.at(-1).body += '\nchanged';
  await assert.rejects(f.run(event), /request_changed/);
  assert.equal(f.mutations.length, 0);
});

test('maintainer can stop incomplete submission after head changed, preserving pending history', async () => {
  const f = fixture();
  f.setFault({ before: true, matches: (m, p) => m === 'POST' && p.includes('/issues/2/') });
  await assert.rejects(f.run(f.eventFor('submit')), /offline/);
  const pending = f.comments.at(-1);
  f.pr.head.sha = 'd'.repeat(40);
  const result = await f.run(f.eventFor('stop', 'reviewer', pending.id));
  assert.equal(result.state, 'paused');
  assert.equal(parseHandoff(pending).phase, 'pending');
  assert.equal(parseHandoff(f.comments.at(-1)).phase, 'complete');
  assert.deepEqual(f.prIssue.labels, ['help wanted', 'status:paused', 'action:worker']);
});

test('stop before first submit and unrelated labels survive incremental transition', async () => {
  const f = fixture();
  f.setFault({ matches: (m, p) => m === 'POST' && p.endsWith('/labels'), change: () => { f.issue.labels.push('human-added'); } });
  assert.equal((await f.run(f.eventFor('stop', 'reviewer'))).state, 'paused');
  assert.ok(f.issue.labels.includes('human-added'));
});

test('CRLF web commands and PR issue bindings are accepted', async () => {
  const f = fixture();
  f.pr.body = 'Description\r\nControl-Room-Issue: 1\r\n';
  const event = f.eventFor('submit');
  event.comment.body = event.comment.body.replace(/\n/g, '\r\n');
  assert.equal((await f.run(event)).status, 'recorded');
});

test('pending stop can itself be superseded after a changed head', async () => {
  const f = fixture();
  f.setFault({ before: true, matches: (m, p) => m === 'POST' && p.includes('/issues/2/') });
  await assert.rejects(f.run(f.eventFor('stop', 'reviewer')), /offline/);
  const pendingId = f.comments.at(-1).id;
  f.pr.head.sha = 'e'.repeat(40);
  assert.equal((await f.run(f.eventFor('stop', 'reviewer', pendingId))).state, 'paused');
});

test('actual controller records reach inbox through correction, acknowledgment, re-review and stop', async () => {
  const f = fixture();
  const inbox = () => readWorkerInbox({ workerId: 'worker-01', repository, fetchImpl: async url => ({ ok: true,
    json: async () => structuredClone(url.includes('/comments') ? f.comments : [f.issue]) }) });
  let result = await f.run(f.eventFor('submit'));
  assert.equal((await inbox())[0].disposition, 'waiting');
  result = await f.run(f.eventFor('changes', 'reviewer', result.commentId));
  let entry = (await inbox())[0];
  assert.equal(entry.markerState, 'changes-required');
  assert.equal(entry.acknowledged, false);
  result = await f.run(f.eventFor('acknowledge', 'builder', result.commentId));
  assert.equal((await inbox())[0].acknowledged, true);
  result = await f.run(f.eventFor('resubmit', 'builder', result.commentId));
  assert.equal((await inbox())[0].disposition, 'waiting');
  result = await f.run(f.eventFor('stop', 'reviewer', result.commentId));
  entry = (await inbox())[0];
  assert.equal(entry.disposition, 'stop');
  assert.match(entry.action, /STOP/);
  await f.run(f.eventFor('stopped', 'builder', result.commentId));
  assert.equal((await inbox())[0].acknowledged, true);
});

// R5I-01: the handoff must not grant a pull request its review position under a
// reservation the submit controller would refuse. These three cases are the
// joined claim-submit/handoff regression: the same fixture that runClaimSubmit
// refuses must also be refused here, and a live reservation still hands off.

// An expired lease: acceptance is two hours old against a one-hour packet.
test('R5I-01 expired reservation cannot reach review through the handoff', async () => {
  const f = fixture();
  // Rewrite the accepted marker as if it was accepted two hours before NOW.
  f.comments[0].body = `CLAIM ACCEPTED — worker\n${claimMarker(NOW - 2 * 3_600_000).join('\n')}`;
  await assert.rejects(f.run(f.eventFor('submit')), /handoff_claim_lease_expired/);
  assert.equal(f.comments.filter(c => parseHandoff(c)).length, 0, 'no journal may be written');
  assert.ok(!f.issue.labels.includes('status:in-review'), 'the issue must not move to review');
  assert.ok(!f.prIssue.labels.includes('status:in-review'), 'the pull request must not move to review');
  assert.equal(f.mutations.length, 0, 'a refused handoff writes nothing');
});

// The approved work packet changed after acceptance.
test('R5I-01 changed work packet cannot reach review through the handoff', async () => {
  const f = fixture();
  const changed = { ...PACKET, writeScopes: ['src/owned-scope.ts', 'src/extra-scope.ts'] };
  f.issue.body = `Work packet.\n\n<!-- acr-public-work:v1 ${JSON.stringify(changed)}\n-->`;
  assert.equal(parseClaimPacket(f.issue.body).writeScopes.length, 2, 'the new packet is valid, just not the accepted one');
  await assert.rejects(f.run(f.eventFor('submit')), /handoff_claim_packet_changed/);
  assert.equal(f.comments.filter(c => parseHandoff(c)).length, 0);
  assert.equal(f.mutations.length, 0);
});

// A live reservation still hands off, so the gate refuses only real staleness.
test('R5I-01 a live reservation still hands off to review', async () => {
  const f = fixture();
  const result = await f.run(f.eventFor('submit'));
  assert.equal(result.status, 'recorded');
  assert.equal(result.state, 'in-review');
  assert.ok(f.issue.labels.includes('status:in-review'));
  assert.ok(f.prIssue.labels.includes('action:reviewer'));
});

// resubmit re-grants review after a correction, so it carries the same gate.
test('R5I-01 resubmit re-checks the reservation before returning a PR to review', async () => {
  const f = fixture();
  let result = await f.run(f.eventFor('submit'));
  result = await f.run(f.eventFor('changes', 'reviewer', result.commentId));
  result = await f.run(f.eventFor('acknowledge', 'builder', result.commentId));
  // A resubmit re-grants review, so the gate runs again on the same live claim.
  const refreshed = await f.run(f.eventFor('resubmit', 'builder', result.commentId));
  assert.equal(refreshed.status, 'recorded');
  assert.equal(refreshed.state, 're-review');
  assert.ok(f.prIssue.labels.includes('status:re-review'));

  // Now expire the reservation and resubmit a further correction: refused.
  const g = fixture();
  let first = await g.run(g.eventFor('submit'));
  first = await g.run(g.eventFor('changes', 'reviewer', first.commentId));
  first = await g.run(g.eventFor('acknowledge', 'builder', first.commentId));
  const journals = g.comments.filter(c => parseHandoff(c));
  const expired = fixture();
  expired.comments[0].body = `CLAIM ACCEPTED — worker\n${claimMarker(NOW - 2 * 3_600_000).join('\n')}`;
  expired.issue.labels = ['platform:any', 'status:changes-required', 'action:worker'];
  for (const journal of journals) expired.comments.push(structuredClone(journal));
  await assert.rejects(expired.run(expired.eventFor('resubmit', 'builder', journals.at(-1).id)),
    /handoff_claim_lease_expired/);
  assert.ok(!expired.prIssue.labels.includes('status:re-review'), 'no PR returns to review');
});

// A legacy v2 acceptance is a compatibility record, never current authority.
test('R5I-01 a legacy v2 acceptance cannot move a PR into review', async () => {
  const f = fixture();
  f.comments[0].body = 'CLAIM ACCEPTED — worker\n<!-- agent-control-room-claim:v2 issue=1 request=9 actor=builder worker=worker-01 -->';
  await assert.rejects(f.run(f.eventFor('submit')), /handoff_claim_legacy_claim_manual/);
  assert.equal(f.comments.filter(c => parseHandoff(c)).length, 0);
  assert.equal(f.mutations.length, 0);
});

// A revoked reservation ends the claim: the handoff must refuse it too.
test('R5I-01 a released reservation cannot reach review through the handoff', async () => {
  const f = fixture();
  f.comments.push({ id: 12, user: { login: 'github-actions[bot]', type: 'Bot' },
    body: 'CLAIM RELEASED — returned.\n<!-- agent-control-room-claim:v3 issue=1 request=9 actor=builder worker=worker-01 released=1 -->' });
  await assert.rejects(f.run(f.eventFor('submit')), /handoff_claim_no_accepted_claim_for_pair/);
  assert.equal(f.comments.filter(c => parseHandoff(c)).length, 0);
});

// R5I-06: concurrent duplicate handoffs must converge on one journal. The
// workflow serializes runs today; this makes the helper itself safe to call
// concurrently, which is what a duplicate webhook redelivery produces.

/** A saved event object that many runs may consume at once. */
const savedEvent = f => f.eventFor('submit');

test('R5I-06 twenty concurrent duplicate handoffs converge on one settled journal', async () => {
  const f = fixture();
  const event = savedEvent(f);
  const outcomes = await Promise.all(Array.from({ length: 20 }, () => f.run(event).then(
    value => ({ ok: value }), error => ({ ok: false, error }))));
  const refused = outcomes.filter(value => !value.ok);
  // Every duplicate either drove or observed the same transition. The old code
  // refused 19 of 20 with handoff_concurrent_change and then poisoned the
  // retry, so ANY refusal here is the bug returning.
  assert.equal(refused.length, 0,
    `unexpected refusals: ${refused.map(v => v.error.message).join(', ')}`);
  assert.equal(outcomes.length, 20);
  // Exactly one journal is settled. Duplicates may leave pending copies in the
  // history, but the canonical fold means only the lowest id is ever completed.
  const journals = f.comments.filter(c => parseHandoff(c));
  const complete = journals.filter(c => parseHandoff(c).phase === 'complete');
  assert.equal(complete.length, 1, 'exactly one journal carries the settled decision');
  const canonical = complete[0];
  assert.equal(canonical.id, Math.min(...journals.map(c => c.id)),
    'the lowest-id journal is the canonical one that is completed');
  // Both sides settle on the agreed target labels.
  assert.deepEqual(f.issue.labels, ['platform:any', 'status:in-review', 'action:reviewer']);
  assert.deepEqual(f.prIssue.labels, ['help wanted', 'status:in-review', 'action:reviewer']);
  // The settled result is reachable on a later retry of the same saved request.
  // This is exactly what used to fail with handoff_predecessor_changed.
  for (const retry of [await f.run(event), await f.run(event)]) {
    assert.equal(retry.status, 'already-recorded');
    assert.equal(retry.commentId, canonical.id);
  }
  // A retry writes nothing at all.
  const before = f.mutations.length;
  await f.run(event);
  assert.equal(f.mutations.length, before, 'a replayed handoff performs no writes');
  // The worker inbox sees the settled decision, not a pending orphan.
  const inbox = await readWorkerInbox({ workerId: 'worker-01', repository, fetchImpl: async url => ({ ok: true,
    json: async () => structuredClone(url.includes('/comments') ? f.comments : [f.issue]) }) });
  assert.equal(inbox[0].disposition, 'waiting', 'the worker sees the settled review state');
});

test('R5I-06 a duplicate journal is folded into one canonical timeline', async () => {
  const f = fixture();
  const event = savedEvent(f);
  await f.run(event);
  const settled = f.comments.filter(c => parseHandoff(c)).at(-1);
  // Simulate the orphan a concurrent duplicate would have left behind: a second
  // pending journal for the SAME saved request, with a higher comment id.
  f.comments.push({ id: 900, user: { login: 'github-actions[bot]', type: 'Bot' },
    body: `Workflow handoff: pending\n\n<!-- agent-control-room-handoff:v1 ${JSON.stringify(
      { ...parseHandoff(settled), phase: 'pending' })} -->` });
  const retry = await f.run(event);
  assert.equal(retry.status, 'already-recorded', 'the duplicate must not re-run the transition');
  assert.equal(retry.commentId, settled.id, 'the lowest-id journal stays canonical');
  assert.deepEqual(f.issue.labels, ['platform:any', 'status:in-review', 'action:reviewer']);
  assert.deepEqual(f.prIssue.labels, ['help wanted', 'status:in-review', 'action:reviewer']);
});

// A competing journal for a DIFFERENT, newer request must still be refused. This
// is the guard the duplicate fold must not weaken: folding one request's copies
// together may never excuse another actor's later decision.
test('R5I-06 a competing newer decision from another request is still refused', async () => {
  const f = fixture();
  const event = f.eventFor('submit');
  // A journal for a DIFFERENT, newer request appears after this run read the
  // history but before it settles: another actor has already decided.
  const foreign = { issue: 1, pr: 2, workerId: 'worker-01', claimWorkerId: 'worker-01', actor: 'builder',
    head: sha, state: 'in-review', action: 'reviewer', acknowledged: false, requestId: event.comment.id + 1,
    previousId: 0, claimId: 10, phase: 'pending', reviewUrl: 'https://example/other' };
  // Inject the competing journal only once this run has already read the
  // history and created its own journal: the exact window fresh() guards.
  let injected = false;
  f.onRead(async (method, path) => {
    if (injected || !path.includes('/comments?')) return;
    if (!f.comments.some(c => parseHandoff(c)?.requestId === event.comment.id)) return;
    injected = true;
    f.comments.push({ id: 950, user: { login: 'github-actions[bot]', type: 'Bot' },
      body: `Workflow handoff: pending\n\n<!-- agent-control-room-handoff:v1 ${JSON.stringify(foreign)} -->` });
  });
  await assert.rejects(f.run(event), /handoff_concurrent_change/);
  assert.ok(injected, 'the competing decision must have landed mid-run');
  // Nothing of this request was settled above the competing decision.
  assert.equal(f.comments.filter(c => parseHandoff(c)?.requestId === event.comment.id
    && parseHandoff(c).phase === 'complete').length, 0);
});

// The authority used for the gate must be the SAME claim record the rest of the
// handoff acts on. If the handoff resolved one accepted marker but the gate
// validated another, the gate would vouch for a reservation it never checked.
test('R5I-01 the gated claim is the one the handoff acts on', async () => {
  const f = fixture();
  // Two live accepted markers for the same pair: the newest wins the lookup, so
  // an older v3 marker with a different packet cannot become the authority.
  f.comments.push({ id: 11, user: { login: 'github-actions[bot]', type: 'Bot' },
    body: `CLAIM RENEWED — worker\n<!-- agent-control-room-claim:v3 issue=1 request=9 actor=builder worker=worker-01 packet=${'b'.repeat(64)} accepted=${NOW} -->` });
  await assert.rejects(f.run(f.eventFor('submit')), /handoff_claim_packet_changed/);
  // With the stale-packet marker removed, the same request hands off.
  const g = fixture();
  assert.equal((await g.run(g.eventFor('submit'))).status, 'recorded');
});

// Two journals that share a saved-request id but are DIFFERENT assignments are
// not duplicates. Folding them together would let one worker's decision stand
// in for another's, which is the authority failure R5I-01 exists to prevent.
test('R5I-06 journals sharing a request id but not an assignment stay distinct', async () => {
  const f = fixture();
  const event = f.eventFor('submit');
  // Settle this request first, so the foreign journal below can never be a
  // legitimate replay target: it is a DIFFERENT worker and predecessor that
  // merely reuses the same numeric request id.
  await f.run(event);
  const settled = f.comments.filter(c => parseHandoff(c)).at(-1);
  const foreign = { ...parseHandoff(settled), workerId: 'worker-other', claimWorkerId: 'worker-other',
    state: 'changes-required', action: 'worker', previousId: settled.id, phase: 'pending' };
  f.comments.push({ id: 960, user: { login: 'github-actions[bot]', type: 'Bot' },
    body: `Workflow handoff: pending\n\n<!-- agent-control-room-handoff:v1 ${JSON.stringify(foreign)} -->` });
  // Same request id as the settled record, different assignment: the foreign
  // journal is its own record and is never treated as a copy of ours.
  const both = f.comments.filter(c => parseHandoff(c)
    && parseHandoff(c).issue === 1 && parseHandoff(c).requestId === parseHandoff(settled).requestId);
  assert.equal(both.length, 2, 'the foreign journal is a distinct record, not a duplicate copy');
  assert.deepEqual(both.map(c => parseHandoff(c).workerId).sort(), ['worker-01', 'worker-other']);
  // The worker inbox must never show the other worker's assignment to this
  // worker. A requestId-only fold would let that foreign record stand in for
  // this worker's own settled journal and rewrite its identity.
  const view = await readWorkerInbox({ workerId: 'worker-01', repository,
    fetchImpl: async url => ({ ok: true,
      json: async () => structuredClone(url.includes('/comments') ? f.comments : [f.issue]) }) });
  assert.deepEqual(view.filter(entry => entry.workerId && entry.workerId !== 'worker-01'), [],
    'a foreign worker assignment must never appear in this worker inbox');
  const other = await readWorkerInbox({ workerId: 'worker-other', repository,
    fetchImpl: async url => ({ ok: true,
      json: async () => structuredClone(url.includes('/comments') ? f.comments : [f.issue]) }) });
  // Each worker reads only its own record: neither fold lets the two records
  // for one request id merge into a single identity.
  assert.ok(other.every(entry => !entry.workerId || entry.workerId === 'worker-other'),
    'the other worker sees only its own assignment');
});

// The fold must key on the WHOLE assignment. Two journals for one issue and PR
// that share the saved-request id and the worker but point at DIFFERENT
// predecessors are two steps in the handoff chain, not two copies of one step:
// folding them would drop a real intermediate step from the worker's history.
test('R5I-06 two chain steps sharing a request id are both kept', async () => {
  const f = fixture();
  const first = f.eventFor('submit');
  const settled = await f.run(first);
  // A second step of the chain that reuses the same numeric request id but
  // names the previous journal as its predecessor.
  const step = { ...parseHandoff(f.comments.find(c => c.id === settled.commentId)),
    previousId: settled.commentId, phase: 'pending' };
  f.comments.push({ id: 961, user: { login: 'github-actions[bot]', type: 'Bot' },
    body: `Workflow handoff: pending\n\n<!-- agent-control-room-handoff:v1 ${JSON.stringify(step)} -->` });
  const journals = f.comments.filter(c => parseHandoff(c));
  assert.equal(journals.length, 2, 'both chain steps remain in the history');
  assert.deepEqual(journals.map(c => parseHandoff(c).previousId).sort(), [0, settled.commentId],
    'the two steps point at different predecessors');
  // The worker inbox must still be able to see the newest step, which is the
  // one naming the earlier journal as its predecessor.
  const view = await readWorkerInbox({ workerId: 'worker-01', repository,
    fetchImpl: async url => ({ ok: true,
      json: async () => structuredClone(url.includes('/comments') ? f.comments : [f.issue]) }) });
  assert.ok(view.some(entry => entry.markerCommentId === 961),
    `the newest chain step must be visible: ${JSON.stringify(view.map(e => e.markerCommentId))}`);
});

// The competing-decision guard must not be satisfied by another step of the
// handoff chain that merely reuses this request's numeric id. If it were, a
// later step naming a different predecessor would look like a copy of this
// request and its journal would be completed by this run.
test('R5I-06 a later chain step reusing this request id is not treated as a copy', async () => {
  const f = fixture();
  const event = f.eventFor('submit');
  // A different step of the chain lands MID-RUN: it shares this request's
  // numeric id but names a different predecessor and a different state, so it is
  // a competing decision and not a duplicate copy of this request's journal.
  const competing = { issue: 1, pr: 2, workerId: 'worker-01', claimWorkerId: 'worker-01',
    actor: 'builder', head: sha, state: 'paused', action: 'worker', acknowledged: false,
    requestId: event.comment.id, previousId: 7, claimId: 10, phase: 'pending',
    reviewUrl: 'https://example/other' };
  let injected = false;
  f.onRead(async (method, path) => {
    if (injected || !path.includes('/comments?')) return;
    if (!f.comments.some(c => parseHandoff(c)?.requestId === event.comment.id)) return;
    injected = true;
    f.comments.push({ id: 970, user: { login: 'github-actions[bot]', type: 'Bot' },
      body: `Workflow handoff: pending\n\n<!-- agent-control-room-handoff:v1 ${JSON.stringify(competing)} -->` });
  });
  await assert.rejects(f.run(event), /handoff_concurrent_change/);
  assert.ok(injected, 'the competing chain step must have landed mid-run');
  assert.equal(f.comments.filter(c => parseHandoff(c)?.requestId === event.comment.id
    && parseHandoff(c).phase === 'complete').length, 0,
    'no journal of this request is completed on top of a competing step');
});

// A handoff journal written before the saved-request id existed carries no
// requestId at all. It cannot be matched to a copy, so it must always stand as
// its own record — dropping it would silently hide the worker's assignment.
test('R5I-06 a journal without a request id is still its own record', async () => {
  const f = fixture();
  // An older controller journal: no requestId, no previousId.
  const legacy = { issue: 1, pr: 2, workerId: 'worker-01', claimWorkerId: 'worker-01',
    actor: 'builder', head: sha, state: 'in-review', action: 'reviewer',
    acknowledged: false, phase: 'complete' };
  f.comments.push({ id: 12, user: { login: 'github-actions[bot]', type: 'Bot' },
    body: `Workflow handoff: complete\n\n<!-- agent-control-room-handoff:v1 ${JSON.stringify(legacy)} -->` });
  const view = await readWorkerInbox({ workerId: 'worker-01', repository,
    fetchImpl: async url => ({ ok: true,
      json: async () => structuredClone(url.includes('/comments') ? f.comments : [f.issue]) }) });
  assert.ok(view.some(entry => entry.markerCommentId === 12),
    `a requestId-less journal must remain visible to the worker: ${JSON.stringify(view.map(e => e.markerCommentId))}`);
  assert.equal(view.at(-1).markerState, 'in-review');
});

// The lease can expire WHILE the label transition runs. The review position must
// not be completed under a reservation that is no longer current, so the journal
// is left pending and visible rather than settled into review.
test('R5I-01 a lease that expires mid-transition leaves the journal pending', async () => {
  const f = fixture();
  const event = f.eventFor('submit');
  // Expire the reservation only after the first label write, i.e. after the
  // opening authority check has already passed.
  let expired = false;
  f.onRead(async (method, path) => {
    // Fire once the labels are already moved to review: that is the window
    // between the opening authority check and the completion check, and the only
    // window in which a lease can expire out from under this run.
    if (expired) return;
    if (!f.issue.labels.includes('status:in-review')) return;
    expired = true;
    f.comments[0].body = `CLAIM ACCEPTED — worker\n${claimMarker(NOW - 2 * 3_600_000).join('\n')}`;
  });
  await assert.rejects(f.run(event), /handoff_claim_lease_expired/);
  assert.ok(expired, 'the reservation must have expired during the transition');
  const journals = f.comments.filter(c => parseHandoff(c));
  assert.equal(journals.length, 1, 'a journal exists but is not settled');
  assert.equal(journals[0] ? parseHandoff(journals[0]).phase : 'complete', 'pending',
    'the journal stays pending so the refusal is visible in the history');
  // The worker inbox reports the pending journal as attention, not a settled review.
  const view = await readWorkerInbox({ workerId: 'worker-01', repository,
    fetchImpl: async url => ({ ok: true,
      json: async () => structuredClone(url.includes('/comments') ? f.comments : [f.issue]) }) });
  assert.notEqual(view.at(-1)?.disposition, 'waiting',
    'an unsettled handoff must not read as a settled review state');
});

// The lease is not the only dimension that can go stale mid-transition: the WORK
// PACKET lives in the issue body, not in a comment, and anyone can edit it while
// the label transition runs. The final gate re-reads comments for the claim, so
// the lease case above is structurally covered — but a body read from the fetch
// taken at the top of the function is not, no matter what the test does. A packet
// edited strictly between the opening check and completion must be refused: the
// reservation approved `src/owned-scope.ts`, and settling review under
// `src/**` is exactly the widening the gate exists to stop.
test('R5I-01 a work packet changed mid-transition leaves the journal pending', async () => {
  const f = fixture();
  const event = f.eventFor('submit');
  const widened = { ...PACKET, writeScopes: ['src/**'] };
  const widenedBody = `Work packet.\n\n<!-- acr-public-work:v1 ${JSON.stringify(widened)}\n-->`;
  // Fire the edit only after the opening authority check has already passed on
  // the original body — i.e. once the labels are moving to review. That is the
  // only window in which a packet edit can land under this run.
  let swapped = false;
  f.onRead(async (method, path) => {
    if (swapped || !path.includes('/comments?')) return;
    if (!f.issue.labels.includes('status:in-review')) return;
    swapped = true;
    f.issue.body = widenedBody;
  });
  await assert.rejects(f.run(event), /handoff_claim_packet_changed/);
  assert.ok(swapped, 'the work packet must have changed during the transition');
  assert.equal(parseClaimPacket(f.issue.body).writeScopes[0], 'src/**',
    'the new packet is a VALID packet, just not the accepted one');
  const journals = f.comments.filter(c => parseHandoff(c));
  assert.equal(journals.length, 1, 'a journal exists but is not settled');
  assert.equal(parseHandoff(journals[0]).phase, 'pending',
    'the journal stays pending so the refusal is visible in the history');
  // The labels ARE already moved to review by the time the final gate runs —
  // the same as the lease case, and the reason the journal phase, not a label
  // rollback, is what this refusal rests on. Assert that explicitly, so a future
  // reordering cannot quietly turn this into a half-applied transition.
  assert.ok(f.issue.labels.includes('status:in-review') && f.prIssue.labels.includes('action:reviewer'),
    'the label transition runs before the final gate, so the journal phase is the refusal');
  // The worker inbox reports the pending journal as attention, not a settled review.
  const view = await readWorkerInbox({ workerId: 'worker-01', repository,
    fetchImpl: async url => ({ ok: true,
      json: async () => structuredClone(url.includes('/comments') ? f.comments : [f.issue]) }) });
  assert.equal(view.at(-1)?.disposition, 'attention',
    'an unsettled handoff must read as attention, not as a settled review state');
  assert.equal(view.at(-1)?.state, 'attention',
    'and never as waiting for review');
});
