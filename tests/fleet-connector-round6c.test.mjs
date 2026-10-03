import assert from 'node:assert/strict';
import test from 'node:test';
import {PassThrough, Readable, Writable} from 'node:stream';
import {mkdir, mkdtemp, writeFile, rm, readdir, readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {serveMcp, WORKING_AGREEMENT} from '../scripts/fleet/connector.mjs';

const WORKER = `fleet-worker:${'a'.repeat(32)}`;
const CLAIM = `fleet-claim:${'b'.repeat(32)}`;
const OFFER = `fleet-offer:${'c'.repeat(32)}`;
const agreement = {version:WORKING_AGREEMENT.version,digest:WORKING_AGREEMENT.digest,startsWork:false,grantsAuthority:false};
const rpc = (id, method, params) => ({jsonrpc:'2.0',id,method,...(params ? {params} : {})});
const call = (id,name,args={}) => rpc(id,'tools/call',{name,arguments:args});
const line = value => Buffer.from(JSON.stringify(value)+'\n');
const response = value => Response.json({ok:true,result:value});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(),'qa-r6conn-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const workspaceRoot = join(root,'workspace'), creds = join(root,'credentials');
  await mkdir(workspaceRoot); await mkdir(creds);
  const configPath = join(creds,'bot.json');
  await writeFile(configPath,JSON.stringify({schema:'control-room.fleet-connector/v1',server:'https://control.example',
    workerId:WORKER,secret:`crf_${'A'.repeat(43)}`,credentialExpiresAt:'2099-01-01T00:00:00.000Z'}),{mode:0o600});
  return {root,workspaceRoot,configPath};
}
function sink() {
  const chunks=[];
  const output = new Writable({write(chunk,_encoding,callback){chunks.push(chunk.toString());callback();}});
  return {output, replies:()=>chunks.join('').trim().split('\n').filter(Boolean).map(value=>JSON.parse(value))};
}

test('control: ordinary MCP output drains; twenty clients accept a fifty-message burst', {timeout:10000}, async t => {
  const f=await fixture(t);
  const runs=await Promise.all(Array.from({length:20},async()=>{
    const s=sink();
    await serveMcp({...f,input:Readable.from(Array.from({length:50},(_,id)=>line(rpc(id,'ping')))),output:s.output});
    assert.equal(s.replies().length,50); assert.equal(s.output.writableLength,0);s.output.destroy();
    return 50;
  }));
  console.log('ordinary output',JSON.stringify({sessions:runs.length,replies:runs.reduce((a,b)=>a+b,0)}));
});

test('R6C-02: malformed UTF-8 refuses instead of selecting a replacement attachment', {timeout:10000}, async t => {
  const f=await fixture(t); const s=sink();
  await writeFile(join(f.workspaceRoot,'\ufffd.txt'),'benign replacement-name document');
  const submitted=[];
  const fetcher=async (url,options)=>{
    const pathname=new URL(url).pathname;
    if(pathname.endsWith('/me'))return response({workingAgreement:agreement});
    if(pathname.endsWith('/mcp/calls'))return response({recorded:true});
    if(pathname.endsWith('/result')){submitted.push(JSON.parse(options.body));return response({submitted:true});}
    assert.fail('unexpected fixture route');
  };
  const before=JSON.stringify(call(1,'submit_result',{claimId:CLAIM,answer:'fixture result',files:['PLACEHOLDER.txt']}));
  const [prefix,suffix]=before.split('PLACEHOLDER');
  const invalid=Buffer.concat([Buffer.from(prefix),Buffer.from([0xff]),Buffer.from(suffix+'\n')]);
  assert.throws(()=>new TextDecoder('utf-8',{fatal:true}).decode(invalid));
  await serveMcp({...f,input:Readable.from(Array.from({length:20},()=>invalid)),output:s.output,fetcher});
  assert.equal(submitted.length,0);
  assert.equal(s.replies().length,20);
  assert.ok(s.replies().every(x=>x.error?.code===-32700 && x.error.data.reason==='invalid_utf8'));
  s.output.destroy();
});

