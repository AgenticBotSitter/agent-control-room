// Revalidate four already-retained notice exceptions; no new discovery or downloads.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=p=>fs.readFileSync(p),json=p=>JSON.parse(read(p));
const graph=json('docs/research/reuse-comparisons/f9-prepared-licenses-evidence.json');
const records=Object.values(graph.actualStdout).flat();
function installed(name,version){const item=records.find(p=>p.name===name);assert.ok(item);assert.deepEqual(item.versions,[version]);assert.equal(item.paths.length,1);const marker='/node_modules/';const at=item.paths[0].indexOf(marker);assert.ok(at>0);const dir=path.resolve('.'+item.paths[0].slice(at));const real=fs.realpathSync(dir);assert.ok(real.startsWith(path.resolve('node_modules')+path.sep));const p=json(path.join(real,'package.json'));assert.equal(p.name,name);assert.equal(p.version,version);return real;}
const results=[];
for(const entry of json('docs/research/embedded-runtime-notice-texts.json').entries){
 assert.ok(['pg-types','pgpass'].includes(entry.package));const dir=installed(entry.package,entry.version);
 const full=read(path.join(dir,entry.file));assert.equal(hash(full),entry.readmeSha256);assert.equal(hash(read(path.join(dir,'package.json'))),entry.manifestSha256);
 assert.equal(hash(entry.text),entry.noticeSha256);assert.ok(full.includes(Buffer.from(entry.text)));
 results.push({package:entry.package,version:entry.version,kind:'installed_README_section',file:entry.file,sourceSha256:entry.readmeSha256,textSha256:entry.noticeSha256,bytes:Buffer.byteLength(entry.text),currentSourceMatches:true,retainedIn:'docs/research/embedded-runtime-notice-texts.json'});
}
const upstream=json('docs/research/pinned-upstream-notice-texts.json');
const postgres=upstream.entries.find(p=>p.package==='postgres');assert.ok(postgres);installed(postgres.package,postgres.version);assert.equal(hash(postgres.text),postgres.sha256);assert.equal(Buffer.byteLength(postgres.text),postgres.bytes);
results.push({package:'postgres',version:postgres.version,kind:'retained_upstream_release_text',textSha256:postgres.sha256,bytes:postgres.bytes,commit:postgres.commit,currentInstalledVersionMatches:true,wholePackageSourceCorrespondence:'not_proven_by_this_check',retainedIn:'docs/research/pinned-upstream-notice-texts.json'});
const receipt=json('docs/research/reuse-comparisons/f9-entities-source-receipt.json'),dir=installed('@nodable/entities','3.0.0');
const matching=receipt.files.filter(f=>f.localMatch===true);assert.equal(matching.length,8);
for(const file of matching){assert.ok(file.path.startsWith('Entity/'));assert.equal(hash(read(path.join(dir,file.path.slice(7)))),file.sha256);}
const license=receipt.files.find(f=>f.path==='LICENSE'),text=read('docs/research/reuse-comparisons/f9-entities-MIT.txt');assert.equal(hash(text),license.sha256);assert.equal(text.length,license.bytes);
results.push({package:'@nodable/entities',version:'3.0.0',kind:'retained_upstream_text_with_matching_code',codeFilesMatched:matching.length,textSha256:license.sha256,bytes:text.length,commit:receipt.pin,sourceManifestDiscrepancy:'upstream manifest2.2.0 versus installed3.0.0 remains explicit; prior source acquisition evidence, not reacquired',retainedIn:'docs/research/reuse-comparisons/f9-entities-MIT.txt'});
assert.deepEqual(results.map(r=>r.package+'@'+r.version).sort(),['@nodable/entities@3.0.0','pg-types@2.2.0','pgpass@1.0.5','postgres@3.4.7'].sort());
console.log(JSON.stringify({scope:'Four known notice exceptions revalidated against current installed identities, retained checksums and applicable source bytes. No generic walker, tool candidate execution, legal clearance or distribution assembly.',results,count:results.length,downloads:0,appWrites:0},null,2));
