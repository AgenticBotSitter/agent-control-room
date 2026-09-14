import assert from 'node:assert/strict';
import test from 'node:test';
import { runHandoff, parseHandoff, parseHandoffCommand } from '../scripts/review-handoff-controller.mjs';
import { readWorkerInbox } from '../scripts/public-worker-inbox.mjs';

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
  const eventFor = (command, actor = 'builder', previousId = 0) => {
    const comment = { id: ++id, user: { login: actor }, issue_url: `https://api.github.com/repos/${repository}/issues/1`,
      html_url: `https://github.com/${repository}/issues/1#issuecomment-${id}`,
      body: `HANDOFF ${command}\nworker-id: worker-01\npr: 2\nhead: ${pr.head.sha}\nprevious: ${previousId}` };
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
