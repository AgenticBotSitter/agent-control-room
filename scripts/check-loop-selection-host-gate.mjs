import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { isMainModuleV1 } from '../src/installer/shared/is-main-module.mjs';
import { parseStrictJsonV1 } from '../src/installer/shared/strict-json.mjs';
import { b8ExternalHostInventoryV1, validateB8ExternalHostTitlesV1 } from './check-test-lane-coverage.mjs';

export const b8P71CasesV1=Object.freeze(['qualified fixture defaults','deterministic merged encoding','unknown model refusal']);
export const b8U81CasesV1=Object.freeze(['ordinary eligible','bound acknowledged review','final builder refusal','manual refusal',
  'chained refusal','recovery refusal','post-claim source drift zero workers','legacy no-context parity',
  'stable admission 01','stable admission 02','stable admission 03','stable admission 04','stable admission 05',
  'stable admission 06','stable admission 07','stable admission 08','stable admission 09','stable admission 10',
  'stable admission 11','stable admission 12','stable admission 13','stable admission 14','stable admission 15',
  'stable admission 16','stable admission 17','stable admission 18','stable admission 19','stable admission 20',
  'stable admission 21','stable admission 22','stable admission 23','stable admission 24','stable admission 25',
  'stable admission 26','stable admission 27','stable admission 28','stable admission 29','stable admission 30',
  'custody unchanged checked binding and receipt','custody missing changed members refuse before invocation',
  'custody locked CLI completed intake durable replay']);
const need=(condition,message)=>{if(!condition)throw Error('B8 host gate: '+message);};
const hash=raw=>createHash('sha256').update(raw).digest('hex');
const decode=raw=>parseStrictJsonV1(raw,{maxBytes:16*1048576});
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('\0')===[...keys].sort().join('\0');

/** Validate complete TAP hierarchy, its plans, sequential IDs and completions.
 * Logged lookalikes cannot create unprefixed ok/plan records. */
