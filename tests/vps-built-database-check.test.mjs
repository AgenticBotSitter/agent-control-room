import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../dist-vps/server/index.js';
import { createPrivateWebDatabaseCheck } from '../dist-vps/server/bootstrap.js';
import { limitedWebFixture, startupConfig } from './helpers/web-startup.ts';
import { now, request } from './helpers/web-foundation.ts';

test('compiled database-only check closes its restricted pool without installing the compiled website', async () => {
  assert.equal((await handler(request())).status, 503);
  const f = await limitedWebFixture();
  const check = createPrivateWebDatabaseCheck({ openDatabase: () => f.pool, clock: () => now });
  const result = await check(startupConfig);
  assert.equal(result.databasePreflight, 'passed'); assert.equal(result.databaseClosed, true);
  assert.equal(result.applicationInstalled, false); assert.equal(result.listenerStarted, false);
  assert.equal(result.backupVerified, false); assert.equal(result.productionReady, false);
  assert.equal(f.closes(), 1);
  assert.equal((await handler(request())).status, 503);
});
