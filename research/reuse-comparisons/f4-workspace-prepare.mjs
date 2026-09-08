// Research-only packaging of unchanged pinned files; never run against a product checkout.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = process.argv[2];
if (!root?.startsWith('/private/tmp/control-room-f4-workspace.')) throw Error('owned root required');
const pinned = JSON.parse(fs.readFileSync(new URL('../../docs/research/reuse-comparisons/f4-workspace-acquisitions.json', import.meta.url)));
const files = fs.readdirSync(root).filter(n => n.startsWith('backend__') && n.endsWith('.go')).sort();
const expected=pinned.files.map(x=>x.path.replaceAll('/','__')).sort();
if(JSON.stringify(files)!==JSON.stringify(expected))throw Error('exact pinned file set mismatch');
const receipt = pinned.files.map(item => { const name=item.path.replaceAll('/','__'); const st=fs.lstatSync(path.join(root,name));if(!st.isFile()||st.isSymbolicLink())throw Error('source is not regular file');const data=fs.readFileSync(path.join(root,name));const hash=crypto.createHash('sha256').update(data).digest('hex');if(data.length!==item.bytes||hash!==item.sha256)throw Error('pinned source mismatch: '+item.path);return item; });
// Verify every byte before copying any source. An existing module could contain injected files.
if(fs.existsSync(path.join(root,'module')))throw Error('module already exists');
fs.mkdirSync(path.join(root,'module'),{recursive:true});
for (const item of receipt) {const target=path.join(root,'module',item.path.replace(/^backend\//,''));fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(root,item.path.replaceAll('/','__')),target);}
fs.writeFileSync(path.join(root,'module/go.mod'),'module github.com/aoagents/agent-orchestrator/backend\n\ngo 1.25.7\n');
for(const name of ['cache','modcache','tmp'])fs.mkdirSync(path.join(root,name),{recursive:true});
console.log(JSON.stringify({root,pin:'24e101914976a14145d7302f49626db3541ef8b5',files:receipt},null,2));
