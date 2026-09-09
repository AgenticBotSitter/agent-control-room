import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { PrivateProjectWorkspace } from '../private-app/app/workspace.tsx';

test('project navigation hides old details and lifecycle actions before the new read completes', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const saved = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const pending = [];
  globalThis.fetch = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
  const root = createRoot(document.getElementById('root'));
  const project = id => ({ projectId: id, title: id === 'project:first' ? 'PRIVATE FIRST PROJECT' : 'Second project',
    summary: 'Saved purpose', lifecycle: 'active', version: 1, origin: 'ordinary', lifecycleEditable: true,
    createdAt: '2026-09-09T12:00:00.000Z', updatedAt: '2026-09-09T12:00:00.000Z' });
  const render = id => root.render(React.createElement(PrivateProjectWorkspace, { projectId: id, section: 'settings' }));
  try {
    await act(async () => render('project:first'));
    await act(async () => pending[0].resolve(Response.json({ project: project('project:first') })));
    assert.match(document.body.textContent, /PRIVATE FIRST PROJECT/);
    assert.ok([...document.querySelectorAll('button')].some(button => button.textContent === 'Archive project'));
    await act(async () => render('project:second'));
    assert.doesNotMatch(document.body.textContent, /PRIVATE FIRST PROJECT/);
    assert.ok(![...document.querySelectorAll('button')].some(button => button.textContent === 'Archive project'));
    assert.match(document.body.textContent, /Loading project/);
    await act(async () => pending[1].resolve(Response.json({ project: project('project:second') })));
    assert.match(document.body.textContent, /Second project/);
    assert.doesNotMatch(document.body.textContent, /PRIVATE FIRST PROJECT/);
    assert.equal(pending.length, 2);
    const archive = [...document.querySelectorAll('button')].find(button => button.textContent === 'Archive project');
    await act(async () => archive.click());
    assert.equal(pending[2].options.method, 'POST');
    await act(async () => render('project:first'));
    assert.equal(pending.length, 3); // Reads wait while the original save owns the client.
    const { origin, lifecycleEditable, ...savedProject } = project('project:second');
    await act(async () => pending[2].resolve(Response.json({ project: { ...savedProject, lifecycle: 'archived', version: 2 }, replayed: false })));
    assert.equal(pending.length, 4, 'settling the original save must immediately reload the current route');
    assert.equal(pending[3].options.method, 'GET');
    assert.match(pending[3].url, /project%3Afirst$/);
    await act(async () => pending[3].resolve(Response.json({ project: project('project:first') })));
    assert.match(document.body.textContent, /PRIVATE FIRST PROJECT/);
    assert.doesNotMatch(document.body.textContent, /Second project/);
    assert.equal(pending.filter(request => request.options.method === 'POST').length, 1);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
