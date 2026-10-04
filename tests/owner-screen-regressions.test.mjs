import assert from 'node:assert/strict';
import test from 'node:test';
import React,{act,createElement as h} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {readFile} from 'node:fs/promises';
import {OperationsControlPanel} from '../private-app/app/operations-control.tsx';
import {FleetWorkers} from '../private-app/app/workers/fleet-workers.tsx';
import {ConnectBotWorkspace} from '../private-app/app/workers/connect/connect-bot-workspace.tsx';
import {PrivateHeader} from '../private-app/app/private-header.tsx';
import {PasskeyRegistration} from '../private-app/app/setup/passkey-registration.tsx';
import {LocalRuntimeContextV1} from '../private-app/app/local-runtime.tsx';
import {createProjectBrowserClient} from '../src/web/v1/browser-client.ts';
import {createTaskBrowserClient} from '../src/web/v1/task-browser-client.ts';
import {projectCatalogPageSchema,projectViewSchema} from '../src/web/v1/project-wire.ts';
import {taskAttentionPageSchema} from '../src/web/v1/task-attention-wire.ts';
import {operationsModeViewSchemaV1} from '../src/web/v1/operations-mode-wire.ts';
import {createOperationsModeBrowserClient} from '../src/web/v1/operations-mode-browser-client.ts';
import {createFleetOwnerHttpHandlerV1} from '../src/web/v1/fleet-owner-http.ts';
import {ownerWorkerNoteV1} from '../src/fleet/v1/owner-note.ts';
import {fleetBoardSchemaV1,connectBoardSchemaV1} from '../src/fleet/v1/owner-browser-client.ts';
const now='2026-10-01T12:00:00.000Z';
const mode={schema:'control-room.installation-operations-mode-view/v1',mode:'running',reason:'',setByIdentityId:'',setAt:'',revision:0,replayed:false,admitsNewWork:true,stopRequests:null,startsWork:false,grantsExecutionAuthority:false};
operationsModeViewSchemaV1.parse(mode);
const project={projectId:'project:qa',title:'📱 日本語 العربية café '.repeat(5),summary:'Synthetic phone review',lifecycle:'active',version:1,createdAt:now,updatedAt:now,origin:'ordinary',lifecycleEditable:true};
projectViewSchema.parse(project);
const catalog={projects:[project],nextCursor:null,canCreate:true,sources:{ordinary:'included',ideas:'not_configured'}};
projectCatalogPageSchema.parse(catalog);
const task={jobId:'job:qa',projectId:'project:qa',requestId:'request:qa',title:project.title,state:'failed',version:1,createdAt:now,updatedAt:now};
const attention={items:[{task,inputDigest:'sha256:'+'a'.repeat(64),reasons:['failed']}],nextCursor:null,examined:1,observedAt:now,startsWork:false,sources:{ordinary:'included',ideas:'not_configured'}};
taskAttentionPageSchema.parse(attention);
const worker={workerId:'fleet-worker:'+'a'.repeat(32),displayName:'QA worker 📱 日本語',workerKind:'codex',status:'connected',projectIds:['project:qa'],capabilities:['writing'],maxConcurrent:1,activeClaims:0,lastSeenAt:now,platform:'macos',credentialExpiresAt:now,latestNote:null};
const result={resultId:'fleet-result:'+'b'.repeat(32),projectId:'project:qa',workerName:'QA worker',title:'QA delivered file',summary:'Synthetic result',fileCount:1,submittedAt:now,decision:null,note:null};
const board={workers:[worker],pendingCodes:[],results:[],gatewayConfigured:true,connectBot:{available:true}};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const runtime={mode:'local',status:{taskWorkersStarted:false,workers:[],projectSections:['overview','work','files','settings']}};
async function mount(component,transport,url='https://qa.invalid/workers'){
 const dom=new JSDOM('<div id="root"></div>',{url,pretendToBeVisual:true});
 const saved={}; for(const key of ['window','document','navigator','HTMLElement','HTMLInputElement','HTMLTextAreaElement','File','FileReader','history','location','IS_REACT_ACT_ENVIRONMENT','fetch']){
  saved[key]=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:key==='window'?dom.window:key==='fetch'?transport:key==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[key]});
 }
 const root=createRoot(dom.window.document.getElementById('root'));
 return {dom,root,doc:dom.window.document,async show(){await act(async()=>{root.render(component);await sleep(10);});await act(async()=>await sleep(20));},async close(){try{await act(async()=>root.unmount());}finally{dom.window.close();for(const [k,v] of Object.entries(saved))if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}}};
}
function probe(name,fn){test(name,fn);}
probe('UI-01: default operations client reads once',async()=>{
 let reads=0;const m=await mount(h(OperationsControlPanel),async()=>{reads++;return reads<=40?json(mode):json({},503);},'https://qa.invalid/');
 try{await m.show();for(let i=0;i<5;i++)await act(async()=>await sleep(20));assert.equal(reads,1);}finally{await m.close();}
});
probe('UI-01: 20 mounted panels issue only 20 reads',async()=>{
 let reads=0;const m=await mount(h(React.Fragment,null,...Array.from({length:20},(_,key)=>h(OperationsControlPanel,{key}))),async()=>{reads++;await sleep(10);return reads<=500?json(mode):json({},503);});
 try{await m.show();for(let i=0;i<10;i++)await act(async()=>await sleep(20));assert.equal(reads,20);}finally{await m.close();}
});
probe('UI-02: attention box and badge remain outside the collapsed menu',async()=>{
 const m=await mount(h(LocalRuntimeContextV1.Provider,{value:runtime},h(PrivateHeader)),async()=>json(attention));
 try{await m.show();await act(async()=>await sleep(30));const badge=m.doc.querySelector('.private-nav-badge');assert.ok(badge);assert.equal(Boolean(badge.closest('nav')),false);assert.equal(m.doc.querySelectorAll('.private-attention-box').length,1);assert.equal(m.doc.querySelector('.private-navigation-toggle').getAttribute('aria-expanded'),'false');}finally{await m.close();}
});
probe('UI-03: double tap and 50 tap burst issue one worker key command',async()=>{
 const posts=[];let release;const held=new Promise(r=>release=r);
 const m=await mount(h(FleetWorkers),async(path,opts={})=>{if(opts.method==='POST'){posts.push({path,hasIdempotencyKey:!!opts.headers?.['idempotency-key']});await held;return json({});}return json(board);});
 try{await m.show();const button=[...m.doc.querySelectorAll('button')].find(e=>e.textContent==='Give it a new key');assert.ok(button);
 await act(async()=>{button.click();await sleep(20);});await act(async()=>{button.click();await sleep(20);});assert.equal(posts.length,1);
 for(let i=0;i<48;i++)await act(async()=>button.click());assert.equal(posts.length,1);assert.equal(button.disabled,true);
 release();await act(async()=>await sleep(30));
 }finally{release();await m.close();}
});
probe('UI-05: a failed file read leaves an error and retry',async()=>{
 const m=await mount(h(FleetWorkers),async(path,opts={})=>String(path).endsWith('/files')?json({},503):json({...board,results:[result]}));
 try{await m.show();const btn=[...m.doc.querySelectorAll('button')].find(e=>e.textContent==='Show files');assert.ok(btn);await act(async()=>{btn.click();await sleep(20);});assert.equal([...m.doc.querySelectorAll('button')].some(e=>/Try again/.test(e.textContent)),true);assert.equal([...m.doc.querySelectorAll('[role="alert"]')].some(e=>/could not|failed|try again/i.test(e.textContent)),true);}finally{await m.close();}
});
for(const [name,C]of [['workers',FleetWorkers],['connect',ConnectBotWorkspace]]) probe('UI-04: '+name+' malformed reply is unavailable',async()=>{
 let error;const m=await mount(h(LocalRuntimeContextV1.Provider,{value:runtime},h(C)),async()=>json({}));
 try{try{await m.show();}catch(e){error=e.message;}assert.equal(error,undefined);assert.match(m.doc.body.textContent,/could not be checked/);assert.ok([...m.doc.querySelectorAll('button')].some(e=>/Read again/.test(e.textContent)));}finally{await m.close();}
});
probe('UI-06: lost code reply is uncertain and blocks another issuance',async()=>{
 let simulatedCommits=0;const m=await mount(h(LocalRuntimeContextV1.Provider,{value:runtime},h(ConnectBotWorkspace)),async(path,opts={})=>{if(opts.method==='POST'){simulatedCommits++;throw new TypeError('Synthetic lost response');}if(String(path).includes('needs-me'))return json(attention);return json(String(path).endsWith('/projects')?catalog:board);});
 try{await m.show();const input=m.doc.querySelector('[name="bot-name"]');const setValue=Object.getOwnPropertyDescriptor(m.dom.window.HTMLInputElement.prototype,'value').set;
 await act(async()=>{setValue.call(input,'QA bot');input[Object.keys(input).find(k=>k.startsWith('__reactProps$'))].onChange({target:input});});
 const label=[...m.doc.querySelectorAll('label')].find(e=>e.textContent.includes(project.title));assert.ok(label);
 await act(async()=>label.querySelector('input').click());const form=m.doc.querySelector('form');await act(async()=>{form.dispatchEvent(new m.dom.window.Event('submit',{bubbles:true,cancelable:true}));await sleep(20);});
 assert.equal(simulatedCommits,1);assert.match(m.doc.body.textContent,/could not be confirmed/);assert.doesNotMatch(m.doc.body.textContent,/Nothing changed/);assert.equal(m.doc.querySelector('button[type=submit]').disabled,true);}finally{await m.close();}
});
probe('passkey-invalid-fragment-cleared-and-safe',async()=>{
 let calls=0;const m=await mount(h(PasskeyRegistration),async()=>{calls++;return json({});},'https://qa.invalid/setup#invalid');
 try{await m.show();assert.equal(m.dom.window.location.hash,'');assert.equal(calls,0);assert.match(m.doc.body.textContent,/No passkey was activated\. Do not retry or reload this page.*show the lead after reopening Claude/);}finally{await m.close();}
});
probe('project-client-50-concurrent-saves',async()=>{
 let calls=0,release;const held=new Promise(r=>release=r);const client=createProjectBrowserClient(async()=>{calls++;await held;const {origin,lifecycleEditable,...ordinary}=project;return json({project:ordinary,replayed:false},201);},()=> 'qa-project-save-key');
 const pending=Array.from({length:50},()=>client.create({title:project.title,summary:project.summary}));release();const answers=await Promise.allSettled(pending);assert.equal(calls,1);assert.equal(answers.filter(x=>x.status==='fulfilled').length,1);
});
probe('task-client-lost-reply-preserves-same-save',async()=>{
 const calls=[];let fail=true;const client=createTaskBrowserClient(async(path,opts)=>{calls.push({body:opts.body,key:opts.headers['idempotency-key']});if(fail){fail=false;throw new TypeError('Synthetic lost reply');}return json({receipt:{jobId:'job:qa',projectId:'project:qa',requestId:'request:qa',createdAt:now,submission:'proposed',startsWork:false},replayed:true},201);},()=> 'qa-task-save-key');
 await assert.rejects(client.propose('project:qa',{title:'QA task',instructions:'Synthetic test'}));assert.equal(client.hasPending(),true);await client.retrySave();assert.deepEqual(calls[0],calls[1]);
});
probe('UI-08: a failed status GET offers Read again with no save claim',async()=>{
 let posts=0;const m=await mount(h(OperationsControlPanel),async(path,opts={})=>{if(opts.method==='POST')posts++;return json({},503);});
 try{await m.show();assert.equal(posts,0);assert.match(m.doc.body.textContent,/current work mode could not be checked/);assert.match(m.doc.body.textContent,/No change was requested/);assert.doesNotMatch(m.doc.body.textContent,/save could not be confirmed/);}finally{await m.close();}
});
probe('UI-07: worker notes hide private paths and secret markers',async()=>{
 const marker='api'+'_key='+Array.from({length:32},()=> 'q').join('');
 const privatePath='/qa-private/marker-file';
 const m=await mount(h(FleetWorkers),async()=>json({...board,workers:[{...worker,latestNote:{kind:'blocker',message:'Cannot read '+privatePath+' '+marker,occurredAt:now,taskTitle:'Synthetic task'}}]}));
 try{await m.show();const text=m.doc.body.textContent;assert.equal(text.includes(marker),false);assert.equal(text.includes(privatePath),false);assert.match(text,/private details/);}finally{await m.close();}
});
probe('UI-09: focus refreshes an open page badge',async()=>{
 let calls=0,hasItem=false;const m=await mount(h(LocalRuntimeContextV1.Provider,{value:runtime},h(PrivateHeader)),async(path)=>{if (path.includes("action-items")) return json({observedAt:now,items:[],truncated:false}); calls++;return json(hasItem?attention:{...attention,items:[],examined:0});});
 try{await m.show();assert.equal(m.doc.querySelector('.private-nav-badge')?.firstChild.textContent,'0');hasItem=true;await act(async()=>{m.dom.window.dispatchEvent(new m.dom.window.Event('focus'));await sleep(30);});assert.equal(calls,2);assert.ok(m.doc.querySelector('.private-nav-badge'));assert.match(m.doc.querySelector('.private-attention-box').textContent,/Needs attention/);}finally{await m.close();}
});