const ping = id => line(rpc(id, 'ping'));
test('R6C-01: unread output bounds a 2000-request burst and closes with a named timeout', {timeout:3000}, async t => {
  const f = await fixture(t);
  let pulled = 0, peak = 0;
  const output = new Writable({highWaterMark:1024, write(_chunk, _encoding, _cb) { peak = this.writableLength; }});
  const input = Readable.from((function* () { for (let id=0; id<2000; id++) { pulled++; yield line(rpc(id,'tools/list')); } })());
  t.after(()=> {input.destroy(); output.destroy();});
  await assert.rejects(serveMcp({...f,input,output,replyTimeoutMs:50}), error => error.code === 'mcp_reply_timeout');
  assert.ok(pulled < 10, `pulled ${pulled} while the sink was blocked`);
  assert.ok(peak < 65536, `queued ${peak} bytes`);
  assert.equal(input.destroyed,true); assert.equal(output.destroyed,true);
});

test('R6C-01: a full queue closes before writing or consuming the next request', {timeout:3000}, async t => {
  const f=await fixture(t);
  const output=new Writable({write(_chunk,_encoding,_cb){}});
  output.write(Buffer.alloc(1024*1024));
  const input=Readable.from([ping(1),ping(2)]);
  t.after(()=>{input.destroy();output.destroy();});
  await assert.rejects(serveMcp({...f,input,output,replyTimeoutMs:50}), e=>e.code==='mcp_reply_queue_overflow');
  assert.equal(output.destroyed,true); assert.equal(input.destroyed,true);
});

for(const [name,bytes] of [['invalid UTF-8',Buffer.from([0xff,0x0a])],['parse',Buffer.from('{bad}\n')],['too large',Buffer.from('x'.repeat(512*1024+1)+'\n')],['normal',ping(1)]]) {
  test(`R6C-01: ${name} replies pause input until the sink drains`, {timeout:3000}, async t=>{
    const f=await fixture(t); let callback, writes=0; const chunks=[];
    const output=new Writable({highWaterMark:1, write(chunk,_encoding,cb){writes++;chunks.push(chunk.toString());callback=cb;}});
    const input=new PassThrough(); const serving=serveMcp({...f,input,output,replyTimeoutMs:500});
    t.after(()=>{input.destroy();output.destroy();});
    input.end(Buffer.concat([bytes,ping(2)]));
    while(!callback) await new Promise(done=>setImmediate(done));
    await new Promise(done=>setImmediate(done));
    assert.equal(writes,1);
    assert.equal(output.writableLength,Buffer.byteLength(chunks[0]),'the next reply must not be queued');
    callback(); callback=undefined;
    while(!callback) await new Promise(done=>setImmediate(done));
    assert.equal(writes,2); callback(); await serving;
    const replies=chunks.map(x=>JSON.parse(x)); assert.equal(replies[1].id,2);
  });
}

for (const event of ['error','close']) test(`R6C-01: output ${event} stops the session during a blocked reply`, {timeout:3000}, async t=>{
  const f=await fixture(t); let started;
  const ready=new Promise(done=>{started=done;});
  const output=new Writable({write(_chunk,_encoding,_cb){started();}});
  const input=new PassThrough(); const serving=serveMcp({...f,input,output,replyTimeoutMs:500});
  t.after(()=>{input.destroy();output.destroy();});
  const refused=assert.rejects(serving,e=>e.code===`mcp_reply_${event==='error'?'failed':'closed'}`);
  input.write(ping(1)); await ready;
  output.destroy(event==='error' ? new Error('fixture broken pipe') : undefined);
  await refused; assert.equal(input.destroyed,true);
});

