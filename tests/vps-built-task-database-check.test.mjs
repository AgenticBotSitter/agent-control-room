import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../dist-vps/server/index.js';
import { createPrivateTaskDatabaseCheck } from '../dist-vps/server/taskDatabaseCheck.js';
import { taskStartupFixture } from './helpers/task-startup.ts';
import { request } from './helpers/web-foundation.ts';
import { instant } from './hermes-native-fixture.ts';

test('compiled task database check verifies configured roles and closes without installing the application', async t => {
  assert.equal((await handler(request())).status, 503);
  const f = await taskStartupFixture(); t.after(f.close);
  const opened = [];
  const check = createPrivateTaskDatabaseCheck({
    openDatabase: config => { opened.push(config.username); return f.openDatabase(config); },
    clock: () => instant + 8000,
  });
  const receipt = await check(f.config);
  assert.deepEqual(opened, ['web_test', 'coordinator_test']);
  assert.deepEqual(receipt.rolesChecked, ['web', 'coordinator']);
  assert.equal(receipt.schema, 'control-room.private-task-database-check/v1');
  assert.equal(receipt.databasePreflight, 'passed');
  assert.equal(receipt.databaseClosed, true);
  for (const flag of ['applicationInstalled', 'listenerStarted', 'workersStarted', 'backupVerified', 'productionReady'])
    assert.equal(receipt[flag], false, flag);
  assert.equal(f.web.closes(), 1); assert.equal(f.coordinator.closes(), 1);
  assert.equal((await handler(request())).status, 503);
});
