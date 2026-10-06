import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createFleetGatewayHandlerV1, createFleetGatewayAdmissionV1 } from '../src/fleet/v1/gateway-http.ts';
import { FleetGatewayStoreV1 } from '../src/fleet/v1/gateway-store.ts';
import { FLEET_GATEWAY_SERVER_OPTIONS_V1 } from '../scripts/run-fleet-gateway.ts';
import { createFleetReleaseTrustForTestV1 } from './support/fleet-release.ts';
const trust=createFleetReleaseTrustForTestV1().trust;
const gateway={tenantId:'tenant:qa'};
const enrollment={ code: `crj_${'J'.repeat(43)}`, credentialDigest: `sha256:${'0'.repeat(64)}`, workerKind: 'mcp-agent', platform: 'linux', architecture: 'x64', connectorVersion: '1.0.0', clientNonce: `crn_${'A'.repeat(43)}` };

const workerId=`fleet-worker:${'a'.repeat(32)}`;
async function exchange(handler,raw,extra={}) {
  const req=Readable.from([typeof raw==='string'?Buffer.from(raw):raw]);
  Object.assign(req,{url:'/fleet/v1/enroll',method:'POST',headers:{'content-type':'application/json',...extra},socket:{remoteAddress:'192.0.2.1'}});
  const res={headersSent:false,writeHead(status,headers){this.status=status;this.headers=headers;this.headersSent=true;},end(body){this.body=JSON.parse(body);},destroy(){this.destroyed=true;}};
  await handler.handle(req,res);return res;
}
function fleet(store,options={}) {return createFleetGatewayHandlerV1({store,releaseTrust:trust,...options});}

test('A2-07: fleet JSON refuses bogus media types and invalid UTF8',async()=>{
  let observed;
  const handler=fleet({async enroll(value){observed=value;return {workerId,replayed:false};}});
  assert.equal((await exchange(handler,JSON.stringify(enrollment),{'content-type':'application/jsonjunk'})).status,400);
  const raw=Buffer.from(JSON.stringify(enrollment).replace('"platform":"linux"','"platform":"BAD"'));
  raw[raw.indexOf('BAD')]=255;
  assert.equal((await exchange(handler,raw)).status,400);assert.equal(observed,undefined);
});

test('A2-08: enrollment refuses inherited and non-string platforms before DB',async()=>{
  let boundaries=0;
  const sentinel=Object.assign(new Error('database boundary intentionally unavailable'),{code:'QA_NO_DATABASE'});
  const store=new FleetGatewayStoreV1({async transaction(){boundaries++;throw sentinel;}},{tenantId:gateway.tenantId});
  await assert.rejects(store.enroll(enrollment),x=>x===sentinel);
  for(const platform of ['__proto__','constructor','toString',['linux']]) await assert.rejects(store.enroll({...enrollment,platform}),x=>x.code==='invalid');
  assert.equal(boundaries,1);
  for(const platform of ['unknown',null,{},0,'linux\0']) await assert.rejects(store.enroll({...enrollment,platform}),x=>x.code==='invalid');
  assert.equal(boundaries,1);
});

test('A2-08: malformed heartbeat platforms refuse before the transaction',async()=>{
  let calls=0;
  const sentinel=new Error('database boundary');
  const store=new FleetGatewayStoreV1({async transaction(){calls++;throw sentinel;}},{tenantId:gateway.tenantId});
  const principal={workerId};
  for(const platform of ['__proto__','constructor','toString',['linux'],null,{},0,'unknown'])
    await assert.rejects(store.heartbeat(principal,{connectorVersion:'1.0.0',platform}),e=>e.code==='invalid');
  assert.equal(calls,0);
  await assert.rejects(store.heartbeat(principal,{connectorVersion:'1.0.0',platform:'linux'}),e=>e===sentinel);
  assert.equal(calls,1);
});
test('real loopback gateway: 50 concurrent enrollment calls, dropped/slow connections, health and retry',async(t)=>{
  let active=0,peak=0;
  const handler=fleet({async enroll(){active++;peak=Math.max(peak,active);try{await delay(80);return {workerId,replayed:false};}finally{active--;}}},
    {admission:createFleetGatewayAdmissionV1({enrollPerIp:100,enrollGlobal:100,maxConcurrentEnroll:4})});
  let partialsStarted=0,partialsHandled=0,startedPartials,handledPartials;
  const allPartialsStarted=new Promise(done=>{startedPartials=done;});
  const allPartialsHandled=new Promise(done=>{handledPartials=done;});
  const server=createServer(FLEET_GATEWAY_SERVER_OPTIONS_V1,(req,res)=>{
    const partial=req.headers['content-length']==='4000';
    if(partial&&++partialsStarted===20)startedPartials();
    void handler.handle(req,res).then(()=>{if(partial&&++partialsHandled===20)handledPartials();});
  });
  const sockets=new Set();server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  const clients=[];
  try {
    await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
    const port=server.address().port;assert.notEqual(port,7864);
    const origin=`http://127.0.0.1:${port}`;
    const send=()=>fetch(origin+'/fleet/v1/enroll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(enrollment),signal:AbortSignal.timeout(2000)}).then(async r=>{await r.arrayBuffer();return r.status;});
    const statuses=await Promise.all(Array.from({length:50},send));
    assert.ok(statuses.every(x=>[201,429].includes(x)));assert.equal(peak,4);assert.ok(statuses.includes(201)&&statuses.includes(429));
    for(let i=0;i<20;i++) {
      const client=connect(port,'127.0.0.1');clients.push(client);client.on('error',()=>{});
      await new Promise(ok=>client.once('connect',ok));
      client.write(`POST /fleet/v1/enroll HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 4000\r\nConnection: close\r\n\r\n{`);
    }
    const response=await fetch(origin+'/fleet/v1/health',{signal:AbortSignal.timeout(1000)});assert.deepEqual(await response.json(),{ready:true});
    await allPartialsStarted;
    for(const client of clients) client.destroy();
    await allPartialsHandled;assert.equal(await send(),201);
    console.log(`FLEET_NETWORK: ${statuses.filter(x=>x===201).length}/50 accepted, ${statuses.filter(x=>x===429).length}/50 limited, peak enroll=4; health stayed available with 20 partial uploads; retry passed`);
  } catch(error) {
    if(error.code==='EPERM'||error.code==='EACCES') {t.skip('sandbox blocks loopback listener');console.log('NETWORK-VERIFIED: no - sandbox');} else throw error;
  } finally {
    for(const client of clients)client.destroy();for(const socket of sockets)socket.destroy();
    if(server.listening)await new Promise(ok=>server.close(ok));
  }
});
