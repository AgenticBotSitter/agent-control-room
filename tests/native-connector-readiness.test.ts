import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeConnector } from '../src/node-bridge/native-connector';
import { createNativeHttpNodeHost } from '../src/node-bridge/native-http-host';

test('HTTP host cancellation inside the final readiness check prevents exchange', async () => {
  const abort = new AbortController(); let checks = 0, exchanges = 0;
  const host = createNativeHttpNodeHost({ async openWire() {}, async receiveWire() {}, async disconnected() { return 0; } },
    { async exchange() { exchanges++; throw new Error('unexpected exchange'); }, async close() {} },
    () => { if (++checks === 3) abort.abort(); });
  await assert.rejects(host.open('recover', abort.signal));
  await host.close();
  assert.equal(checks, 3); assert.equal(exchanges, 0);
});

test('connector and standalone HTTP host refuse incomplete readiness before I/O', async () => {
  for (const kind of ['connector', 'host'] as const) {
    for (const value of ['fulfilled', 'rejected', 'false'] as const) {
      let effects = 0;
      const unexpected = async () => { effects++; throw new Error('unexpected effect'); };
      const runtime = { openWire: unexpected, receiveWire: unexpected, disconnected: async () => 0,
        hasAcceptedDispatch() { effects++; return false; }, start: unexpected, poll: unexpected, close: async () => {} };
      const client = { exchange: unexpected, close: async () => {} };
      const assertCurrent = () => value === 'false' ? false : value === 'fulfilled'
        ? Promise.resolve() : Promise.reject(new Error('synthetic incomplete readiness'));
      if (kind === 'host') {
        const host = createNativeHttpNodeHost(runtime, client, assertCurrent);
        await assert.rejects(async () => host.open('recover', new AbortController().signal));
        await host.close();
      } else {
        const connector = createNativeConnector(runtime as unknown as Parameters<typeof createNativeConnector>[0], client,
          { maxCycles: 1, intervalMs: 1, timeoutMs: 100 }, { assertCurrent });
        await assert.rejects(async () => connector.run('recover', new AbortController().signal));
        await connector.close();
      }
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(effects, 0, `${kind}: ${value}`);
    }
  }
});
