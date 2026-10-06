import assert from 'node:assert/strict';
import test from 'node:test';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createServer, request as httpRequest} from 'node:http';
import {connect} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {createFleetGatewayHandlerV1,createFleetGatewayAdmissionV1,FLEET_BODY_LIMITS_V1} from '../src/fleet/v1/gateway-http.ts';
import {FleetErrorV1} from '../src/fleet/v1/errors.ts';
import {createFleetReleaseTrustForTestV1} from './support/fleet-release.ts';
import {MAC_LOCAL_FLEET_GATEWAY_SERVER_OPTIONS_V1} from '../src/fleet/v1/mac-local-composition.ts';
const trust=createFleetReleaseTrustForTestV1().trust;
const workerId='fleet-worker:'+'a'.repeat(32),claimId='fleet-claim:'+'b'.repeat(32),uploadId='result-upload:'+'c'.repeat(32);
const bearer='crw_'+'q'.repeat(43),credentialDigest='sha256:'+createHash('sha256').update(bearer).digest('hex');
const principal={workerId,tenantId:'tenant:qa',identityId:'identity:qa',projectIds:['project:qa'],credentialExpiresAt:'2026-10-02T00:00:00.000Z'};
const enroll={code:'crj_'+'J'.repeat(43),credentialDigest,workerKind:'mcp-agent',platform:'linux',architecture:'x64',connectorVersion:'1.0.0',clientNonce:'crn_'+'A'.repeat(43)};
function handler(store,options={}){return createFleetGatewayHandlerV1({releaseTrust:trust,store,...options})}
async function exchange(h,path,method='GET',body,headers={},readProbe,requestState={}){
 const raw=body===undefined?undefined:Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body));
 const r=new Readable({read(){readProbe?.();if(raw)this.push(raw);this.push(null)}});
 Object.assign(r,{url:path,method,headers:{'content-type':'application/json',authorization:'Bearer '+bearer,'x-control-room-worker':workerId,...headers},socket:{remoteAddress:'192.0.2.1'},...requestState});
 const s=new EventEmitter();Object.assign(s,{headersSent:false,writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true},end(body){this.body=String(body)},destroy(){this.destroyed=true}});
 try{await h.handle(r,s);return {status:s.status,body:s.body,headers:s.headers}}finally{r.destroy();s.removeAllListeners()}
}
test('R2W-5: upload listings refuse writes before parsing; explicit void remains available', async () => {
  let reads = 0;
  const voids = [];
  const h = handler({ authenticate: async () => principal }, { uploads: {
    declaredOutputs: async () => ['output'], inputs: async () => ['input'],
    voidUpload: async (_principal, input) => { voids.push(input); return { voided: true }; },
  } });
  const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => exchange(h,
    `/fleet/v1/claims/${claimId}/${index % 2 ? 'outputs' : 'inputs'}`, 'POST', { uploadId }, {}, () => reads++)));
  assert.ok(responses.every(response => [404, 429].includes(response.status)));
  assert.ok(responses.some(response => response.status === 404));
  console.log(`UPLOAD_BURST: ${responses.filter(r => r.status === 404).length} refused by route; ${responses.filter(r => r.status === 429).length} limited; zero mutations`);
  assert.equal(voids.length, 0); assert.equal(reads, 0);
  for (const action of ['outputs', 'inputs']) {
    assert.equal((await exchange(h, `/fleet/v1/claims/${claimId}/${action}`)).status, 200);
    for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD'])
      assert.equal((await exchange(h, `/fleet/v1/claims/${claimId}/${action}`, method, { uploadId })).status, 404);
  }
  const path = `/fleet/v1/claims/${claimId}/void`;
  assert.equal((await exchange(h, path, 'POST', { uploadId: 'invalid' })).status, 400);
  assert.equal((await exchange(h, path, 'POST', { uploadId })).status, 200);
  assert.deepEqual(voids, [{ uploadId, claimId }]);
});