test('R6C-01: EOF waits for the final write callback even below the high-water mark', {timeout:3000}, async t=>{
  const f=await fixture(t); let callback, settled=false;
  const output=new Writable({write(_chunk,_encoding,cb){callback=cb;}});
  const input=Readable.from([ping(1)]);
  t.after(()=>{input.destroy();output.destroy();});
  const serving=serveMcp({...f,input,output,replyTimeoutMs:500}).then(()=>{settled=true;});
  while(!callback) await new Promise(done=>setImmediate(done));
  assert.equal(settled,false); callback(); await serving; assert.equal(settled,true);
});

const damaged = [ [0xff], [0xed,0xa0,0x80], [0xed,0xbf,0xbf], [0xc0,0xaf], [0xe0,0x80,0xaf], [0xe2,0x82], [0xf0,0x9f,0x92] ];
for(const newline of [true,false]) test(`R6C-02: fatal decoding rejects malformed bytes at ${newline?'newline':'EOF'}`, {timeout:3000}, async t=>{
  const f=await fixture(t); const s=sink();
  for(const bytes of damaged){
    const frame=Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":"'),Buffer.from(bytes),Buffer.from('","method":"ping"}'+(newline?'\n':''))]);
    await serveMcp({...f,input:Readable.from([frame]),output:s.output});
  }
  assert.equal(s.replies().length,damaged.length);
  assert.ok(s.replies().every(x=>x.error?.code===-32700 && x.error.data.reason==='invalid_utf8'));
  s.output.destroy();
});

test('R6C-02: escaped lone surrogates in values and keys refuse, then valid split Unicode survives', {timeout:3000},async t=>{
  const f=await fixture(t); const s=sink();
  const bad=[rpc('\ud800','ping'),rpc(1,'ping',{'\udfff':'key'}),call(2,'submit_result',{claimId:CLAIM,answer:'ok',files:['\ud800.txt']})];
  const valid=line(rpc('é😀','ping')); const at=valid.indexOf(Buffer.from('😀'))+2;
  await serveMcp({...f,input:Readable.from([...bad.map(line),valid.subarray(0,at),valid.subarray(at)]),output:s.output,
    fetcher:()=>assert.fail('invalid strings must not reach the gateway')});
  assert.deepEqual(s.replies().slice(0,3).map(x=>x.error?.data?.reason),['invalid_unicode','invalid_unicode','invalid_unicode']);
  assert.equal(s.replies()[3].id,'é😀'); s.output.destroy();
});

// Every refusal the gateway can send while enrolling, and the ONE next step
// that fixes it. The nine final refusals are enumerated from the gateway:
// `unauthenticated` (unknown, cancelled, expired or already-redeemed code),
// `worker_kind_mismatch` (well-formed request, wrong bot), `invalid` (malformed
// request), `conflict` (this digest already holds a credential), `forbidden`,
// and the code-named `code_used`, `code_expired`, `expired` and `code_invalid`.
// Each entry carries the gateway's own code AND the whole next-step sentence,
// so a message that recommends the wrong one fails HERE, not in the field.
const SPENT_CODE='This code may have expired or already been used. Create a new code in Connect a bot and run its line.';
const finalRefusals=[
  // Codes this gateway will never accept again: a new code IS the fix.
  ['unauthenticated',401,SPENT_CODE],
  ['code_used',409,SPENT_CODE],
  ['code_expired',410,SPENT_CODE],
  ['expired',410,SPENT_CODE],
  ['code_invalid',400,SPENT_CODE],
  // Codes whose fix is NOT a new code. These are the ones a blanket rewrite
  // gets wrong, so each keeps the gateway's own code AND its own next step.
  ['worker_kind_mismatch',403,'This code was made for a different bot. Create a code for codex in Connect a bot and run its line.'],
  ['invalid',400,'The join request was refused as malformed. Copy the install line from Connect a bot again and run it unchanged.'],
  ['conflict',409,'Control Room already holds a credential for this machine\'s key. Remove the worker in Connect a bot, then create a new code and run its line.'],
  ['forbidden',403,'Control Room will not enroll this worker from this request. Ask the owner to restore the worker\'s permission, then run the install line again.'],
];
const loadJoin=async()=>({enroll:(await import('../scripts/fleet/connector.mjs')).join});
const refusingGateway=(code,status)=>async url=>String(url).endsWith('/connector-manifest.json')
  ? new Response('',{status:404}) : Response.json({ok:false,error:code},{status});
