import assert from 'node:assert/strict';
import test from 'node:test';
import { suppliedNativeFixtureDatabase, withNativeFixtureDatabase,
  type NativeFixtureDatabase } from '../../tests/helpers/native-fixture-database.ts';

test('injected fixture databases stay scoped across overlapping work and errors', async () => {
  const deny = async (): Promise<never> => { throw new Error('no database operations allowed'); };
  const a: NativeFixtureDatabase = { raw: { query: deny, exec: deny, close: deny },
    db: { query: deny, transaction: deny, transactionWithPreCommitCheck: deny } };
  const b: NativeFixtureDatabase = { ...a };
  assert.equal(suppliedNativeFixtureDatabase(), undefined);
  await Promise.all([a, b].map(backend => withNativeFixtureDatabase(async () => backend, async () => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await suppliedNativeFixtureDatabase(), backend);
  })));
  await assert.rejects(withNativeFixtureDatabase(async () => a, async () => {
    assert.equal(await suppliedNativeFixtureDatabase(), a); throw new Error('synthetic fixture failure');
  }), /synthetic fixture failure/);
  assert.equal(suppliedNativeFixtureDatabase(), undefined);
});
