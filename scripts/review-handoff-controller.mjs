import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const MARKER = /<!-- agent-control-room-handoff:v1 (\{[^\n]+\}) -->/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const WORKER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/;
const SHA = /^[a-f0-9]{40}$/;
const BOT = comment => comment?.user?.login === 'github-actions[bot]' && comment.user.type === 'Bot';
const COMMANDS = new Set(['submit', 'changes', 'adopt-changes', 'acknowledge', 'resubmit', 'accept', 'stop', 'stopped']);
const labels = issue => issue.labels.map(label => typeof label === 'string' ? label : label.name);
const bodyFor = record => `Workflow handoff: ${record.phase}\n\nWorker: ${record.workerId}\nState: ${record.state}\nNext: ${record.action}\nReviewed/submitted commit: ${record.head}\nInstructions: ${record.reviewUrl}${record.instruction ? `\n\nCorrection details:\n${record.instruction}` : ''}\n\n<!-- agent-control-room-handoff:v1 ${JSON.stringify(record)} -->`;

export function parseHandoff(comment) {
  if (!BOT(comment)) return undefined;
  try {
    const value = JSON.parse(MARKER.exec(comment.body ?? '')?.[1] ?? 'null');
    return value && Number.isSafeInteger(value.issue) && Number.isSafeInteger(value.requestId)
      && WORKER.test(value.workerId) && (value.claimWorkerId === undefined || WORKER.test(value.claimWorkerId))
      && SHA.test(value.head) ? value : undefined;
  } catch { return undefined; }
}

export function parseHandoffCommand(body) {
  const match = /^HANDOFF (submit|changes|adopt-changes|acknowledge|resubmit|accept|stop|stopped)\nworker-id: ([A-Za-z0-9][A-Za-z0-9._:-]{2,79})\n(?:claim-worker-id: ([A-Za-z0-9][A-Za-z0-9._:-]{2,79})\n)?pr: ([1-9][0-9]*)\nhead: ([a-f0-9]{40})\nprevious: (0|[1-9][0-9]*)(?:\n\n([\s\S]*?))?\n?$/.exec((body ?? '').replace(/\r\n/g, '\n'));
  if (!match) return undefined;
  if ((match[1] === 'adopt-changes') !== Boolean(match[3])) return undefined;
  const instruction = match[7]?.trim();
  if (instruction && (instruction.length > 12000 || instruction.includes('<!-- agent-control-room-handoff:v1'))) return undefined;
  return { command: match[1], workerId: match[2], claimWorkerId: match[3], pr: Number(match[4]), head: match[5], previousId: Number(match[6]), instruction };
}

