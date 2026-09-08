import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import crypto from 'node:crypto';
const root=process.argv[2];
if(!/^\/private\/tmp\/control-room-f4-workspace\.[A-Za-z0-9]+$/.test(root??''))throw Error('owned root required');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const pinned=JSON.parse(fs.readFileSync(new URL('../../docs/research/reuse-comparisons/f4-workspace-acquisitions.json',import.meta.url)));
// Reverify prepared source before compile, including no unlisted module files.
const expected=pinned.files.map(x=>x.path.replace(/^backend\//,''));
function walk(p,prefix=''){return fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>{if(e.isSymbolicLink())throw Error('symlink in module');const rel=prefix+e.name;return e.isDirectory()?walk(path.join(p,e.name),rel+'/'):[rel]})}
if(JSON.stringify(walk(root+'/module').sort())!==JSON.stringify([...expected,'go.mod'].sort()))throw Error('prepared file set mismatch');
for(const x of pinned.files){const b=fs.readFileSync(path.join(root,'module',x.path.replace(/^backend\//,'')));if(b.length!==x.bytes||sha(b)!==x.sha256)throw Error('prepared hash mismatch');}
const mod='module github.com/aoagents/agent-orchestrator/backend\n\ngo 1.25.7\n';if(fs.readFileSync(root+'/module/go.mod','utf8')!==mod)throw Error('module declaration mismatch');
const fixture=fs.readFileSync(new URL('./f4-workspace-local_test.go',import.meta.url));fs.writeFileSync(root+'/module/internal/adapters/workspace/gitworktree/controlroom_research_test.go',fixture,{flag:'wx'});
for(const d of ['home','cache','modcache','tmp'])fs.mkdirSync(root+'/'+d,{recursive:true});
// No inherited environment: in particular no GIT_DIR, WORK_TREE, INDEX_FILE,
// OBJECT_DIRECTORY, ALTERNATE_OBJECT_DIRECTORIES or CONFIG_PARAMETERS.
const env={PATH:'/usr/bin:/bin',HOME:root+'/home',TMPDIR:root+'/tmp',LANG:'C',LC_ALL:'C',GOTOOLCHAIN:'local',GOENV:'off',GOPROXY:'off',GOSUMDB:'off',GOWORK:'off',GOMAXPROCS:'2',GOMEMLIMIT:'256MiB',GOCACHE:root+'/cache',GOMODCACHE:root+'/modcache',CGO_ENABLED:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
const args=['test','-p','1','-timeout','40s','./internal/adapters/workspace/gitworktree','-run','^TestControlRoomOwnedPreservation$','-v'];
const start=Date.now();const r=spawnSync(root+'/go/bin/go',args,{cwd:root+'/module',env,encoding:'utf8',timeout:60000,maxBuffer:1024*1024,killSignal:'SIGKILL'});
const sanitize=s=>(s??'').replaceAll(root,'<owned-root>');
const result={capture:'direct child stdout/stderr/exit from retained launcher',pin:pinned.pin,fixtureSha256:sha(fixture),args,environment:Object.fromEntries(Object.entries(env).map(([k,v])=>[k,sanitize(v)])),elapsedMs:Date.now()-start,status:r.status,signal:r.signal,error:r.error?.code??null,stdout:sanitize(r.stdout),stderr:sanitize(r.stderr)};
fs.writeFileSync(root+'/run-receipt.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));process.exitCode=r.status===0?0:1;