for(const [code,status,nextStep] of finalRefusals) {
  test(`R6C-04: enrollment ${code} names its own next step`,{timeout:3000},async t=>{
    const f=await fixture(t); const configPath=join(f.root,'credentials','new.json');
    const {enroll}=await loadJoin();
    await assert.rejects(enroll({configPath,server:'https://control.example',code:`crj_${'B'.repeat(43)}`,workerKind:'codex',
      fetcher:refusingGateway(code,status)}),
      e=>e.code===code && e.status===status && e.message===nextStep,
      `${code} must keep its own code and its own next step`);
    // A final refusal is also the only path allowed to DISCARD the pending join.
    await assert.rejects(import('node:fs/promises').then(fs=>fs.stat(configPath)),e=>e.code==='ENOENT');
  });
}

test('R6C-04: only a code the gateway will never accept again says the code expired',{timeout:3000},async t=>{
  const f=await fixture(t);
  const {enroll}=await loadJoin();
  for(const [code,status] of finalRefusals) {
    const configPath=join(f.root,'credentials',`${code}.json`);
    await assert.rejects(enroll({configPath,server:'https://control.example',code:`crj_${'B'.repeat(43)}`,workerKind:'codex',
      fetcher:refusingGateway(code,status)}),e=>{
      // The rule, not the example: the spent/expired wording is a property of
      // the CODE, not of the attempt. A code refused for another reason must
      // never be told it expired.
      assert.equal(e.message===SPENT_CODE,['unauthenticated','code_used','code_expired','expired','code_invalid'].includes(code),
        `${code} next step: ${e.message}`);
      return true;
    });
  }
});

test('R6C-04: a wrong bot kind names the kind the owner must choose',{timeout:3000},async t=>{
  const f=await fixture(t);
  const {enroll}=await loadJoin();
  for(const workerKind of ['codex','claude-code','hermes','cursor']) {
    const configPath=join(f.root,'credentials',`kind-${workerKind}.json`);
    await assert.rejects(enroll({configPath,server:'https://control.example',code:`crj_${'B'.repeat(43)}`,workerKind,
      fetcher:refusingGateway('worker_kind_mismatch',403)}),
      e=>e.code==='worker_kind_mismatch'
        && e.message===`This code was made for a different bot. Create a code for ${workerKind} in Connect a bot and run its line.`);
  }
});

// `unauthenticated` is the one refusal the gateway sends for FOUR different
// enrollment situations that share no other code: an unknown code, a cancelled
// code, an expired code, and a committed redemption this nonce cannot replay
// (or a credential the worker no longer holds). All four need a new code, so
// the plain wording is correct for it -- and that is a claim about THIS code
// alone, so it is pinned here rather than left to share a default branch.
test('R6C-04: unauthenticated alone keeps the plain spent-code next step',{timeout:3000},async t=>{
  const f=await fixture(t);
  const {enroll}=await loadJoin();
  const configPath=join(f.root,'credentials','unauthenticated.json');
  await assert.rejects(enroll({configPath,server:'https://control.example',code:`crj_${'B'.repeat(43)}`,workerKind:'codex',
    fetcher:refusingGateway('unauthenticated',401)}),
    e=>e.code==='unauthenticated' && e.status===401 && e.message===SPENT_CODE,
    'a spent, cancelled or already-redeemed code is told to create a new one');
});

test('R6C-01: output closes while idle without waiting for more input', {timeout:3000},async t=>{
  const f=await fixture(t); const input=new PassThrough(); const output=new PassThrough();
  t.after(()=>{input.destroy();output.destroy();});
  const serving=serveMcp({...f,input,output});
  const refusal=assert.rejects(serving,e=>e.code==='mcp_reply_closed');
  input.write(ping(1)); output.resume();
  await new Promise(done=>output.once('data',done));
  await new Promise(done=>setImmediate(done)); output.destroy(); await refusal;
});

