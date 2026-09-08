#!/usr/bin/env node
// Synthetic protocol emitter, NOT Codex. No network, credentials or child processes.
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const root=process.env.F2_FIXTURE_ROOT;
assert.match(root??'',/^\/private\/tmp\/cr-f2-transport\.[A-Za-z0-9]+$/);
const mode=process.env.F2_FIXTURE_MODE;
const instance=process.env.F2_FIXTURE_INSTANCE;
assert.match(instance??'',/^\d+$/);
assert.ok(['success','truncated','malformed','nonzero','oversize','wait','stderr'].includes(mode));
const trace={pid:process.pid,mode,args:process.argv.slice(2),environmentKeys:Object.keys(process.env).sort(),inputBytes:0};
let prompt='';
for await(const chunk of process.stdin){prompt+=chunk;assert.ok(prompt.length<1000);}
trace.inputBytes=Buffer.byteLength(prompt);
trace.inputMatches=prompt==='Synthetic prompt';
writeFileSync(`${root}/${mode}-${instance}.json`,JSON.stringify(trace));
const frame=x=>process.stdout.write(JSON.stringify(x)+'\n');
if(mode==='wait'){
  process.on('SIGTERM',()=>process.exit(0));
  setTimeout(()=>process.exit(90),2000);
}else if(mode==='nonzero'||mode==='stderr'){
  process.stderr.write(mode==='stderr'?'x'.repeat(65536):'synthetic refusal');
  process.exitCode=7;
}else if(mode==='malformed'){
  process.stdout.write('not-json\n');
}else{
  frame({type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'});
  frame({type:'turn.started'});
  frame({type:'item.completed',item:{id:'fixture',type:'agent_message',text:mode==='oversize'?'x'.repeat(1_000_050):'Synthetic transport result'}});
  if(mode!=='truncated')frame({type:'turn.completed',usage:{input_tokens:8,output_tokens:3}});
}
