import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import ts from 'typescript';
const root='/private/tmp/cr-f3-renderer.XRtXHb',receipt=JSON.parse(fs.readFileSync('docs/research/reuse-comparisons/f3-renderer-acquisitions.json'));
for(const f of receipt.files){const b=fs.readFileSync(root+'/'+f.path.split('/').at(-1));assert.equal(createHash('sha256').update(b).digest('hex'),f.sha256);}
assert.equal(createHash('sha256').update(fs.readFileSync(root+'/selected/package-lock.json')).digest('hex'),receipt.install.lockSha256);
const req=createRequire(root+'/selected/package.json'),React=req('react'),{act}=React,{createRoot}=req('react-dom/client'),{JSDOM}=req('jsdom');
const dom=new JSDOM('<!doctype html><div id="a"></div><div id="b"></div>',{url:'https://fixture.invalid'});
globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.CustomEvent=dom.window.CustomEvent;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const calls=[],pending=new Map(),events=[];window.hermesAPI={copyToClipboard:async x=>calls.push(['copy',x]),openExternal:async x=>calls.push(['external',x]),readMediaFile:x=>{calls.push(['read',x]);return new Promise(resolve=>pending.set(x,resolve));},saveMediaFile:async(...x)=>calls.push(['save',...x]),showMediaMenu:(...x)=>calls.push(['menu',...x]),mediaFileExists:async()=>false};
document.addEventListener('web-preview:navigate',e=>events.push(e.detail));
const timers=new Set(),modules={};
function load(file){if(modules[file])return modules[file];const m={exports:{}};modules[file]=m.exports;
 const allowed={'react':React,'react-dom':req('react-dom'),'react/jsx-runtime':req('react/jsx-runtime'),'react-markdown':req('react-markdown'),'remark-gfm':req('remark-gfm'),'lucide-react':{Copy:()=>null,Download:()=>null,X:()=>null},'./useI18n':{useI18n:()=>({t:x=>x})}};
 const map={'./MediaImage':'MediaImage.tsx','../screens/Chat/mediaUtils':'mediaUtils.ts','../hooks/useLightboxClose':'useLightboxClose.ts'};
 const require=x=>{if(x in allowed)return allowed[x];if(x in map)return load(map[x]);if(x==='react-syntax-highlighter'||x==='react-syntax-highlighter/dist/esm/styles/prism/one-dark')return req(x);throw Error('unexpected import '+x);};
 const code=ts.transpileModule(fs.readFileSync(root+'/'+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
 // Reviewed source executes in ordinary Node; VM is NOT a security sandbox.
 vm.runInNewContext(code,{module:m,exports:m.exports,require,window,document,URL,CustomEvent,console,setTimeout:(f,n)=>{const id=setTimeout(f,n);timers.add(id);return id;}},{filename:file,timeout:1000});modules[file]=m.exports;return m.exports;
}
const {AgentMarkdown}=load('AgentMarkdown.tsx'),{MediaImage}=load('MediaImage.tsx');
const a=document.querySelector('#a'),b=document.querySelector('#b'),ra=createRoot(a),rb=createRoot(b),checks=[];
const check=(name,fn)=>{fn();checks.push(name);};
const render=async(text,key='message-a')=>act(async()=>{ra.render(React.createElement(AgentMarkdown,{key},text));});
const click=async e=>{assert.ok(e);await act(async()=>e.dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true})));};
const start=performance.now();let failure=null;
try{
 await render('|A|B|\n|-|-|\n|one|two|\n\n~~gone~~ `inline`\n\n<script>globalThis.bad=true</script>\n\n[bad](javascript:alert%281%29) [https](https://example.invalid/a) [mail](mailto:test@example.invalid) [relative](/path)');
 check('actual GFM table/strike/inline and no executable script',()=>{assert.equal(a.querySelectorAll('table').length,1);assert.equal(a.querySelector('del').textContent,'gone');assert.equal(a.querySelectorAll('script').length,0);assert.equal(a.querySelector('code').textContent,'inline');});
 const links=[...a.querySelectorAll('a')];await click(links.find(e=>e.textContent==='bad'));check('unsafe link invokes no runtime port or preview',()=>{assert.equal(calls.length,0);assert.equal(events.length,0);});
 await click(links.find(e=>e.textContent==='https'));await click(links.find(e=>e.textContent==='relative'));await click(links.find(e=>e.textContent==='mail'));
 check('HTTPS/relative actual preview dispatch; mailto synthetic port',()=>{assert.deepEqual(events,['https://example.invalid/a','/path']);assert.deepEqual(calls,[['external','mailto:test@example.invalid']]);});
 await render('```js\nconst answer = 42;\n```');
 const deadline=Date.now()+2500;while(!a.querySelector('.token')&&Date.now()<deadline)await act(async()=>{await new Promise(r=>setTimeout(r,10));});
 check('actual lazy Prism renders token positive',()=>assert.ok(a.querySelector('.token')));await click(a.querySelector('.chat-code-copy'));
 check('copy passes exact code to synthetic clipboard port',()=>assert.deepEqual(calls.at(-1),['copy','const answer = 42;']));
 await render('```diff\n+added\n-removed\n```');check('actual diff classes',()=>{assert.equal(a.querySelector('.chat-diff-add').textContent,'+added');assert.equal(a.querySelector('.chat-diff-remove').textContent,'-removed');});
 await render('```text\n┌──┐\n└──┘\n```');check('box remains plain after highlighter positive',()=>{assert.ok(a.querySelector('.chat-code-plain'));assert.equal(a.querySelectorAll('.token').length,0);});
 const long='```js\n'+Array.from({length:17},(_,i)=>'const n'+i+' = '+i+';').join('\n')+'\n```';await render(long);check('long initially collapsed',()=>assert.ok(a.querySelector('.chat-code-collapsed')));await click(a.querySelector('.chat-code-expand-btn'));await render(long+'\n\nstreamed tail');
 check('same message streaming retains expansion',()=>assert.equal(a.querySelectorAll('.chat-code-collapsed').length,0));
 await act(async()=>rb.render(React.createElement(AgentMarkdown,null,long)));
 check('negative finding separate message same source offset inherits expansion',()=>assert.equal(b.querySelectorAll('.chat-code-collapsed').length,0));
 await render('![remote](https://example.invalid/image.png)');check('actual direct img src; no native read',()=>{assert.equal(a.querySelector('img').getAttribute('src'),'https://example.invalid/image.png');assert.equal(calls.filter(x=>x[0]==='read').length,0);});await click(a.querySelector('img'));
 check('actual lightbox portal',()=>assert.equal(document.querySelectorAll('[role=dialog]').length,1));await act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
 check('actual Escape hook closes portal',()=>assert.equal(document.querySelectorAll('[role=dialog]').length,0));
 await render('![download](/fixture/report.pdf)');await click(a.querySelector('.chat-media-file'));check('nonimage uses actual download chip synthetic save',()=>assert.deepEqual(calls.at(-1),['save','/fixture/report.pdf','report.pdf']));
 await render('![local](/fixture/old.png)');check('local read starts via synthetic port',()=>assert.ok(pending.has('/fixture/old.png')));await render('![local](/fixture/new.png)');check('new local request acknowledged',()=>assert.ok(pending.has('/fixture/new.png')));
 await act(async()=>pending.get('/fixture/old.png')('data:image/png;base64,T0xE'));check('late prior markdown media response does not restore image',()=>assert.equal(a.querySelectorAll('img').length,0));await act(async()=>pending.get('/fixture/new.png')('data:image/png;base64,TkVX'));
 check('current media response renders',()=>assert.equal(a.querySelector('img').getAttribute('src'),'data:image/png;base64,TkVX'));
 await render('![query](https://example.invalid/image.png?v=1)');check('negative finding query-string image becomes download chip',()=>{assert.equal(a.querySelectorAll('img').length,0);assert.ok(a.querySelector('.chat-media-file'));});
 // Actual standalone component demonstrates host identity/remount requirement;
 // AgentMarkdown itself remounts custom media renderers across content updates.
 await act(async()=>ra.render(React.createElement(MediaImage,{token:{src:'https://example.invalid/a.png',name:'a',isImage:true,isUrl:true}})));
 await act(async()=>ra.render(React.createElement(MediaImage,{token:{src:'https://example.invalid/b.png',name:'b',isImage:true,isUrl:true}})));
 check('negative standalone same component direct source update retains old resolved src',()=>assert.equal(a.querySelector('img').getAttribute('src'),'https://example.invalid/a.png'));
}catch(e){failure={name:e.name,message:e.message,stack:e.stack};process.exitCode=1;}finally{await act(async()=>{ra.unmount();rb.unmount();});for(const t of timers)clearTimeout(t);dom.window.close();}
const evidence={checks,count:checks.length,failure,elapsedMs:performance.now()-start,calls,previewEvents:events,cleanup:'both roots unmounted, copy timers cleared, DOM closed',scope:'actual selected renderer and media bodies; synthetic ports and translation/icons, JSDOM no browser layout/resources'};fs.writeFileSync('docs/research/reuse-comparisons/f3-renderer-evidence.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
