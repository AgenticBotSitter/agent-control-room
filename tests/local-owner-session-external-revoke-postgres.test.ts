// Round 4 R4C-10. Runs against real PostgreSQL AS THE PRODUCTION WEB LOGIN.
//
// An already-running local host loads its owner sessions once at startup and
// answers from that map. If a session is revoked outside this process -- a
// second device, the updater, an operator action in Control Room -- the running
// host would keep authorizing the copied cookie for the life of the process.
// This asserts the desired behaviour: twenty requests with a durably revoked
// cookie are all refused, so the revocation takes effect within a short bound
// rather than at the next restart.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Client, Pool } from 'pg';
import { withRealPostgres, type RealPostgres } from './support/attack-kit/index';
import { seedFleetTenant, ownerIdentity, FLEET_TENANT, FLEET_WORKSPACE } from './support/fleet-fixture';
import { bindPrivatePgPool } from '../src/web/v1/private-pg-database';
import { privatePgOptions } from '../src/web/v1/private-pg-options';
import { createPostgresLocalOwnerSessionStoreV1 } from '../src/web/v1/local-owner-session-store';
import { createMacLocalWebProcessV1 } from '../src/web/v1/mac-local-web-process';
import { LocalOwnerSessionServiceV1, type LocalOwnerSessionProfileV1 } from '../src/web/v1/local-owner-session';
import { WebSessionAuthority } from '../src/web/v1/session-authority';
import { sha256Digest } from '../src/security';

const port=Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59660);
const origin='http://127.0.0.1:3210', code='synthetic-real-pg-follow-up-code';
const request=(path:string,method='GET',body?:string,cookie?:string)=>new Request(origin+path,{method,
  headers:{origin,'content-type':'application/json',...(cookie?{cookie}:{})},...(body===undefined?{}:{body})});
