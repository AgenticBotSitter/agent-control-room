import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('conditional supervisor template retains website-only non-root and no-auto-effect defaults', async () => {
  const source = await readFile(new URL('../deploy/control-room-website.service.in', import.meta.url), 'utf8');
  const lines = source.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  for (const required of ['User=REVIEWED_SERVICE_USER', 'Group=REVIEWED_SERVICE_GROUP', 'Type=exec',
    'Restart=no', 'KillSignal=SIGTERM', 'KillMode=control-group', 'TimeoutStopSec=45s',
    'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'ProtectSystem=strict', 'ProtectHome=yes', 'UMask=0077'])
    assert.ok(lines.includes(required), required);
  assert.deepEqual(lines.filter(line => line.startsWith('Exec')), [
    'ExecStart=/APPROVED/NODE /APPROVED/RELEASE/scripts/run-private-vps.mjs --configuration /APPROVED/RELEASE/deploy/operator-config.mjs',
  ]);
  assert.doesNotMatch(lines.join('\n'), /PrivateNetwork=yes|User=root|password|pg_restore|pg_dump|--force|git pull/i);
  // Source-contract test only. Installed-version syntax and namespace acceptance remain an operator gate.
});
