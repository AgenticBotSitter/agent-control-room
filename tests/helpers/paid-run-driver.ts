import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createPaidRunJournalLedgerV1 } from '../../src/usage/v1/paid-run-ledger';
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
  if (!rootArg || !['reserve', 'dispatch', 'settle'].includes(point!)) throw new Error('driver_arguments');
  // Keep the IPC channel referenced while parked at a kill checkpoint.
  process.on('message', () => {});
  const root = resolve(rootArg), context = paidRunContext(), admission = await paidRunAdmission(context);
  async function notify(phase: string, requests: number) {
    const lease = JSON.parse(await readFile(join(root, admission.runKey, 'lease.json'), 'utf8'));
    process.send?.({ phase, requests, generation: lease.generation, runKey: admission.runKey, pinDigest: admission.pinDigest });
  }
  const hold = () => new Promise<void>(() => {});
  const store = createPaidRunJournalLedgerV1({ root, afterReserve: async () => {
    if (point === 'reserve') { await notify('reserve', 0); await hold(); }
  } });
  const ledger = await store.open(admission);
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
void main().catch(error => { console.error(error); process.exitCode = 1; });
