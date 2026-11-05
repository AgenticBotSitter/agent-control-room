import assert from 'node:assert/strict';
import fsPromises, { readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { createPaidRunJournalLedgerV1, paidRunLedgerRootIdentityV1 } from '../../src/usage/v1/paid-run-ledger';
import { createPaidRunExecutorV1 } from '../../src/usage/v1/paid-run-executor';
import { paidRunAdmission, paidRunContext, paidRunFakeProfile, paidRunNow,
  paidRunFixture, paidRunInput, createPaidRunFakeProviderV1 } from './paid-run-fake-provider';

async function main() {
  if (process.argv.includes('--self-check')) {
    const f = await paidRunFixture({ cap: '5999999' });
    try {
      const result = await f.executor.call(paidRunInput(1));
      assert.deepEqual(result, { kind: 'refused', reason: 'cap_exhausted' }); assert.equal(f.fake.requests.length, 0);
      console.log('RESULT paid-run-driver self-check PASS assertions=2 requests=0');
    } finally { await f.close(); }
    return;
  }
  const [rootArg, point] = process.argv.slice(2);
  const recoveryCheckpoint = /^recovery-(anchor|journal)-(recovered|release|settle|block)$/.exec(point ?? '');
  if (!rootArg || !recoveryCheckpoint && !['reserve', 'dispatch', 'settle', 'lock-window', 'journal-created', 'anchor-open', 'anchor-dispatch', 'anchor-settle', 'recovery-window', 'recovery-seed'].includes(point!)) throw new Error('driver_arguments');
  // Keep the IPC channel referenced while parked at a kill checkpoint.
  process.on('message', () => {});
  const root = resolve(rootArg), context = paidRunContext({ ledgerRootIdentity: await paidRunLedgerRootIdentityV1(root) }), admission = await paidRunAdmission(context);
  async function notify(phase: string, requests: number) {
    const lease = JSON.parse(await readFile(join(root, admission.runKey, 'lease.json'), 'utf8'));
    process.send?.({ phase, requests, generation: lease.generation, runKey: admission.runKey, pinDigest: admission.pinDigest });
  }
  const hold = () => new Promise<void>(() => {});
  if (recoveryCheckpoint) {
    const boundary = recoveryCheckpoint[1], type = recoveryCheckpoint[2];
    const realRename = fsPromises.rename, realOpen = fsPromises.open;
    fsPromises.rename = async (...args: Parameters<typeof realRename>) => {
      await realRename(...args);
      if (boundary === 'anchor' && String(args[1]) === join(root, admission.runKey, 'head.json')) {
        const record = JSON.parse(await readFile(args[1], 'utf8'));
        if (record.type === type) { await notify(point!, 0); await hold(); }
      }
    };
    fsPromises.open = (async (...args: Parameters<typeof realOpen>) => {
      const file = await realOpen(...args);
      if (boundary === 'journal' && String(args[0]) === join(root, admission.runKey, 'journal.jsonl')) {
        const realSync = file.sync.bind(file);
        file.sync = async () => {
          await realSync();
          const lines = (await readFile(args[0], 'utf8')).trim().split('\n');
          if (JSON.parse(lines.at(-1)!).type === type) { await notify(point!, 0); await hold(); }
        };
      }
      return file;
    }) as typeof realOpen;
    syncBuiltinESMExports();
  }
  if (point === 'lock-window' || point === 'journal-created' || point === 'recovery-window') {
    const realOpen = fsPromises.open;
    fsPromises.open = (async (...args: Parameters<typeof realOpen>) => {
      const target = String(args[0]);
      const createsJournal = target === join(root, admission.runKey, 'journal.jsonl') && (Number(args[1]) & constants.O_CREAT) !== 0;
      if (target === join(root, admission.runKey, 'journal.jsonl') && !createsJournal && point === 'recovery-window') {
        await notify(point, 1); await hold();
      }
      // Intercept the actual filesystem boundary, not a product test hook.
      if (createsJournal && point === 'lock-window') { await notify(point, 0); await hold(); }
      const file = await realOpen(...args);
      if (createsJournal && point === 'journal-created') { await notify(point, 0); await hold(); }
      return file;
    }) as typeof realOpen;
    syncBuiltinESMExports();
  }
  if (point!.startsWith('anchor-')) {
    const realRename = fsPromises.rename;
    fsPromises.rename = async (...args: Parameters<typeof realRename>) => {
      await realRename(...args);
      if (String(args[1]) === join(root, admission.runKey, 'head.json')) {
        const record = JSON.parse(await readFile(args[1], 'utf8'));
        if (point === 'anchor-' + record.type) { await notify(point, record.type === 'settle' ? 1 : 0); await hold(); }
      }
    };
    syncBuiltinESMExports();
  }
  const store = createPaidRunJournalLedgerV1({ root, afterReserve: async () => {
    if (point === 'reserve') { await notify('reserve', 0); await hold(); }
  } });
  if (point === 'recovery-window' || recoveryCheckpoint) { await store.reopenForSettlementV1(admission); throw new Error('missed recovery checkpoint'); }
  const ledger = await store.open(admission);
  if (point === 'recovery-seed') {
    // Independent literal reservations total 18M. Dispatch intent alone is enough
    // to require a full charge, even though this fixture never enters transport.
    for (const [n, maxNanoUsd] of [[1, '1000000'], [2, '2000000'], [3, '6000000'], [4, '6000000'], [5, '3000000']] as const) {
      const callId = paidRunInput(n).callId;
      assert.equal((await ledger.reserve({ callId, maxNanoUsd, requestDigest: admission.pinDigest,
        priceRowDigest: admission.pin.priceRowDigest, check: () => {} })).kind, 'reserved');
      if (n >= 3) assert.equal((await ledger.dispatch(callId)).kind, 'dispatched');
    }
    await ledger.settle(paidRunInput(5).callId, { accountedNanoUsd: '2700000', excessNanoUsd: '0', outcome: 'completed', servedModelId: 'served/one' });
    await notify(point, 0); await hold();
  }
  const fake = createPaidRunFakeProviderV1(point === 'dispatch' ? [{ failure: 'hang' }] : []);
  const transport = { async send(...args: Parameters<typeof fake.transport.send>) {
    // Independent observation happens at send entry, while the child still owns the lease.
    const rows = (await readFile(join(root, admission.runKey, 'journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(rows.some(r => r.type === 'dispatch' && r.callId === args[0].callId), 'dispatch durable before send');
    const response = fake.transport.send(...args);
    if (point === 'dispatch') await notify('dispatch', fake.requests.length);
    return response;
  } };
  const executor = createPaidRunExecutorV1({ admission, ledger, transport, profile: paidRunFakeProfile,
    clock: () => paidRunNow, currentConfig: async () => ({ providerVersion: 1, servedModelId: 'served/one',
      billingKind: 'token', priceRows: context.prices }) });
  try {
    await executor.call(paidRunInput(1)); await notify('settle', fake.requests.length); await hold();
  } finally { await executor.stop('run_ended'); await ledger.close(); }
}
void main().catch(error => {
  console.error(error); process.exitCode = 1;
  // Park only at intentional kill checkpoints, never after a failed setup/replay.
  if (process.connected) process.disconnect();
});
