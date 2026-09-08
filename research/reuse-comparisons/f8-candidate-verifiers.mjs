// Shared research-only, hash-pinned actual candidate adapter. No application writes.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
export async function candidateVerifier(root,kind,moduleOutput=false){
 assert.match(root,/^\/private\/tmp\/cr-f8-jwt\.[A-Za-z0-9]+$/);
 assert.ok(['jose','jsonwebtoken'].includes(kind));
 const hash=b=>createHash('sha256').update(b).digest('hex'),local=createRequire(import.meta.url),req=createRequire(`${root}/package.json`);
 const receipt=JSON.parse(readFileSync(new URL('../../docs/research/reuse-comparisons/f8-jwt-acquisitions.json',import.meta.url)));
 for(const [file,digest] of Object.entries(receipt.files))assert.equal(hash(readFileSync(`${root}/node_modules/${file}`)),digest);
 const jwt=req('jsonwebtoken'),jose=await import(pathToFileURL(`${root}/node_modules/jose/dist/webapi/index.js`).href);
 let source=readFileSync(new URL('../../src/web/v1/access-verifier.ts',import.meta.url),'utf8');
 assert.equal(hash(source),'b51bc1fcde7c6c1790bd46a6ed9f3544aa808456c7b966b51d232038c2472426');
 const once=(from,to)=>{assert.equal(source.split(from).length,2,from);source=source.replace(from,to);};
 once('createPublicKey, verify,','createPublicKey,');
 const a=source.indexOf('function decode('),b=source.indexOf('/** Pure credential',a);assert.ok(a>0&&b>a);
 source=source.slice(0,a)+`function validateSegment(value: string, utf8: boolean): void {
 if(!segment.test(value))throw new Error();
 const bytes=Buffer.from(value,"base64url");
 if(bytes.toString("base64url")!==value)throw new Error();
 if(utf8)new TextDecoder("utf-8",{fatal:true}).decode(bytes);
}\n`+source.slice(b);
 once('const header = headerSchema.parse(decode(h));','validateSegment(h,true);validateSegment(c,true);validateSegment(s,false); const header=headerSchema.parse(candidateHeader(token));');
 const c=source.indexOf('      const signature ='),d=source.indexOf('      const now = nowMs / 1000;',c);assert.ok(c>0&&d>c);
 source=source.slice(0,c)+'      const claims=claimsSchema.parse('+(kind==='jose'?'(await candidate(token,key,nowMs,expectedIssuer,audience,maxSessionSeconds)).payload':'candidate(token,key,nowMs,expectedIssuer,audience,maxSessionSeconds)')+');\n'+source.slice(d);
 if(kind==='jose')once('return (request: Request, nowMs: number): VerifiedWebIdentity =>','return async (request: Request, nowMs: number): Promise<VerifiedWebIdentity> =>');
 assert.ok(!source.includes('JSON.parse(')&&!source.includes('verify("RSA-SHA256"'));
 const candidateHeader=kind==='jose'?t=>jose.decodeProtectedHeader(t):t=>jwt.decode(t,{complete:true})?.header;
 const candidate=kind==='jose'?(t,k,n,i,a,m)=>jose.jwtVerify(t,k,{algorithms:['RS256'],issuer:i,audience:a,currentDate:new Date(n),requiredClaims:['iss','aud','sub','iat','exp'],maxTokenAge:m,clockTolerance:0}):(t,k,n,i,a,m)=>jwt.verify(t,k,{algorithms:['RS256'],issuer:i,audience:a,clockTimestamp:n/1000,maxAge:m,clockTolerance:0});
 const exports={};vm.runInContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,vm.createContext({exports,candidateHeader,candidate,Buffer,TextDecoder,URL,Date,require:s=>{assert.ok(['node:crypto','zod'].includes(s));return local(s);}}));
 return moduleOutput?exports:exports.createAccessVerifier;
}