export function validateB8ProductTapV1(output,parent,expected){
  need(typeof output==='string'&&!/\b(?:SKIP|TODO|quarantin\w*)\b|^\s*not ok\b/im.test(output.replace(/^# (?:skipped|todo) 0$/gm,'')),'failed/skipped/quarantined TAP');
  const scopes=new Map([[0,{title:null,children:[],plan:null}]]),finished=[];
  let yaml=false,version=0;
  for(const line of output.split(/\r?\n/)){
    if(/^\s*---\s*$/.test(line)){need(!yaml,'nested diagnostic');yaml=true;continue;}
    if(yaml){if(/^\s*\.\.\.\s*$/.test(line))yaml=false;continue;}
    if(line==='TAP version 13'){version++;continue;}
    if(version===0&&(!line.trim()||line.startsWith('> ')))continue;
    let m=/^( *)# Subtest: (.+)$/.exec(line);
    if(m){const depth=m[1].length,scope=scopes.get(depth);need(scope&&!scope.pending,'misnested/duplicate subtest');
      scope.pending=m[2];need(!scopes.has(depth+4),'unfinished nested subtest');scopes.set(depth+4,{title:m[2],children:[],plan:null});continue;}
    m=/^( *)ok (\d+) - (.+)$/.exec(line);
    if(m){const depth=m[1].length,scope=scopes.get(depth),child=scopes.get(depth+4);
      need(scope&&scope.pending===m[3]&&child?.title===m[3]&&Number(m[2])===scope.children.length+1,'wrong completion/name/order');
      need(child.plan!==null?child.plan===child.children.length:child.children.length===0,'missing/mismatched subtest plan');
      scope.children.push({title:m[3],children:child.children});finished.push(m[3]);scope.pending=undefined;scopes.delete(depth+4);continue;}
    m=/^( *)1\.\.(\d+)(?:\s*#.*)?$/.exec(line);
    if(m){const scope=scopes.get(m[1].length);need(scope&&scope.plan===null&&Number(m[2])>0,'missing/duplicate/empty plan');scope.plan=Number(m[2]);continue;}
    need(!line.trim()||/^\s*#/.test(line),'unrecognized/truncated TAP record');
  }
  const root=scopes.get(0);need(version===1&&!yaml&&scopes.size===1&&!root.pending&&root.plan===1&&root.children.length===1,'incomplete parent TAP');
  const value=root.children[0];need(value.title===parent&&value.children.length===expected.length,'wrong/missing parent or subcase count');
  need(new Set(expected).size===expected.length&&value.children.every((v,i)=>v.title===expected[i]&&!v.children.length),'wrong/duplicate/extra/misnested subcases');
  for(const name of ['fail','cancelled','skipped','todo'])need(new RegExp('^# '+name+' 0$','m').test(output),'missing clean TAP summary '+name);
  need(finished.length===expected.length+1&&new RegExp('^# tests '+(expected.length+1)+'$','m').test(output),'unexpected completed TAP records/count');return {parent,subcases:[...expected],passed:expected.length+1};
}

export function validateB8ToolsReceiptV1(output,inventory,pins){
  const records=output.split(/\r?\n/).filter(l=>l.startsWith('B8_TOOLS_RECEIPT '));need(records.length===1,'missing/duplicate tools receipt');
  const receipt=decode(records[0].slice('B8_TOOLS_RECEIPT '.length));
  need(exact(receipt,['schemaVersion','toolsSha','inventorySha256','suites'])&&receipt.schemaVersion===1
    &&receipt.toolsSha===pins.toolsSha&&receipt.inventorySha256===pins.inventorySha256,'tools receipt pins/shape');
  need(exact(inventory,['schemaVersion','suites'])&&inventory.schemaVersion===1&&inventory.suites.length===13,'tools inventory size');
  need(inventory.suites.every((s,i)=>s.id===b8ExternalHostInventoryV1[i]),'tools inventory identities');
  need(Array.isArray(receipt.suites)&&receipt.suites.length===13,'missing tools suites');
  for(let i=0;i<13;i++){
    const want=inventory.suites[i],got=receipt.suites[i];
    need(exact(got,['schemaVersion','suite','phases','finalStatus'])&&got.schemaVersion===1&&got.suite===want.id&&got.finalStatus==='PASS','tools suite completion');
    need(Array.isArray(got.phases)&&got.phases.length===want.phases.length,'missing tools phase');
    const phaseNames=new Set();
    for(const required of want.phases){
      need(!phaseNames.has(required.name),'duplicate inventory phase');phaseNames.add(required.name);
      const matches=got.phases.filter(p=>p.name===required.name);need(matches.length===1,'missing/duplicate phase');const p=matches[0];
      need(exact(p,['name','checks','executed','passed','failed','skipped','notRun'])&&Array.isArray(p.checks),'phase shape');
      const ids=p.checks.map(c=>c.id),expected=required.ids;
      need(Number.isSafeInteger(required.expectedCount)&&required.expectedCount>0&&required.expectedCount===expected.length
        &&new Set(expected).size===expected.length&&new Set(ids).size===ids.length&&ids.length===expected.length
        &&expected.every(id=>ids.includes(id)),'wrong/missing/duplicate named checks');
      need(p.checks.every(c=>exact(c,['id','status'])&&c.status==='pass')&&p.executed===expected.length&&p.passed===p.executed
        &&p.failed===0&&p.skipped===0&&p.notRun===0,'invalid completion totals');
    }
  }
  need(/^TOOLS HOST PASS expectedSuites=13 executedSuites=13 skipped=0$/m.test(output),'missing validated tools completion');
  need(!/NOT RUN|\bquarantin\w*|^RESULT: FAIL/im.test(output),'tools refusal output');return receipt;
}

/** Foreground child with bounded output and process-group teardown, including
 * descendants left behind by an otherwise successful parent. */
export async function executeB8HostChildV1(command,args,{cwd,env,timeoutMs}){
  need(Number.isFinite(timeoutMs)&&timeoutMs>0,'invalid child budget');
  const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe'],detached:true});
  let size=0,failed=false,killTimer;const stdout=[],stderr=[];
  const signal=(sig)=>{try{process.kill(-child.pid,sig);}catch(e){if(e.code!=='ESRCH')failed=true;}};
  const stop=()=>{failed=true;signal('SIGTERM');killTimer??=setTimeout(()=>signal('SIGKILL'),1000);};
  const timer=setTimeout(stop,timeoutMs),interrupt=()=>stop();
  process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
  for(const [stream,target] of [[child.stdout,stdout],[child.stderr,stderr]])stream.on('data',b=>{size+=b.length;if(size>16*1048576)stop();else target.push(b);});
  child.on('error',()=>{failed=true;});
  try{
    const result=await new Promise(res=>child.once('close',(code,signal)=>res({code,signal})));
    let descendants=false;try{process.kill(-child.pid,0);descendants=true;}catch(e){need(e.code==='ESRCH','child cleanup inspection failed');}
    if(descendants){signal('SIGTERM');await new Promise(r=>setTimeout(r,1000));signal('SIGKILL');failed=true;}
    return {...result,stdout:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(stdout)),
      stderr:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(stderr)),cleaned:!descendants,failed};
  }finally{clearTimeout(timer);clearTimeout(killTimer);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}
}
export function b8HostChildEnvironmentV1(input,root){
  const env={PATH:input.PATH??'/usr/bin:/bin',LANG:'C.UTF-8',LC_ALL:'C.UTF-8',NODE_ENV:'test',CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1',npm_config_offline:'true',
    A2_PRODUCT_ROOT:resolve(root),A2_REQUIRE_PRODUCT:'1'};
  for(const key of ['CONTROL_ROOM_A2_TEST_LOOP','CR_PYTHON','CONTROL_ROOM_B8_PRODUCT_SHA','CONTROL_ROOM_B8_TOOLS_SHA',
    'CONTROL_ROOM_B8_INTERPRETER_SHA256','CONTROL_ROOM_B8_TOOLS_GATE_TIMEOUT_MS','CONTROL_ROOM_B8_QUALIFICATION_RECEIPT'])if(input[key])env[key]=input[key];
  return env;
}
export function productionB8HostPreflightV1(root=process.cwd(),input=process.env){
  need(process.platform==='darwin','required macOS host');validateB8ExternalHostTitlesV1(root);
  need(typeof input.CONTROL_ROOM_A2_TEST_LOOP==='string'&&input.CONTROL_ROOM_A2_TEST_LOOP.length>0,'missing qualified tools checkout');
  const loop=realpathSync(input.CONTROL_ROOM_A2_TEST_LOOP);need(loop===resolve(loop)&&!/(?:^|[/\\])(?:\.codex|\.hermes|\.env|auth\.json|tokens?)(?:[/\\]|$)/i.test(loop),'tools root refused');
  const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:10000}).trim();
  const pins={productSha:git(root,'rev-parse','HEAD'),toolsSha:git(dirname(loop),'rev-parse','HEAD')};
  for(const [key,value] of [['CONTROL_ROOM_B8_PRODUCT_SHA',pins.productSha],['CONTROL_ROOM_B8_TOOLS_SHA',pins.toolsSha]])need(/^[a-f0-9]{40}$/.test(input[key]??'')&&input[key]===value,'missing/mismatched '+key);
  need(!git(root,'status','--porcelain')&&!git(dirname(loop),'status','--porcelain'),'dirty qualification tree');
  const shim=join(dirname(loop),'bin/lib/python.sh');
  const python=realpathSync(execFileSync('/bin/sh',['-c','. "$1" && printf "%s" "$CR_PYTHON"','b8',shim],{encoding:'utf8',timeout:10000}));
  const interpreterSha256=hash(readFileSync(python));need(input.CONTROL_ROOM_B8_INTERPRETER_SHA256===interpreterSha256,'missing/mismatched interpreter pin');
  need(input.CR_PYTHON&&realpathSync(input.CR_PYTHON)===python,'supplied interpreter differs from shim');
  const inventoryBytes=readFileSync(join(loop,'b8-host-cases.json')),inventory=decode(inventoryBytes.toString('utf8'));
  pins.inventorySha256=hash(inventoryBytes);
  need(input.CONTROL_ROOM_B8_QUALIFICATION_RECEIPT,'missing lead qualification receipt');
  const receiptPath=resolve(input.CONTROL_ROOM_B8_QUALIFICATION_RECEIPT);need(!/(?:^|[/\\])(?:\.codex|\.hermes|\.env|auth\.json|tokens?)(?:[/\\]|$)/i.test(receiptPath)&&lstatSync(receiptPath).isFile()&&!lstatSync(receiptPath).isSymbolicLink(),'receipt path refused');
  const receipt=decode(readFileSync(receiptPath,'utf8'));
  const immutable={toolsSha:pins.toolsSha,interpreterSha256,inventorySha256:pins.inventorySha256,
    schemaDigest:'sha256:'+hash(readFileSync(join(loop,'bridge/selection-schema.json'))),
    moduleSha256:hash(readFileSync(join(loop,'bridge/a2-contract.mjs'))),entrypointSha256:hash(readFileSync(join(loop,'bridge/cr-entry.py')))};
  need(Object.entries(immutable).every(([k,v])=>receipt[k]===v),'qualification receipt pins mismatch');
  const timeoutMs=Number(input.CONTROL_ROOM_B8_TOOLS_GATE_TIMEOUT_MS);need(Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=86400000,'missing finite tools budget');
  return {root,loop,python,inventory,pins,timeoutMs,env:b8HostChildEnvironmentV1(input,root)};
}
export async function runB8HostGateV1({preflight=productionB8HostPreflightV1,execute=executeB8HostChildV1,log=console.log}={}){
  try{
    const c=await preflight();
    const run=async(command,args,cwd,timeoutMs)=>{const r=await execute(command,args,{cwd,env:c.env,timeoutMs});
      if(r.code!==0||r.signal||r.failed||r.cleaned!==true){
        log('B8 child failed: '+basename(command)+' '+args.join(' ')+
          ' code='+r.code+' signal='+r.signal+' failed='+r.failed+' cleaned='+r.cleaned);
        for(const stream of ['stdout','stderr']){
          const tail=String(r[stream]??'').trimEnd().split(/\r?\n/).slice(-40)
            .filter(line=>!/(?:password|passwd|passphrase|secret|token|(?:api|access)[_ -]?key|authorization|bearer|cookie|credential|private[_ -]?key|\b(?:gh[pousr]_|github_pat_|xox[baprs]-|sk-[a-z0-9])|https?:\/\/[^\s/@]+:[^\s/@]+@)/i.test(line));
          log('B8 child '+stream+' tail:\n'+tail.join('\n'));
        }
      }
      need(r.code===0&&!r.signal&&!r.failed&&r.cleaned===true,'child failed/timeout/signal/cleanup');return r.stdout;};
    const tools=validateB8ToolsReceiptV1(await run(c.python,['-B','check_b8_host_gate.py'],c.loop,c.timeoutMs),c.inventory,c.pins);
    const u81=validateB8ProductTapV1(await run('pnpm',['run','test:loop-selection:real'],c.root,602000),'U81 real selection check',b8U81CasesV1);
    const p71=validateB8ProductTapV1(await run('pnpm',['run','test:loop-policy:real'],c.root,602000),'P71 real settings check',b8P71CasesV1);
    const final=await preflight();need(JSON.stringify(final.pins)===JSON.stringify(c.pins),'candidate pins changed');
    log('B8_HOST_RECEIPT '+JSON.stringify({schemaVersion:1,...c.pins,suites:tools.suites,product:[u81,p71]}));
    log('HOST GATE PASS toolsExpected=13 toolsExecuted=13 productExpected=2 productExecuted=2 skipped=0');return 0;
  }catch(error){log('HOST GATE FAIL: '+error.message);return 1;}
}
if(isMainModuleV1(process.argv[1],import.meta.url))process.exitCode=await runB8HostGateV1();
