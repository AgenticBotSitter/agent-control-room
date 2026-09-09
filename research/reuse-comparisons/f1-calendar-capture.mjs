import{execFileSync}from'node:child_process';import{writeFileSync,readFileSync}from'node:fs';import{createHash}from'node:crypto';
const script='research/reuse-comparisons/f1-calendar-fit.mjs';
const result={command:'node --import tsx f1-calendar-fit.mjs; sterile PATH and TZ=UTC',harnessSha256:createHash('sha256').update(readFileSync(script)).digest('hex')};
try{result.actualStdout=execFileSync(process.execPath,['--import','tsx',script],{env:{PATH:'/usr/bin:/bin',TZ:'UTC'},encoding:'utf8',timeout:30000,maxBuffer:1000000});result.exitCode=0;result.parsed=JSON.parse(result.actualStdout);}
catch(e){result.exitCode=e.status;result.signal=e.signal;result.actualStdout=String(e.stdout??'');result.actualStderr=String(e.stderr??'');}
writeFileSync('docs/research/reuse-comparisons/f1-calendar-evidence.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({exitCode:result.exitCode,cases:result.parsed?.caseCount}));if(result.exitCode!==0)process.exitCode=1;
