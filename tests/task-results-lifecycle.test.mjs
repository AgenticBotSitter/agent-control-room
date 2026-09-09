import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { PrivateTaskResults } from '../private-app/app/task-results.tsx';

test('result reader ignores late content after leaving its task', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const saved = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const pending = [];
  globalThis.fetch = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
  const root = createRoot(dom.window.document.getElementById('root'));
  const artifact = { artifactId: 'artifact:test', attemptId: 'attempt:test', runId: 'run:test',
    contentHash: `sha256:${'a'.repeat(64)}`, sizeBytes: 12, receivedAt: '2026-09-08T12:00:00.000Z',
    byteCheck: 'matched_recorded_claim', qualityAccepted: false };
  const page = jobId => ({ projectId: 'project:test', jobId, observedAt: artifact.receivedAt,
    resultSource: 'configured', reviewSource: 'configured', items: [artifact], reviews: [],
    additionalResultsOmitted: false, additionalTargetsOmitted: false, canReadContent: true, reviewCommands: 'not_connected' });
  const render = jobId => root.render(React.createElement(PrivateTaskResults,
    { projectId: 'project:test', jobId, reviewWorkspace: {} }));
  try {
    await act(async () => render('job:first'));
    await act(async () => pending[0].resolve(Response.json(page('job:first'))));
    const read = [...document.querySelectorAll('button')].find(button => button.textContent === 'Read result');
    assert.ok(read);
    await act(async () => read.click());
    await act(async () => pending[1].resolve(Response.json(page('job:first'))));
    assert.equal(pending.length, 3);
    await act(async () => render('job:second'));
    assert.doesNotMatch(document.body.textContent, /Saved result file/);
    await act(async () => pending[2].resolve(Response.json({ projectId: 'project:test', jobId: 'job:first',
      artifact, text: 'PRIVATE FIRST TASK CONTENT', contentVerifiedAt: artifact.receivedAt, untrustedContent: true })));
    assert.doesNotMatch(document.body.textContent, /PRIVATE FIRST TASK CONTENT/);
    await act(async () => pending[3].resolve(Response.json({ ...page('job:second'), items: [] })));
    assert.doesNotMatch(document.body.textContent, /PRIVATE FIRST TASK CONTENT/);
    assert.match(document.body.textContent, /No result files have been received/);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
