import{execFileSync}from'node:child_process';import{readFileSync,writeFileSync}from'node:fs';import{createHash}from'node:crypto';
const script='research/reuse-comparisons/f1-calendar-previous-fit.mjs',result={command:'node f1-calendar-previous-fit.mjs; sterile TZ=UTC',harnessSha256:createHash('sha256').update(readFileSync(script)).digest('hex')};
try{result.actualStdout=execFileSync(process.execPath,[script],{env:{PATH:'/usr/bin:/bin',TZ:'UTC'},encoding:'utf8',timeout:10000,maxBuffer:100000});result.exitCode=0;result.parsed=JSON.parse(result.actualStdout);}catch(e){result.exitCode=e.status;result.actualStderr=String(e.stderr??'');}
writeFileSync('docs/research/reuse-comparisons/f1-calendar-previous-evidence.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
