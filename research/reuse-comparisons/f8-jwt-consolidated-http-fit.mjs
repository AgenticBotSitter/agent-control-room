// Research only: actual hash-pinned HTTP/auth modules, adapted in memory.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import {WebSessionAuthority} from '../../src/web/v1/session-authority.ts';
const root=process.argv[2];assert.match(root,/^\/private\/tmp\/cr-f8-jwt\.[A-Za-z0-9]+$/);
const req=createRequire(`${root}/package.json`),local=createRequire(import.meta.url);
const hash=b=>createHash('sha256').update(b).digest('hex');
const receipt=JSON.parse(readFileSync(new URL('../../docs/research/reuse-comparisons/f8-jwt-acquisitions.json',import.meta.url)));
for(const [file,digest] of Object.entries(receipt.files))assert.equal(hash(readFileSync(`${root}/node_modules/${file}`)),digest);
const jwt=req('jsonwebtoken'),jose=await import(pathToFileURL(`${root}/node_modules/jose/dist/webapi/index.js`).href);
const sourceHashes={'access-verifier':'b51bc1fcde7c6c1790bd46a6ed9f3544aa808456c7b966b51d232038c2472426','project-http':'8a824353ddf0b819b8c1f8c2e0d60bd8602b21909a1b8348c55bca34aedad7ff','http-common':'3d8372bf7b297d23e56a3578f7a979248acaf50f21c349ebd02de5292f4801a6'};
const sources=Object.fromEntries(Object.entries(sourceHashes).map(([name,digest])=>{const s=readFileSync(new URL(`../../src/web/v1/${name}.ts`,import.meta.url),'utf8');assert.equal(hash(s),digest);return[name,s];}));
function replaceOnce(s,from,to){assert.equal(s.split(from).length,2);return s.replace(from,to);}
function modules(kind,{awaitIdentity=true,gate=async()=>{}}={}){
 const cache={};
 const candidateHeader=kind==='jose'?token=>jose.decodeProtectedHeader(token):token=>jwt.decode(token,{complete:true})?.header;
 const candidate=kind==='jose'?async(token,key,nowMs,issuer,audience,maxAge)=>{await gate();return jose.jwtVerify(token,key,{algorithms:['RS256'],issuer,audience,currentDate:new Date(nowMs),requiredClaims:['iss','aud','sub','iat','exp'],maxTokenAge:maxAge,clockTolerance:0});}:(token,key,nowMs,issuer,audience,maxAge)=>jwt.verify(token,key,{algorithms:['RS256'],issuer,audience,clockTimestamp:nowMs/1000,maxAge,clockTolerance:0});
 function load(name){if(cache[name])return cache[name];let source=sources[name];assert.ok(source);
  if(name==='access-verifier'&&kind!=='current'){
   source=source.replace('createPublicKey, verify,','createPublicKey,');
   const decodeStart=source.indexOf('function decode('),decodeEnd=source.indexOf('/** Pure credential',decodeStart);
   assert.ok(decodeStart>0&&decodeEnd>decodeStart);
   source=source.slice(0,decodeStart)+'function validateSegment(value: string, utf8: boolean): void {\n if (!segment.test(value)) throw new Error();\n const bytes=Buffer.from(value,"base64url");\n if(bytes.toString("base64url")!==value)throw new Error();\n if(utf8)new TextDecoder("utf-8",{fatal:true}).decode(bytes);\n}\n'+source.slice(decodeEnd);
   source=replaceOnce(source,'const header = headerSchema.parse(decode(h));','validateSegment(h,true);validateSegment(c,true);validateSegment(s,false);\n const header=headerSchema.parse(candidateHeader(token));');
   const sigStart=source.indexOf('      const signature ='),sigEnd=source.indexOf('      const now = nowMs / 1000;',sigStart);
   assert.ok(sigStart>0&&sigEnd>sigStart);
   source=source.slice(0,sigStart)+'      const claims=claimsSchema.parse('+(kind==='jose'?'(await candidate(token,key,nowMs,expectedIssuer,audience,maxSessionSeconds)).payload':'candidate(token,key,nowMs,expectedIssuer,audience,maxSessionSeconds)')+');\n'+source.slice(sigEnd);
   assert.ok(!source.includes('JSON.parse(')&&!source.includes('verify("RSA-SHA256"'));

   if(kind==='jose')source=replaceOnce(source,'return (request: Request, nowMs: number): VerifiedWebIdentity =>','return async (request: Request, nowMs: number): Promise<VerifiedWebIdentity> =>');
  }
  if(name==='project-http'&&kind==='jose'&&awaitIdentity)source=replaceOnce(source,'const identity = verifyIdentity(request, clock());','const identity = await verifyIdentity(request, clock());');
  const exports={};cache[name]=exports;
  const context=vm.createContext({exports,candidate,candidateHeader,Buffer,TextDecoder,URL,Date,Request,Response,setTimeout,clearTimeout,require(spec){if(spec.startsWith('./'))return load(spec.slice(2));assert.ok(['node:crypto','zod'].includes(spec));return local(spec);}});
  vm.runInContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);return exports;
 }
 return {auth:load('access-verifier'),http:load('project-http')};
}
const primary=generateKeyPairSync('rsa',{modulusLength:2048}),rotated=generateKeyPairSync('rsa',{modulusLength:2048});
const now=1800000000000,sec=now/1000,origin='https://app.invalid';
const trust={issuer:'https://issuer.invalid',audience:'synthetic-audience',keys:[{kid:'one',jwk:primary.publicKey.export({format:'jwk'})}],validUntilMs:now+90000,maxSessionSeconds:3600};
const base={iss:trust.issuer,aud:[trust.audience],sub:'subject',type:'app',iat:sec-1,exp:sec+120};
function token(c=base,{kid='one',key=primary.privateKey,header={}}={}){const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url'),body=`${enc({alg:'RS256',typ:'JWT',kid,...header})}.${enc(c)}`;return `${body}.${sign('RSA-SHA256',Buffer.from(body),key).toString('base64url')}`;}
function request(tok,{url=origin+'/api/v1/projects',method='GET',headers={}}={}){return new Request(url,{method,headers:{...(tok?{'cf-access-jwt-assertion':tok}:{}),...headers}});}
function expectedIdentity(tok,c=base){const expiry=Math.min(c.exp,c.iat+trust.maxSessionSeconds);return{provider:trust.issuer,subject:c.sub,tokenDigest:`sha256:${hash(tok)}`,issuedAt:new Date(c.iat*1000).toISOString(),expiresAt:new Date(expiry*1000).toISOString(),verificationExpiresAt:new Date(Math.min(expiry*1000,trust.validUntilMs)).toISOString()};}
function fixture(kind,opts={}){let calls=0;const seen=[];const m=modules(kind,opts);const handler=m.http.createProjectHttpHandler({origin,trust:opts.trust??trust,clock:()=>opts.clock??now,service:{async listPage(identity){calls++;assert.equal(typeof identity?.then,'undefined','service must receive identity, not promise');assert.ok(Object.isFrozen(identity));seen.push(JSON.parse(JSON.stringify(identity)));return{items:[],after:null};}}});return{handler,m,calls:()=>calls,seen};}
const results=[];
const cases=[['valid',token(),200,undefined],['missing',null,401,'authentication_required'],['bad signature',token(base,{key:rotated.privateKey}),401,'authentication_required'],['wrong audience',token({...base,aud:['other']}),401,'authentication_required'],['missing subject',token({...base,sub:undefined}),401,'authentication_required'],['missing expiry',token({...base,exp:undefined}),401,'authentication_required'],['future issued',token({...base,iat:sec+1}),401,'authentication_required'],['max age exact',token({...base,iat:sec-3600}),401,'authentication_required'],['extra header',token(base,{header:{jku:'https://no-network.invalid'}}),401,'authentication_required']];
for(const kind of ['current','jsonwebtoken','jose']){
 const f=fixture(kind);
 for(const [name,tok,status,error] of cases){const before=f.calls(),r=await f.handler(request(tok));assert.equal(r.status,status,`${kind}/${name}`);if(error)assert.deepEqual(await r.json(),{error});assert.equal(f.calls()-before,status===200?1:0);assert.equal(r.headers.get('cache-control'),'no-store');if(status===200)assert.deepEqual(f.seen.at(-1),expectedIdentity(tok));results.push({kind,case:name,status,serviceCalls:f.calls()-before});}
 for(const [name,opts] of [['wrong origin',{url:'https://other.invalid/api/v1/projects'}],['cross site',{headers:{'sec-fetch-site':'cross-site'}}],['write without origin',{method:'POST'}]]){const before=f.calls(),r=await f.handler(request(token(),opts));assert.equal(r.status,403);assert.deepEqual(await r.json(),{error:'access_denied'});assert.equal(f.calls(),before);results.push({kind,case:name,status:403,serviceCalls:0});}
 for(const clock of [now+90000,NaN]){const g=fixture(kind,{clock}),r=await g.handler(request(token()));assert.equal(r.status,401);assert.deepEqual(await r.json(),{error:'authentication_required'});assert.equal(g.calls(),0);results.push({kind,case:Number.isNaN(clock)?'invalid clock':'expired trust',status:401,serviceCalls:0});}
 const newTrust={...trust,keys:[{kid:'two',jwk:rotated.publicKey.export({format:'jwk'})}]},g=fixture(kind,{trust:newTrust});
 const old=await g.handler(request(token()));assert.equal(old.status,401);assert.equal(g.calls(),0);
 const fresh=token(base,{kid:'two',key:rotated.privateKey}),r=await g.handler(request(fresh));assert.equal(r.status,200);assert.deepEqual(g.seen[0],expectedIdentity(fresh));results.push({kind,case:'new captured trust rejects old key accepts new',status:200,serviceCalls:g.calls()});
 // Captured old verifier remains pinned to old keys; rotation requires new trusted snapshot.
 const beforeOld=f.calls();assert.equal((await f.handler(request(fresh))).status,401);const oldDelta=f.calls()-beforeOld;assert.equal(oldDelta,0);results.push({kind,case:'old captured trust rejects new key',status:401,serviceCalls:oldDelta});
}
let release;const gate=new Promise(r=>release=r);const held=fixture('jose',{gate:()=>gate});const pending=held.handler(request(token(base,{key:rotated.privateKey})));await new Promise(r=>setTimeout(r,0));assert.equal(held.calls(),0);release();assert.equal((await pending).status,401);assert.equal(held.calls(),0);results.push({kind:'jose',case:'held verification denial never calls service',status:401,serviceCalls:0});
// Deliberately demonstrate the unadapted caller mismatch with a valid token only.
const negative=fixture('jose',{awaitIdentity:false});const response=await negative.handler(request(token()));assert.equal(response.status,503);assert.equal(negative.calls(),1);results.push({kind:'jose-unadapted-negative',case:'promise reached service without await',status:503,serviceCalls:1});
for(const [label,claims,currentTrust,elapsed,expectedCalls] of [
 ['trust expires during valid verify',base,trust,90000,0],
 ['token expires during valid verify',{...base,exp:sec+1},{...trust,validUntilMs:now+600000},1000,0],
 ['session age expires during valid verify',{...base,iat:sec-3599},trust,1000,0],
 ['fresh valid verify reaches transaction',base,trust,1,1],
]) {
 let releaseValid;const waitValid=new Promise(r=>releaseValid=r);
 const m=modules('jose',{gate:()=>waitValid});
 const verifying=m.auth.createAccessVerifier(currentTrust)(request(token(claims)),now);
 let transactions=0,operations=0;
 const db={transactionWithPreCommitCheck:async()=>{transactions++;throw Object.assign(new Error('synthetic transaction sentinel'),{code:'transaction_sentinel'});}};
 releaseValid();const identity=await verifying;
 const authority=new WebSessionAuthority(db,{tenantId:'tenant:synthetic',workspaceId:'workspace:synthetic'},()=>now+elapsed);
 await assert.rejects(authority.authenticated(identity,async()=>{operations++;}),{code:expectedCalls?'transaction_sentinel':'authentication_required'});
 assert.equal(transactions,expectedCalls);assert.equal(operations,0);
 results.push({kind:'jose-downstream-authority',case:label,transactions,operations});
}
console.log(JSON.stringify({scope:'Actual auth/project-http/http-common plus actual session-authority preflight; consolidated library parsing/verification and jose await; synthetic listPage and transaction sentinel; no DB/listener/live Access/bootstrap.',sourceHashes,versions:{jose:'6.2.12',jsonwebtoken:'9.0.3'},results,count:results.length,maxRssKiB:process.resourceUsage().maxRSS,appWrites:0},null,2));