function button(m, label) { const value = [...m.doc.querySelectorAll('button')].find(e => e.textContent === label); assert.ok(value, label); return value; }
function handler(element, name = 'onClick') { return element[Object.keys(element).find(k => k.startsWith('__reactProps$'))][name]; }
async function fillConnect(m) {
  const input = m.doc.querySelector('[name="bot-name"]');
  await act(async () => handler(input, 'onChange')({ target: { value: 'QA bot' } }));
  const label = [...m.doc.querySelectorAll('label')].find(e => e.textContent.includes(project.title));
  assert.ok(label); await act(async () => label.querySelector('input').click());
}

test('UI-03: synchronous callers are guarded even before the disabled control renders', async () => {
  let posts = 0, release;
  const held = new Promise(r => release = r);
  const m = await mount(h(FleetWorkers), async (_path, init = {}) => {
    if (init.method === 'POST') { posts++; await held; return json({ code: 'synthetic code', purpose: 'rekey', expiresAt: now }); }
    return json(board);
  });
  try {
    await m.show(); const run = handler(button(m, 'Give it a new key'));
    await act(async () => { for (let i = 0; i < 50; i++) run(); });
    assert.equal(posts, 1); assert.equal(button(m, 'Give it a new key').disabled, true);
    release(); await act(async () => await sleep(20));
    assert.equal(button(m, 'Give it a new key').disabled, false);
  } finally { release(); await m.close(); }
});