function webPool(pg:RealPostgres) {
  const login=pg.connection('web');
  return bindPrivatePgPool(new Pool({...privatePgOptions({host:'127.0.0.1',port:pg.port,database:pg.database,
    username:login.user,password:login.password,majorVersion:17}),host:login.host}));
}
test('R4C-10: external production-login revocation must invalidate the already-running local host',async()=>{
  await withRealPostgres(async pg=>{
    const admin=new Client(pg.admin({database:pg.database})); await admin.connect();
    const web=webPool(pg); let app:ReturnType<typeof createMacLocalWebProcessV1>|undefined;
    try {
      await seedFleetTenant(admin.query.bind(admin));
      const owner=ownerIdentity();
      const profile:LocalOwnerSessionProfileV1={schema:'control-room.local-owner-session/v1',origin,
        tenantId:FLEET_TENANT,provider:owner.provider,subject:owner.subject,
        ownerCodeDigest:sha256Digest({ownerCode:code}),sessionSeconds:300};
      const store=createPostgresLocalOwnerSessionStoreV1(web.client,profile);
      app=createMacLocalWebProcessV1({origin,workspaceId:FLEET_WORKSPACE,localOwnerSession:profile,
        localOwnerSessionStore:store,initialLocalOwnerSessions:await store.load(Date.now()),
        database:{client:web.client,close:async()=>{},isAvailable:()=>true},clock:Date.now,
        workerReadiness:{read:()=>[]},workBatchIntegrityKey:new Uint8Array(32).fill(1),fleet:{ownerAuthority:web.client}});
      const render=()=>new Response('fixture');
      const signedIn=await app.handle(request('/api/v1/local-owner-session','POST',JSON.stringify({ownerCode:code})),render);
      assert.equal(signedIn.status,201);
      const cookie=signedIn.headers.get('set-cookie')!.split(';')[0];
      assert.equal((await app.handle(request('/api/v1/local-workers','GET',undefined,cookie),render)).status,200);
      const cache=new LocalOwnerSessionServiceV1(profile,store,await store.load(Date.now()));
      const identity=cache.verify(request('/api/v1/local-workers','GET',undefined,cookie),Date.now());
      // This production-web operation represents another process/device revoking the token.
      await store.revoke(identity.tokenDigest,new Date().toISOString());
      assert.ok(!(await store.load(Date.now())).some(s=>s.tokenDigest===identity.tokenDigest));
      const authority=new WebSessionAuthority(web.client,{tenantId:FLEET_TENANT,workspaceId:FLEET_WORKSPACE});
      await assert.rejects(authority.authenticated(identity,async()=>true),e=>(e as {code?:string}).code==='authentication_required');
      const bursts=await Promise.all(Array.from({length:20},()=>app!.handle(request('/api/v1/local-workers','GET',undefined,cookie),render)));
      console.log('R4C-10 production-login revoked-cookie statuses:',JSON.stringify(bursts.map(r=>r.status)));
      assert.ok(bursts.every(r=>r.status===401),'a live host must not authorize a revoked cookie from its startup cache');
      // Control: a LIVE session still works, so the guard refuses only what is
      // durably gone. A second sign-in is issued after the first was revoked.
      const second=await app.handle(request('/api/v1/local-owner-session','POST',JSON.stringify({ownerCode:code})),render);
      assert.equal(second.status,201);
      const liveCookie=second.headers.get('set-cookie')!.split(';')[0];
      assert.equal((await app.handle(request('/api/v1/local-workers','GET',undefined,liveCookie),render)).status,200);
      // Control: a store that cannot answer must NOT sign the owner out. A
      // transient database fault is not evidence of a revocation, and refusing
      // every request during an outage would lock the owner out of their own
      // machine. The subject is a session this service issued itself, so its
      // own map is what answers -- not whatever the store happens to hold.
      // `save` succeeds -- a session can be issued while only `load` is broken,
      // which is the realistic partial outage. A `save` that threw would fail
      // `issue` itself and prove nothing about verifyLive.
      const offlineStore={save:async()=>{},load:async()=>{throw new Error('store unavailable');},revoke:async()=>{}};
      const offline=new LocalOwnerSessionServiceV1(profile,offlineStore as never,[]);
      const offlineCookie=(await offline.issue(
        new Request(origin+'/api/v1/local-owner-session',{method:'POST',
          headers:{origin,'sec-fetch-site':'same-origin','content-type':'application/json'}}),code,Date.now()))
        .cookie.split(';')[0];
      await assert.doesNotReject(Promise.resolve(
        offline.verifyLive(request('/api/v1/local-workers','GET',undefined,offlineCookie),Date.now())),
        'an unreadable store must not refuse a live session');
      // alreadyEnded() must judge against the store's LIVE rows using the
      // request's own time. A sentinel either matches every stored row
      // (meaningless) or none -- and "none" is what would declare every
      // well-formed cookie already ended, including a live one, so a real
      // sign-out would silently do nothing. A fresh service: the foreign-origin
      // rejection above filled the earlier one's failure window, and `issue` is
      // rate limited by design.
      const issuer=new LocalOwnerSessionServiceV1(profile,store as never,await store.load(Date.now()));
      const third=await issuer.issue(
        new Request(origin+'/api/v1/local-owner-session',{method:'POST',
          headers:{origin,'sec-fetch-site':'same-origin','content-type':'application/json'}}),
        code,Date.now());
      const thirdCookie=third.cookie.split(';')[0];
      const thirdIdentity=issuer.verify(request('/api/v1/local-workers','GET',undefined,thirdCookie),Date.now());
      assert.equal((await store.load(Date.now())).some(s=>s.tokenDigest===thirdIdentity.tokenDigest),true);
      await issuer.revoke(request('/api/v1/local-owner-session','DELETE',undefined,thirdCookie),Date.now());
      assert.equal((await store.load(Date.now())).some(s=>s.tokenDigest===thirdIdentity.tokenDigest),false,
        'a live session must be revoked, never assumed already ended');
      // A session this process issued but the store does not know is still
      // refused: the process's own map is not the authority once a store exists.
      // The session above is durably revoked now, so it is the natural subject:
      // its own map still knows it, and the store does not.
      const stillKnows=new LocalOwnerSessionServiceV1(profile,{...store,load:async()=>[]} as never,[
        {tokenDigest:thirdIdentity.tokenDigest,issuedAt:new Date(Date.now()-1000).toISOString(),
          expiresAt:new Date(Date.now()+300000).toISOString()}]);
      assert.ok(stillKnows.verify(request('/api/v1/local-workers','GET',undefined,thirdCookie),Date.now()),
        'the in-process map still holds the revoked session');
      await assert.rejects(Promise.resolve(stillKnows.verifyLive(request('/api/v1/local-workers','GET',undefined,thirdCookie),Date.now())),
        (e:unknown)=>(e as {code?:string}).code==='authentication_required',
        'a session the store does not know is refused even when this process still holds it');
    } finally {
      await app?.close(); await web.close(); await admin.end();
    }
  },{port,allowedPorts:[port],boundMs:60000});
});
