import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTaskReviewWorkspace } from '../src/web/v1/task-review-workspace';
import { OwnerTaskReview } from '../private-app/app/task-owner-review';
import { sha256Digest } from '../src/security';
import { BrowserRequestError } from '../src/web/v1/browser-client';

// Reuses the existing private review-workspace regression's synthetic cases.
const binding = { projectId: 'project:one', jobId: 'job:one', artifactId: 'artifact:one', targetId: 'target:one',
  targetDigest: sha256Digest('target'), contentHash: sha256Digest('content') };

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
  const workspace = createTaskReviewWorkspace(() => client as never);
  const session = workspace.get(binding);
  assert.equal(await session.save('accepted', attestation), undefined);
  const receipt = await session.save();
  assert.equal(receipt?.decision, 'accepted');
  assert.deepEqual(calls, [{ artifactId: binding.artifactId, targetId: binding.targetId,
    targetDigest: binding.targetDigest, contentHash: binding.contentHash, decision: 'accepted', feedback: '',
    acceptanceAttestation: attestation }, calls[0]]);
});
