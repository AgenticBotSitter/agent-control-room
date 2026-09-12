import fs from 'node:fs/promises';
import {execFileSync,spawn} from 'node:child_process';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
const available=Number(execFileSync('/bin/df',['-k','.'],{encoding:'utf8'}).trim().split('\n').at(-1).split(/\s+/)[3])*1024;
if(available<20*1024**3)throw Error('storage floor');
const root=await fs.mkdtemp('/private/tmp/cr-f3-minimal-');
const dependencies={'react':'19.2.6','react-dom':'19.2.6','react-markdown':'10.1.0','remark-gfm':'4.0.1','jsdom':'26.1.0'};
await fs.mkdir(join(root,'home'));await fs.mkdir(join(root,'cache'));
await fs.writeFile(join(root,'package.json'),JSON.stringify({name:'cr-research-minimal-markdown',version:'0.0.0',private:true,dependencies}));
await fs.writeFile(join(root,'empty.npmrc'),'');
await fs.writeFile(join(root,'global.npmrc'),'');
const receipt={root,availableBeforeBytes:available,dependencies,scope:'isolated script-disabled research; no application dependency changes',status:'prepared'};
const save=()=>fs.writeFile(join(root,'acquisition.json'),JSON.stringify(receipt,null,2));await save();
console.log(JSON.stringify(receipt));
const child=spawn(join(dirname(process.execPath),'npm'),['install','--ignore-scripts','--no-audit','--no-fund','--omit=optional','--fetch-retries=0','--fetch-timeout=15000','--cache',join(root,'cache'),'--userconfig',join(root,'empty.npmrc'),'--globalconfig',join(root,'global.npmrc')],
 {cwd:root,env:{PATH:dirname(process.execPath)+':/usr/bin:/bin',HOME:join(root,'home'),TMPDIR:root,CI:'true'},stdio:['ignore','pipe','pipe']});
let output='',reason;
const stop=why=>{reason??=why;child.kill('SIGTERM');};
for(const s of [child.stdout,child.stderr])s.on('data',b=>{output+=b;if(output.length>65536)stop('output cap');});
const timer=setTimeout(()=>stop('60s deadline'),60000);
const monitor=setInterval(()=>{if(Number(execFileSync('/usr/bin/du',['-sk',root],{encoding:'utf8'}).split(/\s/)[0])>131072)stop('128MiB cohort cap');},1000);
const terminal=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',(code,signal)=>resolve({code,signal}));});
clearTimeout(timer);clearInterval(monitor);
Object.assign(receipt,{terminal,reason,output,allocatedKiB:Number(execFileSync('/usr/bin/du',['-sk',root],{encoding:'utf8'}).split(/\s/)[0]),status:'terminal'});
try{const lock=await fs.readFile(join(root,'package-lock.json'));receipt.lockSha256=createHash('sha256').update(lock).digest('hex');receipt.packages=JSON.parse(lock).packages;}catch{}
await save();console.log(JSON.stringify({root,terminal,reason,allocatedKiB:receipt.allocatedKiB,output}));
if(terminal.code!==0||reason)process.exitCode=1;
