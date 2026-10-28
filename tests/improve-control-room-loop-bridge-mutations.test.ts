// Dedicated lane: guards are disabled only in owned clean disposable copies.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { assertGuardBites, reapKitClusters } from "./support/attack-kit/index";
const exec=promisify(execFile), root=resolve(".");
const probes=[
  {name:"sweep isolates invalid rows",file:"src/web/v1/improve-control-room-loop-service.ts",
    find:'} catch { /* Keep unverified or stale commands; continue with other finished rows. */ }',
    replace:'} catch (error) { throw error; }',
    pattern:"B1b first-use sweep skips",assertion:"sweep continues past stale and invalid rows to clean the verified finished command",postgres:false},
  {name:"approve refusal status fallback",file:"src/web/v1/improve-control-room-loop-adapter.ts",
    find:'observed = await status(run);',replace:'throw unavailable();',
    pattern:"^B1b exit 2 approve empty",assertion:"definite process refusal is recorded as refused",postgres:false},
  {name:"finished command startup sweep",file:"src/web/v1/improve-control-room-loop-service.ts",
    find:'await this.#sweepCommandFiles(identity, projectId);',replace:'/* MUTANT: omit finished command sweep. */',
    pattern:"^B1b first-use sweep removes only durable finished command directories$",assertion:"first-use sweep reclaims durable finished command",postgres:false},
  {name:"cleanup failure preserves receipt",file:"src/web/v1/improve-control-room-loop-service.ts",
    find:'try { await this.#adapter.releaseCommandFiles?.(claim.command_id); } catch { /* Retain for an authorized retry. */ }',
    replace:'await this.#adapter.releaseCommandFiles?.(claim.command_id);',
    pattern:"B1b cleanup failure",assertion:"cleanup failure preserves committed receipt",postgres:false},
  {name:"cleanup validates configuration",file:"src/web/v1/improve-control-room-loop-adapter.ts",
    find:'releaseCommandFiles: async (commandId: string) => {\n      validate();',
    replace:'releaseCommandFiles: async (commandId: string) => {',
    pattern:"B1b cleanup rechecks",assertion:"cleanup refuses stale executable pin",postgres:false},
  {name:"owner authority",file:"src/improve-control-room/v1/service.ts",
    find:'actor.require(mutation ? "tasks.propose" : "projects.read", projectId, true, mutation ? "high" : "low");',
    replace:'actor.require(mutation ? "tasks.propose" : "projects.read", projectId, false, mutation ? "high" : "low");',
    pattern:"B1b strict bodies",assertion:"B1b denied caller attempts zero persistence",postgres:false},
  {name:"exact owner confirmation",file:"src/web/v1/improve-control-room-loop-service.ts",
    find:'|| !equal(authorization.confirmation, status.confirmation)',replace:'|| false',
    pattern:"B1b exact-current confirmation guard",assertion:"B1b changed owner confirmation refuses before claim",postgres:false},
  {name:"one confirmation per version",file:"src/web/v1/improve-control-room-loop-service.ts",
    find:'if (local.authorization || priorConfirmation) throw conflict();',replace:'if (false) throw conflict();',
    pattern:"B1b website intake confirm start status stop",assertion:"new keys cannot rewrite an already saved owner confirmation",postgres:false},
  {name:"configured path fence",file:"src/web/v1/improve-control-room-loop-adapter.ts",
    find:'checkedPath(c.settingsFile, c.configRoot);',replace:'/* MUTANT: omit configured settings path fence. */',
    pattern:"B1b configured execution/path fence",assertion:"B1b configured symlink refusal",postgres:false},
  {name:"configured executable pin",file:"src/web/v1/improve-control-room-loop-adapter.ts",
    find:'|| loopByteHashV1(readFileSync(c.entrypoint)) !== c.entrypointSha256',replace:'|| false',
    pattern:"B1b configured executable pin guard",assertion:"B1b changed executable refuses construction before any command",postgres:false},
  {name:"freshness at actual spawn",file:"src/web/v1/improve-control-room-loop-service.ts",
    find:'if (elapsed < 0 || elapsed >= this.#freshness) throw unavailable();',replace:'if (false) throw unavailable();',
    pattern:"B1b admission expiry after A2 lock wait",assertion:"B1b expired admission after lock wait spawns no Start",postgres:false},
  {name:"pending claims never redispatch",file:"src/web/v1/improve-control-room-loop-service.ts",
    find:'if (admitted.replayed) {',replace:'if (admitted.replayed && false) {',
    pattern:"B1b claim without result",assertion:"B1b pending claim never dispatches twice",postgres:false},
  {name:"SQL sole Start claim",file:"db/migrations/0302_control_loop_improvement_commands.sql",
    find:"CREATE UNIQUE INDEX control_loop_commands_start ON control_loop_improvement_commands(tenant_id,request_id)\n  WHERE entry_kind='claim' AND operation='start';",replace:'-- MUTANT: sole Start constraint absent.',
    pattern:"B1b SQL claim uniqueness guard",assertion:"B1b SQL unique Start refusal",postgres:true},
  {name:"desk creator scope",file:"src/improve-control-room/v1/service.ts",
    find:'AND owner_identity_id=$3 ORDER BY created_at DESC,id DESC LIMIT 100',
    replace:'AND $3::text IS NOT NULL ORDER BY created_at DESC,id DESC LIMIT 100',
    pattern:"B1a loop desk returns only",assertion:"same-project requests from another creator are excluded",postgres:true,
    testFile:"tests/improve-control-room-desk-postgres.test.ts"},
  {name:"active command cleanup fence",file:"src/web/v1/improve-control-room-loop-adapter.ts",
    find:'|| activeCommands.has(commandId)) throw unavailable();',replace:'|| false) throw unavailable();',
    pattern:"B1b cleanup refuses a command",assertion:"active command cannot be reclaimed",postgres:false},
  {name:"completed command cleanup",file:"src/web/v1/improve-control-room-loop-service.ts",
    find:'\n    await this.#releaseCommandFiles(claim);',replace:'\n    /* MUTANT: retain completed command files. */',
    pattern:"B1b command files remain",assertion:"committed result releases only its command directory",postgres:false},
  {name:"sweep outside freshness window",file:"src/web/v1/improve-control-room-loop-service.ts",
    find:'    try { return await this.#dispatch(identity, projectId, operation, body, preflight, admitted); }\n    finally { await this.#sweepCommandFiles(identity, projectId); }',
    replace:'    await this.#sweepCommandFiles(identity, projectId);\n    return this.#dispatch(identity, projectId, operation, body, preflight, admitted);',
    pattern:"^B1b slow restart sweep",assertion:"Start dispatches exactly once despite a slow sweep",postgres:false},
  {name:"bounded sweep page",file:"src/web/v1/improve-control-room-loop-service.ts",
    find:'ORDER BY c.command_id LIMIT ${sweepLimit}`',replace:'ORDER BY c.command_id`',
    pattern:"^B1b restart sweep releases one bounded page",assertion:"sweep releases at most one bounded page per call",postgres:false},
  {name:"loop key equals legacy key",file:"src/web/v1/improve-control-room-loop-service.ts",
    find:'loopKey.length === legacyKey.length && timingSafeEqual(loopKey, legacyKey);',replace:'true;',
    pattern:"^B1b split loop and legacy",assertion:"hosted composition refuses a split loop key",postgres:false},
];
test("B1b guard-off proofs with restored green checks",{timeout:550000,concurrency:2},async t=>{
  await mkdir(resolve(".test-tmp"),{recursive:true});const copies:string[]=[];
  try{
    // PostgreSQL setup dominates this lane. Each group owns an independent
    // clean copy; every baseline, mutation and restored check is preserved.
    const groups=await Promise.allSettled([false,true].map(async postgres=>{
    const copy=await mkdtemp(resolve(".test-tmp/b1b-mutations-"));copies.push(copy);
    execFileSync("git",["-c","core.hooksPath=/dev/null","clone","--local","--no-hardlinks","--quiet",root,copy],{timeout:120000});
    assert.equal(execFileSync("git",["-C",copy,"rev-parse","HEAD"],{encoding:"utf8"}).trim(),execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim());
    await symlink(join(root,"node_modules"),join(copy,"node_modules"),"dir");
    for(const probe of probes.filter(probe=>probe.postgres===postgres))await t.test(probe.name,async()=>{
      const file="testFile" in probe ? probe.testFile! : probe.postgres?"tests/improve-control-room-loop-bridge-postgres.test.ts":"tests/improve-control-room-loop-bridge.test.ts";
      const command=probe.postgres?[process.execPath,"scripts/ci/run-mutation-postgres-test.mjs","--test-concurrency=1","--test-timeout=600000",`--test-name-pattern=${probe.pattern}`,file]
        :[process.execPath,"scripts/run-tests-with-quarantine.mjs","--import","tsx","--test",`--test-name-pattern=${probe.pattern}`,file];
      const testCmd=["/usr/bin/env","CONTROL_ROOM_PG_TEST_PORT_BASE=58500","CONTROL_ROOM_PG_TEST_PORT_WIDTH=10",...command];
      const original=await readFile(join(copy,probe.file),"utf8");
      const result=await assertGuardBites({root:copy,file:probe.file,find:probe.find,replace:probe.replace,testCmd,boundMs:180000,because:probe.assertion});
      assert.equal(result.applied,true);assert.equal(result.exitCode,1);assert.equal(result.signal,null);
      assert.ok(result.output.includes(probe.assertion),`loaded mutation reached independent assertion: ${probe.assertion}`);
      assert.match(result.output,/ERR_ASSERTION/u);assert.match(result.output,/# fail 1/u);
      assert.doesNotMatch(result.output,/migration_altered:|private_database_preflight_failed|SyntaxError|# skipped [1-9]|# tests 0|timed out/iu);
      assert.equal(await readFile(join(copy,probe.file),"utf8"),original);
      const env: NodeJS.ProcessEnv={...process.env,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:"1",CONTROL_ROOM_PG_TEST_PORT_BASE:"58500",CONTROL_ROOM_PG_TEST_PORT_WIDTH:"10"};delete env.NODE_TEST_CONTEXT;
      const restored=await exec(testCmd[0]!,testCmd.slice(1),{cwd:copy,env,timeout:180000,maxBuffer:4*1024*1024});
      assert.match(restored.stdout,/# fail 0/u);assert.doesNotMatch(restored.stdout,/# skipped [1-9]|# tests 0/u);
      console.log(`B1b mutation ${probe.name}: loaded=true intended_assertion=true restored=true green=true`);
    });
    }));
    for(const group of groups)if(group.status==='rejected')throw group.reason;
  }finally{
    const cleanup=await Promise.allSettled(copies.map(async copy=>{await reapKitClusters(join(copy,".test-tmp"));await rm(copy,{recursive:true,force:true});}));
    if(cleanup.some(result=>result.status==='rejected'))throw new Error('bridge_mutation_cleanup_uncertain');
  }
});
