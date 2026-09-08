import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root='/private/tmp/cr-f7-miniflux-extractor.s3s5gY';
const out='docs/research/reuse-comparisons/f7-miniflux-extractor-runtime-evidence.json';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const receipt={root, scope:'isolated actual unchanged Miniflux pure package; no service',acquisitions:[],commands:[]};
function disk(){const s=fs.statfsSync(root);if(s.bavail*s.bsize<20*1024**3)throw Error('free disk bound');}
async function get(url,file,limit){disk();const r=await fetch(url);if(!r.ok)throw Error(`${r.status} ${url}`);const b=Buffer.from(await r.arrayBuffer());if(b.length>limit)throw Error('download cap');fs.writeFileSync(path.join(root,file),b);receipt.acquisitions.push({url,file,bytes:b.length,sha256:hash(b)});return b;}
const env={PATH:'/usr/bin:/bin',HOME:root,TMPDIR:root,GOPATH:path.join(root,'gopath'),GOCACHE:path.join(root,'gocache'),GOMODCACHE:path.join(root,'gomodcache'),GOTOOLCHAIN:'local',GOMAXPROCS:'2',CGO_ENABLED:'0',GOPROXY:'https://proxy.golang.org',GOSUMDB:'sum.golang.org'};
function run(exe,args,options={}){disk();const r=spawnSync(exe,args,{cwd:path.join(root,'module'),env,timeout:120000,maxBuffer:2*1024**2,encoding:'utf8',...options});receipt.commands.push({exe,args,status:r.status,signal:r.signal,error:r.error?.message,stdout:r.stdout,stderr:r.stderr});fs.writeFileSync(out,JSON.stringify(receipt,null,2)+'\n');if(r.status!==0)throw Error(`command failed ${args.join(' ')}`);return r.stdout;}
try {
 const retained=JSON.parse(fs.readFileSync(path.join(root,'receipt.json')));
 for(const f of retained.files)if(hash(fs.readFileSync(path.join(root,f.local)))!==f.sha256)throw Error('source hash mismatch');
 const corpus=fs.readFileSync('research/reuse-comparisons/f7-extraction-corpus.json');
 receipt.corpusSHA256=hash(corpus);
 if(receipt.corpusSHA256!=='4f7f0d52d377129144bcd2674c718f9ad5d8b77e1c165d7b804013e3cb172f6a')throw Error('corpus mismatch');
 const listing=JSON.parse(await get('https://go.dev/dl/?mode=json&include=all','go-downloads.json',5000000));
 const version=listing.find(x=>x.version==='go1.26.0');
 const artifact=version.files.find(x=>x.os==='darwin'&&x.arch==='arm64'&&x.kind==='archive');
 const tar=await get(`https://go.dev/dl/${artifact.filename}`,artifact.filename,150000000);
 if(hash(tar)!==artifact.sha256)throw Error('official toolchain checksum mismatch');
 receipt.toolchain=artifact;
 fs.mkdirSync(path.join(root,'module'),{recursive:true});
 run('/usr/bin/tar',['-xzf',path.join(root,artifact.filename),'-C',root]);
 const mod=path.join(root,'module');
 for(const name of ['internal/reader/readability/readability.go','internal/reader/readability/readability_test.go','internal/urllib/url.go']){const dest=path.join(mod,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(root,name.replaceAll('/','--')),dest);}
 fs.copyFileSync('research/reuse-comparisons/f7-miniflux-extractor-runner.go',path.join(mod,'main.go'));
 fs.writeFileSync(path.join(mod,'go.mod'),'module miniflux.app/v2\ngo 1.26.0\nrequire (\n github.com/PuerkitoBio/goquery v1.12.0\n golang.org/x/net v0.58.0\n github.com/andybalholm/cascadia v1.3.3\n)\n');
 const go=path.join(root,'go/bin/go');
 run(go,['version']);
 run(go,['mod','download','-json','all']);
 receipt.goSum=fs.readFileSync(path.join(mod,'go.sum'),'utf8');
 run(go,['test','-p','1','-parallel','1','-timeout','90s','-json','./internal/reader/readability']);
 run(go,['build','-p','1','-o',path.join(root,'extractor'),'.']);
 run(go,['list','-deps','.']);
 receipt.results=JSON.parse(run(path.join(root,'extractor'),[],{input:corpus}));
 receipt.completed=true;
}catch(error){receipt.failure=String(error);process.exitCode=1;}
finally {fs.writeFileSync(out,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({completed:receipt.completed,failure:receipt.failure,commands:receipt.commands.length}));}
