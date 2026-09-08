import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {promises as fsp} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import ts from 'typescript';
const root=process.argv[2];if(!/^\/private\/tmp\/control-room-f4\.[A-Za-z0-9]+$/.test(root??''))throw Error('owned root');
const owned=await fsp.mkdtemp(path.join(root,'maestro-state-'));
const code=ts.transpileModule(await fsp.readFile(path.join(root,'maestro/lib/amp-inbox-writer.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
const checks=[];const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);};
function load(){const exports={};const require=(name)=>{if(name==='fs')return fs;if(name==='path')return path;if(name==='os')return {...os,homedir:()=>owned};throw Error(`blocked dependency ${name}`);};vm.runInNewContext(code,{exports,require,console:{log(){},error(){}},Date,JSON,Error});return exports;}
const writer=load();const began=performance.now();
try{
 const envelope={id:'message-1',from:'sender@synthetic.local',to:'one@synthetic.local',timestamp:'2026-09-08T00:00:00Z',subject:'Synthetic discussion',thread_id:'idea-session-1'};
 const payload={type:'request',message:'Synthetic opinion',context:{projectId:'project-1',attemptId:'attempt-1'}};
 const first=await writer.writeToAMPInbox(envelope,payload,'one',undefined,'agent-one');assert.ok(first?.startsWith(owned));
 check('durable stored message',JSON.parse(await fsp.readFile(first,'utf8')).payload.context.attemptId==='attempt-1');
 check('duplicate same envelope uses same path',await writer.writeToAMPInbox(envelope,payload,'one',undefined,'agent-one')===first);
 const record=JSON.parse(await fsp.readFile(first,'utf8'));record.local.status='read';await fsp.writeFile(first,JSON.stringify(record));
 await writer.writeToAMPInbox(envelope,{...payload,message:'Changed payload'},'one',undefined,'agent-one');
 const changed=JSON.parse(await fsp.readFile(first,'utf8'));
 check('duplicate changed payload overwrites',changed.payload.message==='Changed payload');
 check('duplicate resets read status',changed.local.status==='unread');
 check('new module sees same stored path',load().getAgentAMPDir('one','agent-one')===path.join(owned,'.agent-messaging/agents/agent-one'));
 const second=await writer.writeToAMPInbox(envelope,payload,'two',undefined,'agent-two');check('distinct recipients isolated',second!==first);
 console.log(JSON.stringify({checks,actualWriter:true,homedirInjectedOnly:true,credentialsRead:false,providerCalls:0,elapsedMs:performance.now()-began,maxRSSKiB:process.resourceUsage().maxRSS},null,2));
}finally{await fsp.rm(owned,{recursive:true,force:true});}
