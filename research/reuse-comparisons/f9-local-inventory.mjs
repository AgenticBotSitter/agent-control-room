// Read-only selected package/attribution inventory. No package code execution.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const hash = b => createHash('sha256').update(b).digest('hex');
const json = path => JSON.parse(readFileSync(path,'utf8'));
const root = json('package.json');
const old = json('docs/research/public-candidate-notice-reconciliation.json');
const direct = Object.entries({...root.dependencies,...root.devDependencies}).map(([name,version]) => {
  const base = join('node_modules',name), manifest = json(join(base,'package.json'));
  const notices = readdirSync(base).filter(n=>/^(licen[sc]e|notice|copying|copyright)(\.|$)/i.test(n))
    .filter(n=>!n.endsWith('.json')).map(file=>({file,sha256:hash(readFileSync(join(base,file)))}));
  const prior = old.entries.find(x=>x.name===name);
  return {name,declaredVersion:version,installedVersion:manifest.version,license:manifest.license??null,
    group:Object.hasOwn(root.dependencies,name)?'runtime':'development',rootNotices:notices,
    priorRecord:prior?{version:prior.version,manifestMatches:prior.manifestSha256===hash(readFileSync(join(base,'package.json')))}:null};
});
const vendor = readdirSync('src/vendor/control-center').filter(n=>n.endsWith('.ts')).map(file=>{
  const path=join('src/vendor/control-center',file),b=readFileSync(path);
  return {path,bytes:b.length,sha256:hash(b),noticeMentions:readFileSync('third_party/control-center/NOTICE.md','utf8').includes(file)};
});
const lockSha256=hash(readFileSync('pnpm-lock.yaml'));
const selectedXmlChildren=[['@nodable/entities','3.0.0'],['fast-xml-builder','1.3.1'],['is-unsafe','2.0.2'],['path-expression-matcher','1.6.2'],['strnum','2.4.2'],['xml-naming','0.3.0']].map(([name,version])=>{
  const base=join('node_modules/.pnpm',`${name.replace('/','+')}@${version}`,'node_modules',name),manifest=json(join(base,'package.json'));
  return {name,version:manifest.version,license:manifest.license,rootNotices:readdirSync(base).filter(n=>/^(licen[sc]e|notice|copying|copyright)(\.|$)/i.test(n)).map(file=>({file,sha256:hash(readFileSync(join(base,file)))}))};
});
console.log(JSON.stringify({schema:'control-room.f9.local-provenance/v1',scope:'Selected current direct manifests/root notices and vendor files; not transitive/bundle/distribution clearance',lockSha256,priorLockSha256:old.lockSha256,priorLockMatches:lockSha256===old.lockSha256,directCount:direct.length,priorDirectCount:old.directPackageCount,direct,selectedXmlChildren,vendor,retainedNotices:['third_party/control-center/LICENSE','third_party/control-center/NOTICE.md','third_party/rss-parser/LICENSE','third_party/rss-parser/NOTICE.md'].map(path=>({path,exists:existsSync(path),sha256:hash(readFileSync(path))})),downloads:0,packageCodeExecuted:false},null,2));
