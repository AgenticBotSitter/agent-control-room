import fs from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import path from 'node:path';
import {createHash} from 'node:crypto';
const file='docs/research/reuse-comparisons/f3-renderer-acquisitions.json',r=JSON.parse(await fs.readFile(file,'utf8')),root=r.root;
if(root!=='/private/tmp/cr-f3-renderer.XRtXHb'||r.install.stopped!=='cohort cap'||r.resumedInstall)throw Error('wrong state');
const lock=await fs.readFile(root+'/selected/package-lock.json');if(createHash('sha256').update(lock).digest('hex')!==r.install.lockSha256)throw Error('lock mismatch');
const available=Number(execFileSync('/bin/df',['-k',root],{encoding:'utf8'}).trim().split('\n').at(-1).split(/\s+/)[3]);if(available<20*1024*1024)throw Error('free floor');
let peak=0,output='',stopped=null;const child=spawn(path.join(path.dirname(process.execPath),'npm'),r.install.args,{cwd:root+'/selected',env:{PATH:path.dirname(process.execPath)+':/usr/bin:/bin',HOME:root+'/home',TMPDIR:root,CI:'true'},stdio:['ignore','pipe','pipe']});
const collect=b=>{output+=b;if(output.length>65536){stopped='output';child.kill();}};child.stdout.on('data',collect);child.stderr.on('data',collect);
function sample(){const n=Number(execFileSync('/usr/bin/du',['-sk',root],{encoding:'utf8'}).split(/\s/)[0]);peak=Math.max(peak,n);if(n>204800){stopped='200MiB cap';child.kill();}return n;}
const timer=setTimeout(()=>{stopped='60s';child.kill();},60000),interval=setInterval(sample,1000);const terminal=await new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));clearInterval(interval);clearTimeout(timer);
r.resumedInstall={authorization:'root explicitly raised exact cohort to200MiB; unchanged global4GiB/free20GiB',availableKiB:available,terminal,stopped,output,finalKiB:sample(),sampledPeakKiB:peak};await fs.writeFile(file,JSON.stringify(r,null,2));console.log(JSON.stringify(r.resumedInstall));
