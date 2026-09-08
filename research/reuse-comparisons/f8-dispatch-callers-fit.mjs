// Actual caller modules and candidate libraries; synthetic services, no DB/listener.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {candidateVerifier} from './f8-candidate-verifiers.mjs';
const root=process.argv[2],hash=b=>createHash('sha256').update(b).digest('hex');
const pins={'task-http':'9874644900e425edd03aeebe9bda0bc7d09a233571b1ca9a823ce9e73e96c6e0','news-collection-http':'63ff1965f478b28f7b52e48ac93ba859184d33d420c69b2db5d3e38c5399e4ad','http-common':'3d8372bf7b297d23e56a3578f7a979248acaf50f21c349ebd02de5292f4801a6','private-process':'79b5261c991634e61f6c89a15fe94e759606448b619b28c838adf6929a9b4aea','access-key-cache':'957522108a0c0f8b0bb6d9e363dbd071e16a5a7159133e84a54b8ae7d9fbf0e9'};
const sources=Object.fromEntries(Object.entries(pins).map(([n,h])=>{const s=readFileSync(new URL(`../../src/web/v1/${n}.ts`,import.meta.url),'utf8');assert.equal(hash(s),h);return[n,s];}));
const now=1800000000000,key=generateKeyPairSync('rsa',{modulusLength:2048}),wrong=generateKeyPairSync('rsa',{modulusLength:2048});
const origin='https://app.invalid',project='project:test';
const trust={issuer:'https://issuer.invalid',audience:'synthetic',keys:[{kid:'one',jwk:key.publicKey.export({format:'jwk'})}],validUntilMs:now+90000,maxSessionSeconds:3600};
function token(mode){const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');const body=`${enc({alg:'RS256',kid:'one'})}.${enc({iss:trust.issuer,aud:[mode==='audience'?'other':trust.audience],sub:'test-owner',type:'app',iat:now/1000-100,exp:now/1000+(mode==='expired'?-1:60)})}`;return`${body}.${sign('RSA-SHA256',Buffer.from(body),mode==='signature'?wrong.privateKey:key.privateKey).toString('base64url')}`;}
async function fixture(kind,target,{gate,adapt=true}={}){
 const auth=await candidateVerifier(root,kind,true),cache={'access-verifier':auth};
 if(gate){const original=auth.createAccessVerifier;auth.createAccessVerifier=t=>{const verify=original(t);return async(r,n)=>{await gate;return verify(r,n);};};}
 function load(name){if(cache[name])return cache[name];let s=sources[name];assert.ok(s,name);
  if(kind==='jose'&&adapt){
   const changes={'task-http':['const identity = verify(request, (options.clock ?? Date.now)());','const identity = await verify(request, (options.clock ?? Date.now)());'],'news-collection-http':['const identity = verify(request, clock()),','const identity = await verify(request, clock()),'],'private-process':['const identity = createAccessVerifier(trust)(request, clock());','const identity = await createAccessVerifier(trust)(request, clock());']};
   if(changes[name]){const[a,b]=changes[name];assert.equal(s.split(a).length,2);s=s.replace(a,b);}
  }
  const exports={};cache[name]=exports;const req=createRequire(new URL(`../../src/web/v1/${name}.ts`,import.meta.url));
  vm.runInContext(ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,vm.createContext({exports,Request,Response,URL,Date,TextDecoder,Uint8Array,AbortController,structuredClone,setTimeout,clearTimeout,require:p=>p.startsWith('./')&&(sources[p.slice(2)]||cache[p.slice(2)])?load(p.slice(2)):req(p)}));return exports;
 }
 let calls=0,dbCalls=0,closes=0;const identities=[];
 const observe=identity=>{calls++;assert.equal(typeof identity?.then,'undefined');assert.ok(Object.isFrozen(identity));assert.equal(identity.subject,'test-owner');identities.push(JSON.parse(JSON.stringify(identity)));};
 let handler,close=async()=>{};
 if(target==='task')handler=load('task-http').createTaskHttpHandler({origin,trust,clock:()=>now,service:{list:async identity=>{observe(identity);return{items:[],after:null};}}});
 if(target==='news')handler=load('news-collection-http').createNewsCollectionHttpHandler({origin,trust,projectId:project,clock:()=>now,planning:{propose:async identity=>{observe(identity);return{replayed:false};}},admission:{approve:async()=>{throw Error('unexpected approve');}}});
 if(target==='private'){
  const process=load('private-process').createPrivateWebProcess({origin,issuer:trust.issuer,audience:trust.audience,tenantId:'tenant:test',workspaceId:'workspace:test',maxSessionSeconds:3600,loadKeys:async()=>trust.keys,clock:()=>now,
   database:{client:{query:async()=>{dbCalls++;throw Error('DB forbidden');},transaction:async()=>{dbCalls++;throw Error('DB forbidden');},transactionWithPreCommitCheck:async()=>{dbCalls++;throw Error('DB forbidden');}},close:async()=>{closes++;}},
   ideaProjects:{integrityKey:new Uint8Array(32).fill(7)},ideaCreation:{tenantId:'tenant:test',workspaceId:'workspace:test',create:async()=>{throw Error('create forbidden');},options:async identity=>{observe(identity);return{startsWork:false,minParticipants:3,maxParticipants:6,requiredPerspectives:['skeptic'],participants:['skeptic','builder','operator'].map((p,i)=>({participantId:`participant:${i}`,participantDigest:'sha256:'+'a'.repeat(64),displayName:p,perspective:p,harness:'hermes'}))};}}});
  handler=r=>process.handle(r,()=>{throw Error('render forbidden');});close=()=>process.close();
 }
 return{handler,close,counts:()=>({calls,dbCalls,closes}),identities};
}
function request(target,mode){const path=target==='task'?`/api/v1/projects/${project}/tasks`:target==='news'?`/api/v1/projects/${encodeURIComponent(project)}/news/collection/propose`:'/api/v1/ideas/options';const post=target==='news';return new Request(origin+path,{method:post?'POST':'GET',headers:{...(mode==='missing'?{}:{'cf-access-jwt-assertion':token(mode)}),...(post?{origin,'content-type':'application/json'}:{})},...(post?{body:'{}'}:{})});}
const results=[];
for(const kind of ['jsonwebtoken','jose'])for(const target of ['task','news','private']){
 const f=await fixture(kind,target);
 try{for(const mode of ['valid','missing','signature','audience','expired']){
  const before=f.counts().calls,r=await f.handler(request(target,mode));assert.equal(r.status,mode==='valid'?(target==='news'?201:200):401,`${kind}/${target}/${mode}`);assert.equal(r.headers.get('cache-control'),'no-store');
  assert.equal(f.counts().calls-before,mode==='valid'?1:0);assert.equal(f.counts().dbCalls,0);
  if(mode!=='valid')assert.deepEqual(await r.json(),{error:'authentication_required'});
  results.push({kind,target,mode,status:r.status,serviceCalls:f.counts().calls-before});
 }}finally{await f.close();}
 assert.equal(f.counts().closes,target==='private'?1:0);
}
for(const target of ['task','news','private'])for(const mode of ['valid','signature']){
 let release;const gate=new Promise(r=>release=r),f=await fixture('jose',target,{gate});
 const pending=f.handler(request(target,mode));await new Promise(r=>setImmediate(r));assert.equal(f.counts().calls,0);
 release();const r=await pending;assert.equal(r.status,mode==='valid'?(target==='news'?201:200):401);assert.equal(f.counts().calls,mode==='valid'?1:0);await f.close();
 results.push({kind:'jose',target,mode:`held-${mode}`,status:r.status,...f.counts()});
}
console.log(JSON.stringify({scope:'Actual task/news/private-process plus key-cache and HTTP error modules; candidate verifier adaptations; synthetic services and fake pool; no DB, browser, listener or live identity. Other imported current modules execute but are not individually hash pinned.',pins,results,count:results.length,maxRssKiB:process.resourceUsage().maxRSS},null,2));
