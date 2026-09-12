import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,lstatSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root='/private/tmp/cr-f2-hermes-session.FNPCGw';
// Identical receipt capture after first successful readout was truncated by its UI budget.
// Only the exact experiment-created fixture subtree is removed; source/target stay intact.
if(lstatSync(`${root}/fixture`).isSymbolicLink())throw Error('unexpected symlink');
rmSync(`${root}/fixture`,{recursive:true});
const script='research/reuse-comparisons/f2-hermes-session-fit.py';
const result={command:'sterile-python -I -B f2-hermes-session-fit.py <owned>',harnessSha256:createHash('sha256').update(readFileSync(script)).digest('hex'),firstRun:{exitCode:0,caseCount:12,readout:'Full JSON not retained because initial tool output limit truncated it; this identical capture is the evidence below.'}};
try{result.actualStdout=execFileSync('/Users/alastairfraser/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',['-I','-B',script,root],{encoding:'utf8',timeout:30000,maxBuffer:1000000,env:{PATH:'/usr/bin:/bin',TMPDIR:root}});result.exitCode=0;result.parsed=JSON.parse(result.actualStdout);}
catch(error){result.exitCode=error.status;result.actualStdout=String(error.stdout??'');result.actualStderr=String(error.stderr??'');}
writeFileSync('docs/research/reuse-comparisons/f2-hermes-session-evidence.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({exitCode:result.exitCode,caseCount:result.parsed?.caseCount}));
if(result.exitCode!==0)process.exitCode=1;
