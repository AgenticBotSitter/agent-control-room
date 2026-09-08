import {readFileSync,readdirSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
export const entitiesRoot=path.resolve('node_modules/.pnpm/entities@2.2.0/node_modules/entities');
export function inventory(){
 const packages=[],seen=new Set();
 function packageRoot(name,from){
  const req=createRequire(path.join(from,'package.json'));let entry;
  for(const search of req.resolve.paths(name)??[]){const candidate=path.join(search,name);try{if(JSON.parse(readFileSync(path.join(candidate,'package.json'),'utf8')).name===name)return realpathSync(candidate);}catch{}}
  try{entry=req.resolve(name+'/package.json');}catch{entry=req.resolve(name);}
  let dir=path.dirname(realpathSync(entry));
  while(dir!==path.dirname(dir)){try{if(JSON.parse(readFileSync(path.join(dir,'package.json'),'utf8')).name===name)return dir;}catch{}dir=path.dirname(dir);}
  throw Error('package root missing '+name);
 }
 function visit(root){root=realpathSync(root);if(seen.has(root))return;seen.add(root);
  const meta=JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')),files=[];
  function walk(dir){for(const entry of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(entry.name==='node_modules')continue;const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('unexpected package content symlink');if(entry.isDirectory())walk(file);else if(entry.isFile())files.push({file:path.relative(root,file),sha256:hash(file)});}}
  walk(root);packages.push({name:meta.name,version:meta.version,license:meta.license,files});
  for(const name of Object.keys(meta.dependencies??{}).sort())visit(packageRoot(name,root));
 }
 for(const root of [path.resolve('node_modules/rss-parser'),path.resolve('node_modules/fast-xml-parser'),entitiesRoot])visit(root);
 const sources=['src/project-adapters/abs-news/v1/feed-decoder.ts','src/vendor/control-center/sitemap.ts','src/vendor/control-center/source-reader.ts','src/vendor/control-center/freshness.ts','src/vendor/control-center/feed-discovery.ts','src/vendor/control-center/industry-curation.ts','pnpm-lock.yaml'].map(file=>({file,sha256:hash(file)}));
 return{packages:packages.sort((a,b)=>a.name.localeCompare(b.name)),sources};
}
export function verify(){
 const expected=JSON.parse(readFileSync('docs/research/reuse-comparisons/f7-parser-decision-pins.json','utf8'));
 const current=inventory();
 if(JSON.stringify(current)!==JSON.stringify(expected))throw Error('pinned source/dependency identity mismatch');
 for(const [name,version] of [['rss-parser','3.13.0'],['fast-xml-parser','5.11.0'],['entities','2.2.0']])if(!current.packages.some(p=>p.name===name&&p.version===version))throw Error('required exact version missing');
 return{packages:current.packages.map(({name,version})=>({name,version})),sourceCount:current.sources.length,hashedPackageFiles:current.packages.reduce((n,p)=>n+p.files.length,0)};
}
if(process.argv.includes('--capture'))console.log(JSON.stringify(inventory(),null,2));