test('R6C-02: a lone surrogate in a string stream refuses before byte conversion', {timeout:3000},async t=>{
  const f=await fixture(t); const s=sink();
  await assert.rejects(serveMcp({...f,input:Readable.from(['{"method":"ping","id":"\ud800"}\n']),output:s.output}),e=>e.code==='invalid_unicode');
  assert.equal(s.replies().length,0);
});

// A non-final failure is retryable, so it RETAINS the pending secret and nonce
// and the retry must replay the exact same binding. Three shapes qualify for the
// plain retry sentence, because in each the connector cannot know whether the
// redemption committed: a genuine transport failure, the connector's own
// request deadline, and a server failure status.
//
// `rate_limited` (429) and `paused` (423) are deliberately NOT here. They are
// refusals the gateway understood and answered, so the connector keeps their own
// message rather than inventing a sentence the gateway never sent.
for(const failure of ['unavailable','network','timeout','server-error']) test(`R6C-04: ${failure} enrollment retains its binding and directs an exact retry`,{timeout:3000},async t=>{
  const f=await fixture(t); const configPath=join(f.root,'credentials','new.json');
  const {enroll}=await loadJoin(); const {readFile}=await import('node:fs/promises');
  const bindings=[];
  const fetcher=async (url,init)=>{
    if(String(url).endsWith('/connector-manifest.json')) return new Response('',{status:404});
    bindings.push(JSON.parse(init.body));
    // A real dropped connection is a TypeError whose CAUSE carries the OS code,
    // which is the shape `isNetworkConnectionError` walks. A bare TypeError is
    // not treated as a transport failure, and must not be either.
    if(failure==='network') throw new TypeError('fetch failed',{cause:Object.assign(new Error('connect ECONNREFUSED'),
      {code:'ECONNREFUSED'})});
    if(failure==='timeout') throw Object.assign(new Error('Control Room request timed out.'),
      {name:'TimeoutError',code:'request_timeout'});
    // 503 plus a body the gateway never sends, so the connector's own reply
    // limit cannot be what failed: this is a server failure, not a bad reply.
    if(failure==='server-error') return Response.json({ok:false,error:'unavailable'},{status:500});
    return Response.json({ok:false,error:'unavailable'},{status:503});
  };
  const opts={configPath,server:'https://control.example',code:`crj_${'B'.repeat(43)}`,workerKind:'codex',fetcher};
  for(let i=0;i<2;i++) await assert.rejects(enroll(opts),e=>/Retry the same install line; it may already have joined/.test(e.message));
  assert.deepEqual(bindings[1],bindings[0]);
  assert.equal(JSON.parse(await readFile(configPath,'utf8')).workerId,null);
});

// A refusal the gateway understood keeps ITS OWN message, on the non-final
// path too. `rate_limited` and `paused` say nothing about the code: a new one
// would be consumed by the same limit, and the pending record is kept either way.
for(const [code,status] of [['rate_limited',429],['paused',423],['refused_secret_material',422],['too_large',413]]) {
  test(`R6C-04: ${code} keeps its own message and its pending binding`,{timeout:3000},async t=>{
    const f=await fixture(t); const configPath=join(f.root,'credentials','new.json');
    const {enroll}=await loadJoin(); const {readFile}=await import('node:fs/promises');
    await assert.rejects(enroll({configPath,server:'https://control.example',code:`crj_${'B'.repeat(43)}`,workerKind:'codex',
      fetcher:refusingGateway(code,status)}),e=>{
      assert.equal(/Retry the same install line; it may already have joined/u.test(e.message),false,
        `${code} must keep the gateway's own refusal, not the retry sentence`);
      assert.match(e.message,new RegExp(code,'u'));
      return true;
    });
    const pending=JSON.parse(await readFile(configPath,'utf8'));
    assert.equal(pending.workerId,null,`${code} is not final, so the pending binding survives`);
    assert.match(pending.clientNonce,/^crn_[A-Za-z0-9_-]{43}$/u);
  });
}

