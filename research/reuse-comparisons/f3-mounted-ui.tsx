// Research-only common adapter. Candidate rendering is actual pinned source;
// identity, freshness and auth clearing are explicit Control Room glue under test.
import {useLayoutEffect,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {flushSync} from 'react-dom';
import {ActiveSessionsBar} from 'f3-desktop';
import {setWebState,_buildSessionAction,_isSessionEffectivelyStreaming} from 'f3-webui';
import {createProjectBrowserClient} from '../../src/web/v1/browser-client';
import {ProjectCatalog} from '../../app/components/project-catalog';
import type {ProjectView} from '../../src/web/v1/project-wire';
const client=createProjectBrowserClient();
const viewRoot=createRoot(document.getElementById('app')!);
let projects:ProjectView[]=[];let generation=0;let state:'loading'|'ready'|'unavailable'='loading';let selected='';
const closed=new Set<string>();
const runs=new Map<string,{key:string;projectId:string;sessionId:string;machine:string;loading:boolean}>();
const checks:string[]=[];
function assert(value:unknown,message:string){if(!value)throw new Error(message);checks.push(message);}
function keyFor(project:ProjectView){return `${project.projectId}:machine-${project.title.endsWith('A')?'a':'b'}:same`}
function WebRows({rows}:{rows:ProjectView[]}){
  const element=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const host=element.current!;
    host.replaceChildren();
    for(const p of rows){const key=keyFor(p);const record=runs.get(key)!;
      const row=document.createElement('div');row.dataset.sessionKey=key;
      const open=_buildSessionAction(p.title,'Open project view','',()=>{selected=key;render();});
      const close=_buildSessionAction(`Close ${p.title}`,'Close view, not work','',()=>{closed.add(key);render();});
      setWebState({session:{session_id:key},busy:record.loading});
      const status=document.createElement('span');status.textContent=_isSessionEffectivelyStreaming({session_id:key})?'Working':'Idle';
      row.append(open,status,close);host.append(row);
    }
    return()=>host.replaceChildren();
  },[rows]);
  return <div id="webui" role="menu" ref={element}/>;
}
function render(){
  const rows=projects.filter(p=>!closed.has(keyFor(p)));
  flushSync(()=>viewRoot.render(<>
    <p id="state">{state}</p>
    <h2>Current Control Room catalog</h2><div id="baseline"><ProjectCatalog state={state} projects={projects}/></div>
    <h2>Desktop controlled bar</h2><div id="desktop"><ActiveSessionsBar runs={rows.map(p=>({runId:keyFor(p),connectionId:runs.get(keyFor(p))!.machine,profile:'hermes',sessionId:'same',loading:runs.get(keyFor(p))!.loading,title:p.title}))}
      activeRunId={selected} onSelect={(key:string)=>{selected=key;render();}} onClose={(key:string)=>{closed.add(key);render();}} onNew={()=>{}}/></div>
    <h2>WebUI extracted action rows</h2><WebRows rows={rows}/>
  </>));
}
async function refresh(){
  const own=++generation;
  try{const page=await client.list();if(own!==generation)return;
    projects=page.projects;state='ready';
    for(const p of projects){const key=keyFor(p);if(!runs.has(key))runs.set(key,{key,projectId:p.projectId,sessionId:'same',machine:p.title.endsWith('A')?'machine-a':'machine-b',loading:true});}
  }catch(error){if(own!==generation)return;projects=[];state='unavailable';
    if(['authentication_required','access_denied'].includes((error as {code?:string}).code??'')){
      runs.clear();closed.clear();selected='';setWebState({session:null,busy:false});
    }
  }
  render();
}
const control=(action:string)=>fetch(`/fixture/${action}`,{method:'POST',headers:{'x-f3-fixture':'1'}});
const text=(id:string)=>document.getElementById(id)!.textContent!;
const pause=()=>new Promise(resolve=>setTimeout(resolve,40));
type ReadReceipt={requestId:number;status:number;projectCount:number};
async function awaitHeld():Promise<ReadReceipt>{
  const deadline=performance.now()+5000;
  while(performance.now()<deadline){
    const response=await fetch('/fixture/state',{cache:'no-store',signal:AbortSignal.timeout(1000)});
    if(!response.ok)throw new Error('fixture state unavailable');
    const data=await response.json();if(data.held)return data.held;
    // Bounded polling cadence, never evidence that the protected response arrived.
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error('successful protected hold acknowledgement timed out');
}
async function exercise(){
  await refresh();
  for(const id of ['desktop','webui','baseline'])assert(text(id).includes('Project A')&&text(id).includes('Project B'),`${id}: real protected catalog project labels rendered`);
  assert(runs.size===2&&new Set([...runs.values()].map(r=>r.sessionId)).size===1,'composite adapter preserves two machines sharing native session ID');
  document.querySelector<HTMLButtonElement>('#desktop .active-session-chip-close')!.click();await pause();
  assert(document.querySelectorAll('#desktop [role=tab]').length===1&&runs.size===2&&[...runs.values()].every(r=>r.loading),'Desktop mounted close hides view without stopping synthetic work');
  closed.clear();render();
  [...document.querySelectorAll<HTMLButtonElement>('#webui button')].find(e=>e.textContent==='Close Project B')!.click();await pause();
  assert(!text('webui').includes('Project B')&&runs.size===2&&[...runs.values()].every(r=>r.loading),'WebUI actual DOM action close hides view without stopping synthetic work');
  closed.clear();render();
  await control('offline');await refresh();
  assert(!text('desktop').includes('Project')&&!text('webui').includes('Project')&&state==='unavailable','offline clears candidate project presentation instead of reporting completion');
  await control('online');await refresh();
  assert(text('desktop').includes('Project A')&&text('webui').includes('Project B')&&runs.size===2,'reconnect restores views without duplicate session records');
  await control('hold');const old=refresh();
  const held=await awaitHeld();
  assert(held.status===200&&held.projectCount===2&&Number.isSafeInteger(held.requestId),'positively acknowledged exact held pre-expiry protected response: 200 and two projects');
  await control('expire');await refresh();
  const denied=(await(await fetch('/fixture/state',{cache:'no-store',signal:AbortSignal.timeout(1000)})).json()).lastCompleted as ReadReceipt;
  assert(denied.requestId===held.requestId+1&&denied.status===401&&denied.projectCount===0,'exact subsequent protected request rejected with 401 before successful held response release');
  assert(['desktop','webui','baseline'].every(id=>!text(id).includes('Project A')&&!text(id).includes('Project B')),'expired synthetic Access assertion clears all mounted private labels');
  assert(runs.size===0&&closed.size===0&&selected==='','expired authentication clears adapter session identity and selection caches');
  const releasedResponse=await fetch('/fixture/release',{method:'POST',headers:{'x-f3-fixture':'1','x-f3-request-id':String(held.requestId)},signal:AbortSignal.timeout(1000)});
  if(!releasedResponse.ok)throw new Error('exact held response release rejected');
  const released=await releasedResponse.json();
  assert(released.requestId===held.requestId&&released.status===200&&released.projectCount===2&&released.afterRequestId===denied.requestId&&released.afterStatus===401,'server released exact successful held request only after exact 401 denial');
  await old;
  assert(['desktop','webui','baseline'].every(id=>!text(id).includes('Project A')&&!text(id).includes('Project B')),'late pre-expiry protected response cannot resurrect project labels');
  await control('renew');await refresh();
  assert(text('desktop').includes('Project A')&&text('webui').includes('Project A'),'new valid synthetic assertion restores authorized labels');
  const tab=document.querySelector<HTMLElement>('#desktop [role=tab]')!;
  tab.focus();assert(document.activeElement!==tab,'negative: unmodified Desktop role-tab is not keyboard-focusable');
  const button=document.querySelector<HTMLButtonElement>('#webui button')!;button.focus();
  assert(document.activeElement===button,'WebUI actual action button accepts browser focus');
  await control('expire');await refresh();
  const receipt={state:'passed',checks,count:checks.length,scope:'actual browser-mounted selected candidates through real Control Room browser client, HTTP auth handler, SQL project service; synthetic identity/run data; no live agents',remaining:['real terminal/session registration','upstream CSS/mobile/keyboard-complete adaptations','full conversation caches','complete UI reload persistence']};
  document.getElementById('results')!.textContent=JSON.stringify(receipt,null,2);
  await fetch('/fixture/result',{method:'POST',headers:{'x-f3-fixture':'1'},body:JSON.stringify(receipt)});
}
render();exercise().catch(async error=>{const receipt={state:'failed',checks,error:String(error)};document.getElementById('results')!.textContent=JSON.stringify(receipt,null,2);await fetch('/fixture/result',{method:'POST',headers:{'x-f3-fixture':'1'},body:JSON.stringify(receipt)});});
