import assert from "node:assert/strict";
import test from "node:test";
import { execFile,execFileSync } from "node:child_process";
import { mkdir,mkdtemp,readFile,rm,symlink } from "node:fs/promises";
import { resolve,join } from "node:path";
import { promisify } from "node:util";
import { assertGuardBites } from "./support/attack-kit/index";
const exec=promisify(execFile),root=resolve("."),file="tests/helpers/improve-control-room-first-website.ts";
// Each probe disables one NEW B5 verifier guard. The forged proof in its named case
// must then fail that case's own intended assertion; unchanged product/A2 guards are not re-mutated.
const probes=[
  {name:"real versus fixture qualification",find:`  if (b.toolingRevision !== pins.toolingRevision) refuse("B5_FIXTURE_NOT_REAL", "card tooling");`,
  replace:"",pattern:"B5 verifier refuses a fixture chain presented as real",assertion:"B5 forged fixture chain is refused by its own guard"},
  {name:"rejected and final head binding",find:`  if (card.candidateRevision !== final) refuse("B5_HEAD_BINDING", "card head");`,replace:"",
    pattern:"B5 verifier binds rejected and final heads to the saved card",assertion:"B5 stale card head is refused by the head guard"},
  {name:"candidate repository HEAD and clean state",find:`  if (facts.head !== card.candidateRevision || facts.head !== manifest.heads.final || !facts.clean) bad("head");`,replace:"",
    pattern:"B5 verifier re-reads the candidate repository and its page facts",assertion:"B5 dirty candidate repository is refused"},
  {name:"artifact byte binding",find:"if (b5Bytes(bytes) !== entry.sha256 || bytes.length !== entry.bytes || artifacts.has(entry.path))",replace:"if (artifacts.has(entry.path))",
    pattern:"B5 verifier accepts complete real-shaped evidence and reports missing phone evidence as incomplete",assertion:"B5 changed retained bytes are refused"},
  {name:"closed-browser rejection and original-builder repair",find:"if (!repair || repair.identity !== defective!.identity || repair.family !== defective!.family)",replace:"if (!repair)",
    pattern:"B5 verifier requires closed-browser rejection and original-builder repair",assertion:"B5 repair by a different writer is refused by the repair guard"},
  {name:"full cleanup and retained corpus",find:`if (teardown.b3cCleanup !== "complete" || !teardown.scratchAbsent || `,replace:"if (",
    pattern:"B5 verifier requires full cleanup before the retained read-back",assertion:"B5 refused cleanup is refused by the cleanup guard"},
];
test("B5 verifier guard mutations bite independently and restore green",{timeout:290000},async t=>{
  await mkdir(resolve(".test-tmp"),{recursive:true});const copy=await mkdtemp(resolve(".test-tmp/b5-mutations-"));
  try{
    execFileSync("git",["-c","core.hooksPath=/dev/null","clone","--local","--no-hardlinks","--quiet",root,copy],{timeout:120000});
    await symlink(join(root,"node_modules"),join(copy,"node_modules"),"dir");
    for(const p of probes)await t.test(p.name,async()=>{
      const cmd=[process.execPath,"scripts/run-tests-with-quarantine.mjs","--import","tsx","--test",`--test-name-pattern=^${p.pattern}$`,"tests/improve-control-room-first-website.test.ts"];
      const original=await readFile(join(copy,file),"utf8");
      const result=await assertGuardBites({root:copy,file,find:p.find,replace:p.replace,testCmd:cmd,boundMs:40000,because:p.assertion});
      assert.equal(result.applied,true);assert.equal(result.exitCode,1);assert.equal(result.signal,null);
      assert.ok(result.output.includes(p.assertion),`B5 loaded mutant reached intended assertion: ${p.assertion}`);
      assert.match(result.output,/ERR_ASSERTION/u);assert.match(result.output,/# fail 1/u);
      assert.doesNotMatch(result.output,/SyntaxError|# skipped [1-9]|# tests 0|timed out/iu);
      assert.equal(await readFile(join(copy,file),"utf8"),original);
      const env:NodeJS.ProcessEnv={...process.env,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:"1"};delete env.NODE_TEST_CONTEXT;
      const restored=await exec(cmd[0]!,cmd.slice(1),{cwd:copy,env,timeout:40000,maxBuffer:4*1024*1024});
      assert.match(restored.stdout,/# pass 1/u);assert.match(restored.stdout,/# fail 0/u);assert.doesNotMatch(restored.stdout,/# skipped [1-9]|# tests 0/u);
      console.log(`B5 mutation ${p.name}: baseline=true loaded=true intended_assertion=true restored=true green=true`);
    });
  }finally{await rm(copy,{recursive:true,force:true});}
});
