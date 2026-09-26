import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexDeliveryBoundWorkspacePreparationV1 }
  from '../src/harness/codex-v1/delivery-bound-workspace-preparation';
import type { CodexLocalStartBindingV1 } from '../src/harness/codex-v1/local-start-runtime';
import { createControllerWorkerDeliveryV1 } from '../src/harness/v1/controller-worker-delivery';
import { sha256Digest } from '../src/security/canonical-digest';

const revision = 'a'.repeat(40);
const intent = Object.freeze({ schema: 'control-room.workspace-intent/v1' as const,
  tenantId: 'tenant:test', nodeId: 'node:test', projectId: 'project:test', jobId: 'job:test',
  attemptId: 'attempt:test', runId: 'run:test', leaseId: 'lease:test', leaseEpoch: 1,
  repositoryRoot: '/synthetic/repository', workspaceRoot: '/synthetic/workspaces',
  checkoutPath: `/synthetic/workspaces/codex-${sha256Digest('run:test').slice(7, 31)}`, revision });

function delivery(change: { jobId?: string; prompt?: string } = {}) {
  return createControllerWorkerDeliveryV1({
    identity: { tenantId: intent.tenantId, nodeId: intent.nodeId, projectId: intent.projectId,
      jobId: change.jobId ?? intent.jobId, attemptId: intent.attemptId, runId: intent.runId },
    worker: { workerId: 'worker:codex', adapterId: 'codex-app-server/v1', adapterRevision: 'source-test' },
    input: { prompt: change.prompt ?? 'Do the exact task.', instructions: 'Return bounded evidence.' },
    authorityDigest: sha256Digest('authority'), connectorProfileDigest: sha256Digest('profile'),
    acceptanceProfileId: 'profile:codex', acceptanceProfileDigest: sha256Digest('acceptance'),
    issuedAt: '2026-09-24T00:00:00.000Z', expiresAt: '2026-09-24T00:10:00.000Z',
  });
}

function binding(packet = delivery()): CodexLocalStartBindingV1 {
  const dispatchFrameDigest = sha256Digest('distinct-dispatch-frame');
  assert.notEqual(packet.deliveryDigest, dispatchFrameDigest);
  return { queueId: 'queue:test', activation: {
    tenantId: intent.tenantId, nodeId: intent.nodeId, projectId: intent.projectId, jobId: intent.jobId,
    attemptId: intent.attemptId, runId: intent.runId, leaseId: intent.leaseId, leaseEpoch: intent.leaseEpoch,
    workspaceIntentDigest: sha256Digest(intent), workspacePath: intent.checkoutPath,
    prompt: packet.input.prompt, instructions: packet.input.instructions, inputDigest: packet.inputDigest,
    connectorProfileDigest: packet.connectorProfileDigest,
  }, dispatchFrameDigest } as CodexLocalStartBindingV1;
}

function fixture(options: { failCreate?: boolean; revokeDuringCreate?: boolean } = {}) {
  let creates = 0, removes = 0, inspections = 0, current = true;
  const journal = {
    reserveWorkspaceIntent: () => 'recorded' as const,
    recordWorkspaceRoots() { return 'recorded' as const; }, recordWorkspaceCreation() { return 'recorded' as const; },
    reserveWorkspaceRemoval: () => 'recorded' as const, recordWorkspaceRemoved() { return 'recorded' as const; },
  };
  const preparation = createCodexDeliveryBoundWorkspacePreparationV1({ workspaceIntent: intent, journal,
    policy: { allowedPaths: ['src/**'], maximumChangedFiles: 5, maximumChangedBytes: 4096 },
    workspacePort: {
      async inspectRootIdentities() { return {
        repository: { realPath: intent.repositoryRoot, device: '1', inode: '2' },
        workspace: { realPath: intent.workspaceRoot, device: '1', inode: '3' },
        commonGit: { realPath: `${intent.repositoryRoot}/.git`, device: '1', inode: '4' } }; },
      async observeCheckout() { return { state: 'absent' as const }; },
      async inspectExisting(path) { inspections++; return { realPath: path, device: '1',
        inode: path === intent.repositoryRoot ? '2' : '3' }; },
      async createDetachedWorktree() {
        creates++;
        if (options.revokeDuringCreate) current = false;
        if (options.failCreate) throw new Error('lost_create_response');
        return { realPath: intent.checkoutPath, repositoryRealPath: intent.repositoryRoot,
          headRevision: revision, device: '1', inode: '5' };
      },
      async removeWorktree() { removes++; },
    },
  });
  const assertCurrent = () => { if (!current) throw new Error('revoked'); };
  return { preparation, assertCurrent, counts: () => ({ creates, removes, inspections }) };
}

test('one exact shared delivery prepares and retains one workspace while its digest stays distinct from dispatch', async () => {
  const f = fixture(), packet = delivery(), startBinding = binding(packet);
  f.preparation.bindDelivery(packet);
  await f.preparation.prepare(startBinding, f.assertCurrent);
  await f.preparation.prepare(startBinding, f.assertCurrent);
  assert.deepEqual(f.counts(), { creates: 1, removes: 0, inspections: 2 });
  assert.throws(() => f.preparation.bindDelivery(packet), /unavailable/,
    'the shared delivery binding is one-use even when the packet is exact');
  assert.equal('cleanup' in f.preparation, false); assert.equal('lease' in f.preparation, false);
  assert.equal('workspacePath' in f.preparation, false);
});

test('absent, changed, or mismatched shared delivery refuses before workspace effects', async () => {
  const absent = fixture();
  await assert.rejects(absent.preparation.prepare(binding(), absent.assertCurrent), /unavailable/);
  assert.deepEqual(absent.counts(), { creates: 0, removes: 0, inspections: 0 });

  const wrongIdentity = fixture();
  assert.throws(() => wrongIdentity.preparation.bindDelivery(delivery({ jobId: 'job:other' })), /unavailable/);
  assert.deepEqual(wrongIdentity.counts(), { creates: 0, removes: 0, inspections: 0 });

  const changed = fixture(), packet = delivery(); changed.preparation.bindDelivery(packet);
  await assert.rejects(changed.preparation.prepare(binding(delivery({ prompt: 'Changed task.' })), changed.assertCurrent),
    /unavailable/);
  assert.deepEqual(changed.counts(), { creates: 0, removes: 0, inspections: 0 });
});

test('creation uncertainty is retained and a repeated prepare never creates or cleans again', async () => {
  const f = fixture({ failCreate: true }), packet = delivery(); f.preparation.bindDelivery(packet);
  await assert.rejects(f.preparation.prepare(binding(packet), f.assertCurrent), /unavailable/);
  await assert.rejects(f.preparation.prepare(binding(packet), f.assertCurrent), /unavailable/);
  assert.deepEqual(f.counts(), { creates: 1, removes: 0, inspections: 2 });
});

test('authority is rechecked after acquisition before the workspace can be accepted for start', async () => {
  const f = fixture({ revokeDuringCreate: true }), packet = delivery(); f.preparation.bindDelivery(packet);
  await assert.rejects(f.preparation.prepare(binding(packet), f.assertCurrent), /revoked/);
  assert.deepEqual(f.counts(), { creates: 1, removes: 0, inspections: 2 });
});
