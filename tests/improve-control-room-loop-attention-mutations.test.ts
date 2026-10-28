// Dedicated lane: no child invocation can select this runner.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { assertGuardBites } from "./support/attack-kit/index";
const exec=promisify(execFile),root=resolve(".");
const probes=[
  {name:"discovery creator",file:"src/improve-control-room/v1/service.ts",find:"AND r.owner_identity_id=$3",replace:"AND ($3::text IS NOT NULL)",
    suite:"tests/improve-control-room-loop-attention.test.tsx",pattern:"B2b discovery creator predicate",assertion:"B2b discovery excludes foreign creators before status"},
  {name:"complete document binding",file:"src/web/v1/improve-control-room-loop-adapter.ts",
    find:"if (loopByteHashV1(bytes) !== expected.reportSha256 || JSON.stringify(decoded) !== JSON.stringify(expected)) throw unavailable();",
    replace:"/* MUTANT: exact document hash and descriptor binding disabled. */",
    suite:"tests/improve-control-room-loop-bridge.test.ts",pattern:"B2b approval document isolation",assertion:"B2b changed complete text is refused before approval"},
  {name:"shared attention 403 clearing",file:"private-app/app/shared-task-attention.ts",
    find:'const operatorAccessLost = (code: string) => ["authentication_required", "access_denied"].includes(code);',
    replace:'const operatorAccessLost = (code: string) => code === "authentication_required";',
    suite:"tests/improve-control-room-loop-attention.test.tsx",pattern:"B2b shared attention clears protected rows on 403",assertion:"B2b access loss removes retained protected rows"},
];
test("B2b three new guards fail independently and restore green",{timeout:600000},async t=>{
  await mkdir(resolve(".test-tmp"),{recursive:true});const copy=await mkdtemp(resolve(".test-tmp/b2b-mutations-"));
  try{
    execFileSync("git",["-c","core.hooksPath=/dev/null","clone","--local","--no-hardlinks","--quiet",root,copy],{timeout:120000});
    await symlink(join(root,"node_modules"),join(copy,"node_modules"),"dir");
    for(const probe of probes)await t.test(probe.name,async()=>{
      const testCmd=[process.execPath,"scripts/run-tests-with-quarantine.mjs","--import","tsx","--test",`--test-name-pattern=^${probe.pattern}$`,probe.suite];
      const original=await readFile(join(copy,probe.file),"utf8");
      const result=await assertGuardBites({root:copy,file:probe.file,find:probe.find,replace:probe.replace,testCmd,boundMs:120000,because:probe.assertion});
      assert.equal(result.applied,true);assert.equal(result.exitCode,1);assert.equal(result.signal,null);
      assert.ok(result.output.includes(probe.assertion),`loaded mutation reaches its named independent assertion: ${probe.assertion}`);
      assert.match(result.output,/ERR_ASSERTION/u);assert.match(result.output,/# fail 1/u);
      assert.doesNotMatch(result.output,/SyntaxError|# skipped [1-9]|# tests 0|timed out|migration_altered:/iu);
      assert.equal(await readFile(join(copy,probe.file),"utf8"),original);
      const env:NodeJS.ProcessEnv={...process.env,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:"1"};delete env.NODE_TEST_CONTEXT;
      const restored=await exec(testCmd[0]!,testCmd.slice(1),{cwd:copy,env,timeout:120000,maxBuffer:4*1024*1024});
      assert.match(restored.stdout,/# pass 1/u);assert.match(restored.stdout,/# fail 0/u);assert.doesNotMatch(restored.stdout,/# skipped [1-9]|# tests 0/u);
      console.log(`B2b mutation ${probe.name}: baseline=true loaded=true intended_assertion=true restored=true green=true`);
    });
  }finally{await rm(copy,{recursive:true,force:true});}
});