// The rule behind the retry sentence: the sentence belongs ONLY to a genuine
// transport or server failure. Every other error keeps its own message, because
// in all of these the redemption may already have committed and no sentence may
// imply the machine had NOT joined. A lost response mid-stream, a reply that
// failed validation and a body past the byte limit are all such errors: none is
// a transport or server failure, and each names something specific.
for(const [name,failure,wanted] of [['a dropped connection mid-response',()=>{throw new Error('simulated lost enrollment response');},/simulated lost enrollment response/u],
  ['a reply that fails validation',()=>Response.json({ok:true,result:{}}),/invalid reply/u],
  ['a reply past the connector byte limit',()=>new Response(`{"ok":false,"error":"unavailable"}`+' '.repeat(600*1024),{status:503}),/byte limit/u],
  ['a 404 route the gateway does not serve',()=>Response.json({ok:false,error:'not_found'},{status:404}),/not_found/u],
  // The discriminator: a TypeError with NO recognisable transport code is not
  // a connection failure. Treating every TypeError as one would invent a
  // sentence the connector cannot justify.
  ['a TypeError with no transport cause',()=>{throw new TypeError('fetch failed');},/fetch failed/u]]) {
  test(`R6C-04: ${name} is not rewritten as a plain retry`,{timeout:3000},async t=>{
    const f=await fixture(t); const configPath=join(f.root,'credentials','new.json');
    const {enroll}=await loadJoin(); const {readFile}=await import('node:fs/promises');
    await assert.rejects(enroll({configPath,server:'https://control.example',code:`crj_${'B'.repeat(43)}`,workerKind:'codex',
      fetcher:async url=>String(url).endsWith('/connector-manifest.json') ? new Response('',{status:404}) : failure()}),
      e=>{
        assert.equal(/Retry the same install line; it may already have joined/u.test(e.message),false,
          `${name} must keep its own message, not the blanket retry sentence`);
        assert.match(e.message,wanted);
        return true;
      });
    // Whatever it says, the pending binding survives so the retry replays the
    // same credential digest and nonce, and nothing is discarded.
    const pending=JSON.parse(await readFile(configPath,'utf8'));
    assert.equal(pending.workerId,null);
    assert.match(pending.clientNonce,/^crn_[A-Za-z0-9_-]{43}$/u);
  });
}

test('R6C-01: an actual unread stdout pipe bounds a 2000-request burst and refuses delivery', {timeout:5000},async t=>{
  const f=await fixture(t); const {spawn}=await import('node:child_process');
  const child=spawn(process.execPath,['tests/support/fleet-mcp-unread-output.mjs',f.configPath,f.workspaceRoot],
    {detached:true,stdio:['pipe','pipe','pipe']});
  let evidence=''; child.stderr.on('data',chunk=>{evidence+=chunk;});
  child.stdin.on('error',()=>{});
  const exited=new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  const closed=new Promise(resolve=>child.once('close',resolve));
  let deadline;
  const timeout=new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('native connector did not exit')),2500);});
  try {
    child.stdin.end(Buffer.concat(Array.from({length:2000},(_,id)=>line(rpc(id,'tools/list')))));
    assert.equal(await Promise.race([exited,timeout]),1,'failed reply delivery must exit unsuccessfully');
    child.stdout.destroy(); await closed;
    const result=JSON.parse(evidence.trim());
    assert.match(result.reason,/mcp_reply_timeout/); assert.ok(result.peak<=65536,`queued ${result.peak}`);
    console.log('native unread output',JSON.stringify(result));
  } finally {
    if(child.exitCode===null && child.signalCode===null) {
      try {process.kill(-child.pid,'SIGKILL');} catch(error) {if(error.code!=='ESRCH')throw error;}
    }
    clearTimeout(deadline);
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); await closed;
  }
});

