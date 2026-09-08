// Research-only source adaptation. No candidate library, connection, or credential use.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {createAccessVerifier} from '../../src/web/v1/access-verifier.ts';
import {sha256Digest, assertNoSecretMaterial} from '../../src/security/index.ts';
import {localId, digestSchema} from '../../src/harness/v1/native-run-identifiers.ts';
import {validatePrivatePostgresConfiguration} from '../../src/web/v1/private-postgres.ts';
import {candidateVerifier} from './f8-candidate-verifiers.mjs';

const candidateKind=process.argv[3];
const verifyFactory=process.argv[2]?await candidateVerifier(process.argv[2],candidateKind):createAccessVerifier;

const local=createRequire(import.meta.url),hash=s=>createHash('sha256').update(s).digest('hex');
const pins={'private-owner-bootstrap':'a562fe42b7010de891ac411ac782eb93543259184befb2b150d4743a1a024e39','access-verifier':'b51bc1fcde7c6c1790bd46a6ed9f3544aa808456c7b966b51d232038c2472426'};
for(const [name,digest] of Object.entries(pins))assert.equal(hash(readFileSync(new URL(`../../src/web/v1/${name}.ts`,import.meta.url))),digest);
const original=readFileSync(new URL('../../src/web/v1/private-owner-bootstrap.ts',import.meta.url),'utf8');
function once(s,from,to){assert.equal(s.split(from).length,2,from);return s.replace(from,to);}
const now=1800000000000,keys=generateKeyPairSync('rsa',{modulusLength:2048});
const trust={issuer:'https://issuer.invalid',audience:'synthetic',keys:[{kid:'one',jwk:keys.publicKey.export({format:'jwk'})}],validUntilMs:now+10000,maxSessionSeconds:3600};
const config={databaseName:'synthetic',tenantId:'tenant:test',workspaceId:'workspace:test',identityId:'identity:test',grantId:'grant:test',displayName:'Synthetic owner',expectedOwnerSubjectDigest:sha256Digest({provider:trust.issuer,subject:'test-owner'})};
function token(subject='test-owner'){
 const enc=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
 const body=`${enc({alg:'RS256',kid:'one'})}.${enc({iss:trust.issuer,aud:[trust.audience],sub:subject,type:'app',iat:now/1000-1,exp:now/1000+60})}`;
 return `${body}.${sign('RSA-SHA256',Buffer.from(body),keys.privateKey).toString('base64url')}`;
}

