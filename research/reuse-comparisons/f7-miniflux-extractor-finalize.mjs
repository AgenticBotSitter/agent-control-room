import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root='/private/tmp/cr-f7-miniflux-extractor.s3s5gY';
const evidence='docs/research/reuse-comparisons/f7-miniflux-extractor-runtime-evidence.json';
const receipt=JSON.parse(fs.readFileSync(evidence));
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const p=path.join(dir,e.name);return e.isDirectory()?walk(p):e.isFile()?[p]:[];});}
receipt.retainedDownloadCache=walk(path.join(root,'gomodcache/cache/download')).map(p=>{const b=fs.readFileSync(p);return{path:path.relative(root,p),bytes:b.length,sha256:sha(b)};});
receipt.localAllocatedKiB=Number(spawnSync('/usr/bin/du',['-sk',root],{encoding:'utf8'}).stdout.split(/\s/)[0]);
receipt.freeBytes=fs.statfsSync(root).bavail*fs.statfsSync(root).bsize;
receipt.runtimeLicenseFiles=['github.com/andybalholm/cascadia@v1.3.3/LICENSE','golang.org/x/net@v0.58.0/LICENSE','github.com/!puerkito!bio/goquery@v1.12.0/LICENSE'].map(p=>{const b=fs.readFileSync(path.join(root,'gomodcache',p));return{path:p,sha256:sha(b),text:b.toString()};});
receipt.upstreamTestPasses=receipt.commands.find(c=>c.args[0]==='test').stdout.trim().split('\n').map(JSON.parse).filter(e=>e.Action==='pass'&&e.Test).length;
receipt.actualExternalPackages=receipt.commands.find(c=>c.args[0]==='list').stdout.split('\n').filter(p=>p.startsWith('github.')||p.startsWith('golang.'));
receipt.authoredFixtureHashes=['research/reuse-comparisons/f7-miniflux-extractor-execute.mjs','research/reuse-comparisons/f7-miniflux-extractor-runner.go'].map(p=>({path:p,sha256:sha(fs.readFileSync(p))}));
if(receipt.localAllocatedKiB>4*1024*1024||receipt.freeBytes<20*1024**3)throw Error('storage bound');
fs.writeFileSync(evidence,JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({tests:receipt.upstreamTestPasses,allocatedKiB:receipt.localAllocatedKiB,downloads:receipt.retainedDownloadCache.length}));
