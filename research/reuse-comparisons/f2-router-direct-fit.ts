import assert from 'node:assert/strict';
import { CodexAppServerJsonlSessionV1 } from '../../src/harness/codex-v1/isolated-jsonrpc';
const checks:string[]=[];
function session(){const s=new CodexAppServerJsonlSessionV1();const init=s.request('initialize',{});s.receive(JSON.stringify({id:init.id,result:{}}));s.notification('initialized',{});return s;}
const s=session();const a=s.request('thread/start',{}),b=s.request('thread/start',{});
assert.deepEqual(s.receive(JSON.stringify({id:b.id,result:'b'})),{kind:'response',id:b.id,method:'thread/start',ok:true,result:'b'});
assert.deepEqual(s.receive(JSON.stringify({id:a.id,result:'a'})),{kind:'response',id:a.id,method:'thread/start',ok:true,result:'a'});checks.push('out of order responses correlate');
assert.throws(()=>s.receive(JSON.stringify({id:a.id,result:'duplicate'})),/correlation/);
assert.throws(()=>s.receive(JSON.stringify({id:999,result:'unknown'})),/correlation/);checks.push('duplicate and unknown responses rejected');
assert.equal(s.receive(JSON.stringify({id:99,method:'item/commandExecution/requestApproval',params:{}})).kind,'server_request_forbidden');checks.push('server request forbidden without handler');
for(let i=0;i<16;i++)s.request('thread/start',{});
assert.throws(()=>s.request('thread/start',{}),/limit/);checks.push('pending requests capped at16');
assert.equal(s.disconnect().pendingRequestCount,16);
assert.throws(()=>s.request('thread/start',{}),/closed/);
assert.throws(()=>s.receive(JSON.stringify({id:3,result:'late'})),/closed/);checks.push('disconnect permanently closes request and receive');
assert.equal(s.disconnect().pendingRequestCount,0);checks.push('duplicate disconnect idempotent');
console.log(JSON.stringify({scope:'actual existing direct JSONL session synthetic messages, no process',count:checks.length,checks},null,2));
