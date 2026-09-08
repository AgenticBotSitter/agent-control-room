import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startWebsiteOnly } from '../scripts/run-private-vps.mjs';

function fixture() {
  const abort = new AbortController(), counts = { opened: 0, closed: 0, started: 0 };
  let closing;
  const app = { isReady: () => !closing, close() { return closing ??= Promise.resolve().then(() => { counts.closed++; }); } };
  const prepared = { mode: 'website-only', port: 3210, configuration: { web: { origin: 'https://test.example' } } };
  const dependencies = { signal: abort.signal, handler: () => {}, assets: {},
    bootstrap: { validatePrivateStartupConfiguration: value => structuredClone(value),
      async startPrivateWebApplication() { counts.opened++; return app; } },
    serving: { createPrivateNodeService(input) {
      assert.equal(input.origin, 'https://test.example'); assert.equal(input.application, app);
      return { isReady: app.isReady, async start() { counts.started++; }, close: app.close };
    } } };
  return { abort, counts, prepared, dependencies };
}

test('restricted website starts without a coordinator and closes its owned database', async () => {
  const f = fixture(), service = await startWebsiteOnly(f.prepared, f.dependencies);
  assert.equal(service.isReady(), true); await service.close(); await service.close();
  assert.deepEqual(f.counts, { opened: 1, started: 1, closed: 1 });
});

test('invalid profiles and canceled startup open no database', async () => {
  for (const extra of [{ coordinator: {} }, { news: {} }]) {
    const f = fixture(); Object.assign(f.prepared.configuration, extra);
    await assert.rejects(startWebsiteOnly(f.prepared, f.dependencies)); assert.equal(f.counts.opened, 0);
  }
  const f = fixture(); f.abort.abort();
  await assert.rejects(startWebsiteOnly(f.prepared, f.dependencies)); assert.equal(f.counts.opened, 0);
});

test('cancellation during database startup closes the late database without binding', async () => {
  const f = fixture(), start = f.dependencies.bootstrap.startPrivateWebApplication;
  f.dependencies.bootstrap.startPrivateWebApplication = async () => { const app = await start(); f.abort.abort(); return app; };
  await assert.rejects(startWebsiteOnly(f.prepared, f.dependencies));
  assert.deepEqual(f.counts, { opened: 1, started: 0, closed: 1 });
});

test('listener construction failure closes the acquired database', async () => {
  const f = fixture(); f.dependencies.serving.createPrivateNodeService = () => { throw new Error('synthetic'); };
  await assert.rejects(startWebsiteOnly(f.prepared, f.dependencies)); assert.equal(f.counts.closed, 1);
});