test('R2W-6: existing typed size errors survive an already-aborted request in both parsers', async () => {
  const h = handler({ authenticate: async () => principal }, { uploads: { chunk: async () => {
    throw new Error('oversized bytes must not reach storage');
  } } });
  const json = await exchange(h, '/fleet/v1/enroll', 'POST', ' '.repeat(FLEET_BODY_LIMITS_V1.enroll + 1),
    {}, undefined, { aborted: true });
  assert.equal(json.status, 413); assert.equal(JSON.parse(json.body).error, 'too_large');
  const raw = await exchange(h, `/fleet/v1/claims/${claimId}/uploads/${uploadId}/chunks`, 'POST',
    Buffer.alloc(FLEET_BODY_LIMITS_V1.chunk + 1), { 'content-type': 'application/octet-stream',
      'x-control-room-chunk-ordinal': '1', 'x-control-room-chunk-digest': 'sha256:' + '0'.repeat(64) },
    undefined, { aborted: true });
  assert.equal(raw.status, 413); assert.equal(JSON.parse(raw.body).error, 'too_large');
});

test('R2W-6: raw upload chunks preserve streamed too_large and genuine abort stays invalid', async () => {
  let chunks = 0;
  const h = handler({ authenticate: async () => principal }, { uploads: { chunk: async () => { chunks++; return {}; } } });
  const server = createServer(MAC_LOCAL_FLEET_GATEWAY_SERVER_OPTIONS_V1, (req, res) => void h.handle(req, res));
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  try {
    await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
    const port = server.address().port; assert.notEqual(port, 7864);
    const url = `http://127.0.0.1:${port}/fleet/v1/claims/${claimId}/uploads/${uploadId}/chunks`;
    const body = Buffer.alloc(FLEET_BODY_LIMITS_V1.chunk + 1, 32);
    for (const chunked of [false, true]) {
      const headers = {
        authorization: 'Bearer ' + bearer, 'x-control-room-worker': workerId, 'content-type': 'application/octet-stream',
        'x-control-room-chunk-ordinal': '1',
        'x-control-room-chunk-digest': 'sha256:' + '0'.repeat(64),
        ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': String(body.length) }),
      };
      // Node's client accepts an early refusal while request bytes are still being sent.
      const response = await new Promise((resolve, reject) => {
        const client = httpRequest(url, { method: 'POST', headers, signal: AbortSignal.timeout(5000) }, res => {
          let text = ''; res.on('data', bytes => { text += bytes; });
          res.on('error', reject); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
        });
        client.on('error', reject); client.end(chunked ? body : undefined);
      });
      assert.equal(response.status, 413); assert.deepEqual(response.body, { ok: false, error: 'too_large' });
    }
    assert.equal(chunks, 0);
  } finally {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(ok => server.close(ok));
  }
  // No typed server refusal exists for a genuinely interrupted request.
  const request = new Readable({ read() { this.aborted = true; this.destroy(new Error('test_disconnect')); } });
  Object.assign(request, { url: '/fleet/v1/enroll', method: 'POST', headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '192.0.2.1' } });
  const response = new EventEmitter();
  Object.assign(response, { headersSent: false, writeHead(status) { this.status = status; this.headersSent = true; },
    end(body) { this.body = String(body); } });
  try {
    await h.handle(request, response);
    assert.equal(response.status, 400); assert.equal(response.body, JSON.stringify({ ok: false, error: 'invalid' }));
  } finally { request.destroy(); response.removeAllListeners(); }
});
test('R2W-6 real HTTP: 50 enrollment burst, slow uploads, drop halfway, declared and chunked oversize, timed-out header, recovery',async()=>{
 let admissionNow=0;const admission=createFleetGatewayAdmissionV1({clock:()=>admissionNow});
 let active=0,peak=0,calls=0;const h=handler({enroll:async()=>{calls++;active++;peak=Math.max(peak,active);try{await delay(60);return {workerId,replayed:false}}finally{active--}},authenticate:async()=>{throw new FleetErrorV1('unauthenticated')}},{admission});
 const server=createServer(MAC_LOCAL_FLEET_GATEWAY_SERVER_OPTIONS_V1,(req,res)=>void h.handle(req,res));const accepted=new Set(),clients=[];
 server.on('connection',s=>{accepted.add(s);s.on('close',()=>accepted.delete(s))});
 try{
 await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok)});const port=server.address().port;assert.notEqual(port,7864);const base=`http://127.0.0.1:${port}`;
 const send=async()=>{const r=await fetch(base+'/fleet/v1/enroll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(enroll),signal:AbortSignal.timeout(2500)});await r.text();return r.status};
 const statuses=await Promise.all(Array.from({length:50},send));assert.ok(statuses.every(x=>[201,429].includes(x)));assert.equal(peak,4);
 for(let i=0;i<20;i++){const s=connect(port,'127.0.0.1');clients.push(s);s.on('error',()=>{});await new Promise(ok=>s.once('connect',ok));s.write(`POST /fleet/v1/enroll HTTP/1.1\r\nHost: local\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{`)}
 const start=performance.now();const health=await fetch(base+'/fleet/v1/health',{signal:AbortSignal.timeout(1000)});assert.deepEqual(await health.json(),{ready:true});const healthMs=Math.round(performance.now()-start);
 // A slow burst may legitimately spend all eight per-IP enrollments. Advance
 // only the admission clock: recovery tests body/concurrency isolation in a
 // fresh budget window, independently of host scheduling and the burst count.
 admissionNow+=60_000;
 const retry=await send();assert.equal(retry,201);for(const s of clients)s.destroy();await delay(50);assert.equal(active,0);
 for(const chunked of [false,true]){const response=await fetch(base+'/fleet/v1/enroll',{method:'POST',headers:{'content-type':'application/json',...(chunked?{}:{'content-length':'4097'})},body:chunked?new ReadableStream({start(c){c.enqueue(Buffer.alloc(4097,32));c.close()}}):' '.repeat(4097),...(chunked?{duplex:'half'}:{}),signal:AbortSignal.timeout(2000)});assert.equal(response.status,413);const body=await response.text();assert.equal(body,JSON.stringify({ok:false,error:'too_large'}));}
 const unfinished = await new Promise((resolve, reject) => {
   const client = httpRequest(base + '/fleet/v1/enroll', { method: 'POST',
     headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(2000) }, res => {
     let body = ''; res.on('data', bytes => { body += bytes; }); res.on('error', reject);
     res.on('end', () => { client.destroy(); resolve({ status: res.statusCode, body }); });
   });
   client.on('error', reject);
   // Cross the limit without ending the HTTP message: the refusal must still arrive.
   client.write(Buffer.alloc(4097, 32));
 });
 assert.equal(unfinished.status, 413); assert.equal(unfinished.body, JSON.stringify({ ok: false, error: 'too_large' }));
 const slow=connect(port,'127.0.0.1');clients.push(slow);slow.on('error',()=>{});await new Promise(ok=>slow.once('connect',ok));slow.write('GET /fleet/v1/health HTTP/1.1\r\n');
 let data='';slow.on('data',b=>data+=b);await Promise.race([new Promise(ok=>slow.once('close',ok)),delay(7000).then(()=>{throw new Error('slow_header_not_closed')})]);assert.match(data,/408 Request Timeout/);
 console.log(`NETWORK HELD: burst=${statuses.filter(x=>x===201).length} accepted/${statuses.filter(x=>x===429).length} limited; peak=4; 20 partial uploads health=${healthMs}ms; legitimate enroll while slow bodies=201; half-body disconnect releases work; declared oversize=413; chunked oversize=413; slow header=408; calls=${calls}`);
 }finally{for(const s of clients)s.destroy();for(const s of accepted)s.destroy();if(server.listening)await new Promise(ok=>server.close(ok));assert.equal(server.listening,false)}
});
