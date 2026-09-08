import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const owned=process.argv[2];assert.match(owned,/^\/private\/tmp\/cr-f9-runtime-text\.[A-Za-z0-9]+$/);const hash=b=>createHash('sha256').update(b).digest('hex'),json=p=>JSON.parse(fs.readFileSync(p));
const impl=owned+'/node_modules/@cyclonedx/cyclonedx-library/dist.node/contrib/license/utils.node.js';assert.equal(hash(fs.readFileSync(impl)),'10a3bc2b7855dcfe85e8f3943d8bd2c512875d2cded34bc7df9ab51544891b36');
const {Utils:{LicenseEvidenceGatherer}}=createRequire(owned+'/package.json')('@cyclonedx/cyclonedx-library/Contrib/License');
const checked=json('docs/research/reuse-comparisons/f9-runtime-exceptions-evidence.json');assert.equal(checked.exitCode,0);const checks=checked.output.results;assert.equal(checks.length,4);
const embedded=json('docs/research/embedded-runtime-notice-texts.json').entries,upstream=json('docs/research/pinned-upstream-notice-texts.json').entries;
const primary=json('docs/research/reuse-comparisons/f9-runtime-text-evidence.json').actualStdout;const missing=primary.results.filter(r=>!r.gathered.length);assert.equal(missing.length,4);const results=[];
for(const entry of checks){const target=missing.find(x=>x.name===entry.package&&x.version===entry.version);assert.ok(target);let text;
 if(entry.package==='@nodable/entities')text=fs.readFileSync(entry.retainedIn);else text=Buffer.from((entry.package==='postgres'?upstream:embedded).find(x=>x.package===entry.package&&x.version===entry.version).text);
 assert.equal(hash(text),entry.textSha256);const dir=path.join(owned,'staged',entry.package.replaceAll('/','-'));fs.mkdirSync(dir,{recursive:true});const license=path.join(dir,'LICENSE');fs.writeFileSync(license,text,{flag:'wx'});
 const guard=p=>{assert.equal(path.dirname(p),dir);assert.ok(!fs.lstatSync(p).isSymbolicLink());assert.ok(fs.lstatSync(p).size<=2e6);return p;};
 const collector=new LicenseEvidenceGatherer({fs:{readdirSync:p=>{assert.equal(p,dir);return fs.readdirSync(p);},statSync:p=>fs.lstatSync(guard(p)),readFileSync:p=>fs.readFileSync(guard(p))}});const attachments=[...collector.getFileAttachments(dir,e=>{throw e;})];assert.equal(attachments.length,1);const bytes=Buffer.from(attachments[0].text.content,'base64');assert.deepEqual(bytes,text);
 results.push({...entry,stagedFilename:'LICENSE',collectedBytes:bytes.length,collectedSha256:hash(bytes),byteIdentical:true});
}
const names=new Set([...primary.results.filter(x=>x.gathered.length).map(x=>x.name),...results.map(x=>x.package)]);assert.equal(names.size,39);
console.log(JSON.stringify({scope:'Actual public gatherer consumes four explicitly staged retained texts; no package source edits or generic license discovery.',defaultPackagesWithText:35,defaultMissingPreserved:missing.map(x=>x.name),exceptionPackages:results.length,totalIdentityCoverage:names.size,totalTextFiles:primary.textFileCount+results.length,implementationSha256:hash(fs.readFileSync(impl)),results},null,2));
