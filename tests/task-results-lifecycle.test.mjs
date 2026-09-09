import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { PrivateTaskResults } from '../private-app/app/task-results.tsx';
import { createHash } from 'node:crypto';

test('result reader ignores late content after leaving its task', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const saved = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const pending = [];
  globalThis.fetch = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
  const root = createRoot(dom.window.document.getElementById('root'));
  const protectedText = 'PRIVATE FIRST TASK CONTENT';
  const artifact = { artifactId: 'artifact:test', attemptId: 'attempt:test', runId: 'run:test',
    contentHash: `sha256:${createHash('sha256').update(protectedText).digest('hex')}`,
    sizeBytes: Buffer.byteLength(protectedText), receivedAt: '2026-09-08T12:00:00.000Z',
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
      artifact, text: protectedText, contentVerifiedAt: artifact.receivedAt, untrustedContent: true })));
    assert.doesNotMatch(document.body.textContent, /PRIVATE FIRST TASK CONTENT/);
    await act(async () => pending[3].resolve(Response.json({ ...page('job:second'), items: [] })));
    assert.doesNotMatch(document.body.textContent, /PRIVATE FIRST TASK CONTENT/);
    assert.match(document.body.textContent, /No result files have been received/);
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')));
    await act(async () => pending[4].resolve(Response.json(page('job:second'))));
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Read result').click());
    await act(async () => pending[5].resolve(Response.json(page('job:second'))));
    await act(async () => {
      pending[6].resolve(Response.json({ projectId: 'project:test', jobId: 'job:second', artifact,
        text: protectedText, contentVerifiedAt: artifact.receivedAt, untrustedContent: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    assert.match(document.body.textContent, /PRIVATE FIRST TASK CONTENT/);
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')));
    assert.doesNotMatch(document.body.textContent, /PRIVATE FIRST TASK CONTENT/);
    await act(async () => pending[7].resolve(new Response('', { status: 403 })));
    assert.doesNotMatch(document.body.textContent, /PRIVATE FIRST TASK CONTENT/);
    assert.match(document.body.textContent, /access/);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