test('UI-03: a definitive refusal permits retry while a lost reply stays locked', async () => {
  for (const refused of [true, false]) {
    let posts = 0;
    const m = await mount(h(FleetWorkers), async (_path, init = {}) => {
      if (init.method === 'POST') { posts++; if (refused) return json({}, 400); throw new TypeError('lost reply'); }
      return json(board);
    });
    try {
      await m.show(); await act(async () => { button(m, 'Give it a new key').click(); await sleep(20); });
      assert.equal(button(m, 'Give it a new key').disabled, !refused);
      assert.match(m.doc.body.textContent, refused ? /was refused/ : /could not be confirmed/);
      await act(async () => { button(m, 'Give it a new key').click(); await sleep(20); });
      assert.equal(posts, refused ? 2 : 1);
    } finally { await m.close(); }
  }
});

test('UI-03: a malformed successful key reply stays uncertain and locked', async () => {
  let posts = 0;
  const m = await mount(h(FleetWorkers), async (_path, init = {}) => {
    if (init.method === 'POST') { posts++; return json({}); } return json(board);
  });
  try {
    await m.show(); await act(async () => { button(m, 'Give it a new key').click(); await sleep(20); });
    assert.equal(posts, 1); assert.equal(button(m, 'Give it a new key').disabled, true);
    assert.match(m.doc.body.textContent, /could not be confirmed/);
  } finally { await m.close(); }
});

