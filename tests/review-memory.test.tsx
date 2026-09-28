import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTaskReviewWorkspace, type ReviewWorkspaceBinding } from '../src/web/v1/task-review-workspace';
import { OwnerTaskReview } from '../private-app/app/task-owner-review';
import { sha256Digest } from '../src/security';
import { BrowserRequestError } from '../src/web/v1/browser-client';
import type { TaskReviewOptions } from '../src/web/v1/task-review-wire';

// Reuses the existing private review-workspace regression's synthetic cases.
const binding = { projectId: 'project:one', jobId: 'job:one', artifactId: 'artifact:one', targetId: 'target:one',
  targetDigest: sha256Digest('target'), contentHash: sha256Digest('content') };
const authentication = { actorId: sha256Digest('actor:one'), sessionEpoch: sha256Digest('session:one') };
const bind = <T extends ReturnType<typeof createTaskReviewWorkspace>>(workspace: T,
  value = authentication) => { workspace.bindAuthenticatedSession(value); return workspace; };

test('review drafts survive detached subscribers but never follow a different exact binding', () => {
  const workspace = createTaskReviewWorkspace();
  const session = workspace.get(binding); session.setFeedback('An unsaved owner draft');
  const detach = session.subscribe(() => {}); detach();
  assert.equal(workspace.get(binding).getSnapshot().feedback, 'An unsaved owner draft');
  for (const field of Object.keys(binding) as (keyof typeof binding)[])
    assert.equal(workspace.get({ ...binding, [field]: `${binding[field]}-other` }).getSnapshot().feedback, '');
  assert.equal(createTaskReviewWorkspace().get(binding).getSnapshot().feedback, '');
  const shell = renderToStaticMarkup(createElement(OwnerTaskReview, { ...binding, workspace, onSaved() {} }));
  assert.match(shell, /Loading owner review/);
  assert.doesNotMatch(shell, /An unsaved owner draft|<textarea/);
  assert.equal(workspace.get(binding), session);
});

test('review capacity preserves earlier drafts instead of silently evicting them', () => {
  const workspace = createTaskReviewWorkspace();
  const existing = workspace.get(binding); existing.setFeedback('Retained draft at capacity');
  for (let index = 1; index < 128; index++) workspace.get({ ...binding, artifactId: `artifact:${index}` });
  const shell = renderToStaticMarkup(createElement(OwnerTaskReview,
    { ...binding, artifactId: 'artifact:overflow', workspace, onSaved() {} }));
  assert.match(shell, /workspace limit/);
  assert.doesNotMatch(shell, /Retained draft at capacity/);
  assert.equal(workspace.get(binding), existing);
  assert.equal(existing.getSnapshot().feedback, 'Retained draft at capacity');
});

test('a lost acceptance reply retries the exact read attestation', async () => {
  const attestation = { scenarioId: 'scenario:human', instructionsDigest: sha256Digest('instructions'), confirmed: true as const };
  const calls: unknown[] = [];
  const client = { hasPending: () => true, options: async () => { throw new Error('unused'); },
    async record(_projectId: string, _jobId: string, draft: unknown) { calls.push(draft); throw new BrowserRequestError('uncertain'); },
    async retrySave() { calls.push(calls[0]); return { projectId: binding.projectId, jobId: binding.jobId,
      artifactId: binding.artifactId, targetId: binding.targetId, targetDigest: binding.targetDigest,
      contentHash: binding.contentHash, reviewId: 'review:one', findingId: null, decision: 'accepted' as const,
      feedbackDigest: sha256Digest(''), recordedAt: '2026-09-27T00:00:00.000Z', grantsApproval: false as const,
      grantsExecutionAuthority: false as const, startsRevision: false as const }; } };
  const workspace = bind(createTaskReviewWorkspace(() => client as never));
  const session = workspace.get(binding);
  session.setAttested(attestation, true);
  assert.equal(await session.save('accepted', attestation), undefined);
  const receipt = await session.save();
  assert.equal(receipt?.decision, 'accepted');
  assert.deepEqual(calls, [{ artifactId: binding.artifactId, targetId: binding.targetId,
    targetDigest: binding.targetDigest, contentHash: binding.contentHash, decision: 'accepted', feedback: '',
    acceptanceAttestation: attestation }, calls[0]]);
});

