import assert from 'node:assert/strict';
import test from 'node:test';
import { runHandoff, parseHandoff, parseHandoffCommand } from '../scripts/review-handoff-controller.mjs';
import { readWorkerInbox, renderWorkerInbox } from '../scripts/public-worker-inbox.mjs';

const sha = 'a'.repeat(40);
const repository = 'example/project';
function fixture() {
  const issue = { number: 1, state: 'open', labels: ['status:working', 'platform:any'] };
  const prIssue = { number: 2, state: 'open', labels: ['help wanted'] };
  const pr = { state: 'open', body: 'Control-Room-Issue: 1', head: { sha }, user: { login: 'builder' }, base: { repo: { full_name: repository } } };
  const comments = [{ id: 10, user: { login: 'github-actions[bot]', type: 'Bot' },
    body: 'CLAIM ACCEPTED — worker\n<!-- agent-control-room-claim:v2 issue=1 request=9 actor=builder worker=worker-01 -->' }];
  let id = 20;
  const mutations = [];
  let fault;
  const api = async (method, path, body) => {
    const number = Number(/comments\/(\d+)/.exec(path)?.[1]);
    if (method === 'GET') {
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
      body: `HANDOFF ${command}\nworker-id: ${workerId}\n${claimWorkerLine}pr: 2\nhead: ${pr.head.sha}\nprevious: ${previousId}${instruction ? `\n\n${instruction}` : ''}` };
    comments.push(comment);
    return { action: 'created', sender: { login: actor }, issue: { number: 1 }, comment };
  };
  const run = event => runHandoff({ event, repository, api, maintainers: ['reviewer'] });
  return { issue, prIssue, pr, comments, mutations, run, eventFor, setFault(value) { fault = value; } };
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