test('R6C-01: a single oversized reply is refused before any output write', {timeout:3000},async t=>{
  const f=await fixture(t); const s=sink(); let work=0;
  const fetcher=async url=>{
    if(String(url).endsWith('/me')) return response({workingAgreement:agreement});
    if(String(url).endsWith('/mcp/calls')) return response({recorded:true});
    if(String(url).endsWith('/work')) {work++;return response([{offerId:OFFER,description:'"'.repeat(250000)}]);}
    assert.fail('unexpected route');
  };
  await assert.rejects(serveMcp({...f,input:Readable.from([line(call(1,'list_eligible_work')),ping(2)]),output:s.output,fetcher}),
    e=>e.code==='mcp_reply_queue_overflow');
  assert.equal(work,1); assert.equal(s.replies().length,0); assert.equal(s.output.destroyed,true);
});

test('R6C-01: an already closed output refuses before reading input', {timeout:3000},async t=>{
  const f=await fixture(t); const input=Readable.from([ping(1)]); const output=new PassThrough(); output.destroy();
  t.after(()=>input.destroy());
  await assert.rejects(serveMcp({...f,input,output,replyTimeoutMs:50}),e=>e.code==='mcp_reply_closed');
});

test('R6C-02: valid UTF-8 at EOF remains exact', {timeout:3000},async t=>{
  const f=await fixture(t);const s=sink();
  await serveMcp({...f,input:Readable.from([Buffer.from(JSON.stringify(rpc('é😀','ping')))]),output:s.output});
  assert.equal(s.replies()[0].id,'é😀');s.output.destroy();
});

test('R6C-01: twenty stalled clients each bound fifty replies and all close explicitly', {timeout:3000},async t=>{
  const f=await fixture(t);
  await Promise.all(Array.from({length:20},async()=>{
    let peak=0;
    const output=new Writable({highWaterMark:1,write(_chunk,_encoding,_cb){peak=this.writableLength;}});
    const input=Readable.from(Array.from({length:50},(_,id)=>line(rpc(id,'tools/list'))));
    try {
      await assert.rejects(serveMcp({...f,input,output,replyTimeoutMs:50}),e=>e.code==='mcp_reply_timeout');
      assert.ok(peak<65536); assert.equal(output.destroyed,true); assert.equal(input.destroyed,true);
    } finally {input.destroy();output.destroy();}
  }));
});

test('R6C-02: fifty malformed frames refuse and the following ping still succeeds', {timeout:3000},async t=>{
  const f=await fixture(t);const s=sink();
  const invalid=Buffer.from([0xff,0x0a]);
  await serveMcp({...f,input:Readable.from([...Array.from({length:50},()=>invalid),ping(99)]),output:s.output});
  assert.equal(s.replies().length,51);
  assert.ok(s.replies().slice(0,50).every(x=>x.error?.data?.reason==='invalid_utf8'));
  assert.equal(s.replies()[50].id,99);s.output.destroy();
});

// --- Enrollment refusals under load and on the unhappy paths.
//
// Each case is about the MESSAGE the owner sees and the STATE left behind, so
// they are asserted per case rather than by a single representative code.
const CODE=`crj_${'B'.repeat(43)}`;
const refusing=(code,status)=>async url=>String(url).endsWith('/connector-manifest.json')
  ? new Response('',{status:404}) : Response.json({ok:false,error:code},{status});
