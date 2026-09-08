// Research-only source adaptation. No network, provider, key store or files written.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { createAccessVerifier } from '../../src/web/v1/access-verifier.ts';
const root=process.argv[2]; assert.match(root,/^\/private\/tmp\/cr-f8-jwt\.[A-Za-z0-9]+$/);
const receipt=JSON.parse(readFileSync(new URL('../../docs/research/reuse-comparisons/f8-jwt-acquisitions.json',import.meta.url)));
const hash=b=>createHash('sha256').update(b).digest('hex');
for(const [f,h] of Object.entries(receipt.files))assert.equal(hash(readFileSync(`${root}/node_modules/${f}`)),h);
const req=createRequire(`${root}/package.json`), localRequire=createRequire(import.meta.url);
const jwt=req('jsonwebtoken'), jose=await import(pathToFileURL(`${root}/node_modules/jose/dist/webapi/index.js`).href);
assert.equal(req('jsonwebtoken/package.json').version,'9.0.3');assert.equal(req('jose/package.json').version,'6.2.12');
const source=readFileSync(new URL('../../src/web/v1/access-verifier.ts',import.meta.url),'utf8');
assert.equal(hash(source),'b51bc1fcde7c6c1790bd46a6ed9f3544aa808456c7b966b51d232038c2472426');
const signatureCall='verify("RSA-SHA256", Buffer.from(`${h}.${c}`), key, signature)';
assert.equal(source.split(signatureCall).length,2);
function mapped(kind){
  let adapted=source.replace(signatureCall,kind==='jose'?'(await candidate(token, key, nowMs, expectedIssuer, audience), true)':'(candidate(token, key, nowMs, expectedIssuer, audience), true)');
  if(kind==='jose')adapted=adapted.replace('return (request: Request, nowMs: number): VerifiedWebIdentity =>','return async (request: Request, nowMs: number): Promise<VerifiedWebIdentity> =>');
  const exports={};
  const candidate=kind==='jose'?(token,key,nowMs,issuer,audience)=>jose.jwtVerify(token,key,{algorithms:['RS256'],issuer,audience,currentDate:new Date(nowMs),clockTolerance:0}):(token,key,nowMs,issuer,audience)=>jwt.verify(token,key,{algorithms:['RS256'],issuer,audience,clockTimestamp:nowMs/1000,clockTolerance:0});
  const context=vm.createContext({exports,candidate,Buffer,TextDecoder,URL,Date,require(name){assert.ok(['node:crypto','zod'].includes(name));return localRequire(name);}});
  vm.runInContext(ts.transpileModule(adapted,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,context);
  return exports.createAccessVerifier;
}
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const other=generateKeyPairSync('rsa',{modulusLength:2048});
const now=1_800_000_000_000, seconds=now/1000;
const trust={issuer:'https://issuer.invalid',audience:'synthetic-audience',keys:[{kid:'synthetic-key',jwk:publicKey.export({format:'jwk'})}],validUntilMs:now+600000,maxSessionSeconds:3600};
const header={alg:'RS256',typ:'JWT',kid:'synthetic-key'};
const claims={iss:trust.issuer,aud:[trust.audience],sub:'synthetic-subject',type:'app',iat:seconds-10,exp:seconds+500};
const encode=x=>Buffer.from(JSON.stringify(x)).toString('base64url');
function token(c=claims,h=header,key=privateKey){const body=`${encode(h)}.${encode(c)}`;return `${body}.${sign('RSA-SHA256',Buffer.from(body),key).toString('base64url')}`;}
const tests=[
 ['valid',token(),true],['wrong signature',token(claims,header,other.privateKey),false],
 ['wrong issuer',token({...claims,iss:'https://other.invalid'}),false],['wrong audience',token({...claims,aud:['other']}),false],
 ['string audience',token({...claims,aud:trust.audience}),false],['missing subject',token({...claims,sub:undefined}),false],
 ['wrong token type',token({...claims,type:'service'}),false],['missing expiry',token({...claims,exp:undefined}),false],
 ['expired',token({...claims,exp:seconds}),false],['future issued',token({...claims,iat:seconds+1}),false],
 ['future not before',token({...claims,nbf:seconds+1}),false],['fractional issued',token({...claims,iat:seconds-.5}),false],
 ['session age boundary',token({...claims,iat:seconds-3600}),false],['unknown key',token(claims,{...header,kid:'other'}),false],
 ['extra header',token(claims,{...header,jku:'https://untrusted.invalid/keys'}),false],['no typ',token(claims,{alg:'RS256',kid:'synthetic-key'}),true],
 ['wrong algorithm',token(claims,{...header,alg:'RS512'}),false],['overlong token','x'.repeat(16385),false],
 ['padded signature',token()+'=',false],['malformed','bad.parts.here',false],['absent',null,false],
];
const variants={current:createAccessVerifier(trust),jsonwebtoken:mapped('jsonwebtoken')(trust),jose:mapped('jose')(trust)};
const results=[], timings={};
for(const [name,verify] of Object.entries(variants)){
 const start=performance.now();
 for(const [caseName,tok,expected] of tests){const r=new Request('https://app.invalid/api/v1/projects',{headers:tok?{'cf-access-jwt-assertion':tok}:{}});let accepted=false,identity;try{identity=await verify(r,now);accepted=true;}catch(e){assert.equal(e.code,'authentication_required');}assert.equal(accepted,expected,`${name}: ${caseName}`);if(expected){assert.equal(identity.subject,claims.sub);assert.equal(identity.tokenDigest,`sha256:${hash(tok)}`);assert.equal(identity.expiresAt,new Date((seconds+500)*1000).toISOString());}results.push({variant:name,case:caseName,accepted});}
 const r=new Request('https://app.invalid',{headers:{'cf-access-jwt-assertion':token()}});
 for(const t of [trust.validUntilMs,NaN]){await assert.rejects(async()=>verify(r,t));results.push({variant:name,case:t===trust.validUntilMs?'trust expired':'invalid clock',accepted:false});}
 timings[name]={cases:tests.length+2,elapsedMs:performance.now()-start};
}
const raw=[];
for(const [label,c] of [['string audience',{...claims,aud:trust.audience}],['missing subject',{...claims,sub:undefined}],['wrong token type',{...claims,type:'service'}],['missing expiry',{...claims,exp:undefined}],['future issued',{...claims,iat:seconds+1}]]){
 for(const [name,fn] of Object.entries({jsonwebtoken:()=>jwt.verify(token(c),publicKey,{algorithms:['RS256'],issuer:trust.issuer,audience:trust.audience,clockTimestamp:seconds}),jose:()=>jose.jwtVerify(token(c),publicKey,{algorithms:['RS256'],issuer:trust.issuer,audience:trust.audience,currentDate:new Date(now)})})){let accepted=false;try{await fn();accepted=true;}catch{/* Record rejection without retaining token/error material. */}raw.push({variant:name,case:label,accepted});assert.equal(accepted,true);}
}
console.log(JSON.stringify({scope:'Actual package verification through hash-pinned current verifier adapted only at signature call; synthetic in-memory keys. No HTTP handler, DB, live Access or whole-application acceptance.',versions:{jose:'6.2.12',jsonwebtoken:'9.0.3'},results,rawWithoutPolicy:raw,timings,parentMaxRssKiB:process.resourceUsage().maxRSS,applicationFilesChanged:0},null,2));
