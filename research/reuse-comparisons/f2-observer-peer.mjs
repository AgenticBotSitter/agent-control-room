#!/usr/bin/env node
// Synthetic finite emitter only; no Codex binary, credentials or network.
import fs from 'node:fs';import assert from 'node:assert/strict';
const root=process.env.F2_OBSERVER_ROOT,mode=process.env.F2_OBSERVER_MODE;assert.match(root,/^\/private\/tmp\/cr-f2-observer\.[A-Za-z0-9]+$/);assert.ok(['resume','wrong-thread','late-message','late-usage','failed-with-usage','terminal-nonzero','eof-no-terminal'].includes(mode));
let input='';for await(const x of process.stdin){input+=x;assert.ok(input.length<200);}assert.equal(input,'Synthetic observer comparison');fs.writeFileSync(root+'/'+mode+'.json',JSON.stringify({pid:process.pid,args:process.argv.slice(2)}));
const frame=x=>process.stdout.write(JSON.stringify(x)+'\n'),id=mode==='wrong-thread'?'22222222-2222-4222-8222-222222222222':'11111111-1111-4111-8111-111111111111';
frame({type:'thread.started',thread_id:id});frame({type:'turn.started'});frame({type:'item.completed',item:{id:'answer',type:'agent_message',text:'Synthetic main answer'}});
const usage={input_tokens:17,cached_input_tokens:5,cache_write_input_tokens:4,output_tokens:8,reasoning_output_tokens:3};
if(mode==='failed-with-usage')frame({type:'turn.failed',error:{message:'synthetic failure'},usage});else if(mode!=='eof-no-terminal')frame({type:'turn.completed',usage});
if(mode==='late-message')frame({type:'item.completed',item:{id:'late',type:'agent_message',text:'Synthetic late answer'}});
if(mode==='late-usage')frame({type:'turn.completed',usage:{...usage,input_tokens:23}});
if(mode==='terminal-nonzero'){process.stderr.write('synthetic exit after terminal');process.exitCode=7;}
