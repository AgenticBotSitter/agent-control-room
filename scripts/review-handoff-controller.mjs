import { isMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";
import { readFile } from 'node:fs/promises';
import { currentClaimAuthority, parseClaimMarker } from "./automatic-claim-controller.mjs";

const MARKER = /<!-- agent-control-room-handoff:v1 (\{[^\n]+\}) -->/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const WORKER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/;
const SHA = /^[a-f0-9]{40}$/;
const BOT = comment => comment?.user?.login === 'github-actions[bot]' && comment.user.type === 'Bot';
const COMMANDS = new Set(['submit', 'changes', 'adopt-changes', 'acknowledge', 'resubmit', 'accept', 'accept-amendment', 'stop', 'stopped']);
// Commands that put a pull request into, or back into, review. This is the one
// place the handoff grants a PR its review position, so it is the one place the
// reservation must still be current authority.
const REVIEW_ENTRY = new Set(['submit', 'resubmit']);
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
  const match = /^HANDOFF (submit|changes|adopt-changes|acknowledge|resubmit|accept|accept-amendment|stop|stopped)\nworker-id: ([A-Za-z0-9][A-Za-z0-9._:-]{2,79})\n(?:claim-worker-id: ([A-Za-z0-9][A-Za-z0-9._:-]{2,79})\n)?pr: ([1-9][0-9]*)\nhead: ([a-f0-9]{40})\nprevious: (0|[1-9][0-9]*)(?:\n\n([\s\S]*?))?\n?$/.exec((body ?? '').replace(/\r\n/g, '\n'));
  if (!match) return undefined;
  if ((match[1] === 'adopt-changes') !== Boolean(match[3])) return undefined;
  const instruction = match[7]?.trim();
  if (instruction && (instruction.length > 12000 || instruction.includes('<!-- agent-control-room-handoff:v1'))) return undefined;
  if (match[1] === 'accept-amendment' && !instruction) return undefined;
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

// The live accepted claim for this pair. The v3 marker is authoritative: the
// legacy v2 acceptance kept in the same body is a reader-compatibility record,
// never current authority on its own.
function acceptedClaim(comments, issue, workerId) {
  const claims = comments.filter(BOT)
    .filter(comment => parseClaimMarker(comment.body)?.worker === workerId);
  const latest = claims.filter(comment => comment.body?.startsWith('CLAIM ACCEPTED —')
    || comment.body?.startsWith('CLAIM RENEWED —')).at(-1);
  const marker = parseClaimMarker(latest?.body);
  if (!marker || marker.issue !== issue || marker.worker !== workerId) throw new Error('handoff_claim_unavailable');
  return { id: latest.id, actor: marker.actor };
}

function nextState(command, previous) {
  if (command === 'submit' && !previous) return ['in-review', 'reviewer', false];
  if (command === 'adopt-changes' && !previous) return ['changes-required', 'worker', false];
  if (command === 'changes' && ['in-review', 're-review'].includes(previous?.state)) return ['changes-required', 'worker', false];
  if (command === 'acknowledge' && previous?.state === 'changes-required' && !previous.acknowledged) return ['changes-required', 'worker', true];
  if (command === 'resubmit' && previous?.state === 'changes-required' && previous.acknowledged) return ['re-review', 'reviewer', false];
  // A worker may refresh an already submitted head while it still awaits
  // review. This is a new review request, never acceptance of the new code.
  if (command === 'resubmit' && ['in-review', 're-review'].includes(previous?.state)
    && previous.action === 'reviewer') return ['re-review', 'reviewer', false];
  if (command === 'accept' && ['in-review', 're-review'].includes(previous?.state)) return [previous.state, 'integrator', false];
  if (command === 'accept-amendment' && ['in-review', 're-review'].includes(previous?.state)) return [previous.state, 'integrator', false];
  if (command === 'stop' && (previous?.state !== 'paused' || previous?.phase === 'pending')) return ['paused', 'worker', false];
  if (command === 'stopped' && previous?.state === 'paused' && !previous.acknowledged) return ['paused', 'integrator', true];
  throw new Error('handoff_transition_invalid');
}

// This controller records cooperative repository work. It cannot stop a process,
// grant runtime authority, prove a shared account's worker identity, or merge code.
// `now` is injected by tests so lease expiry is deterministic; production uses
// the wall clock.
export async function runHandoff({ event, repository, api, maintainers = [], now = Date.now() }) {
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
  // Acknowledgment records receipt of the predecessor's review, even when the
  // worker has already pushed a correction. Every other command targets HEAD.
  const acknowledgingReview = request.command === 'acknowledge';
  if (issue.state !== 'open' || pr.state !== 'open' || (!acknowledgingReview && pr.head.sha !== request.head)
    || pr.base.repo.full_name !== repository) throw new Error('handoff_target_changed');
  const issueBindings = [...(pr.body ?? '').replace(/\r\n/g, '\n').matchAll(/^Control-Room-Issue: ([1-9][0-9]*)$/gm)];
  const adoptingChanges = request.command === 'adopt-changes';
  const exactIssueBinding = issueBindings.length === 1 && Number(issueBindings[0][1]) === issueNumber;
  const normalizedPrBody = (pr.body ?? '').replace(/\r\n/g, '\n');
  const legacyBindings = [...normalizedPrBody.matchAll(/\b(?:Closes|Fixes|Resolves)\s*#([1-9][0-9]*)\b/gi)]
    .map(match => Number(match[1]));
  // Older contributors sometimes described the parent issue later on the same
  // line. Only the first issue immediately after this explicit field labels the
  // PR; closing keywords elsewhere are still collected above and must agree.
  legacyBindings.push(...[...normalizedPrBody.matchAll(/^Outcome\s*\/\s*issue\s*:\s*#([1-9][0-9]*)\b/gim)]
    .map(match => Number(match[1])));
  legacyBindings.push(...[...(pr.title ?? '').matchAll(/\(issue\s+#([1-9][0-9]*)\)/gi)]
    .map(match => Number(match[1])));
  const uniqueLegacyBindings = [...new Set(legacyBindings)];
  const exactLegacyIssueBinding = uniqueLegacyBindings.length === 1 && uniqueLegacyBindings[0] === issueNumber;
  // Legacy correction adoption exists partly to repair older PRs that predate the
  // mandatory Control-Room-Issue line. During that single maintainer-only
  // transition, bind the PR to the issue through the existing exact review
  // evidence below. Every later worker transition still requires the PR body
  // to contain the one exact issue line.
  const records = comments.map(comment => ({ comment, record: parseHandoff(comment) }))
    .filter(item => item.record?.issue === issueNumber);
  // R5I-06: concurrent copies of one request can each create a journal. Fold
  // them into one canonical timeline before anything is validated, so exactly
  // one record occupies each saved-request slot. The lowest comment id wins and
  // is the journal a later retry replays; the higher duplicates are orphans the
  // rest of this run ignores rather than mistaking for newer history. Identity
  // is the whole assignment, not the request id alone: two journals are copies
  // only when their issue, PR, worker, request and predecessor all agree.
  const canonical = [];
  const byIdentity = new Map();
  const journalIdentity = item => JSON.stringify([item.record.issue, item.record.pr, item.record.workerId,
    item.record.requestId, item.record.previousId ?? null]);
  for (const item of records) {
    const key = journalIdentity(item);
    const existing = byIdentity.get(key);
    if (!existing) { byIdentity.set(key, item); canonical.push(item); continue; }
    if (item.comment.id < existing.comment.id) {
      canonical[canonical.indexOf(existing)] = item;
      byIdentity.set(key, item);
    }
  }
  const latest = canonical.at(-1);
  const replay = latest?.record.requestId === requestId ? latest : undefined;
  const predecessor = replay ? canonical.at(-2) : latest;
  const continuingAdoptedLegacy = ['acknowledge', 'stop', 'stopped'].includes(request.command)
    && issueBindings.length === 0 && predecessor?.record.requiresPrIssueBinding === true;
  if (!exactIssueBinding && ((!adoptingChanges && !continuingAdoptedLegacy) || issueBindings.length !== 0))
    throw new Error('handoff_pr_issue_mismatch');
  const claimWorkerId = request.command === 'adopt-changes'
    ? request.claimWorkerId : predecessor?.record.claimWorkerId ?? request.workerId;
  const claim = acceptedClaim(comments, issueNumber, claimWorkerId);
  if (pr.user.login !== claim.actor) throw new Error('handoff_pr_owner_mismatch');
  // R5I-01: a PR must not reach review under a reservation the submit
  // controller would refuse. `submit`/`resubmit` grant the review position, so
  // they pass the identical canonical current-claim gate: current v3 marker,
  // the issue's exact work packet, and an unexpired lease. The authority is
  // re-checked before the journal is created and again before it is completed,
  // so a lease that expires mid-transition leaves no settled review position.
  if (REVIEW_ENTRY.has(request.command)) {
    const authority = currentClaimAuthority(comments,
      { issueNumber, actor: claim.actor, workerId: claimWorkerId }, issue.body ?? '', now);
    if (!authority.ok) throw new Error(`handoff_claim_${authority.reason}`);
  }
  const maintainerAction = ['changes', 'adopt-changes', 'accept', 'accept-amendment', 'stop'].includes(request.command);
  if (maintainerAction ? (!maintainers.includes(actor) || actor === claim.actor) : actor !== claim.actor)
    throw new Error('handoff_authority_denied');
  if ((predecessor?.comment.id ?? 0) !== request.previousId || (predecessor?.record.phase === 'pending' && request.command !== 'stop')) throw new Error('handoff_predecessor_changed');
  if (predecessor && (predecessor.record.workerId !== request.workerId || predecessor.record.pr !== request.pr
    || predecessor.record.claimId !== claim.id)) throw new Error('handoff_assignment_changed');
  if (predecessor && !['resubmit', 'accept-amendment', 'stop', 'stopped'].includes(request.command) && predecessor.record.head !== request.head)
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
  // Copies of THIS request: same issue, PR, worker, request id and predecessor.
  // Anything else in the history is a different decision, not a duplicate.
  const copyOfThisRequest = comment => {
    const value = parseHandoff(comment);
    return value !== undefined && value.issue === record.issue && value.pr === record.pr
      && value.workerId === record.workerId && value.requestId === record.requestId
      && (value.previousId ?? null) === (record.previousId ?? null);
  };
  let journalId = replay?.comment.id;
  if (!journalId) {
    try { journalId = (await api('POST', `${root}/issues/${issueNumber}/comments`, { body: bodyFor(record) })).id; }
    catch (error) {
      // A lost reply is reconciled by adopting whatever journal the history
      // now shows for this saved request. More than one means a concurrent
      // duplicate also created one; the canonical (lowest id) journal wins and
      // the duplicate is abandoned rather than left to poison a later retry.
      const matches = (await commentsFor(api, repository, issueNumber))
        .filter(copyOfThisRequest).sort((a, b) => a.id - b.id);
      if (matches.length === 0) throw error;
      journalId = matches[0].id;
    }
  }
  // R5I-06: many duplicate runs may reach this point before any of them has
  // re-read the history, so each may have created its own journal. Re-read and
  // fold now, BEFORE any label write, so every duplicate that observes a peer
  // adopts that peer's canonical (lowest-id) journal instead of writing a second
  // one. Whichever journal remains lowest is the one that will be completed, and
  // every duplicate drives the same labels toward the same settled target.
  if (!replay) {
    const concurrent = (await commentsFor(api, repository, issueNumber))
      .filter(copyOfThisRequest).sort((a, b) => a.id - b.id)[0];
    if (concurrent) journalId = concurrent.id;
  }
  async function canonicalJournalId() {
    const history = await commentsFor(api, repository, issueNumber);
    return history.filter(copyOfThisRequest).sort((a, b) => a.id - b.id)[0]?.id;
  }
  async function fresh() {
    const history = await commentsFor(api, repository, issueNumber);
    const canonicalId = await canonicalJournalId();
    const currentClaim = acceptedClaim(history, issueNumber, claimWorkerId);
    const currentPr = await api('GET', `${root}/pulls/${request.pr}`);
    // Duplicates of THIS request are not competing decisions: the fold picked
    // one canonical journal and every duplicate drives it to the same target.
    // A DIFFERENT request's journal appearing NEWER than this run's canonical
    // journal means someone else made a later decision, which must be refused.
    // The previous transition's journal is older and is exactly what is expected.
    const latestOther = history.filter(c => parseHandoff(c)?.issue === issueNumber)
      .filter(c => !copyOfThisRequest(c)).at(-1);
    if ((latestOther?.id ?? 0) > (canonicalId ?? journalId) || currentClaim.id !== claim.id
      || currentClaim.actor !== claim.actor
      || currentPr.head.sha !== (acknowledgingReview ? pr.head.sha : request.head)
      || currentPr.state !== 'open' || currentPr.body !== pr.body) throw new Error('handoff_concurrent_change');
    // This run adopts the canonical journal so the completion PATCH below
    // settles exactly one record even if this run created a different one.
    if (canonicalId !== undefined && canonicalId !== journalId) journalId = canonicalId;
  }
  // A replayed journal written by an older controller may predate the recorded
  // source labels. Treat a missing record as the labels observed now, so an
  // interrupted transition is reconciled instead of crashing.
  for (const [number, source] of [[issueNumber, record.sourceIssueLabels ?? workflowLabels(issue)],
    [request.pr, record.sourcePrLabels ?? workflowLabels(prIssue)]]) {
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
  // The fresh pair of reads below is the ONLY authority on "are these targets
  // still open and settled on these labels" AND, for the issue, on what the work
  // packet says now. Bind them: the final gate must read the issue body from
  // this fetch, not from the one taken at the top of this function.
  const [settledIssue, settledPr] = await Promise.all([getIssue(issueNumber), getIssue(request.pr)]);
  if (![settledIssue, settledPr].every(value => value.state === 'open' && equal(workflowLabels(value), target)))
    throw new Error('handoff_labels_unsettled');
  // Second authority check, immediately before the journal is settled. A lease
  // can expire while the label transition runs, and so can the work packet be
  // edited, so a review position must not be completed under a reservation that
  // is no longer current — in either dimension. Both are re-read here: the claim
  // from a fresh comment list, the packet from the issue fetched just above. The
  // journal is left pending, which the worker's inbox already reports as
  // attention, so the refusal is visible rather than a silent review entry.
  if (REVIEW_ENTRY.has(request.command)) {
    const final = currentClaimAuthority(await commentsFor(api, repository, issueNumber),
      { issueNumber, actor: claim.actor, workerId: claimWorkerId }, settledIssue.body ?? '', now);
    if (!final.ok) throw new Error(`handoff_claim_${final.reason}`);
  }
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
if (isMainModuleV1(process.argv[1], import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
