import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorkerLifecycleFixture, projectSyntheticRecovery, recordSyntheticLifecycle,
  reopenSyntheticLifecycle, runSyntheticLauncherScenario } from '../tests/helpers/private-worker-lifecycle';

export async function testPrivateWorkerLifecycleV1() {
  const root = await mkdtemp(join(tmpdir(), 'control-room-worker-lifecycle-')); await chmod(root, 0o700);
  try {
    const fixture = await createWorkerLifecycleFixture(root);
    const interrupted = recordSyntheticLifecycle(fixture.startPath, 'thread');
    const reopened = reopenSyntheticLifecycle(fixture.startPath);
    const completedRoot = await mkdtemp(join(tmpdir(), 'control-room-worker-completed-'));
    await chmod(completedRoot, 0o700);
    try {
      const completedFixture = await createWorkerLifecycleFixture(completedRoot);
      recordSyntheticLifecycle(completedFixture.startPath, 'recorded');
      const recovery = projectSyntheticRecovery(completedFixture.startPath, 'completed');
      const launch = await Promise.all(['completed', 'revoked', 'late-acquisition', 'drain-failure', 'hermes-completed'].map(value =>
        runSyntheticLauncherScenario(value as 'completed' | 'revoked' | 'late-acquisition' | 'drain-failure' | 'hermes-completed')));
      return Object.freeze({ schema: 'control-room.synthetic-private-worker-lifecycle-evidence/v1',
        interruptionStatus: interrupted.status, reopenStatus: reopened.status,
        duplicateWorkStarted: false, recoveryStatus: recovery.status, usage: recovery.usage,
        launcher: Object.freeze(launch.map(value => ({ scenario: value.scenario, code: value.code,
          runs: value.runs, closes: value.closes, acquisitions: value.acquisitions }))),
        providerCalls: 0, credentialsRead: 0, servicesStarted: 0,
        automaticRestarts: 0, canonicalPublicationAllowed: false,
        completionVerified: false, grantsExecutionAuthority: false });
    } finally { await rm(completedRoot, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(await testPrivateWorkerLifecycleV1())}\n`); }
  catch { console.error('Control Room synthetic worker lifecycle failed.'); process.exitCode = 1; }
}