/* ------------------------------------------------------------------ *
 * The read-and-correct gesture is scoped to ONE exact result.
 *
 * This used to be a module-global map keyed on the scenario and the
 * instructions digest. Neither distinguishes one result from another, so
 * ticking "I read it and it's correct" for result A arrived already ticked
 * for result B — a different artifact with a different content hash — and
 * Accept was enabled with no second owner gesture. The reviewer reproduced
 * that as `actual: true, expected: false`; the fix keys the gesture on the
 * result-bound review session.
 *
 * These are mounted through the real `OwnerTaskReview`, not the presentational
 * panel, so the panel's own remount (the 30s options poll returns a new
 * `options` object) and the controller's `key` both run exactly as they do for
 * an owner. A test on the panel alone would pass against the broken code,
 * because the panel is handed the value.
 * ------------------------------------------------------------------ */

const scenario = 'scenario:owner-read';
const instructionsDigest = sha256Digest('read the exact result');

/** The options a real configured scenario returns for one exact result. */
function availableOptions(bound: ReviewWorkspaceBinding, overrides: Partial<TaskReviewOptions> = {}): TaskReviewOptions {
  return { ...bound, canReview: true, availability: 'available', ownReview: null, grantsExecutionAuthority: false,
    acceptanceAttestation: { scenarioId: scenario, label: 'Owner read', instructions: 'Read it and check it is correct.',
      instructionsDigest }, ...overrides };
}

/** A review client that serves the options for whatever binding it is asked
 * about, so one mounted panel can be re-pointed at a different result the way
 * the real page is when the owner opens a second result. It refuses to save,
 * because what is under test is which result a gesture belongs to, not that a
 * decision reaches the server. */
function reviewingClient(optionsFor: (bound: ReviewWorkspaceBinding) => TaskReviewOptions) {
  return { hasPending: () => false,
    retrySave: async () => { throw new BrowserRequestError('unavailable'); },
    options: async (projectId: string, jobId: string, rest: { artifactId: string; targetId: string; targetDigest: string; contentHash: string }) =>
      optionsFor({ projectId, jobId, ...rest }),
    record: async () => { throw new BrowserRequestError('unavailable'); } };
}