const scratch=async t=>{const dir=await mkdtemp(join(tmpdir(),'qa-enroll-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};

test('R6C-04: fifty concurrent enrollments each get one clean refusal and no pending file',{timeout:60000},async t=>{
  const dir=await scratch(t),{enroll}=await loadJoin();
  // 50 distinct credential paths run truly concurrently, each refusing the
  // same spent code. Every caller must get its own code and message, leave no
  // pending artifact, and release its rotation lock.
  const results=await Promise.all(Array.from({length:50},async(_,index)=>{
    const configPath=join(dir,`bot-${index}.json`); let seen;
    await enroll({server:'https://control.example',code:CODE,workerKind:'codex',configPath,fetcher:refusing('code_used',409)})
      .catch(error=>{seen=error;});
    let leftover=true; await stat(configPath).then(()=>{},()=>{leftover=false;});
    return {seen,leftover};
  }));
  for(const [index,{seen,leftover}] of results.entries()){
    assert.ok(seen,`caller ${index} was not refused`);
    assert.equal(seen.code,'code_used',`caller ${index} saw code ${seen.code}`);
    assert.equal(seen.message,SPENT_CODE);
    assert.equal(leftover,false,`caller ${index} left a pending credential file`);
  }
  // r6kfix keeps one permanent, empty kernel-lock inode per lock (`<lock>.guard`); the lock itself must be gone.
  assert.deepEqual((await readdir(dir)).filter(name=>name.includes('.rotate.lock')&&!name.endsWith('.rotate.lock.guard')),[],
    'every rotation lock was released');
});

test('R6C-04: a final refusal is final, and a retry neither changes nor resurrects it',{timeout:15000},async t=>{
  const dir=await scratch(t),configPath=join(dir,'retry.json'),{enroll}=await loadJoin();
  const attempt=async()=>{let seen;
    await enroll({server:'https://control.example',code:CODE,workerKind:'codex',configPath,fetcher:refusing('code_expired',410)})
      .catch(error=>{seen=error;});
    assert.ok(seen); return seen;};
  const first=await attempt(),second=await attempt();
  assert.equal(second.code,'code_expired');
  assert.equal(second.message,first.message,'the next step is stable across retries');
  await assert.rejects(stat(configPath),e=>e.code==='ENOENT');
});

test('R6C-04: a non-final refusal keeps the binding, and ten retries replay one body',{timeout:60000},async t=>{
  const dir=await scratch(t),configPath=join(dir,'limited.json'),{enroll}=await loadJoin();
  // `rate_limited` is not final, so the secret and nonce MUST survive it and a
  // retry must replay the identical enrollment body: the same credential digest
  // and the same client nonce, or a retry could consume a second credential.
  const bodies=[];
  for(let index=0;index<10;index++){
    let seen;
    await enroll({server:'https://control.example',code:CODE,workerKind:'codex',configPath,
      fetcher:async(url,init)=>{
        // Only the enrollment body is the subject; the preflight manifest call
        // carries none and must not be parsed as one.
        if(!String(url).endsWith('/connector-manifest.json')) bodies.push(JSON.parse(init.body));
        return refusing('rate_limited',429)(url);}})
      .catch(error=>{seen=error;});
    assert.ok(seen,'the fixture did not refuse'); assert.equal(seen.code,'rate_limited');
    assert.doesNotMatch(seen.message,/Retry the same install line/u,
      'a refusal the gateway understood keeps its own message');
  }
  assert.equal(new Set(bodies.map(body=>JSON.stringify(body))).size,1,
    'a non-final refusal must not change the credential digest or nonce');
  const pending=JSON.parse(await readFile(configPath,'utf8'));
  assert.equal(pending.workerId,null);
  assert.match(pending.clientNonce,/^crn_[A-Za-z0-9_-]{43}$/u);
  // Thirty more callers, all limited at once: the advice must stay identical.
  const many=await Promise.all(Array.from({length:30},async(_,index)=>{
    let seen;
    await enroll({server:'https://control.example',code:CODE,workerKind:'codex',
      configPath:join(dir,`many-${index}.json`),fetcher:refusing('rate_limited',429)})
      .catch(error=>{seen=error;});
    assert.ok(seen); return seen;}));
  assert.equal(new Set(many.map(error=>error.message)).size,1,'the same refusal gives one answer under load');
  assert.deepEqual((await readdir(dir)).filter(name=>name.includes('.rotate.lock')&&!name.endsWith('.rotate.lock.guard')),[]);
});