test('leaving halfway aborts key commands, file reads and code creation', async () => {
  for (const action of ['key', 'files', 'code']) {
    let pendingSignal;
    const Component = action === 'code' ? ConnectBotWorkspace : FleetWorkers;
    const m = await mount(h(LocalRuntimeContextV1.Provider, { value: runtime }, h(Component)), async (path, init = {}) => {
      if (init.method === 'POST' || String(path).endsWith('/files')) {
        pendingSignal = init.signal;
        return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new TypeError('aborted')), { once: true }));
      }
      return json(String(path).endsWith('/projects') ? catalog : String(path).includes('needs-me') ? attention : { ...board, results: [result] });
    });
    try {
      await m.show();
      if (action === 'code') { await fillConnect(m); await act(async () => m.doc.querySelector('form').dispatchEvent(new m.dom.window.Event('submit', { bubbles: true, cancelable: true }))); }
      else await act(async () => button(m, action === 'key' ? 'Give it a new key' : 'Show files').click());
      assert.ok(pendingSignal); assert.equal(pendingSignal.aborted, false);
      await act(async () => m.root.render(h(React.Fragment))); assert.equal(pendingSignal.aborted, true);
    } finally { await m.close(); }
  }
});

test('UI-04: nested fleet arrays and fields are validated before either board is saved', () => {
  assert.equal(fleetBoardSchemaV1.safeParse(board).success, true);
  assert.equal(connectBoardSchemaV1.safeParse(board).success, true);
  for (const value of [{}, { ...board, workers: null }, { ...board, workers: [{}] },
    { ...board, workers: [{ ...worker, status: 'raw_private_code' }] }, { ...board, pendingCodes: [{}] }]) {
    assert.equal(fleetBoardSchemaV1.safeParse(value).success, false);
    assert.equal(connectBoardSchemaV1.safeParse(value).success, false);
  }
  for (const value of [{ ...board, results: null }, { ...board, results: [{}] },
    { ...board, workers: [{ ...worker, capabilities: null }] },
    { ...board, workers: [{ ...worker, latestNote: {} }] }]) assert.equal(fleetBoardSchemaV1.safeParse(value).success, false);
  for (const value of [{ ...board, connectBot: {} }, { ...board, connectBot: { available: true, release: {} } }])
    assert.equal(connectBoardSchemaV1.safeParse(value).success, false);
});