async function commentsFor(api, repository, issue) {
  const output = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api('GET', `/repos/${repository}/issues/${issue}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error('handoff_comments_invalid');
    output.push(...batch);
    if (batch.length < 100) return output;
  }
  throw new Error('handoff_history_incomplete');
}

function acceptedClaim(comments, issue, workerId) {
  const claims = comments.filter(BOT).filter(c => c.body?.includes('<!-- agent-control-room-claim:v2'));
  const latest = claims.at(-1);
  if (!latest?.body.startsWith('CLAIM ACCEPTED —')) throw new Error('handoff_claim_unavailable');
  const match = /<!-- agent-control-room-claim:v2 issue=(\d+) request=(\d+) actor=([^ ]+) worker=([^ ]+) -->/.exec(latest.body);
  if (!match || Number(match[1]) !== issue || match[4] !== workerId) throw new Error('handoff_worker_changed');
  return { id: latest.id, actor: match[3] };
}

function nextState(command, previous) {
  if (command === 'submit' && !previous) return ['in-review', 'reviewer', false];
  if (command === 'adopt-changes' && !previous) return ['changes-required', 'worker', false];
  if (command === 'changes' && ['in-review', 're-review'].includes(previous?.state)) return ['changes-required', 'worker', false];
  if (command === 'acknowledge' && previous?.state === 'changes-required' && !previous.acknowledged) return ['changes-required', 'worker', true];
  if (command === 'resubmit' && previous?.state === 'changes-required' && previous.acknowledged) return ['re-review', 'reviewer', false];
  if (command === 'accept' && ['in-review', 're-review'].includes(previous?.state)) return [previous.state, 'integrator', false];
  if (command === 'stop' && (previous?.state !== 'paused' || previous?.phase === 'pending')) return ['paused', 'worker', false];
  if (command === 'stopped' && previous?.state === 'paused' && !previous.acknowledged) return ['paused', 'integrator', true];
  throw new Error('handoff_transition_invalid');
}

// This controller records cooperative repository work. It cannot stop a process,
// grant runtime authority, prove a shared account's worker identity, or merge code.
export async function runHandoff({ event, repository, api, maintainers = [] }) {
  const request = parseHandoffCommand(event.comment?.body);
  if (!request) return { status: 'ignored' };
  if (!COMMANDS.has(request.command) || event.issue?.pull_request || event.action !== 'created') throw new Error('handoff_event_invalid');
  const issueNumber = event.issue.number;
  const requestId = event.comment.id;
  const actor = event.sender?.login;
  if (!Number.isSafeInteger(issueNumber) || !Number.isSafeInteger(requestId) || !LOGIN.test(actor ?? '')
    || event.comment.user?.login !== actor) throw new Error('handoff_actor_invalid');
  if (!maintainers.length || maintainers.some(login => !LOGIN.test(login))) throw new Error('handoff_maintainers_unconfigured');
  const root = `/repos/${repository}`;
  const getIssue = number => api('GET', `${root}/issues/${number}`);
  const [issue, pr, comments, savedRequest] = await Promise.all([
    getIssue(issueNumber), api('GET', `${root}/pulls/${request.pr}`), commentsFor(api, repository, issueNumber),
    api('GET', `${root}/issues/comments/${requestId}`),
  ]);
  if (savedRequest.body !== event.comment.body || savedRequest.user?.login !== actor
    || savedRequest.issue_url !== `https://api.github.com/repos/${repository}/issues/${issueNumber}`) throw new Error('handoff_request_changed');
  if (issue.state !== 'open' || pr.state !== 'open' || pr.head.sha !== request.head
    || pr.base.repo.full_name !== repository) throw new Error('handoff_target_changed');
  const issueBindings = [...(pr.body ?? '').replace(/\r\n/g, '\n').matchAll(/^Control-Room-Issue: ([1-9][0-9]*)$/gm)];
  const adoptingChanges = request.command === 'adopt-changes';
  const exactIssueBinding = issueBindings.length === 1 && Number(issueBindings[0][1]) === issueNumber;
  const legacyBindings = [...(pr.body ?? '').replace(/\r\n/g, '\n')
    .matchAll(/^(?:Outcome\s*\/\s*issue\s*:|Closes|Fixes|Resolves)\s*#([1-9][0-9]*)\b/gim)]
    .map(match => Number(match[1]));
  const titleBinding = /\(issue\s+#([1-9][0-9]*)\)/i.exec(pr.title ?? '');
  if (titleBinding) legacyBindings.push(Number(titleBinding[1]));
  const uniqueLegacyBindings = [...new Set(legacyBindings)];
  const exactLegacyIssueBinding = uniqueLegacyBindings.length === 1 && uniqueLegacyBindings[0] === issueNumber;
  // Legacy correction adoption exists partly to repair older PRs that predate the
  // mandatory Control-Room-Issue line. During that single maintainer-only
  // transition, bind the PR to the issue through the existing exact review
  // evidence below. Every later worker transition still requires the PR body
  // to contain the one exact issue line.
  const records = comments.map(comment => ({ comment, record: parseHandoff(comment) }))
    .filter(item => item.record?.issue === issueNumber);
  const latest = records.at(-1);
  const replay = latest?.record.requestId === requestId ? latest : undefined;
  const predecessor = replay ? records.at(-2) : latest;
  const continuingAdoptedLegacy = ['acknowledge', 'stop', 'stopped'].includes(request.command)
    && issueBindings.length === 0 && predecessor?.record.requiresPrIssueBinding === true;
  if (!exactIssueBinding && ((!adoptingChanges && !continuingAdoptedLegacy) || issueBindings.length !== 0))
    throw new Error('handoff_pr_issue_mismatch');
  const claimWorkerId = request.command === 'adopt-changes'
    ? request.claimWorkerId : predecessor?.record.claimWorkerId ?? request.workerId;
  const claim = acceptedClaim(comments, issueNumber, claimWorkerId);
  if (pr.user.login !== claim.actor) throw new Error('handoff_pr_owner_mismatch');
  const maintainerAction = ['changes', 'adopt-changes', 'accept', 'stop'].includes(request.command);
  if (maintainerAction ? (!maintainers.includes(actor) || actor === claim.actor) : actor !== claim.actor)
    throw new Error('handoff_authority_denied');
  if ((predecessor?.comment.id ?? 0) !== request.previousId || (predecessor?.record.phase === 'pending' && request.command !== 'stop')) throw new Error('handoff_predecessor_changed');
  if (predecessor && (predecessor.record.workerId !== request.workerId || predecessor.record.pr !== request.pr
    || predecessor.record.claimId !== claim.id)) throw new Error('handoff_assignment_changed');
  if (predecessor && !['resubmit', 'stop', 'stopped'].includes(request.command) && predecessor.record.head !== request.head)
    throw new Error('handoff_review_head_changed');
  const [state, action, acknowledged] = nextState(request.command, predecessor?.record);
  const target = [`status:${state}`, `action:${action}`];
  const previousLabels = predecessor ? [`status:${predecessor.record.state}`, `action:${predecessor.record.action}`] : ['status:working'];
  const workflowLabels = value => labels(value).filter(label => /^(status|action):/.test(label)).sort();
  const equal = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const sourceMatches = value => equal(workflowLabels(value), previousLabels)
    || (!predecessor && equal(workflowLabels(value), ['status:working', 'action:worker']));
  const prIssue = await getIssue(request.pr);
  const stoppingPending = request.command === 'stop' && predecessor?.record.phase === 'pending';
  if (adoptingChanges && (!request.instruction || request.previousId !== 0 || predecessor))
    throw new Error('handoff_adoption_invalid');
  if (adoptingChanges) {
    const legacy = comments.some(comment => Number.isSafeInteger(comment?.id) && comment.id > claim.id && comment.id < requestId
      && typeof comment.body === 'string'
      && comment.body.includes(`<!-- agent-control-room-action:v1 worker=${claimWorkerId} state=changes-required issue=${issueNumber} -->`));
    const issueReady = equal(workflowLabels(issue), ['status:changes-required', 'action:worker']);
    const prLabels = workflowLabels(prIssue);
    if (!legacy || (!exactIssueBinding && !exactLegacyIssueBinding) || !issueReady
      || !(prLabels.length === 0 || equal(prLabels, ['status:changes-required', 'action:worker'])))
      throw new Error('handoff_adoption_source_invalid');
  }
  if (!replay && !stoppingPending && !adoptingChanges
    && (!sourceMatches(issue) || (predecessor ? !sourceMatches(prIssue) : workflowLabels(prIssue).length !== 0)))
    throw new Error('handoff_labels_conflict');
  const record = replay?.record ?? {
    issue: issueNumber, pr: request.pr, workerId: request.workerId, claimWorkerId, actor, head: request.head,
    state, action, acknowledged, requestId, previousId: request.previousId, claimId: claim.id,
    phase: 'pending', instruction: request.instruction, reviewUrl: ['acknowledge', 'resubmit', 'stopped'].includes(request.command)
      ? predecessor.record.reviewUrl : savedRequest.html_url,
    requiresPrIssueBinding: !exactIssueBinding
      && (adoptingChanges || predecessor?.record.requiresPrIssueBinding === true),
    sourceIssueLabels: workflowLabels(issue), sourcePrLabels: workflowLabels(prIssue),
  };
  if (replay && record.phase === 'complete') return { status: 'already-recorded', commentId: replay.comment.id };
  let journalId = replay?.comment.id;
  if (!journalId) {
    try { journalId = (await api('POST', `${root}/issues/${issueNumber}/comments`, { body: bodyFor(record) })).id; }
    catch (error) {
      const matches = (await commentsFor(api, repository, issueNumber)).filter(c => parseHandoff(c)?.requestId === requestId);
      if (matches.length !== 1) throw error;
      journalId = matches[0].id;
    }
  }
  async function fresh() {
    const history = await commentsFor(api, repository, issueNumber);
    const current = history.filter(c => parseHandoff(c)?.issue === issueNumber).at(-1);
    const currentClaim = acceptedClaim(history, issueNumber, claimWorkerId);
    const currentPr = await api('GET', `${root}/pulls/${request.pr}`);
    if (current?.id !== journalId || currentClaim.id !== claim.id || currentClaim.actor !== claim.actor
      || currentPr.head.sha !== request.head || currentPr.state !== 'open' || currentPr.body !== pr.body) throw new Error('handoff_concurrent_change');
  }
  for (const [number, source] of [[issueNumber, record.sourceIssueLabels], [request.pr, record.sourcePrLabels]]) {
    await fresh();
    const current = await getIssue(number);
    if (current.state !== 'open') throw new Error('handoff_target_closed');
    if (equal(workflowLabels(current), target)) continue;
    const removals = source.filter(label => !target.includes(label));
    const union = [...new Set([...source, ...target])];
    const intermediates = [source, union, ...removals.map((_, index) => union.filter(label => !removals.slice(0, index + 1).includes(label)))];
    const checkLabels = async () => {
      const value = await getIssue(number);
      if (value.state !== 'open' || !intermediates.some(expected => equal(workflowLabels(value), expected))) throw new Error('handoff_labels_changed');
      return workflowLabels(value);
    };
    let present = await checkLabels();
    if (!target.every(label => present.includes(label))) {
      try { await api('POST', `${root}/issues/${number}/labels`, { labels: target }); }
      catch (error) { present = await checkLabels(); if (!target.every(label => present.includes(label))) throw error; }
    }
    for (const label of removals) {
      await fresh();
      present = await checkLabels();
      if (!present.includes(label)) continue;
      try { await api('DELETE', `${root}/issues/${number}/labels/${encodeURIComponent(label)}`); }
      catch (error) { if ((await checkLabels()).includes(label)) throw error; }
    }
  }
  await fresh();
  if (!(await Promise.all([getIssue(issueNumber), getIssue(request.pr)])).every(value => value.state === 'open' && equal(workflowLabels(value), target)))
    throw new Error('handoff_labels_unsettled');
  const complete = { ...record, phase: 'complete' };
  try { await api('PATCH', `${root}/issues/comments/${journalId}`, { body: bodyFor(complete) }); }
  catch (error) {
    if (JSON.stringify(parseHandoff(await api('GET', `${root}/issues/comments/${journalId}`))) !== JSON.stringify(complete)) throw error;
  }
  return { status: 'recorded', state, action, commentId: journalId };
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('handoff_repository_invalid');
  const api = async (method, path, body) => {
    const response = await fetch(`https://api.github.com${path}`, { method, headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json',
      'content-type': 'application/json', 'x-github-api-version': '2022-11-28',
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`handoff_api_${response.status}`);
    return response.status === 204 ? undefined : response.json();
  };
  console.log(JSON.stringify(await runHandoff({ event, repository, api,
    maintainers: (process.env.HANDOFF_MAINTAINERS ?? '').split(',').map(s => s.trim()).filter(Boolean) })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
