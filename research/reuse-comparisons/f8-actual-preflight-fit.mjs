// Research only. Execute pinned existing fixtures with actual candidate modules.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createHash,generateKeyPairSync} from 'node:crypto';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';import vm from 'node:vm';import ts from 'typescript';
const root=process.argv[2];assert.match(root,/^\/private\/tmp\/cr-f8-jwt\.[A-Za-z0-9]+$/);const hash=b=>createHash('sha256').update(b).digest('hex');
const pins={
 'research/reuse-comparisons/f8-rehearsal-await-fit.mjs':'a4b27b0186797e9d632541f25ac5ad8797a13559f9f36ac7eb0bb0d5294efe07',
 'research/reuse-comparisons/f8-key-cache-boundary.test.ts':'3cbcaf8e915c0a330b0b95e8b907134a1e84c0e123b44e910d3545941f75b86e',
 'src/web/v1/access-key-cache.ts':'957522108a0c0f8b0bb6d9e363dbd071e16a5a7159133e84a54b8ae7d9fbf0e9',
 'research/reuse-comparisons/f8-candidate-verifiers.mjs':'4f339a23862d3dd0fa8539cd3b891f35c56f7ef22e79d46698e32384ae770add'};
for(const [p,h]of Object.entries(pins))assert.equal(hash(readFileSync(p)),h);
const {candidateVerifier}=await import('./f8-candidate-verifiers.mjs');const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;const output=[];
for(const kind of ['jsonwebtoken','jose']){
 const auth=await candidateVerifier(root,kind,true);const cacheFile=pathToFileURL(process.cwd()+'/src/web/v1/access-key-cache.ts'),req=createRequire(cacheFile);const cacheExports={};
 vm.runInContext(ts.transpileModule(readFileSync(cacheFile,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,vm.createContext({exports:cacheExports,structuredClone,AbortController,setTimeout,clearTimeout,URL,require:p=>p==='./access-verifier'?auth:req(p)}));
 const callbacks=[];let cacheFixture=readFileSync('research/reuse-comparisons/f8-key-cache-boundary.test.ts','utf8').replace(/^import .*;\n/gm,'');
 const cacheJs=ts.transpileModule(cacheFixture,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('assert','generateKeyPairSync','test','createAccessKeyCache',cacheJs)(assert,generateKeyPairSync,(name,run)=>callbacks.push({name,run}),cacheExports.createAccessKeyCache);
 const cacheResults=[];for(const {name,run}of callbacks){await run();cacheResults.push({name,status:'passed'});}assert.equal(cacheResults.length,13);
 const {now,trust,request,token}=req('../../../tests/helpers/web-foundation.ts');
 const cache=cacheExports.createAccessKeyCache({issuer:trust.issuer,audience:trust.audience,maxSessionSeconds:trust.maxSessionSeconds,clock:()=>now,loadKeys:async()=>trust.keys});const verification=[];
 try{const loaded=await cache.get();const verify=auth.createAccessVerifier(loaded);for(const [mode,changes]of [['valid',{}],['wrong-issuer',{iss:'https://other.invalid'}],['expired',{exp:now/1000-1}]]){let accepted=false;try{await verify(request('/api/v1/projects','GET',undefined,undefined,token(changes)),now);accepted=true;}catch{}assert.equal(accepted,mode==='valid');verification.push({mode,accepted});}}finally{cache.close();}
 let rehearsal=readFileSync('research/reuse-comparisons/f8-rehearsal-await-fit.mjs','utf8').replace(/^import .*;\n/gm,'');
 rehearsal=rehearsal.replace("new URL('../../src/web/v1/private-database-rehearsal.ts', import.meta.url)",JSON.stringify(pathToFileURL(process.cwd()+'/src/web/v1/private-database-rehearsal.ts').href));
 rehearsal=rehearsal.replace("const auth = require('./access-verifier.ts');",'// Actual candidate module supplied by outer fixture.');
 let receipt;await new AsyncFunction('assert','readFileSync','createHash','createRequire','vm','ts','auth','console',rehearsal)(assert,p=>readFileSync(typeof p==='string'&&p.startsWith('file:')?new URL(p):p,'utf8'),createHash,p=>createRequire(p),vm,ts,auth,{log:text=>{assert.equal(receipt,undefined);receipt=JSON.parse(text);}});
 assert.equal(receipt.results.length,7);output.push({kind,cacheFixture:cacheResults,cacheActualTokenVerification:verification,rehearsal:{...receipt,scope:'Actual candidate verifier after held gate, actual await-adapted rehearsal control flow; fake clocks and fail-on-open DB/probe sentinels; no DB or provider'}});
}
console.log(JSON.stringify({base:'af6bcb4',node:process.version,pins,scope:'Both actual pinned JWT libraries across current cache and researched awaited rehearsal; 13 cache cases +3 actual cached-key token cases +7 held rehearsal cases per candidate. Invalid key admission is current CR factory policy, not library verification.',results:output},null,2));