test('UI-04: a bad refresh removes the old board and Read again recovers', async () => {
  for (const Component of [FleetWorkers, ConnectBotWorkspace]) {
    let bad = false;
    const m = await mount(h(LocalRuntimeContextV1.Provider, { value: runtime }, h(Component)), async path =>
      json(String(path).endsWith('/projects') ? catalog : String(path).includes('needs-me') ? attention : bad ? {} : board));
    try {
      await m.show(); assert.match(m.doc.body.textContent, /QA worker/);
      bad = true;
      if (Component === FleetWorkers) await act(async () => { m.dom.window.dispatchEvent(new m.dom.window.Event('focus')); await sleep(20); });
      else {
        // An uncertain write rechecks the pending-code inventory.
        await fillConnect(m);
        await act(async () => { m.doc.querySelector('form').dispatchEvent(new m.dom.window.Event('submit', { bubbles: true, cancelable: true })); await sleep(20); });
      }
      assert.doesNotMatch(m.doc.body.textContent, /QA worker/);
      assert.match(m.doc.body.textContent, /could not be checked/);
      bad = false; await act(async () => { button(m, 'Read again').click(); await sleep(20); });
      assert.match(m.doc.body.textContent, /QA worker/);
    } finally { await m.close(); }
  }
});

test('UI-04: 50 connector inventory retries share one pending read', async () => {
  let reads = 0, release;
  const held = new Promise(r => release = r);
  const m = await mount(h(LocalRuntimeContextV1.Provider, { value: runtime }, h(ConnectBotWorkspace)), async path => {
    if (String(path).endsWith('/fleet')) { reads++; if (reads === 1) return json({}); await held; return json(board); }
    return json(String(path).endsWith('/projects') ? catalog : attention);
  });
  try {
    await m.show(); const retry = handler(button(m, 'Read again'));
    await act(async () => { for (let i = 0; i < 50; i++) retry(); }); assert.equal(reads, 2);
    release(); await act(async () => await sleep(20)); assert.match(m.doc.body.textContent, /QA worker/);
  } finally { release(); await m.close(); }
});

test('UI-05: 50 file callers share one read, malformed data remains retryable, and retry loads files', async () => {
  let reads = 0, release;
  const held = new Promise(r => release = r);
  const m = await mount(h(FleetWorkers), async path => {
    if (String(path).endsWith('/files')) { reads++; if (reads === 1) { await held; return json({}); }
      return json([{ ordinal: 1, fileName: 'result.txt', sizeBytes: 12 }]); }
    return json({ ...board, results: [result] });
  });
  try {
    await m.show(); const run = handler(button(m, 'Show files'));
    await act(async () => { for (let i = 0; i < 50; i++) run(); });
    assert.equal(reads, 1); release(); await act(async () => await sleep(20));
    assert.match(m.doc.body.textContent, /files could not be checked/);
    await act(async () => { button(m, 'Try again').click(); await sleep(20); });
    assert.equal(reads, 2); assert.match(m.doc.body.textContent, /result.txt/);
    assert.doesNotMatch(m.doc.body.textContent, /files could not be checked/);
  } finally { release(); await m.close(); }
});

