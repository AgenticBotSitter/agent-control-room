import { readFileSync,writeFileSync,appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const manifest=JSON.parse(readFileSync('mutation-checks/cook-r5sdeny.json','utf8')).slice(-7);
const report=process.argv[2];
let active;
function restore(){if(active){writeFileSync(active.file,active.original);active=undefined;}}
process.once('exit',restore);
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{restore();process.exit(128);});
async function run(command){
 let output='';
 const child=spawn('/bin/sh',['-c',command],{stdio:['pipe','pipe','pipe']});
 child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>output+=data);
 let timedOut=false;
 const timer=setTimeout(()=>{timedOut=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},60000);
 const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 clearTimeout(timer);
 return {status,output,timedOut};
}
const baselines=new Set();let caught=0;
for(const [index,entry] of manifest.entries()){
 if(!baselines.has(entry.test)){
  const result=await run(entry.test);
  if(result.status!==0||result.timedOut){console.log('BASELINE FAIL',entry.test,result.output.slice(-6000));process.exit(1);}
  baselines.add(entry.test);console.log('BASELINE PASS',baselines.size);
 }
 const original=readFileSync(entry.file);
 if(original.toString().split(entry.find).length!==2)throw new Error('mutation_anchor_refused:'+entry.why);
 active={file:entry.file,original};
 try{
  writeFileSync(entry.file,original.toString().replace(entry.find,entry.replace));
  const result=await run(entry.test);
  if(result.status===0||result.timedOut||!result.output.includes('ERR_ASSERTION')){
   console.log('MUTATION UNPROVEN',index+1,entry.why,result.status,result.output.slice(-6000));process.exitCode=1;break;
  }
  caught++;console.log('CAUGHT',index+1,entry.why);
  appendFileSync(report,`\nMutation ${index+1}: caught - ${entry.why}.`);
 }finally{
  restore();if(!readFileSync(entry.file).equals(original))throw new Error('restore_refused');
 }
}
console.log('MUTATIONS',caught,'OF',manifest.length,'BASELINES',baselines.size,'RESTORED');