async function mountReview(current: () => ReviewWorkspaceBinding, workspace: ReturnType<typeof createTaskReviewWorkspace>) {
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: 'https://control.invalid/', pretendToBeVisual: true });
  const saved = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById('root')!);
  const settle = async () => { for (let attempt = 0; attempt < 40; attempt += 1) { await act(async () => {
    await new Promise(resolve => dom.window.setTimeout(resolve, 5));
  }); if (dom.window.document.querySelector('input[type="checkbox"]')) return; } };
  await act(async () => { root.render(createElement(OwnerTaskReview, { ...current(), workspace, onSaved() {} })); });
  await settle();
  const document = dom.window.document;
  const box = () => document.querySelector<HTMLInputElement>('input[type="checkbox"]');
  const accept = () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Accept') as HTMLButtonElement;
  return {
    document, box,
    checked: () => box()?.checked ?? null,
    acceptEnabled: () => accept()?.disabled === false,
    tick: async () => {
      const input = box()!;
      await act(async () => { input.click(); });
      await act(async () => { await new Promise(resolve => dom.window.setTimeout(resolve, 5)); });
    },
    authenticate: async (value: typeof authentication | undefined) => {
      await act(async () => { value ? workspace.bindAuthenticatedSession(value) : workspace.invalidateAuthenticatedSession(); });
    },
    show: async () => {
      // Re-render with a different result binding, exactly as opening another
      // result in the same task page does. The controller's key changes, so
      // React unmounts and remounts the whole review subtree.
      await act(async () => { root.render(createElement(OwnerTaskReview, { ...current(), workspace, onSaved() {} })); });
      await settle();
    },
    close: async () => {
      await act(async () => { root.unmount(); });
      dom.window.close();
      for (const [key, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

test('the read-and-correct gesture is scoped to one exact result, not shared across results', async () => {
  const first = binding;
  // A second result of the SAME task: a different artifact, a different target
  // and a different content hash. Everything the old key carried (availability,
  // scenario, instructions digest) is identical, so the old code treated these
  // as one attestation.
  const second: ReviewWorkspaceBinding = { ...binding, artifactId: 'artifact:two', targetId: 'target:two',
    targetDigest: sha256Digest('target-two'), contentHash: sha256Digest('content-two') };
  const workspace = bind(createTaskReviewWorkspace(() => reviewingClient(bound => availableOptions(bound)) as never));
  let current = first;
  const page = await mountReview(() => current, workspace);
  try {
    assert.equal(page.checked(), false, 'a result the owner has not read is not attested');
    assert.equal(page.acceptEnabled(), false, 'Accept is disabled until the owner attests');

    await page.tick();
    assert.equal(page.checked(), true, 'the owner ticked it');
    assert.equal(page.acceptEnabled(), true, 'and Accept is now enabled for that result');

    // The same binding again — a refresh, an options poll, a re-render. The
    // gesture must survive: it is one owner reading one result, and the 30s
    // poll must not silently discard what the owner just did.
    await page.show();
    assert.equal(page.checked(), true, 'a refresh of the SAME binding keeps the owner gesture');
    assert.equal(page.acceptEnabled(), true, 'and keeps Accept available');

    // A different result, same task, same attestation. This is the defect.
    current = second;
    await page.show();
    assert.equal(page.checked(), false,
      'a different result must arrive unattested: a gesture was given for result A, not for result B');
    assert.equal(page.acceptEnabled(), false,
      'Accept must be disabled for a result the owner has not read and attested');

    // And the other direction, so the test cannot pass by never sharing or
    // never separating: each result keeps its own gesture independently.
    await page.tick();
    assert.equal(page.acceptEnabled(), true);
    current = first;
    await page.show();
    assert.equal(page.checked(), true, 'the first result still holds the gesture it was given');
    current = second;
    await page.show();
    assert.equal(page.checked(), true, 'and so does the second, on its own gesture');
  } finally { await page.close(); }
});

test('the gesture resets when any part of the exact review identity changes', async () => {
  // The workspace key is the full identity, so every field of it is load-bearing.
  // Project, job, artifact, target, target digest and content hash each produce a
  // separate session; a tick in one must not be visible in any other.
  const workspace = bind(createTaskReviewWorkspace());
  const session = workspace.get(binding);
  assert.equal(session.attested({ scenarioId: scenario, instructionsDigest }), false);
  session.setAttested({ scenarioId: scenario, instructionsDigest }, true);
  assert.equal(session.attested({ scenarioId: scenario, instructionsDigest }), true);

  for (const [field, value] of Object.entries({
    projectId: 'project:two', jobId: 'job:two', artifactId: 'artifact:two', targetId: 'target:two',
    targetDigest: sha256Digest('target-two'), contentHash: sha256Digest('content-two'),
  }) as [keyof ReviewWorkspaceBinding, string][]) {
    const other = workspace.get({ ...binding, [field]: value });
    assert.equal(other.attested({ scenarioId: scenario, instructionsDigest }), false,
      `a gesture for one ${field} must not be visible to another`);
  }
  // A different attestation for the SAME result is a different question.
  assert.equal(session.attested({ scenarioId: scenario, instructionsDigest: sha256Digest('other') }), false,
    'changed instructions are a different attestation and need a fresh answer');
  // An explicit uncheck retracts it.
  session.setAttested({ scenarioId: scenario, instructionsDigest }, false);
  assert.equal(session.attested({ scenarioId: scenario, instructionsDigest }), false,
    'an explicit uncheck clears the gesture');
});

test('a saved decision spends the gesture that authorised it', async () => {
  const draft = { artifactId: binding.artifactId, targetId: binding.targetId, targetDigest: binding.targetDigest,
    contentHash: binding.contentHash, decision: 'accepted' as const, feedback: '' };
  const receipt = { projectId: binding.projectId, jobId: binding.jobId, ...draft, reviewId: 'review:one',
    findingId: null, feedbackDigest: sha256Digest(''), recordedAt: '2026-09-27T00:00:00.000Z',
    grantsApproval: false as const, grantsExecutionAuthority: false as const, startsRevision: false as const };
  const client = { hasPending: () => false, options: async () => { throw new Error('unused'); },
    record: async () => receipt, retrySave: async () => receipt };
  const workspace = bind(createTaskReviewWorkspace(() => client as never));
  const session = workspace.get(binding);
  const identity = { scenarioId: scenario, instructionsDigest };
  session.setAttested(identity, true);
  const saved = await session.save('accepted', { ...identity, confirmed: true });
  assert.equal(saved?.decision, 'accepted');
  assert.equal(session.attested(identity), false,
    'the gesture authorised this decision, so it is not left behind to enable a second one');
});

test('a direct authenticated-session handoff clears the mounted gesture for the same exact result', async () => {
  const workspace = bind(createTaskReviewWorkspace(() => reviewingClient(bound => availableOptions(bound)) as never));
  const page = await mountReview(() => binding, workspace);
  try {
    await page.tick();
    assert.equal(page.acceptEnabled(), true);
    await page.authenticate({ ...authentication, sessionEpoch: sha256Digest('session:two') });
    await page.show();
    assert.equal(page.checked(), false, 'the previous authenticated session cannot donate its gesture');
    assert.equal(page.acceptEnabled(), false, 'Accept fails closed after a session handoff');
  } finally { await page.close(); }
});

test('sign-out followed by sign-in invalidates the earlier session gesture', () => {
  const workspace = bind(createTaskReviewWorkspace());
  const session = workspace.get(binding);
  const identity = { scenarioId: scenario, instructionsDigest };
  session.setAttested(identity, true);
  assert.equal(session.attested(identity), true);
  workspace.invalidateAuthenticatedSession();
  workspace.bindAuthenticatedSession({ actorId: sha256Digest('actor:two'), sessionEpoch: sha256Digest('session:three') });
  assert.equal(session.attested(identity), false, 'sign-out/sign-in must require a new owner gesture');
});

test('every authenticated binding field is load-bearing for a review gesture', () => {
  for (const [field, value] of Object.entries({
    actorId: sha256Digest('actor:mutated'), sessionEpoch: sha256Digest('session:mutated'),
  }) as [keyof typeof authentication, string][]) {
    const workspace = bind(createTaskReviewWorkspace());
    const session = workspace.get(binding);
    const identity = { scenarioId: scenario, instructionsDigest };
    session.setAttested(identity, true);
    workspace.bindAuthenticatedSession({ ...authentication, [field]: value });
    assert.equal(session.attested(identity), false, `changed ${field} must invalidate the gesture`);
  }
});

test('accepted save without a session-owned live gesture refuses before transport', async () => {
  let recordCalls = 0;
  const client = { hasPending: () => false, options: async () => { throw new Error('unused'); },
    async record() { recordCalls += 1; throw new Error('transport must not run'); },
    async retrySave() { throw new Error('transport must not run'); } };
  const workspace = bind(createTaskReviewWorkspace(() => client as never));
  const session = workspace.get(binding);
  const result = await session.save('accepted', { scenarioId: scenario, instructionsDigest, confirmed: true });
  assert.equal(result, undefined);
  assert.equal(recordCalls, 0, 'acceptance without a live gesture must fail closed before transport');
  assert.equal(session.getSnapshot().error?.code, 'invalid_request');
  assert.equal(session.getSnapshot().pending, false);
});