test('UI-06: 50 code submits send one request; refusal, unknown success and lost reply recover honestly', async () => {
  for (const outcome of ['refused', 'malformed', 'lost']) {
    let posts = 0, reads = 0, release;
    const held = new Promise(r => release = r);
    const m = await mount(h(LocalRuntimeContextV1.Provider, { value: runtime }, h(ConnectBotWorkspace)), async (path, init = {}) => {
      if (init.method === 'POST') { posts++; await held;
        if (outcome === 'lost') throw new TypeError('lost reply');
        return json({}, outcome === 'refused' ? 400 : 200); }
      if (String(path).endsWith('/fleet')) reads++;
      return json(String(path).endsWith('/projects') ? catalog : String(path).includes('needs-me') ? attention : board);
    });
    try {
      await m.show(); await fillConnect(m);
      const submit = handler(m.doc.querySelector('form'), 'onSubmit');
      await act(async () => { for (let i = 0; i < 50; i++) submit({ preventDefault() {} }); });
      assert.equal(posts, 1); assert.equal(m.doc.querySelector('button[type=submit]').disabled, true);
      release(); await act(async () => await sleep(20));
      assert.equal(m.doc.querySelector('button[type=submit]').disabled, outcome !== 'refused');
      assert.match(m.doc.body.textContent, outcome === 'refused' ? /request was refused/ : /creation could not be confirmed/);
      assert.doesNotMatch(m.doc.body.textContent, /Nothing changed/); assert.equal(reads, 2);
    } finally { release(); await m.close(); }
  }
});

test('UI-07: the shared rule hides credentials and filesystem paths, including notes in the HTTP projection', async () => {
  const samples = ['/qa-private/marker-file', 'C:\\private\\marker.txt', '\\\\host\\private\\marker', '~/private/file',
    'api_key=' + 'q'.repeat(32), 'Bearer ' + 'q'.repeat(32), 'token=synthetic', 'ghp_' + 'q'.repeat(32),
    'https://example.invalid/?X-Amz-Signature=synthetic'];
  for (const sample of samples) assert.match(ownerWorkerNoteV1({ message: 'Cannot read ' + sample, taskTitle: sample }).message, /private details/);
  const note = ownerWorkerNoteV1({ message: 'Unrecognized opaque value', taskTitle: 'Unrecognized path format', kind: 'blocker', occurredAt: now });
  assert.match(note.message, /private details/); assert.equal(note.taskTitle, '');
  assert.equal(note.kind, 'blocker'); assert.equal(note.occurredAt, now);
  const handler = createFleetOwnerHttpHandlerV1({ origin: 'https://qa.invalid',
    localOwnerSession: { assertLocalRequest() {}, verify() { return {}; } },
    service: { async listWorkers() { return { ...board, workers: [{ ...worker, latestNote: {
      kind: 'blocker', message: samples[0], taskTitle: samples[1], occurredAt: now } }] }; }, async listResults() { return []; } } });
  const response = await handler(new Request('https://qa.invalid/api/v1/fleet'));
  assert.equal(response.status, 200); const text = await response.text();
  for (const sample of samples) assert.equal(text.includes(sample), false);
  assert.match(text, /private details/);
});

test('UI-08: GET failures are unavailable while POST failures remain uncertain', async () => {
  for (const status of [404, 409, 429, 500, 503]) {
    const client = createOperationsModeBrowserClient(async () => json({}, status));
    await assert.rejects(client.read(), error => error.code === 'unavailable');
  }
  const client = createOperationsModeBrowserClient(async () => json({}, 503));
  await assert.rejects(client.set({ mode: 'paused', reason: '' }), error => error.code === 'uncertain');
  for (const [status, code] of [[401, 'authentication_required'], [403, 'access_denied']]) {
    await assert.rejects(createOperationsModeBrowserClient(async () => json({}, status)).read(), error => error.code === code);
  }
});

