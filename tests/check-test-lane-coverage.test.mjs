import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findUncoveredTests, reachableTests, workflowCommands } from "../scripts/check-test-lane-coverage.mjs";

function fixture({ scripts, workflow, tests }) {
  const root = mkdtempSync(join(tmpdir(), "control-room-lane-coverage-"));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  for (const file of tests) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(join(root, ".github/workflows/ci.yml"), workflow);
  return root;
}

test("an unused package script cannot disguise an uncovered test", () => {
  const root = fixture({
    scripts: { "test:live": "node --test tests/live.test.ts", "test:unused": "node --test tests/orphan.test.ts" },
    workflow: "steps:\n  - run: pnpm run test:live\n",
    tests: ["tests/live.test.ts", "tests/orphan.test.ts"],
  });
  try { assert.deepEqual(findUncoveredTests(root), ["tests/orphan.test.ts"]); }
  finally { rmSync(root, { recursive: true }); }
});

test("nested tests are discovered and workflow-reachable script chains are followed", () => {
  const root = fixture({
    scripts: { test: "pnpm test:nested", "test:nested": "node --test tests/nested/covered.test.mjs" },
    workflow: "steps:\n  - run: |\n      pnpm run test\n",
    tests: ["tests/nested/covered.test.mjs", "tests/nested/orphan.test.mjs"],
  });
  try { assert.deepEqual(findUncoveredTests(root), ["tests/nested/orphan.test.mjs"]); }
  finally { rmSync(root, { recursive: true }); }
});

test("look-alike filenames do not count as exact test arguments", () => {
  const reached = reachableTests({}, ["node --test tests/case.test.tsx"]);
  assert.equal(reached.has("tests/case.test.tsx"), true);
  assert.equal(reached.has("tests/case.test.ts"), false);
});

test("keep-going runner names reach their package chains without covering unused scripts", () => {
  const scripts = { suite: "pnpm a && pnpm b", a: "node --test tests/a.test.mjs",
    b: "node --test tests/b.test.mjs", unused: "node --test tests/unused.test.mjs" };
  assert.deepEqual([...reachableTests(scripts,
    ["node scripts/ci/run-scripts-keep-going.mjs --jobs 1 --expand suite"])].sort(),
    ["tests/a.test.mjs", "tests/b.test.mjs"]);
  for (const flags of ["--jobs 2", "--unknown"]) {
    assert.deepEqual([...reachableTests(scripts,
      [`node scripts/ci/run-scripts-keep-going.mjs ${flags} suite`])], []);
  }
});

test("quoted and block workflow commands are extracted", () => {
  assert.deepEqual(workflowCommands([
    "steps:",
    "  - run: pnpm install --frozen-lockfile",
    "  - run: 'pnpm run test:one'",
    "  - run: |",
    "      pnpm run test:two",
    "      node --test tests/direct.test.js",
  ].join("\n")), ["pnpm install --frozen-lockfile", "pnpm run test:one", "pnpm run test:two\nnode --test tests/direct.test.js"]);
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { b8ExternalHostInventoryV1,b8HostGateCommandV1,validateB8ExternalHostTitlesV1 } from '../scripts/check-test-lane-coverage.mjs';
import { runB8HostGateV1,b8P71CasesV1,b8U81CasesV1,validateB8ProductTapV1,executeB8HostChildV1 } from '../scripts/check-loop-selection-host-gate.mjs';

const expectedP71=['qualified fixture defaults','deterministic merged encoding','unknown model refusal'];
const expectedU81=['ordinary eligible','bound acknowledged review','final builder refusal','manual refusal','chained refusal','recovery refusal',
  'post-claim source drift zero workers','legacy no-context parity',...Array.from({length:30},(_,i)=>'stable admission '+String(i+1).padStart(2,'0'))];
function tap(parent,children){return ['TAP version 13','# Subtest: '+parent,...children.flatMap((c,i)=>['    # Subtest: '+c,'    ok '+(i+1)+' - '+c]),
  '    1..'+children.length,'ok 1 - '+parent,'1..1','# tests '+(children.length+1),'# fail 0','# cancelled 0','# skipped 0','# todo 0',''].join('\n');}
function gateFixture(){
  const suites=b8ExternalHostInventoryV1.slice(0,13).map((id,i)=>({id,argv:['fixture',String(i)],phases:[{name:'unittest',expectedCount:2,ids:['fixture/'+i+'/one','fixture/'+i+'/two']}]}));
  const reports=suites.map(s=>({schemaVersion:1,suite:s.id,finalStatus:'PASS',phases:s.phases.map(p=>({name:p.name,checks:p.ids.map(id=>({id,status:'pass'})),executed:2,passed:2,failed:0,skipped:0,notRun:0}))}));
  const pins={productSha:'a'.repeat(40),toolsSha:'b'.repeat(40),inventorySha256:'c'.repeat(64)};
  const receipt={schemaVersion:1,toolsSha:pins.toolsSha,inventorySha256:pins.inventorySha256,suites:reports};
  const configuration={root:'.',loop:'.',python:'fixture',env:{},timeoutMs:1000,pins,inventory:{schemaVersion:1,suites}};
  const result=stdout=>({code:0,signal:null,stdout,stderr:'',cleaned:true,failed:false});
  return {configuration,receipt,outputs:[result(''),result(tap('U81 real selection check',expectedU81)),result(tap('P71 real settings check',expectedP71))]};
}
function updateTools(f){f.outputs[0].stdout='TOOLS HOST PASS expectedSuites=13 executedSuites=13 skipped=0\nB8_TOOLS_RECEIPT '+JSON.stringify(f.receipt)+'\n';}
const harness=pathToFileURL(resolve('scripts/check-loop-selection-host-gate.mjs')).href;
function runFixtureProcess(f){
  updateTools(f);const code=`import {runB8HostGateV1} from ${JSON.stringify(harness)};const f=${JSON.stringify(f)};let n=0;process.exitCode=await runB8HostGateV1({preflight:()=>f.configuration,execute:async()=>f.outputs[n++],log:console.log});`;
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env,timeout:10000,maxBuffer:1048576});
}

