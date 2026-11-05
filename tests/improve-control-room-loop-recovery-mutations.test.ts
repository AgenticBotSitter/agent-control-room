import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile,execFileSync } from 'node:child_process';
import { mkdir,mkdtemp,readFile,writeFile,rm,symlink } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { promisify } from 'node:util';
import { assertGuardBites } from './support/attack-kit/index';
const exec=promisify(execFile),root=resolve('.');
const probes=[
  {name:'readiness before recovery discovery',file:'src/web/v1/private-task-startup.ts',find:'      dependencies.install(installed);',replace:'      recoveryWorker?.start(); dependencies.install(installed);',pattern:'B3a R2 readiness failure never starts recovery discovery',assertion:'B3a no recovery discovery before every readiness gate succeeds'},
  {name:'recovered command cleanup',file:'src/web/v1/improve-control-room-loop-service.ts',find:'      await this.#releaseCommandFiles(claim);\n    }\n    snapshot=await this.db.transaction(tx=>this.#recoverySnapshot(tx,target));',replace:'      /* MUTANT: retain recovered command files. */\n    }\n    snapshot=await this.db.transaction(tx=>this.#recoverySnapshot(tx,target));',pattern:'B3a R2 recovered result releases only its command files after commit',assertion:'B3a recovered result commits before releasing command files'},
  {name:'terminal inspection short circuit',file:'src/web/v1/improve-control-room-loop-service.ts',find:"    if (['stopped','finished','refused'].includes(status.state)) return blocked;",replace:'    /* MUTANT: inspect already terminal roots. */',pattern:'B3a R2 verified terminal status needs no recovery inspection',assertion:'B3a terminal status avoids redundant recovery inspection without a terminal cache'},
  {name:'verified changed input reason',file:'src/web/v1/improve-control-room-loop-service.ts',find:"        recoveryInputChanged = recoveryCurrent && recovery.mode === 'input_changed';",replace:'        recoveryInputChanged = false;',pattern:'B3a R2 verified changed input is shown explicitly',assertion:'B3a verified changed input retains its reason'},
  {name:'explicit A2 qualification absence',file:'tests/improve-control-room-loop-recovery.test.ts',find:"test('B3a reviewed A2 recovery contract',{skip:process.env.CONTROL_ROOM_B3A_REQUIRE_A2!=='1' ? 'Requires reviewed A2 pins in R and production ownership capability; integration unproven.' : false},async t=>{",replace:"test('B3a reviewed A2 recovery contract',async t=>{ if(process.env.CONTROL_ROOM_B3A_REQUIRE_A2!=='1')return;",pattern:'B3a R2 ordinary A2 gate reports its missing qualification',assertion:'B3a ordinary lane explicitly reports A2 qualification absent'},
  {name:'accepted Start admission',file:'src/web/v1/improve-control-room-loop-service.ts',find:`    if (starts.length!==1 || !start || snapshot.results.get(start.command_id)?.result?.state!=='accepted'
      || snapshot.claims.some(row=>row.operation==='stop' && !snapshot.results.get(row.command_id))) return blocked;`,replace:'    if (!start) return blocked;',pattern:'B3a accepted Start and current authority fence',assertion:'B3a forbidden recovery callback count is zero'},
  {name:'current owner authority admission',file:'src/web/v1/improve-control-room-loop-service.ts',find:`    const authorized = () => grants.some(g => g.role_key==='owner' && !g.revoked_at && (!g.expires_at || Date.parse(g.expires_at)>this.clock())
      && ['high','critical'].includes(g.risk_ceiling) && (g.allowed_actions.includes('*') || g.allowed_actions.includes('tasks.propose'))
      && (g.project_ids.includes('*') || g.project_ids.includes(target.projectId)));`,replace:'    const authorized = () => true;',pattern:'B3a current read-only owner grant shows recovery unavailable',assertion:'B3a forbidden current-authority callback count is zero'},
  {name:'positive exact receipt',file:'src/web/v1/improve-control-room-loop-service.ts',find:'      if (!receipt || receipt.commandId!==claim.command_id || receipt.bindingDigest!==sha256Digest(claim.binding)) return blocked;',replace:'      if (!receipt) return blocked;',pattern:'B3a exact receipt before result append',assertion:'B3a foreign receipt appends zero results'},
  {name:'duplicate driver refusal',file:'src/web/v1/improve-control-room-loop-adapter.ts',find:'    if (acquisitions.has(run) || recoveryChildren.has(run)) return { kind: "busy", evidenceDigest: sha256Digest({ run, owned: true }) };',replace:'    /* MUTANT: local duplicate-driver fence disabled. */',pattern:'B3a duplicate driver refuses second spawn',assertion:'B3a one spawn callback across duplicate drivers'},
  {name:'stopped uncertain changed refusal',file:'src/web/v1/improve-control-room-loop-adapter.ts',find:`        if (observation.mode !== "runnable" || observation.action !== binding.action || observation.revision !== binding.expectedRevision
          || !["none", "ended"].includes(observation.driver.state)) return { kind: "uncertain" as const, evidenceDigest: observation.evidenceDigest };`,replace:'        /* MUTANT: verified recovery observation fence disabled. */',pattern:'B3a stopped uncertain changed input refuse acquisition',assertion:'B3a stopped uncertain changed acquisition count is zero'},
  // Suppress abort too: its post-observation guard otherwise masks the closing fence.
  {name:'closing acquisition fence',file:'src/web/v1/improve-control-room-loop-recovery.ts',find:'      closing=true;abort.abort();',replace:'      /* MUTANT: closing admission fence and masking abort disabled. */',pattern:'B3a closed worker refuses another tick',assertion:'B3a no child admitted after close'},
];
test('B3a recovery guard categories fail independently and restore green',{timeout:290000},async t=>{
  await mkdir(resolve('.test-tmp'),{recursive:true});const copy=await mkdtemp(resolve('.test-tmp/b3a-mutations-'));
  try{
    execFileSync('git',['-c','core.hooksPath=/dev/null','clone','--local','--no-hardlinks','--quiet',root,copy],{timeout:120000});
    await symlink(join(root,'node_modules'),join(copy,'node_modules'),'dir');
    // Mutations exercise this worktree's changes before commit, including the
    // matching bounded reason schema and diagnostic tests.
    for(const file of [...new Set([...probes.map(p=>p.file),'tests/improve-control-room-loop-recovery.test.ts',
      'src/web/v1/improve-control-room-loop-finalization.ts','src/web/v1/improve-control-room-loop-attention-wire.ts',
      'src/improve-control-room/v1/loop-candidate-publisher.ts'])])
      await writeFile(join(copy,file),await readFile(join(root,file)));
    for(const probe of probes)await t.test(probe.name,async()=>{
      const testCmd=[process.execPath,'scripts/run-tests-with-quarantine.mjs','--import','tsx','--test',`--test-name-pattern=^${probe.pattern}$`,'tests/improve-control-room-loop-recovery.test.ts'];
      const original=await readFile(join(copy,probe.file),'utf8');
      const result=await assertGuardBites({root:copy,file:probe.file,find:probe.find,replace:probe.replace,testCmd,boundMs:45000,allowDirtyTree:true,because:probe.assertion});
      assert.equal(result.applied,true);assert.equal(result.exitCode,1);assert.equal(result.signal,null);
      assert.ok(result.output.includes(probe.assertion),`loaded mutant reaches independent assertion: ${probe.assertion}`);
      assert.match(result.output,/ERR_ASSERTION/u);assert.match(result.output,/# fail 1/u);assert.doesNotMatch(result.output,/SyntaxError|# skipped [1-9]|# tests 0|timed out|migration_altered:/iu);
      assert.equal(await readFile(join(copy,probe.file),'utf8'),original);
      const env:NodeJS.ProcessEnv={...process.env,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1'};delete env.NODE_TEST_CONTEXT;
      const restored=await exec(testCmd[0]!,testCmd.slice(1),{cwd:copy,env,timeout:45000,maxBuffer:4*1024*1024});
      assert.match(restored.stdout,/# pass 1/u);assert.match(restored.stdout,/# fail 0/u);assert.doesNotMatch(restored.stdout,/# skipped [1-9]|# tests 0/u);
      console.log(`B3a mutation ${probe.name}: baseline=true loaded=true intended_assertion=true restored=true green=true`);
    });
  }finally{await rm(copy,{recursive:true,force:true});}
});
