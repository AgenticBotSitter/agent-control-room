import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const root=process.argv[2];assert.match(root,/^\/private\/tmp\/cr-f9-staging\.[A-Za-z0-9]+$/);
const app=root+'/app', require=createRequire(app+'/package.json');
const hash=b=>createHash('sha256').update(b).digest('hex');
const pluginPath=root+'/plugin/node_modules/rollup-plugin-license/dist/index.js';
assert.equal(hash(await fs.readFile(pluginPath)),'4b9b0a5b186701f7eb0e56edf993dcb337cd1aa2a3b671ebcd7859e9ea517e25');
const vitePath=require.resolve('vite');assert.ok((await fs.realpath(vitePath)).startsWith(app+'/node_modules/'));
assert.equal(hash(await fs.readFile(vitePath)),'9b3e72282cfda2f0e60ad5b123e2c8a89e27b9b7cc7c892ae7b34036db5f92ef');
assert.equal(hash(await fs.readFile(app+'/node_modules/vinext/dist/index.js')),'f17b6ef12f2f7341c7a07f92274d38bca70fb623c1af2691604405a92da67ff5');
const ts=require('typescript'), original=await fs.readFile(app+'/vite.vps.config.ts','utf8');
await fs.writeFile(app+'/f9-config.mjs',ts.transpileModule(original,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
const {default:config}=await import(pathToFileURL(app+'/f9-config.mjs'));
const {createBuilder,perEnvironmentPlugin}=await import(pathToFileURL(vitePath));
const license=require(pluginPath), environments={}, outputs=[];
const receipt={scope:'actual staged Control Room Vite client/RSC/SSR build, no application runtime/prerender',status:'starting',environments,outputs};
const save=()=>fs.writeFile(root+'/build-evidence.json',JSON.stringify(receipt,null,2)+'\n');await save();
config.plugins.push(perEnvironmentPlugin('f9-license-per-environment',environment=>{
 assert.ok(['client','rsc','ssr'].includes(environment.name));
 const name=environment.name;environments[name]={callbacks:[],modules:[],externals:[]};
 const plugin=license({cwd:app,thirdParty:{includePrivate:true,includeSelf:true,output:{file:root+'/notice-'+name+'.json',template:deps=>{
  const records=deps.map(d=>({name:d.name,version:d.version,license:d.license,licenseTextBytes:d.licenseText?Buffer.byteLength(d.licenseText):0,licenseTextSha256:d.licenseText?hash(d.licenseText):null,noticeTextSha256:d.noticeText?hash(d.noticeText):null}));
  environments[name].callbacks.push(records);return JSON.stringify(deps.map(d=>({name:d.name,version:d.version,license:d.license,licenseText:d.licenseText,noticeText:d.noticeText})),null,2);
 }}}});
 return [plugin,{name:'f9-observe-'+name,generateBundle(_options,bundle){
  for(const o of Object.values(bundle)){outputs.push({environment:name,fileName:o.fileName,type:o.type});if(o.type==='chunk'){environments[name].modules.push(...Object.keys(o.modules).map(id=>id.startsWith(app)?id.slice(app.length+1):id));environments[name].externals.push(...o.imports.filter(x=>!x.startsWith('.')&&!x.startsWith('/')));}}
 }}];
}));
try{
 const builder=await createBuilder({...config,root:app,mode:'production',configFile:false,envFile:false,envDir:root+'/empty-env',cacheDir:root+'/cache/vite',logLevel:'warn'});
 assert.deepEqual(Object.keys(builder.environments).sort(),['client','rsc','ssr']);
 for(const env of Object.values(builder.environments))assert.ok(path.resolve(app,env.config.build.outDir).startsWith(app+'/'));
 await builder.buildApp();receipt.status='built';
 for(const e of Object.values(environments)){e.modules=[...new Set(e.modules)].sort();e.externals=[...new Set(e.externals)].sort();}
 await save();console.log(JSON.stringify({status:receipt.status,environments:Object.fromEntries(Object.entries(environments).map(([k,v])=>[k,{callbacks:v.callbacks.length,records:v.callbacks.map(x=>x.length),modules:v.modules.length}])),outputs:outputs.length}));
}catch(e){receipt.status='failed';receipt.failure=e.message;await save();throw e;}
