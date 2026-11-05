import assert from "node:assert/strict";
import test from "node:test";
import { execFile,execFileSync } from "node:child_process";
import { mkdir,mkdtemp,readFile,writeFile,rm,symlink } from "node:fs/promises";
import { resolve,join } from "node:path";
import { promisify } from "node:util";
import { assertGuardBites } from "./support/attack-kit/index";
const exec=promisify(execFile),root=resolve("."),file="src/web/v1/improve-control-room-loop-finalization.ts";
const probes=[
  {name:"current binding",find:"!same(await input.authorize(),target)",replace:"false",pattern:"B3c current binding admission forbids publication",assertion:"B3c forbidden binding publication count is zero"},
  {name:"terminal quiescence before custody",find:'if(!["candidate_ready","failed","stopped"].includes(o.outcome)||inspected.termination?.state!=="already-ended"){',replace:'if(false){',pattern:"B3c uncertain admission never starts custody",assertion:"B3c forbidden quiescent admission custody count is zero"},
  {name:"late owner freshness",file:"src/web/v1/improve-control-room-loop-service.ts",find:'    const raw=await c.readRecord(binding);\n    if(!equal(binding,await authorize()))throw unavailable();',replace:'    const raw=await c.readRecord(binding);',pattern:"B3c late revoked owner clears lifecycle result",assertion:"B3c late protected lifecycle row count is zero"},
  {name:"verified retained corpus",find:"await c.retain(b,o.inventoryDigest)",replace:'{schemaVersion:1,binding:b,inventoryDigest:o.inventoryDigest,retentionDigest:sha256Digest("MUTANT"),verifiedAt:o.observedAt}',pattern:"B3c retention verification forbids publication and announcement",assertion:"B3c missing corpus publication count is zero"},
  {name:"phase one destructive refusal",find:'      if(record!.phase==="announced"){',replace:'      await (c as unknown as {stopOwned?:()=>Promise<void>}).stopOwned?.();\n      if(record!.phase==="announced"){',pattern:"B3c destructive callbacks are never invoked",assertion:"B3c sentinel destructive callback count is zero"},
  {name:"cleanup custody re-verification",find:'          await retain();await active();',replace:'          await active();',pattern:"B3c cleanup before custody re-verification is forbidden",assertion:"B3c cleanup before custody re-verify count is zero"},
  {name:"exclusive generation fence",find:"return await c.withFence(first.observation.binding,async()=>{",replace:"return await (async (_binding:unknown,work:()=>Promise<unknown>)=>work())(first.observation.binding,async()=>{",pattern:"B3c duplicate finalizers enter retention once",assertion:"B3c one finalizer alone reaches two custody verifications"},
  {name:"publisher receipt binding",find:`  if(o.outcome!=="candidate_ready"||p.projectId!==b.projectId||p.requestId!==b.requestId||p.runLinkId!==b.runLinkId
    ||p.localVersion!==b.localVersion||!same(p.a2InputVersion,b.inputVersion)||p.engineRevision!==b.expectedRevision
    ||p.completionDigest!==o.completionDigest||p.retentionDigest!==retentionDigest)throw unavailable();`,replace:'  if(false)throw unavailable();',pattern:"B3c forged publisher receipt never creates finish",assertion:"B3c forged publisher finish count is zero"},
];
test("B3c finalization guard mutations bite independently and restore green",{timeout:290000},async t=>{
  await mkdir(resolve(".test-tmp"),{recursive:true});const copy=await mkdtemp(resolve(".test-tmp/b3c-mutations-"));
  try{
    execFileSync("git",["-c","core.hooksPath=/dev/null","clone","--local","--no-hardlinks","--quiet",root,copy],{timeout:120000});
    await symlink(join(root,"node_modules"),join(copy,"node_modules"),"dir");
    // Mutations must exercise the current implementation before it is committed.
    for(const path of [file,"src/web/v1/improve-control-room-loop-service.ts","src/web/v1/improve-control-room-loop-recovery.ts","tests/improve-control-room-loop-finalization.test.tsx"])
      await writeFile(join(copy,path),await readFile(join(root,path)));
    for(const p of probes)await t.test(p.name,async()=>{
      const cmd=[process.execPath,"scripts/run-tests-with-quarantine.mjs","--import","tsx","--test",`--test-name-pattern=^${p.pattern}$`,"tests/improve-control-room-loop-finalization.test.tsx"];
      const targetFile=p.file??file;
      const original=await readFile(join(copy,targetFile),"utf8");
      const result=await assertGuardBites({root:copy,file:targetFile,find:p.find,replace:p.replace,testCmd:cmd,boundMs:40000,allowDirtyTree:true,because:p.assertion});
      assert.equal(result.applied,true);assert.equal(result.exitCode,1);assert.equal(result.signal,null);
      assert.ok(result.output.includes(p.assertion),`B3c loaded mutant reached intended assertion: ${p.assertion}`);
      assert.match(result.output,/ERR_ASSERTION/u);assert.match(result.output,/# fail 1/u);
      assert.doesNotMatch(result.output,/SyntaxError|# skipped [1-9]|# tests 0|timed out|migration_altered:/iu);
      assert.equal(await readFile(join(copy,targetFile),"utf8"),original);
      const env:NodeJS.ProcessEnv={...process.env,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:"1"};delete env.NODE_TEST_CONTEXT;
      const restored=await exec(cmd[0]!,cmd.slice(1),{cwd:copy,env,timeout:40000,maxBuffer:4*1024*1024});
      assert.match(restored.stdout,/# pass 1/u);assert.match(restored.stdout,/# fail 0/u);assert.doesNotMatch(restored.stdout,/# skipped [1-9]|# tests 0/u);
      console.log(`B3c mutation ${p.name}: baseline=true loaded=true intended_assertion=true restored=true green=true`);
    });
  }finally{await rm(copy,{recursive:true,force:true});}
});
