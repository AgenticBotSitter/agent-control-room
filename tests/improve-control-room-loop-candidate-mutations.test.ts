// Dedicated guard lane. Child commands cannot select this runner.
// Each probe checks its baseline explicitly before asking the helper to mutate it.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile,execFileSync } from "node:child_process";
import { mkdir,mkdtemp,readFile,rm,symlink } from "node:fs/promises";
import { join,resolve } from "node:path";
import { promisify } from "node:util";
import { assertGuardBites } from "./support/attack-kit/index";
const exec=promisify(execFile),root=resolve(".");
const wire="src/improve-control-room/v1/loop-candidate-wire.ts",service="src/improve-control-room/v1/service.ts";
const probes=[
 {name:"direct evidence equality",file:service,find:'if (canonicalJson(e) !== canonicalJson(verified)) throw new WebAccessError("conflict");',replace:"/* MUTANT: caller evidence trusted. */",
  pattern:"B4 direct recording refuses altered evidence with the real digest",assertion:"B4 direct evidence must equal the verified source before signing"},
 {name:"same-key decision equality",file:service,find:" || decision.decision !== b.decision",replace:"",
  pattern:"B4 same-key replay refuses the opposite decision",assertion:"B4 same-key opposite decision conflicts"},
 {name:"URL body candidate binding",file:"src/web/v1/improve-control-room-loop-candidate-http.ts",find:" || body.data.candidateId !== candidateId",replace:"",
  pattern:"B4 decision URL and body candidate IDs must agree",assertion:"B4 mismatched URL ID is refused before the service"},
 {name:"current local input",file:service,find:" || Number(input.version) !== b.localVersion",replace:" || false",
  pattern:"B4 edited then restored inputs keep the old candidate historical",assertion:"B4 stale local input is refused before source verification"},
 {name:"UI synchronous retry latch",file:"private-app/app/improvement-finish-card.tsx",find:"if (latch.current || !isFresh() || !navigator.onLine) return;",replace:"if (!isFresh() || !navigator.onLine) return;",
  pattern:"B4 per-card retry latch freezes one inert POST",assertion:"B4 per-card synchronous retry latch attempts exactly one same-key POST"},
 {name:"observed repository head",file:"src/improve-control-room/v1/loop-candidate-publisher.ts",find:" || evidence.binding.candidateRevision !== before.candidateRevision",replace:"",
  pattern:"B4 repository head must agree with the verified completion",assertion:"B4 a different observed repository head records zero candidates"},
 {name:"decision authority before replay",file:service,find:'actor.require("updates.decide",row.project_id,true,"high"); await this.#requireSelfProject(tx,row.project_id);',replace:'await this.#requireSelfProject(tx,row.project_id);',
  pattern:"B4 unauthorized exact decision replay is reauthorized before source",assertion:"B4 unauthorized original-key replay never returns a decision receipt"},
 {name:"UI explicit freshness boundary",file:"private-app/app/improvement-finish-card.tsx",find:"if (latch.current || !isFresh() || !navigator.onLine) return;",replace:"if (latch.current || !navigator.onLine) return;",
  pattern:"B4 UI freshness, late replies and access loss",assertion:"B4 checking source attempts zero inert decision POSTs"},
 {name:"UI protected access loss",file:"private-app/app/improvement-finish-card.tsx",find:"if (error instanceof LoopCandidateReadErrorV1 && error.protectedFailure) { generation.current++; setRetained(undefined); }",replace:"/* MUTANT: protected rows retained after access loss. */",
  pattern:"B4 UI freshness, late replies and access loss",assertion:"B4 access loss removes protected retained cards"},
 {name:"creator enumeration",file:service,find:"SELECT * FROM control_loop_update_candidates WHERE tenant_id=$1 AND owner_identity_id=$2\n",
  replace:"SELECT * FROM control_loop_update_candidates WHERE tenant_id=$1 AND ($2::text IS NOT NULL)\n",pattern:"B4 creator enumeration excludes another owner's candidate before source reads",assertion:"B4 creator enumeration scans zero foreign candidate rows"},
 {name:"required completed count",file:wire,find:" || c.completed === 0",replace:"",pattern:"B4 wire completed-count guard",assertion:"B4 zero completed checks cannot certify readiness"},
 {name:"blocking findings",file:wire,find:'if (v.findings.some(f => f.disposition === "OPEN" && f.severity !== "LOW")) bad("open blocking finding");',
  replace:"/* MUTANT: blocking findings admitted. */",pattern:"B4 wire blocking-finding guard",assertion:"B4 open HIGH finding cannot certify readiness"},
 {name:"current final head",file:wire,find:" || r.candidateRevision !== v.binding.candidateRevision",replace:"",pattern:"B4 wire current-head guard",assertion:"B4 stale final review cannot certify current head"},
 {name:"candidate signature",file:service,find:'|| !same(hmacSha256Tag(this.#key, { purpose: "loop-update-candidate/v1", record: material }), row.auth_tag)',replace:"|| false",
  pattern:"B4 tampered retained candidate fails every read",assertion:"B4 tampered candidate never becomes a readable card"},
 {name:"decision signature",file:service,find:'|| !same(hmacSha256Tag(this.#key, { purpose: "loop-update-candidate-decision/v1", record: material }), row.auth_tag)',replace:"|| false",
  pattern:"B4 tampered retained decision fails verification",assertion:"B4 tampered decision never becomes a readable card"},
 {name:"decision exact head",file:service,find:"b.candidateRevision !== row.candidate_revision || b.candidateRecordDigest !== row.record_digest",replace:"b.candidateRecordDigest !== row.record_digest",
  pattern:"B4 decision exact head binding refuses before an insert",assertion:"B4 altered head attempts zero decision inserts"},
 {name:"Start authorization input version",file:service,find:" || canonicalJson(authorization.a2_input_version) !== canonicalJson(claim.binding.inputVersion)",replace:"",
  pattern:"B4 Start claim bound to another A2 input version is refused in service and SQL",assertion:"B4 service refuses a Start claim whose input version differs from its authorization"},
 {name:"decision source freshness",file:service,find:'if (canonicalJson(verified) !== canonicalJson(prepared.e)) throw new WebAccessError("conflict");',replace:"/* MUTANT: changed completion admitted. */",
  pattern:"B4 decision freshness refuses changed sealed completion",assertion:"B4 changed sealed completion attempts zero decision inserts"},
];
function sourceGuardPartition(name:string, selected:typeof probes) { test(name,{timeout:600000},async t=>{
 await mkdir(resolve(".test-tmp"),{recursive:true});const copy=await mkdtemp(resolve(".test-tmp/b4-mutations-"));
 try{
  execFileSync("git",["-c","core.hooksPath=/dev/null","clone","--local","--no-hardlinks","--quiet",root,copy],{timeout:120000});
  await symlink(join(root,"node_modules"),join(copy,"node_modules"),"dir");
  for(const probe of selected)await t.test(probe.name,async()=>{
   const args=[process.execPath,"scripts/run-tests-with-quarantine.mjs","--import","tsx","--test",`--test-name-pattern=^${probe.pattern}$`,"tests/improve-control-room-loop-candidate.test.tsx"];
   const original=await readFile(join(copy,probe.file),"utf8");
   const env:NodeJS.ProcessEnv={...process.env,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:"1"};delete env.NODE_TEST_CONTEXT;
   const baseline=await exec(args[0]!,args.slice(1),{cwd:copy,env,timeout:60000,maxBuffer:4*1024*1024});
   assert.match(baseline.stdout,/# pass 1/u);assert.match(baseline.stdout,/# fail 0/u);
   const result=await assertGuardBites({skipBaseline:true,root:copy,file:probe.file,find:probe.find,replace:probe.replace,testCmd:args,boundMs:60000,because:probe.assertion});
   assert.equal(result.applied,true);assert.equal(result.exitCode,1);assert.equal(result.signal,null);
   assert.ok(result.output.includes(probe.assertion),`loaded mutation reaches intended assertion: ${probe.assertion}`);
   assert.match(result.output,/ERR_ASSERTION/u);assert.match(result.output,/# fail 1/u);
   assert.doesNotMatch(result.output,/SyntaxError|# tests 0|# skipped [1-9]|timed out|migration_altered:/iu);
   assert.equal(await readFile(join(copy,probe.file),"utf8"),original);
   const restored=await exec(args[0]!,args.slice(1),{cwd:copy,env,timeout:60000,maxBuffer:4*1024*1024});
   assert.match(restored.stdout,/# pass 1/u);assert.match(restored.stdout,/# fail 0/u);
   console.log(`B4 mutation ${probe.name}: baseline=true loaded=true intended_assertion=true restored=true green=true`);
  });
 }finally{await rm(copy,{recursive:true,force:true});}
}); }
sourceGuardPartition("B4 candidate service guards fail independently and restore green",probes.filter(p=>!p.name.startsWith("UI ")));
sourceGuardPartition("B4 candidate UI guards fail independently and restore green",probes.filter(p=>p.name.startsWith("UI ")));

const sqlProbesAll=[
 {name:"SQL decision uniqueness",file:"db/migrations/0303_control_loop_update_candidates.sql",
  find:"  UNIQUE (tenant_id,candidate_id),\n",replace:"",
  pattern:"B4 SQL unique decision floor refuses a second consumption",assertion:"B4 SQL unique candidate consumption floor refuses a second decision"},
 {name:"SQL decision append-only",file:"db/migrations/0303_control_loop_update_candidates.sql",
  find:"BEFORE UPDATE OR DELETE OR TRUNCATE ON control_loop_update_candidate_decisions",replace:"BEFORE DELETE OR TRUNCATE ON control_loop_update_candidate_decisions",
  pattern:"B4 SQL append-only guard refuses schema-owner changes",assertion:"B4 SQL schema owner cannot rewrite decisions"},
 {name:"SQL current binding",file:"db/migrations/0305_control_loop_candidate_unavailable_sections.sql",
  find:"AND i.request_sha256=NEW.payload->'binding'->>'requestSha256'",replace:"AND true",
  pattern:"B4 SQL current-input guard independently refuses wrong request bytes",assertion:"B4 SQL wrong request bytes are refused by current binding trigger"},
 {name:"SQL completed counts",file:"db/migrations/0305_control_loop_candidate_unavailable_sections.sql",
  find:"AND (item->>'completed')::numeric>0",replace:"AND true",
  pattern:"B4 SQL completed-check guard independently refuses zero counts",assertion:"B4 SQL zero counts are refused by required check trigger"},
 {name:"SQL owner grant",file:"db/migrations/0303_control_loop_update_candidates.sql",
  find:"IF NOT EXISTS (SELECT 1 FROM control_role_grants g JOIN control_identities i ON",replace:"IF false AND NOT EXISTS (SELECT 1 FROM control_role_grants g JOIN control_identities i ON",
  pattern:"B4 SQL decision owner grant independently refuses revoked authority",assertion:"B4 SQL revoked owner cannot insert an inert decision"},
 {name:"SQL append-only",file:"db/migrations/0303_control_loop_update_candidates.sql",
  find:"BEFORE UPDATE OR DELETE OR TRUNCATE ON control_loop_update_candidates",replace:"BEFORE DELETE OR TRUNCATE ON control_loop_update_candidates",
  pattern:"B4 SQL append-only guard refuses schema-owner changes",assertion:"B4 SQL schema owner cannot rewrite candidates"},
 {name:"SQL application denial",file:"db/roles/production_table_grants.sql",
  find:"REVOKE ALL ON control_loop_update_candidates, control_loop_update_candidate_decisions FROM control_room_application,",
  replace:"REVOKE ALL ON control_loop_update_candidates, control_loop_update_candidate_decisions FROM",
  pattern:"B4 SQL broad application role denial is independent",assertion:"B4 application login has no candidate SELECT"},
 {name:"SQL Start authorization input version",file:"db/migrations/0305_control_loop_candidate_unavailable_sections.sql",
  find:"\n        AND a.a2_input_version=c.binding->'inputVersion'",replace:"",
  pattern:"B4 SQL Start authorization guard refuses a claim bound to another A2 input version",assertion:"B4 SQL refuses a Start claim whose input version differs from its authorization"},
];
function sqlGuardPartition(name:string, sqlProbes:typeof sqlProbesAll) { test(name,{timeout:600000},async t=>{
 await mkdir(resolve(".test-tmp"),{recursive:true});const copy=await mkdtemp(resolve(".test-tmp/b4-sql-mutations-"));
 try{
  execFileSync("git",["-c","core.hooksPath=/dev/null","clone","--local","--no-hardlinks","--quiet",root,copy],{timeout:120000});
  await symlink(join(root,"node_modules"),join(copy,"node_modules"),"dir");
  const env:NodeJS.ProcessEnv={...process.env,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:"1"};delete env.NODE_TEST_CONTEXT;
  // A native setup failure aborts the SQL phase immediately. It is never a bite.
  const first=sqlProbes[0]!;
  const native=await exec(process.execPath,["scripts/ci/run-mutation-postgres-test.mjs","--test-concurrency=1","--test-timeout=600000",
    `--test-name-pattern=^${first.pattern}$`,"tests/improve-control-room-loop-candidate-postgres.test.ts"],
    {cwd:copy,env,timeout:120000,maxBuffer:8*1024*1024}).catch(error=>{
      if(error.stdout)process.stdout.write(error.stdout);if(error.stderr)process.stderr.write(error.stderr);throw error;
    });
  assert.match(native.stdout,/# pass 1/u);assert.match(native.stdout,/# fail 0/u);
  for(const probe of sqlProbes)await t.test(probe.name,async()=>{
   const args=[process.execPath,"scripts/ci/run-mutation-postgres-test.mjs","--test-concurrency=1","--test-timeout=600000",
    `--test-name-pattern=^${probe.pattern}$`,"tests/improve-control-room-loop-candidate-postgres.test.ts"];
   // The preflight used this exact first command on the unchanged copy.
   const baseline=probe===first?native:await exec(args[0]!,args.slice(1),{cwd:copy,env,timeout:120000,maxBuffer:8*1024*1024});
   assert.match(baseline.stdout,/# pass 1/u);assert.match(baseline.stdout,/# fail 0/u);
   const result=await assertGuardBites({skipBaseline:true,root:copy,file:probe.file,find:probe.find,replace:probe.replace,testCmd:args,boundMs:120000,because:probe.assertion});
   assert.equal(result.applied,true);assert.equal(result.exitCode,1);assert.equal(result.signal,null);
   assert.ok(result.output.includes(probe.assertion),`loaded native mutation reaches intended assertion: ${probe.assertion}`);
   assert.match(result.output,/ERR_ASSERTION/u);assert.match(result.output,/# fail 1/u);
   assert.doesNotMatch(result.output,/SyntaxError|# tests 0|# skipped [1-9]|timed out|migration_altered:/iu);
   const restored=await exec(args[0]!,args.slice(1),{cwd:copy,env,timeout:120000,maxBuffer:8*1024*1024});
   assert.match(restored.stdout,/# pass 1/u);assert.match(restored.stdout,/# fail 0/u);
   console.log(`B4 mutation ${probe.name}: baseline=true loaded=true intended_assertion=true restored=true green=true`);
  });
 }finally{await rm(copy,{recursive:true,force:true});}
}); }
sqlGuardPartition("B4 SQL consumption guards require independently loaded native mutations",[sqlProbesAll[0]!]);
sqlGuardPartition("B4 SQL decision immutability guards require independently loaded native mutations",[sqlProbesAll[1]!]);
sqlGuardPartition("B4 SQL binding guards require independently loaded native mutations",[sqlProbesAll[2]!,sqlProbesAll[7]!]);
sqlGuardPartition("B4 SQL completed checks guards require independently loaded native mutations",[sqlProbesAll[3]!]);
sqlGuardPartition("B4 SQL authority guards require independently loaded native mutations",[sqlProbesAll[4]!]);
sqlGuardPartition("B4 SQL candidate immutability guards require independently loaded native mutations",[sqlProbesAll[5]!]);
sqlGuardPartition("B4 SQL grants guards require independently loaded native mutations",[sqlProbesAll[6]!]);

test("B4 inert decision callback mutation reaches the forbidden-attempt spy",{timeout:120000},async()=>{
 const copy=await mkdtemp(resolve(".test-tmp/b4-inert-mutation-"));
 try{
  execFileSync("git",["-c","core.hooksPath=/dev/null","clone","--local","--no-hardlinks","--quiet",root,copy],{timeout:120000});
  await symlink(join(root,"node_modules"),join(copy,"node_modules"),"dir");
  const env:NodeJS.ProcessEnv={...process.env,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:"1"};delete env.NODE_TEST_CONTEXT;
  const args=[process.execPath,"scripts/run-tests-with-quarantine.mjs","--import","tsx","--test",
   "--test-name-pattern=^B4 inert decision transport spy observes forbidden attempts before refusal$","tests/improve-control-room-loop-candidate.test.tsx"];
  const baseline=await exec(args[0]!,args.slice(1),{cwd:copy,env,timeout:60000,maxBuffer:4*1024*1024});assert.match(baseline.stdout,/# pass 1/u);
  const result=await assertGuardBites({skipBaseline:true,root:copy,file:"private-app/app/improvement-finish-card.tsx",find:"      await client.decide(action);",
   replace:'      await fetch("/api/v1/install",{method:"POST"}); await client.decide(action);',testCmd:args,boundMs:60000,
   because:"B4 inert decision attempts zero delivery operations before any downstream refusal"});
  assert.equal(result.applied,true);assert.equal(result.exitCode,1);assert.match(result.output,/ERR_ASSERTION/u);
  assert.ok(result.output.includes("B4 inert decision attempts zero delivery operations before any downstream refusal"));
  assert.doesNotMatch(result.output,/SyntaxError|# tests 0|# skipped [1-9]|timed out/iu);
  const restored=await exec(args[0]!,args.slice(1),{cwd:copy,env,timeout:60000,maxBuffer:4*1024*1024});assert.match(restored.stdout,/# pass 1/u);assert.match(restored.stdout,/# fail 0/u);
  console.log("B4 mutation inert decision callback: baseline=true loaded=true attempted_delivery_seen_before_refusal=true restored=true green=true");
 }finally{await rm(copy,{recursive:true,force:true});}
});

test("B4 decided-state response mutation reaches the invariant assertion",{timeout:120000},async()=>{
 const copy=await mkdtemp(resolve(".test-tmp/b4-state-mutation-"));
 try{
  execFileSync("git",["-c","core.hooksPath=/dev/null","clone","--local","--no-hardlinks","--quiet",root,copy],{timeout:120000});
  await symlink(join(root,"node_modules"),join(copy,"node_modules"),"dir");
  const env:NodeJS.ProcessEnv={...process.env,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:"1"};delete env.NODE_TEST_CONTEXT;
  const args=[process.execPath,"scripts/run-tests-with-quarantine.mjs","--import","tsx","--test",
   "--test-name-pattern=^B4 wire decided state requires version two and a decision time$","tests/improve-control-room-loop-candidate.test.tsx"];
  const baseline=await exec(args[0]!,args.slice(1),{cwd:copy,env,timeout:60000,maxBuffer:4*1024*1024});assert.match(baseline.stdout,/# pass 1/u);
  const result=await assertGuardBites({skipBaseline:true,root:copy,file:wire,
   find:'|| (c.state === "ready" ? c.version !== 1 || c.decidedAt !== null : c.version !== 2 || c.decidedAt === null)',
   replace:'|| (c.state === "ready") !== (c.version === 1 && c.decidedAt === null)',testCmd:args,boundMs:60000,
   because:"B4 accepted state cannot carry a ready candidate version"});
  assert.equal(result.applied,true);assert.equal(result.exitCode,1);assert.match(result.output,/ERR_ASSERTION/u);
  assert.ok(result.output.includes("B4 accepted state cannot carry a ready candidate version"));
  assert.doesNotMatch(result.output,/SyntaxError|# tests 0|# skipped [1-9]|timed out/iu);
  const restored=await exec(args[0]!,args.slice(1),{cwd:copy,env,timeout:60000,maxBuffer:4*1024*1024});assert.match(restored.stdout,/# pass 1/u);assert.match(restored.stdout,/# fail 0/u);
  console.log("B4 mutation decided-state response: baseline=true loaded=true intended_assertion=true restored=true green=true");
 }finally{await rm(copy,{recursive:true,force:true});}
});