function fixture(kind,{onVerify=async()=>{},onAfterWork=()=>{}}={}){
 let current=now,verifications=0,transactions=0,writes=0,commits=0,opens=0,closes=0;
 const abort=new AbortController();
 const clock=()=>current;
 const state={advance:()=>{current=now+10000;},cancel:()=>abort.abort(),counts:()=>({verifications,transactions,writes,commits,opens,closes})};
 const factory=t=>{
  const verify=verifyFactory(t);
  if(kind==='sync')return(req,time)=>{verifications++;return verify(req,time);};
  return async(req,time)=>{const identity=await verify(req,time);verifications++;await onVerify(verifications,state);return identity;};
 };
 let source=original;
 if(kind!=='sync'&&kind!=='unadapted'){
  source=once(source,'function verifyPinnedOwner(','async function verifyPinnedOwner(');
  source=once(source,'request: Request, now: number) {','request: Request, now: number, freshness: () => number, signal?: AbortSignal) {');
  source=once(source,'const identity = verify(request, now);','const identity = await verify(request, now);'+(kind==='fresh'||kind==='discard-precommit'?`
  const after = freshness();
  if (signal?.aborted || !Number.isSafeInteger(after) || after < now
    || Date.parse(identity.issuedAt) > after || Date.parse(identity.expiresAt) <= after
    || Date.parse(identity.verificationExpiresAt) <= after) throw new Error("private_owner_bootstrap_failed");`:''));
  source=once(source,'const current = () => {','const current = async () => {');
  source=once(source,'const identity = verifyPinnedOwner(verify, config, request, now);','const identity = await verifyPinnedOwner(verify, config, request, now, clock, signal);');
  source=once(source,'current(); // Invalid','await current(); // Invalid');
  source=once(source,'        current();','        await current();');
  source=once(source,'const { identity, now } = current();','const { identity, now } = await current();');
  if(kind!=='discard-precommit')source=once(source,'}, () => { current(); });','}, () => current());');
  source=once(source,'      verifyPinnedOwner(createAccessVerifier(trust), config,','      await verifyPinnedOwner(createAccessVerifier(trust), config,');
  source=once(source,"}), clock());","}), clock(), clock, signal);");
 }
 const database={async transactionWithPreCommitCheck(work,check){
  transactions++;
  const tx={async query(sql){
   if(sql.includes('current_database'))return{rows:[{database_name:config.databaseName}]};
   if(sql.includes('FROM tenants'))return{rows:[{id:config.tenantId}]};
   if(sql.includes('FROM workspaces'))return{rows:[{id:config.workspaceId}]};
   throw new Error('unexpected synthetic SQL');
  }};
  const result=await work(tx);onAfterWork(state);await check();commits++;return result;
 }};
 const exports={};
 const security={sha256Digest,assertNoSecretMaterial,SecurityStore:class{async bootstrapOwner(){writes++;}}};
 const context=vm.createContext({exports,Request,structuredClone,Date,AbortSignal,require(spec){
  if(spec==='zod')return local(spec);
  if(spec==='../../security')return security;
  if(spec==='../../harness/v1/native-run-identifiers')return{localId,digestSchema};
  if(spec==='./access-verifier')return{createAccessVerifier:factory};
  if(spec==='./private-postgres')return{validatePrivatePostgresConfiguration,createPrivatePostgresDatabase:()=>{throw new Error('physical connection forbidden');}};
  throw new Error(`unexpected import ${spec}`);
 }});
 vm.runInContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
 const bridge=()=>exports.createPrivateOwnerBootstrap(config,trust,{database,clock});
 const command=exports.createPrivateOwnerBootstrapCommand({clock,openDatabase(){opens++;return{client:database,close:async()=>{closes++;}};}});
 return{...state,bridge,signal:abort.signal,command:subject=>command({configuration:config,trust,database:{host:'127.0.0.1',port:5432,database:'synthetic',username:'synthetic',password:'synthetic-not-used',majorVersion:17},assertion:token(subject)},abort.signal)};
}
const results=[];
for(const kind of (candidateKind==='jose'?['await-only','fresh']:['sync','await-only','fresh'])){
 for(const mode of ['valid','wrong-owner','expired','cancelled','precommit-expiry','precommit-cancel']){
  const f=fixture(kind,{onAfterWork:s=>{if(mode==='precommit-expiry')s.advance();if(mode==='precommit-cancel')s.cancel();}});
  if(mode==='expired')f.advance();if(mode==='cancelled')f.cancel();
  const pending=f.bridge().bootstrap(token(mode==='wrong-owner'?'other':'test-owner'),f.signal);
  if(mode==='valid')assert.equal((await pending).ownerCreated,true);else await assert.rejects(pending,/private_owner_bootstrap_failed/);
  const counts=f.counts();assert.equal(counts.commits,mode==='valid'?1:0);
  if(['wrong-owner','expired','cancelled'].includes(mode))assert.equal(counts.transactions,0);
  results.push({kind,mode,...counts});
 }
}
for(const kind of ['await-only','fresh'])for(const at of [1,4]){
 const f=fixture(kind,{onVerify:async(n,s)=>{if(n===at)s.advance();}});
 const pending=f.bridge().bootstrap(token(),f.signal);
 // Without a post-await check, early expiry is caught at the next boundary but final expiry commits.
 const unsafe=kind==='await-only'&&at===4;
 if(unsafe)await pending;else await assert.rejects(pending,/private_owner_bootstrap_failed/);
 assert.equal(f.counts().commits,unsafe?1:0);
 assert.equal(f.counts().transactions,at===1?(kind==='fresh'?0:1):1);
 results.push({kind,mode:`expiry-during-verification-${at}`,negativeControl:unsafe,...f.counts()});
}
for(const kind of ['await-only','fresh']){
 const f=fixture(kind,{onVerify:async(n,s)=>{if(n===1)s.advance();}});
 await assert.rejects(f.command(),/private_owner_bootstrap_failed/);
 assert.equal(f.counts().opens,kind==='fresh'?0:1);assert.equal(f.counts().closes,f.counts().opens);
 results.push({kind,mode:'expiry-during-command-preflight',...f.counts()});
}
const unadapted=fixture('unadapted');await assert.rejects(unadapted.bridge().bootstrap(token()),/private_owner_bootstrap_failed/);
assert.equal(unadapted.counts().transactions,0);results.push({kind:'unadapted',mode:'valid-identity-promise-refused',...unadapted.counts()});
for(const kind of (candidateKind==='jose'?['fresh']:['sync','fresh'])){
 const f=fixture(kind);assert.equal((await f.command()).databaseClosed,true);
 assert.equal(f.counts().opens,1);assert.equal(f.counts().closes,1);assert.equal(f.counts().commits,1);
 results.push({kind,mode:'valid-command-control',...f.counts()});
}
for(const kind of ['await-only','fresh']){
 const f=fixture(kind,{onVerify:async(n,s)=>{if(n===4)s.cancel();}});
 const pending=f.bridge().bootstrap(token(),f.signal);
 if(kind==='fresh')await assert.rejects(pending,/private_owner_bootstrap_failed/);else await pending;
 assert.equal(f.counts().commits,kind==='fresh'?0:1);
 results.push({kind,mode:'cancel-during-final-verification',negativeControl:kind==='await-only',...f.counts()});
}
let release;const held=new Promise(r=>release=r);
const discarded=fixture('discard-precommit',{onVerify:async n=>{if(n===4)await held;}});
await discarded.bridge().bootstrap(token());assert.equal(discarded.counts().commits,1);
results.push({kind:'discard-precommit',mode:'commits-with-final-verification-held',negativeControl:true,...discarded.counts()});
release();await new Promise(r=>setImmediate(r));
console.log(JSON.stringify({scope:`Actual hash-pinned owner-bootstrap control flow; ${candidateKind??'Node crypto'} verifier with synthetic signed JWT and optional async delay. SecurityStore and transactions are counters, not real persistence. ${candidateKind?'Actual pinned library executes within CR policy adapter.':'Neither jose nor jsonwebtoken executed in this experiment.'}`,candidate:candidateKind??'current',pins,results,count:results.length,resources:{maxRssKiB:process.resourceUsage().maxRSS,downloads:0,connections:0,appWrites:0}},null,2));