test('B8 host inventory validates literal product titles and exact broad exclusions against real source',()=>{
  assert.equal(b8ExternalHostInventoryV1.length,15);assert.equal(b8HostGateCommandV1,'node scripts/check-loop-selection-host-gate.mjs');
  validateB8ExternalHostTitlesV1(process.cwd());assert.deepEqual(b8P71CasesV1,expectedP71);assert.deepEqual(b8U81CasesV1,expectedU81);
  for(const change of ['renamed','duplicate','neighbor','nonmatching-exclusion','host-in-linux']){
    const root=fixture({scripts:{'test:loop-selection:host':b8HostGateCommandV1,unit:"node --test --test-skip-pattern='^P71 real settings check$' tests/loop-policy.test.ts"},workflow:'steps:\n - run: pnpm run unit\n',tests:['tests/loop-policy.test.ts','tests/loop-selection-native.test.ts']});
    try{
      writeFileSync(join(root,'tests/loop-policy.test.ts'),'test("P71 real settings check",()=>{});\ntest("portable neighbor",()=>{});\n');
      writeFileSync(join(root,'tests/loop-selection-native.test.ts'),"test('U81 real selection check',()=>{});\n");
      validateB8ExternalHostTitlesV1(root);
      if(change==='renamed')writeFileSync(join(root,'tests/loop-policy.test.ts'),'test("renamed real settings",()=>{});\n');
      if(change==='duplicate')writeFileSync(join(root,'tests/loop-policy.test.ts'),'test("P71 real settings check",()=>{});\ntest("P71 real settings check",()=>{});\n');
      if(change==='neighbor'||change==='nonmatching-exclusion'){
        const p=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));p.scripts.unit=p.scripts.unit.replace('^P71 real settings check$',change==='neighbor'?'^portable neighbor$':'^missing$');writeFileSync(join(root,'package.json'),JSON.stringify(p));
      }
      if(change==='host-in-linux')writeFileSync(join(root,'.github/workflows/ci.yml'),'steps:\n - run: node --test tests/loop-selection-native.test.ts\n');
      assert.throws(()=>validateB8ExternalHostTitlesV1(root),undefined,change);
    }finally{rmSync(root,{recursive:true,force:true});}
  }
});