test('UI-02/UI-09: 20 headers share one read, coalesce 50 focus events, pause hidden and abort on unmount', async () => {
  let reads = 0, signal, release, finish;
  const stopped = new Promise(r => finish = r);
  const held = new Promise(r => release = r);
  const m = await mount(h(LocalRuntimeContextV1.Provider, { value: runtime },
    h(React.Fragment, null, ...Array.from({ length: 20 }, (_, key) => h(PrivateHeader, { key })))), async (path, init) => {
      if (path.includes("action-items")) return json({observedAt:now,items:[],truncated:false});
      reads++; signal = init.signal; if (reads === 2) await held; if (reads === 4) await stopped; return json(attention);
    });
  let hidden = false;
  Object.defineProperty(m.doc, 'hidden', { configurable: true, get: () => hidden });
  try {
    await m.show(); assert.equal(reads, 1); assert.equal(m.doc.querySelectorAll('.private-attention-box').length, 20);
    await act(async () => { for (let i = 0; i < 50; i++) m.dom.window.dispatchEvent(new m.dom.window.Event('focus')); });
    assert.equal(reads, 2);
    release(); await act(async () => await sleep(20));
    hidden = true; await act(async () => m.dom.window.dispatchEvent(new m.dom.window.Event('focus')));
    assert.equal(reads, 2); hidden = false;
    await act(async () => { m.doc.dispatchEvent(new m.dom.window.Event('visibilitychange')); await sleep(20); });
    assert.equal(reads, 3);
    await act(async () => m.dom.window.dispatchEvent(new m.dom.window.Event('focus')));
    assert.equal(reads, 4); assert.equal(signal.aborted, false);
    await act(async () => m.root.render(h(React.Fragment))); assert.equal(signal.aborted, true);
    finish(); await act(async () => await sleep(10));
    await act(async () => m.dom.window.dispatchEvent(new m.dom.window.Event('focus'))); assert.equal(reads, 4);
  } finally { release(); finish(); await m.close(); }
});

test('leaving Workers or Connect a bot halfway aborts their pending reads', async () => {
  for (const Component of [FleetWorkers, ConnectBotWorkspace]) {
    const signals = [];
    const m = await mount(h(Component), async (_path, init) => {
      signals.push(init.signal);
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new TypeError('aborted')), { once: true }));
    });
    try { await m.show(); assert.ok(signals.length); await act(async () => m.root.render(h(React.Fragment)));
      assert.equal(signals.every(signal => signal.aborted), true); }
    finally { await m.close(); }
  }
});

test('UI-02/UI-09: the red summary is permanent and the shared loop polls every 30 seconds', async () => {
  const css = await readFile('private-app/app/private.css', 'utf8');
  assert.match(css, /\.private-shared-attention\s*\{[^}]*border-color:\s*var\(--red\)[^}]*background:\s*var\(--red-soft\)/);
  let reads = 0, poll;
  const originalTimer = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 30_000) { poll = callback; return originalTimer(callback, 30_000_000, ...args); }
    return originalTimer(callback, delay, ...args);
  };
  const m = await mount(h(LocalRuntimeContextV1.Provider, { value: runtime }, h(PrivateHeader)), async (path) => { if (path.includes("action-items")) return json({observedAt:now,items:[],truncated:false}); reads++; return json(attention); });
  try {
    await m.show(); assert.equal(reads, 1); assert.equal(typeof poll, 'function');
    await act(async () => { poll(); await sleep(20); }); assert.equal(reads, 2);
    assert.ok(m.doc.querySelector('.private-attention-box').compareDocumentPosition(m.doc.querySelector('nav')) & m.dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  } finally { await m.close(); globalThis.setTimeout = originalTimer; }
});

test('UI-09: abandoned attention replies cannot overwrite a new page snapshot', async () => {
  for (const failed of [false, true]) {
    let reads = 0, release;
    const held = new Promise(r => release = r);
    const component = () => h(LocalRuntimeContextV1.Provider, { value: runtime }, h(PrivateHeader));
    const m = await mount(component(), async (path) => {
      if (path.includes("action-items")) return json({observedAt:now,items:[],truncated:false});
      reads++; if (reads === 1) { await held; if (failed) throw new TypeError('abandoned read'); return json(attention); }
      return json({ ...attention, items: [], examined: 0 });
    });
    try {
      await m.show(); await act(async () => m.root.render(h(React.Fragment)));
      await act(async () => { m.root.render(component()); await sleep(20); });
      await act(async () => await sleep(20)); assert.equal(reads, 2);
      assert.equal(m.doc.querySelector('.private-nav-badge')?.firstChild.textContent, '0');
      release(); await act(async () => await sleep(20));
      await act(async () => m.root.render(component()));
      assert.equal(m.doc.querySelector('.private-nav-badge')?.firstChild.textContent, '0');
      assert.doesNotMatch(m.doc.body.textContent, /could not be checked/);
    } finally { release(); await m.close(); }
  }
});

