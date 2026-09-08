import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const cwd=process.cwd();
const root=await fs.mkdtemp('/private/tmp/cr-f9-staging.');
const app=path.join(root,'app');await fs.mkdir(app);
const receipt={root,status:'preparing',sourceFiles:[],dependencyFiles:0,dependencyBytes:0,symlinks:0};
const output='docs/research/reuse-comparisons/f9-staging-acquisitions.json';
const save=()=>fs.writeFile(output,JSON.stringify(receipt,null,2)+'\n');await save();
const digest=b=>createHash('sha256').update(b).digest('hex');
async function copy(rel,dependency=false){
 const source=path.join(cwd,rel),dest=path.join(app,rel),stat=await fs.lstat(source);
 assert.ok(!['.env','.npmrc','.git','.codex','.agents'].some(x=>rel.split('/').includes(x))&&!path.basename(rel).startsWith('.env'));
 if(stat.isDirectory()){await fs.mkdir(dest,{recursive:true});for(const name of await fs.readdir(source))await copy(path.join(rel,name),dependency);}
 else if(stat.isSymbolicLink()){
  assert.ok(dependency);let target=await fs.readlink(source);
  if(path.isAbsolute(target)){assert.ok(target===cwd+'/node_modules'||target.startsWith(cwd+'/node_modules/'));target=path.relative(path.dirname(dest),path.join(app,path.relative(cwd,target)))||'.';}
  const resolved=path.resolve(path.dirname(dest),target);assert.ok(resolved===app+'/node_modules'||resolved.startsWith(app+'/node_modules/'));
  await fs.symlink(target,dest);receipt.symlinks++;
 }else{assert.ok(stat.isFile());await fs.mkdir(path.dirname(dest),{recursive:true});await fs.copyFile(source,dest);
  const copied=await fs.stat(dest);assert.ok(stat.ino!==copied.ino||stat.dev!==copied.dev,'independent_inode');
  if(dependency){receipt.dependencyFiles++;receipt.dependencyBytes+=stat.size;}else receipt.sourceFiles.push({path:rel,bytes:stat.size,sha256:digest(await fs.readFile(dest))});}
}
try{
 for(const rel of ['src','private-app','styles/control-room.css','app/components/connection-center.tsx','app/components/project-catalog.tsx','app/components/project-catalog-navigation.tsx','app/components/project-create-form.tsx','public/favicon.svg','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','next.config.ts','postcss.config.mjs','vite.vps.config.ts'])await copy(rel);
 await copy('node_modules',true);
 async function verify(dir){for(const name of await fs.readdir(dir)){const p=path.join(dir,name),s=await fs.lstat(p);if(s.isSymbolicLink()){const r=await fs.realpath(p);assert.ok(r===app+'/node_modules'||r.startsWith(app+'/node_modules/'));}else if(s.isDirectory())await verify(p);}}
 await verify(app+'/node_modules');
 for(const name of ['empty-env','cache','tmp','plugin'])await fs.mkdir(root+'/'+name);
 const old=JSON.parse(await fs.readFile('docs/research/reuse-comparisons/f9-plugin-acquisitions.json'));
 await fs.writeFile(root+'/plugin/package-lock.json',JSON.stringify(old.lock));
 await fs.writeFile(root+'/plugin/package.json',JSON.stringify({name:old.lock.name,private:true,dependencies:old.lock.packages[''].dependencies}));
 receipt.status='staged_no_build';receipt.pluginPriorLockSha256=digest(Buffer.from(JSON.stringify(old.lock)));await save();console.log(JSON.stringify({root,status:receipt.status,dependencyBytes:receipt.dependencyBytes,dependencyFiles:receipt.dependencyFiles,sourceFiles:receipt.sourceFiles.length,symlinks:receipt.symlinks}));
}catch(e){receipt.status='failed';receipt.failure=e.message;await save();throw e;}