test('B8 complete host wrapper positive control and independent zero/partial/name/count/TAP refusals',async()=>{
  const positive=gateFixture();updateTools(positive);let next=0;const logs=[];
  assert.equal(await runB8HostGateV1({preflight:()=>positive.configuration,execute:async()=>positive.outputs[next++],log:l=>logs.push(l)}),0);
  assert.equal(next,3);assert.ok(logs.some(l=>l.startsWith('HOST GATE PASS')));
  const control=runFixtureProcess(gateFixture());assert.equal(control.status,0,control.stdout+control.stderr);assert.match(control.stdout,/HOST GATE PASS/);
  const negatives={
    'empty Python exit zero':f=>{const p=f.receipt.suites[0].phases[0];p.checks=[];p.executed=p.passed=0;},
    'partial Python exit zero':f=>{const p=f.receipt.suites[0].phases[0];p.checks.pop();p.executed=p.passed=1;},
    'same count wrong name':f=>{f.receipt.suites[0].phases[0].checks[0].id='renamed';},
    'missing tools suite':f=>{f.receipt.suites.pop();},
    'missing phase':f=>{f.receipt.suites[0].phases=[];},
    'duplicate ID':f=>{f.receipt.suites[0].phases[0].checks[1].id=f.receipt.suites[0].phases[0].checks[0].id;},
    'forged count':f=>{f.receipt.suites[0].phases[0].passed=3;},
    'empty parent':f=>{f.outputs[1].stdout=tap('U81 real selection check',[]);},
    'partial parent':f=>{f.outputs[1].stdout=tap('U81 real selection check',expectedU81.slice(1));},
    'renamed subcase':f=>{f.outputs[1].stdout=f.outputs[1].stdout.replaceAll('ordinary eligible','renamed');},
    'duplicate subcase':f=>{f.outputs[1].stdout=tap('U81 real selection check',[expectedU81[1],...expectedU81.slice(1)]);},
    'extra parent':f=>{f.outputs[1].stdout+='ok 2 - extra\n';},
    'wrong parent':f=>{f.outputs[1].stdout=tap('wrong parent',expectedU81);},
    'file wrapper spoof':f=>{f.outputs[1].stdout=tap('tests/loop-selection-native.test.ts',expectedU81);},
    'logged title spoof':f=>{f.outputs[1].stdout='# U81 real selection check\nTAP version 13\n1..0\n';},
    'skip':f=>{f.outputs[1].stdout=f.outputs[1].stdout.replace('ordinary eligible\n','ordinary eligible # SKIP\n');},
    'todo':f=>{f.outputs[1].stdout=f.outputs[1].stdout.replace('ordinary eligible\n','ordinary eligible # TODO\n');},
    'not ok':f=>{f.outputs[1].stdout=f.outputs[1].stdout.replace('    ok 1','    not ok 1');},
    'truncated TAP':f=>{f.outputs[1].stdout=f.outputs[1].stdout.slice(0,100);},
    'nonzero child':f=>{f.outputs[0].code=1;},
    'signal':f=>{f.outputs[0].signal='SIGTERM';},
    'timeout':f=>{f.outputs[0].failed=true;},
    'cleanup incomplete':f=>{f.outputs[0].cleaned=false;},
  };
  for(const [name,change] of Object.entries(negatives)){
    const f=gateFixture();change(f);const r=runFixtureProcess(f);
    assert.equal(r.status,1,name+': '+r.stdout+r.stderr);assert.doesNotMatch(r.stdout,/HOST GATE PASS|B8_HOST_RECEIPT/);assert.match(r.stdout,/HOST GATE FAIL/);
  }
  // Tools failures must block the complete wrapper even with two otherwise valid product hierarchies.
  const f=gateFixture();f.receipt.suites[0].phases=[];updateTools(f);let called=0;
  assert.equal(await runB8HostGateV1({preflight:()=>f.configuration,execute:async()=>f.outputs[called++],log:()=>{}}),1);assert.equal(called,1);
  // Truncated/absent receipt and bridge NOT RUN exercise the actual runner separately.
  for(const output of ['', 'TOOLS HOST PASS\nB8_TOOLS_RECEIPT {', f.outputs[0].stdout+'RESULT: NOT RUN (0 checks)\n']){
    const v=gateFixture();v.outputs[0].stdout=output;let n=0;assert.equal(await runB8HostGateV1({preflight:()=>v.configuration,execute:async()=>v.outputs[n++],log:()=>{}}),1);
  }
});

test('B8 structural TAP rejects wrong nesting and malformed plans independent of exit status',()=>{
  const good=tap('P71 real settings check',expectedP71);
  assert.equal(validateB8ProductTapV1(good,'P71 real settings check',expectedP71).passed,4);
  for(const bad of [good.replace('    1..3','    1..2'),good.replace('    ok 1','        ok 1'),good.replace('1..1\n','1..0\n'),good+'ok 2 - extra\n'])
    assert.throws(()=>validateB8ProductTapV1(bad,'P71 real settings check',expectedP71));
});