for (const saved of [false, true]) probe(`R7DOC-11: lost removal reply rereads saved state (${saved ? 'removed' : 'unchanged'})`, async () => {
 let reads = 0, posts = 0, committed = false;
 const savedConfirm = Object.getOwnPropertyDescriptor(globalThis, 'confirm');
 Object.defineProperty(globalThis, 'confirm', { configurable: true, value: () => true });
 const m = await mount(h(ConnectBotWorkspace), async (path, opts = {}) => {
  if (opts.method === 'POST') { posts++; committed = saved; throw new TypeError('Synthetic lost reply'); }
  if (String(path).endsWith('/projects')) return json(catalog);
  reads++; return json({ ...board, workers: committed ? [{ ...worker, status: 'revoked' }] : [worker] });
 });
 try {
  await m.show(); const remove = [...m.doc.querySelectorAll('button')].find(b => b.textContent === 'Remove');
  assert.ok(remove); await act(async () => { remove.click(); await sleep(30); });
  assert.equal(posts, 1); assert.equal(reads, 2, 'an uncertain write must reread the authoritative inventory');
  assert.match(m.doc.body.textContent, /Removal could not be confirmed.*Check the saved connected bots/u);
  assert.doesNotMatch(m.doc.body.textContent, /Nothing changed|was not removed/u);
  assert.equal([...m.doc.querySelectorAll('button')].some(b => b.textContent === 'Remove'), !saved);
 } finally {
  await m.close(); if (savedConfirm) Object.defineProperty(globalThis, 'confirm', savedConfirm); else delete globalThis.confirm;
 }
});

for (const saved of [false, true]) probe(`R7DOC-11: 20 lost review replies reread saved decisions (${saved ? 'saved' : 'unchanged'})`, async () => {
 let posts = 0, reads = 0; const decisions = new Set();
 const results = Array.from({ length: 20 }, (_, n) => ({ ...result, resultId: `fleet-result:${String(n).padStart(32, '0')}`, title: `Synthetic result ${n}` }));
 const m = await mount(h(FleetWorkers), async (path, opts = {}) => {
  if (opts.method === 'POST') { posts++; if (saved) decisions.add(String(path)); throw new TypeError('Synthetic lost reply'); }
  reads++; return json({ ...board, results: results.map(r => ({ ...r, decision: decisions.has(`/api/v1/fleet/results/${encodeURIComponent(r.resultId)}/review`) ? 'accepted' : null })) });
 });
 try {
  await m.show(); const accepts = [...m.doc.querySelectorAll('button')].filter(b => b.textContent === 'Accept');
  assert.equal(accepts.length, 20);
  await act(async () => { for (const b of accepts) b.click(); await sleep(40); });
  assert.equal(posts, 20); assert.equal(reads, 21);
  assert.doesNotMatch(m.doc.body.textContent, /Nothing changed|decision was not saved/u);
  if (saved) assert.equal([...m.doc.querySelectorAll('button')].filter(b => b.textContent === 'Accept').length, 0);
  else {
   assert.equal([...m.doc.querySelectorAll('p[role=alert]')].filter(e => /decision could not be confirmed.*Check the saved review/u.test(e.textContent)).length, 20);
   await act(async () => { [...m.doc.querySelectorAll('button')].find(b => b.textContent === 'Accept').click(); await sleep(30); });
   assert.equal(posts, 21, 'a later attempt rereads again when its reply is lost');
  }
 } finally { await m.close(); }
});

probe('R7DOC-06: removal confirmation distinguishes revoked access from remote stop', async () => {
 let confirmation = '';
 const savedConfirm = Object.getOwnPropertyDescriptor(globalThis, 'confirm');
 Object.defineProperty(globalThis, 'confirm', { configurable: true, value: text => { confirmation = text; return false; } });
 const m = await mount(h(FleetWorkers), async () => json(board));
 try {
  await m.show(); await act(async () => [...m.doc.querySelectorAll('button')].find(b => b.textContent === 'Remove').click());
  assert.match(confirmation, /access will be revoked immediately.*Running work may continue.*confirm the local stop separately/u);
  assert.doesNotMatch(confirmation, /stop working immediately/u);
 } finally { await m.close(); if (savedConfirm) Object.defineProperty(globalThis, 'confirm', savedConfirm); else delete globalThis.confirm; }
});
