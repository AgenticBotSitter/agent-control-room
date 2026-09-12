import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { PrivateProjectWorkspace } from '../private-app/app/workspace.tsx';

test('idea-lab project reopen renders a revision notice without obscuring lifecycle controls', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const saved = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const pending = [];
  globalThis.fetch = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
  const root = createRoot(document.getElementById('root'));
  const reopenedProject = { projectId: 'project:reopened', title: 'Reopened idea', summary: 'Reopened idea body',
    lifecycle: 'active', version: 3, origin: 'idea_lab', lifecycleEditable: true,
    ideaLifecycleActions: ['pause', 'complete'], createdAt: '2026-09-09T12:00:00.000Z', updatedAt: '2026-09-09T12:00:00.000Z' };
  const render = (projectId, section) => root.render(React.createElement(PrivateProjectWorkspace, { projectId, section }));
  try {
    // Settings section is where idea-lab lifecycle controls live.
    await act(async () => render('project:reopened', 'settings'));
    await act(async () => pending[0].resolve(Response.json({ project: reopenedProject })));
    assert.match(document.body.textContent, /Reopened idea/);
    assert.match(document.body.textContent, /reopened/i);
    // Pause control is still present — the notice never replaces the controls.
    assert.ok([...document.querySelectorAll('button')].some(button => button.textContent === 'Pause project'));
    // An ordinary project with the same version does NOT show the notice on settings either.
    const ordinaryProject = { ...reopenedProject, origin: 'ordinary' };
    await act(async () => render('project:ordinary', 'settings'));
    await act(async () => pending[1].resolve(Response.json({ project: ordinaryProject })));
    assert.doesNotMatch(document.body.textContent, /reopened/i);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

test('network read errors render a project-error notice distinct from permission unavailability', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const saved = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const pending = [];
  globalThis.fetch = () => Promise.resolve(new Response('', { status: 503 }));
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => root.render(React.createElement(PrivateProjectWorkspace, { projectId: 'project:fail', section: 'overview' })));
    await act(async () => new Promise(resolve => setTimeout(resolve, 50)));
    // 503 is not in the permission-collapse list, so the page settles to a read-error notice
    // and the project body remains hidden behind the "unavailable" umbrella.
    assert.match(document.body.textContent, /project read failed|Read|read error|Project read failed/i);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    void pending;
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

for (const projectOrigin of ['ordinary', 'idea_lab']) test(`${projectOrigin} navigation and uncertain saves retain exact project identity`, async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const saved = Object.fromEntries(['window', 'document', 'IS_REACT_ACT_ENVIRONMENT', 'fetch']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const pending = [];
  globalThis.fetch = (url, options) => new Promise(resolve => pending.push({ url, options, resolve }));
  const root = createRoot(document.getElementById('root'));
  const project = (id, lifecycle = projectOrigin === 'idea_lab' ? 'completed' : 'active', version = 1) => ({ projectId: id, title: id === 'project:first' ? 'PRIVATE FIRST PROJECT' : 'Second project',
    summary: 'Saved purpose', lifecycle, version, origin: projectOrigin, lifecycleEditable: true,
    ...(projectOrigin === 'idea_lab' ? { ideaLifecycleActions: lifecycle === 'archived' ? ['reopen'] : lifecycle === 'completed' ? ['archive'] : ['pause', 'complete'] } : {}),
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
    assert.ok(pending[2].url.endsWith(projectOrigin === 'ordinary' ? '/lifecycle' : '/idea-lifecycle'));
    assert.deepEqual(JSON.parse(pending[2].options.body), projectOrigin === 'ordinary'
      ? { lifecycle: 'archived', expectedVersion: 1 } : { action: 'archive', expectedVersion: 1 });
    await act(async () => render('project:first'));
    assert.equal(pending.length, 3); // Reads wait while the original save owns the client.
    const { origin, lifecycleEditable, ideaLifecycleActions, ...savedProject } = project('project:second');
    await act(async () => pending[2].resolve(Response.json({ project: { ...savedProject, lifecycle: 'archived', version: 2 }, replayed: false })));
    assert.equal(pending.length, 4, 'settling the original save must immediately reload the current route');
    assert.equal(pending[3].options.method, 'GET');
    assert.match(pending[3].url, /project%3Afirst$/);
    await act(async () => pending[3].resolve(Response.json({ project: project('project:first') })));
    assert.match(document.body.textContent, /PRIVATE FIRST PROJECT/);
    assert.doesNotMatch(document.body.textContent, /Second project/);
    assert.equal(pending.filter(request => request.options.method === 'POST').length, 1);
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Archive project').click());
    const original = pending[4];
    await act(async () => original.resolve(new Response('', { status: 500 })));
    assert.equal(pending[5].options.method, 'GET');
    await act(async () => pending[5].resolve(Response.json({ project: project('project:first') })));
    await act(async () => render('project:second'));
    await act(async () => pending[6].resolve(Response.json({ project: project('project:second') })));
    const retry = [...document.querySelectorAll('button')].find(button => button.textContent === 'Retry original save');
    assert.ok(retry);
    assert.ok([...document.querySelectorAll('button')].find(button => button.textContent === 'Archive project').disabled);
    assert.equal(pending.filter(request => request.options.method === 'POST').length, 2, 'reads must not retry an uncertain write');
    await act(async () => retry.click());
    assert.equal(pending[7].url, original.url);
    assert.equal(pending[7].options.body, original.options.body);
    assert.equal(pending[7].options.headers['idempotency-key'], original.options.headers['idempotency-key']);
    const { origin: firstOrigin, lifecycleEditable: firstEditable, ideaLifecycleActions: firstActions, ...firstSaved } = project('project:first');
    await act(async () => pending[7].resolve(Response.json({ project: { ...firstSaved, lifecycle: 'archived', version: 2 }, replayed: true })));
    assert.match(pending[8].url, /project%3Asecond$/);
    await act(async () => pending[8].resolve(Response.json({ project: project('project:second') })));
    assert.equal(pending.length, 9, 'one current-route refresh is enough after the retry');
    assert.match(document.body.textContent, /Second project/);
    assert.doesNotMatch(document.body.textContent, /PRIVATE FIRST PROJECT|Retry original save/);
    assert.equal(pending.filter(request => request.options.method === 'POST').length, 3);
    await act(async () => dom.window.dispatchEvent(new dom.window.Event('focus')));
    await act(async () => pending[9].resolve(Response.json({ project: project('project:second', 'archived', 2) })));
    const reopen = [...document.querySelectorAll('button')].find(button => button.textContent === 'Reopen project');
    assert.ok(reopen);
    await act(async () => reopen.click());
    assert.deepEqual(JSON.parse(pending[10].options.body), projectOrigin === 'ordinary'
      ? { lifecycle: 'active', expectedVersion: 2 } : { action: 'reopen', expectedVersion: 2 });
    assert.match(pending[10].url, /project%3Asecond\/(idea-)?lifecycle$/);
    await act(async () => pending[10].resolve(Response.json({ project: { ...savedProject, lifecycle: 'active', version: 3 }, replayed: false })));
    await act(async () => pending[11].resolve(Response.json({ project: project('project:second', 'active', 3) })));
    assert.match(document.body.textContent, /Saved revision 3/);
    assert.equal(pending.filter(request => request.options.method === 'POST').length, 4);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