test('B8 owned foreground child timeout is nonzero evidence and is reaped',async()=>{
  const result=await executeB8HostChildV1(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:process.cwd(),env:{PATH:'/usr/bin:/bin'},timeoutMs:100});
  assert.equal(result.failed,true);assert.notEqual(result.code,0);assert.ok(result.signal);assert.equal(result.cleaned,true);
});

import { symlinkSync } from 'node:fs';

test('B8 independent wrong-name assertion fails with exact-name guard removed and passes restored',()=>{
  mkdirSync(resolve('.test-tmp'),{recursive:true});const root=mkdtempSync(resolve('.test-tmp/b8-host-guard-'));
  try{
    mkdirSync(join(root,'scripts'));symlinkSync(resolve('src'),join(root,'src'));
    symlinkSync(resolve('scripts/check-test-lane-coverage.mjs'),join(root,'scripts/check-test-lane-coverage.mjs'));
    const original=readFileSync(resolve('scripts/check-loop-selection-host-gate.mjs'),'utf8');
    const anchor='expected.every(id=>ids.includes(id))';assert.equal(original.split(anchor).length,2);
    const file=join(root,'scripts/check-loop-selection-host-gate.mjs'),f=gateFixture();
    f.receipt.suites[0].phases[0].checks[0].id='same-count-renamed';updateTools(f);
    const run=()=>{
      const code=`import assert from 'node:assert/strict';import {runB8HostGateV1} from ${JSON.stringify(pathToFileURL(file).href)};const f=${JSON.stringify(f)};let n=0;const status=await runB8HostGateV1({preflight:()=>f.configuration,execute:async()=>f.outputs[n++],log:()=>{}});assert.equal(status,1,'independent wrong-name rejection');`;
      const env={...process.env};delete env.NODE_TEST_CONTEXT;
      return spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',env,timeout:10000});
    };
    writeFileSync(file,original);assert.equal(run().status,0);
    writeFileSync(file,original.replace(anchor,'true'));const mutant=run();assert.equal(mutant.status,1);assert.match(mutant.stderr,/independent wrong-name rejection/);assert.doesNotMatch(mutant.stderr,/SyntaxError|ERR_MODULE_NOT_FOUND/);
    writeFileSync(file,original);assert.equal(run().status,0);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('B8 failed children report identity, exit state and bounded secret-filtered tails',async()=>{
  for(const failure of [{code:7},{signal:'SIGTERM'},{failed:true},{cleaned:false}]){
    const f=gateFixture();updateTools(f);Object.assign(f.outputs[0],failure,{
      stdout:['old stdout',...Array.from({length:45},(_,i)=>'stdout '+i),'API_KEY=fixture-sensitive','API KEY=fixture-sensitive','PRIVATE_KEY=fixture-sensitive','passphrase=fixture-sensitive','Bearer fixture-sensitive','Set-Cookie: session=fixture-sensitive','AWS_ACCESS_KEY_ID=fixture-sensitive','ghp_fixture-sensitive','Authorization: Bearer fixture-sensitive','https://user:fixture-sensitive@example.invalid','last stdout'].join('\n'),
      stderr:['old stderr',...Array.from({length:45},(_,i)=>'stderr '+i),'password=fixture-sensitive','-----BEGIN PRIVATE KEY-----','last stderr'].join('\n'),
    });
    const logs=[];let called=0;
    assert.equal(await runB8HostGateV1({preflight:()=>f.configuration,execute:async()=>f.outputs[called++],log:l=>logs.push(l)}),1);
    assert.equal(called,1);const output=logs.join('\n');
    assert.match(output,/fixture -B check_b8_host_gate.py/);
    assert.match(output,/code=/);assert.match(output,/signal=/);assert.match(output,/cleaned=/);assert.match(output,/failed=/);
    assert.match(output,/stdout tail/);assert.match(output,/stderr tail/);
    assert.match(output,/last stdout/);assert.match(output,/last stderr/);
    assert.doesNotMatch(output,/old stdout|old stderr|stdout 0\n|stderr 0\n|fixture-sensitive|PRIVATE KEY/);
    assert.ok(logs.at(-1).startsWith('HOST GATE FAIL:'));
  }
});
