import assert from 'node:assert/strict';
import { test } from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { SessionObservations } from '../private-app/app/session-observations.tsx';
import { herdrObservationPageSchema } from '../src/web/v1/herdr-wire.ts';

const page = (projectId, ageMs = 0) => ({ projectId, status: 'online', ageMs,
  executionAuthority: false, completionVerified: false, cleanupVerified: false,
  rows: [{ key: 'a'.repeat(64), status: 'done', duplicateSession: true, stateSource: 'advisory',
    executionAuthority: false, completionVerified: false, cleanupVerified: false }] });

test('session panel isolates project changes, marks stale rows and hides observations on denied refresh', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const saved = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const pending = [];
  globalThis.fetch = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
  const root = createRoot(dom.window.document.getElementById('root'));
  const text = () => dom.window.document.body.textContent;
  try {
    await act(async () => root.render(React.createElement(SessionObservations, { projectId: 'project:a' })));
    assert.equal(pending.length, 1); assert.equal(pending[0].options.method, 'GET');
    await act(async () => root.render(React.createElement(SessionObservations, { projectId: 'project:b' })));
    assert.equal(pending.length, 2); assert.equal(pending[0].options.signal.aborted, true);
    await act(async () => pending[0].resolve(Response.json(page('project:a'))));
    assert.doesNotMatch(text(), /completion unverified/);
    await act(async () => pending[1].resolve(Response.json(page('project:b', 4900))));
    assert.match(text(), /done \(completion unverified\)/);
    assert.match(text(), /Duplicate session reference/);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    assert.match(text(), /Offline or stale/);
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')));
    assert.doesNotMatch(text(), /completion unverified/);
    await act(async () => pending[2].resolve(new Response('', { status: 403 })));
    assert.match(text(), /hidden. Check your access/);
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')));
    assert.equal(pending.length, 3);
    await act(async () => dom.window.document.querySelector('button').click());
    assert.equal(pending.length, 4);
    await act(async () => pending[3].resolve(Response.json(page('project:wrong'))));
    assert.match(text(), /unavailable/); assert.doesNotMatch(text(), /completion unverified/);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

test('browser wire rejects claimed authority, raw metadata and internally contradictory pages', () => {
  const valid = page('project:a');
  assert.equal(herdrObservationPageSchema.safeParse(valid).success, true);
  for (const invalid of [{ ...valid, executionAuthority: true }, { ...valid, status: 'not_configured' },
    { ...valid, ageMs: 5000 }, { ...valid, ageMs: null }, { ...valid, rows: [...valid.rows, ...valid.rows] },
    { ...valid, rows: [{ ...valid.rows[0], sessionId: 'must-not-leak' }] }]) {
    assert.equal(herdrObservationPageSchema.safeParse(invalid).success, false);
  }
});
