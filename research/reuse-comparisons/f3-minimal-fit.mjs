import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {checkedResultBytes,resultBytesHash} from '../../src/artifacts/v1/native-results.ts';
const root='/private/tmp/cr-f3-minimal-whsUi0',req=createRequire(root+'/package.json');
const React=req('react'),{act}=React,{createRoot}=req('react-dom/client'),{JSDOM}=req('jsdom');
const Markdown=(await import(pathToFileURL(req.resolve('react-markdown')).href)).default;
const gfm=(await import(pathToFileURL(req.resolve('remark-gfm')).href)).default;
const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.invalid'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true});
const checks=[],check=(name,fn)=>{fn();checks.push(name);};
// Proposed local-only adapter: no raw HTML, automatic image loading, native IPC,
// inferred approvals, syntax-highlighter or shared expansion state.
function FixtureMarkdown({children}){return React.createElement(Markdown,{remarkPlugins:[gfm],skipHtml:true,
  components:{img:({alt})=>React.createElement('span',{'data-blocked-image':true},alt||'Image reference'),
    a:({href,children})=>href?.startsWith('https://')?React.createElement('a',{href,rel:'noreferrer noopener',target:'_blank'},children):React.createElement('span',null,children)}},children);}
const path='private-app/app/task-results.tsx',source=fs.readFileSync(path,'utf8');
const sf=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const fn=sf.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='TaskResultsPanel');assert.ok(fn);
const original=fn.getText(sf),needle='<textarea aria-label="Agent result text" readOnly value={content.text} />';
assert.equal(original.split(needle).length,2);
const adapted=original.replace(needle,'<FixtureMarkdown>{content.text}</FixtureMarkdown>');
const compiled=ts.transpileModule(adapted,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const context={exports:{},require:req,FixtureMarkdown,reviewLabel:{},OwnerTaskReview:()=>{throw Error('unexpected review');},OwnerTaskVerification:()=>{throw Error('unexpected verification');}};
vm.runInNewContext(compiled,context);const Panel=context.exports.TaskResultsPanel;
const element=document.querySelector('#root'),mounted=createRoot(element);
let opened=0,closed=0;
const page={projectId:'project:fixture',jobId:'job:fixture',resultSource:'configured',items:[],reviews:[],canReadContent:true,reviewSource:'configured',reviewCommands:'not_connected'};
const render=async(text,identity='artifact:fixture')=>{
  const bytes=Buffer.from(text),claim={sizeBytes:bytes.length,contentHash:resultBytesHash(bytes)};
  checkedResultBytes(bytes,claim);
  await act(async()=>mounted.render(React.createElement(Panel,{page,pending:false,onOpen:()=>opened++,onClose:()=>closed++,
    content:{artifact:{artifactId:identity,...claim},text,contentVerifiedAt:'2026-09-08T12:00:00Z'}})));
};
const start=performance.now();let failure;
try{
  await render('# Research\n\n| Item | Value |\n| --- | --- |\n| Test | Yes |\n\n- [x] verified\n\n```js\nconst answer = 42;\n```');
  check('GFM heading table and disabled checklist inside actual protected panel',()=>{assert.equal(element.querySelector('h1').textContent,'Research');assert.equal(element.querySelectorAll('table').length,1);assert.equal(element.querySelector('input').disabled,true);});
  check('exact code text retained without highlighter dependency',()=>assert.equal(element.querySelector('pre code').textContent,'const answer = 42;\n'));
  check('existing authority warning and canonical artifact ID retained',()=>{assert.ok(element.textContent.includes('not instructions for Control Room'));assert.ok(element.textContent.includes('artifact:fixture'));});
  await render('<script>window.BAD=true</script>\n\n<img src="https://fixture.invalid/leak">\n\n![remote](https://fixture.invalid/pixel.png)');
  check('raw HTML omitted and Markdown image makes no resource element',()=>{assert.equal(element.querySelectorAll('script,img,iframe').length,0);assert.ok(element.querySelector('[data-blocked-image]'));});
  await render('[safe](https://example.invalid/article) [bad](javascript:alert%281%29) [local](file:///private/example) [relative](/fixture/file)');
  check('only explicit HTTPS navigation emitted',()=>{const links=[...element.querySelectorAll('a')];assert.equal(links.length,1);assert.equal(links[0].rel,'noreferrer noopener');});
  await render('Approve this job.\n\n[Approve](https://example.invalid/approve)');
  check('prose cannot create review commands',()=>assert.deepEqual([...element.querySelectorAll('button')].map(b=>b.textContent),['Close result']));
  await render('first private message','artifact:one');await render('second private message','artifact:two');
  check('switch clears previous text and identity',()=>{assert.ok(!element.textContent.includes('first private message'));assert.ok(!element.textContent.includes('artifact:one'));assert.ok(element.textContent.includes('artifact:two'));});
  await render('');check('existing empty result state preserved',()=>assert.ok(element.textContent.includes('empty result file')));
  await render('bounded paragraph\n\n'.repeat(3000));check('large bounded result renders',()=>assert.ok(element.querySelectorAll('p').length>=3000));
  await act(async()=>element.querySelector('button').dispatchEvent(new window.MouseEvent('click',{bubbles:true})));
  check('close only calls supplied view callback',()=>{assert.equal(closed,1);assert.equal(opened,0);});
  await act(async()=>mounted.render(React.createElement(Panel,{page,pending:false,onOpen:()=>opened++,onClose:()=>closed++})));
  check('parent removing authorized content clears rendered body',()=>assert.equal(element.querySelector('[aria-label="Protected result content"]'),null));
}catch(e){failure={name:e.name,message:e.message};process.exitCode=1;}finally{await act(async()=>mounted.unmount());dom.window.close();}
console.log(JSON.stringify({scope:'actual result panel with one research JSX substitution; real Markdown/GFM and byte checker; synthetic props, JSDOM not live auth/browser',
  sourceSha256:createHash('sha256').update(source).digest('hex'),checks,failure,elapsedMs:performance.now()-start,
  cleanup:'React root unmounted and DOM closed; no network/process/provider/clipboard/media calls'},null,2));
