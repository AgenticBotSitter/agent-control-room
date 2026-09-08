// Disposable synthetic graph, actual installed npm SBOM/list commands, no installs.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
const root=process.argv[2];assert.match(root,/^\/private\/tmp\/cr-f9-tools\.[A-Za-z0-9]+$/);const npm=fs.realpathSync('/Users/alastairfraser/.local/bin/npm');const source=path.resolve(path.dirname(npm),'../lib/commands/sbom.js');const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
// Known local macOS installation only; reject changed identity before execution.
assert.equal(hash(npm),'8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7');assert.equal(hash(source),'5399da11d6b51a261f2292d1a0bd4f7a279d7c4f265278791f28ff5c0231b810');
const npmVersion=JSON.parse(fs.readFileSync(path.resolve(path.dirname(npm),'../package.json'))).version;assert.equal(npmVersion,'10.9.8');
const fixture=path.join(root,'fixture');fs.mkdirSync(fixture);function write(rel,obj){const p=path.join(fixture,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof obj==='string'?obj:JSON.stringify(obj));}
write('package.json',{name:'fixture',version:'1.0.0',license:'MIT',dependencies:{used:'1.0.0',unused:'1.0.0'}});
for(const n of ['used','unused']){write(`node_modules/${n}/package.json`,{name:n,version:'1.0.0',license:'MIT'});write(`node_modules/${n}/LICENSE`,'Synthetic fixture full text marker');}
const env={PATH:path.dirname(process.execPath)+':/usr/bin:/bin',HOME:root,TMPDIR:root,npm_config_userconfig:'/dev/null',npm_config_cache:root+'/cache',npm_config_offline:'true',npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false'};
const run=args=>{const r=spawnSync(process.execPath,[npm,...args],{cwd:fixture,env,encoding:'utf8',timeout:15000,maxBuffer:1e6});return{status:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr};};
const sbom=run(['sbom','--sbom-format=cyclonedx']);assert.equal(sbom.status,0,sbom.stderr);const bom=JSON.parse(sbom.stdout);assert.deepEqual(bom.components.map(c=>c.name).sort(),['unused','used']);assert.equal(sbom.stdout.includes('Synthetic fixture full text marker'),false);
const list=run(['ls','--all','--json']);assert.equal(list.status,0);assert.deepEqual(Object.keys(JSON.parse(list.stdout).dependencies).sort(),['unused','used']);
fs.rmSync(path.join(fixture,'node_modules/used'),{recursive:true});const missing=run(['sbom','--sbom-format=cyclonedx']);assert.notEqual(missing.status,0);assert.match(missing.stderr,/missing|ESBOMPROBLEMS/i);
console.log(JSON.stringify({npmVersion,npmCliSha256:hash(npm),sbomSourceSha256:hash(source),cases:['actual npm lists both installed dependencies including unused','actual CycloneDX metadata output omits full license text','missing required dependency refuses'],sbom,list,missing},null,2));
