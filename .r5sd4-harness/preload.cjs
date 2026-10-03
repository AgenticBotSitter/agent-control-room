const cp=require('node:child_process'),fs=require('node:fs'),util=require('node:util'),path=require('node:path');
const launcher=process.env.R5SD_GROUP_EXEC,record=process.env.R5SD_RECORD,preload=__filename;
const active=new Set();
const native=cp.ChildProcess.prototype.spawn;
function recordPid(pid){if(pid)fs.appendFileSync(record,JSON.stringify({pid})+'\n');}
function kill(pid){try{process.kill(-pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')fs.appendFileSync(record,JSON.stringify({cleanup:e.code,pid})+'\n');}}
process.once('exit',()=>{for(const pid of active)kill(pid);});
cp.ChildProcess.prototype.spawn=function(options){
  const original=options.file,args=options.args.slice(1);
  if(['curl','wget'].includes(path.basename(original))&&args.some(a=>/^https?:\/\//.test(a)&&!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?:[:/]|$)/.test(a)))throw new Error('external_download_refused');
  options.file=launcher;options.args=[launcher,original,...args];options.detached=false;
  if(options.stdio==='ignore')options.stdio=['pipe','ignore','ignore'];
  else if(Array.isArray(options.stdio)&&options.stdio[0]==='ignore')options.stdio=['pipe',...options.stdio.slice(1)];
  const extra={NODE_OPTIONS:'--require='+preload,R5SD_GROUP_EXEC:launcher,R5SD_RECORD:record,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1',CONTROL_ROOM_TEST_PID_RECORD:record};
  options.envPairs=options.envPairs.filter(x=>!Object.keys(extra).some(k=>x.startsWith(k+'='))).concat(Object.entries(extra).map(([k,v])=>k+'='+v));
  const result=native.call(this,options);
  if(this.pid){recordPid(this.pid);active.add(this.pid);this.once('close',()=>{kill(this.pid);active.delete(this.pid);});}
  return result;
};
for(const name of ['spawnSync','execFileSync']){
  const orig=cp[name];
  cp[name]=function(file,args,options){
    if(!Array.isArray(args)){options=args;args=[];}
    options={...options,detached:false};
    options.env={...(options.env||process.env),NODE_OPTIONS:'--require='+preload,R5SD_GROUP_EXEC:launcher,R5SD_RECORD:record,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1',CONTROL_ROOM_TEST_PID_RECORD:record};
    let result;
    try{result=orig.call(cp,launcher,[file,...args],options);return result;}
    finally{if(result?.pid){recordPid(result.pid);kill(result.pid);}}
  };
}
if(process.argv.some(arg=>/setInterval\(\(\)=>\{\},\s*1000\)/.test(arg))){process.stdin.resume();process.stdin.on('end',()=>process.exit(0));}
const nativeFetch=globalThis.fetch;
if(nativeFetch)globalThis.fetch=function(input,...rest){const u=new URL(typeof input==='string'?input:input.url??input);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))return Promise.reject(new Error('external_download_refused'));return nativeFetch(input,...rest);};
require('node:module').syncBuiltinESMExports();
