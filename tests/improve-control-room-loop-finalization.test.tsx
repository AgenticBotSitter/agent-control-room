import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";
import { syntheticRecoveryEngine, seedRecoveryRun, recoveryKey } from "./helpers/improve-control-room-loop-recovery";
import { ImproveControlRoomLoopServiceV1 } from "../src/web/v1/improve-control-room-loop-service";
import { buildActionInbox } from "../src/web/v1/action-inbox";
import { ActionInboxPanel } from "../private-app/app/needs-me/action-inbox";
import { sha256Digest } from "../src/security";

const ordinary = process.env.CONTROL_ROOM_B3C_LOAD !== "1" && process.env.CONTROL_ROOM_B3C_REQUIRE_A2 !== "1";
if (ordinary) test("B3c terminal run reaches shared attention without a browser driver", async t => {
  const f = await taskFixture(); t.after(() => f.db.close());
  const e = await syntheticRecoveryEngine(t), scope = {tenantId:"tenant:web",workspaceId:"workspace:web"};
  const saved = await seedRecoveryRun({...f,db:f.client,scope},e,f.project.projectId,()=>now,"b3c-red-seed");
  await e.edit(saved.run,{state:"stopped"});
  const prospective:LoopFinalizationCapabilityV1 = { enabled:()=>true,
    source:{toolingRevision:e.adapter.toolingRevision,schemaDigest:e.adapter.schemaDigest,readVerifiedCompletion:async()=>{throw new Error("SYNTHETIC no candidate");}},
    repository:{observe:async()=>{throw new Error("SYNTHETIC no repository");}},withFence:async(_binding,work)=>work(),
    retain:async()=>{throw new Error("GET must never retain");},appendRecord:async()=>{throw new Error("GET must never append");}, inspect:async target => ({observation:{schemaVersion:1,
    binding:{...target,eventDigest:sha256Digest("SYNTHETIC durable Stop")},outcome:"stopped",reasonCode:"STOPPED",
    evidenceDigest:sha256Digest("SYNTHETIC Stop evidence"),completionDigest:null,inventoryDigest:sha256Digest("SYNTHETIC inventory"),observedAt:new Date(now).toISOString()},termination:null}),
    readRecord:async()=>null };
  const adapter = {...e.adapter, finalization:prospective};
  const bridge = new ImproveControlRoomLoopServiceV1(f.client,scope,{integrityKey:recoveryKey,adapter},()=>now);
  const attention = await bridge.readAttention(f.identity);
  assert.equal(attention.state,"available");
  assert.equal(attention.state === "available" ? attention.items.length : -1,1,"B3c terminal lifecycle row count actual0/expected1 on predecessor");
  if(attention.state!=="available")return;
  const inbox=buildActionInbox([],[],now,attention.items);
  assert.equal(inbox[0]!.kind,"notification"); assert.match(inbox[0]!.summary,/stopped/i);
  assert.equal(inbox[0]!.href,`/projects/${encodeURIComponent(f.project.projectId)}/improvements#request=${encodeURIComponent(saved.id)}`);
  assert.match(renderToStaticMarkup(<ActionInboxPanel data={{tasks:{state:"loading"},operator:{state:"loading"}}} items={inbox} />),/stopped/i);
});

import { finalizationFixture, persistentFinalizationCapability, KEY, type FixtureState } from "./helpers/improve-control-room-loop-finalization";
import { createImproveControlRoomLoopFinalizerV1, captureLoopFinalizationCapabilityV1, verifyFinalizationRecordV1,
  type LoopFinalizationCapabilityV1, type LoopFinalizationRecordV1 } from "../src/web/v1/improve-control-room-loop-finalization";
import { loopAttentionKey, loopAttentionComplete, loopAttentionItemSchemaV1 } from "../src/web/v1/improve-control-room-loop-attention-wire";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../src/security";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { origin, request, trust } from "./helpers/web-foundation";
import { createImproveControlRoomLoopRecoveryV1 } from "../src/web/v1/improve-control-room-loop-recovery";
import type { TestContext } from "node:test";
async function using(t:TestContext){const f=await finalizationFixture();t.after(f.close);return f;}
const signal=()=>new AbortController().signal;
async function direct(f:Awaited<ReturnType<typeof finalizationFixture>>,capability:LoopFinalizationCapabilityV1=f.capability,
  publish=f.publish,authorize=async()=>f.target){
  return createImproveControlRoomLoopFinalizerV1({capability,publishCompletion:publish,authorize,signal:signal()}).finalize(f.target);
}
if(ordinary){
  test("B3c bootstrap observes terminal runs using the existing server cycle",async t=>{
    const {taskStartupFixture}=await import("./helpers/task-startup");
    const {createPrivateTaskBootstrap}=await import("../src/web/v1/private-task-startup");
    const {instant}=await import("./hermes-native-fixture");
    const f=await taskStartupFixture();t.after(f.close);
    const e=await syntheticRecoveryEngine(t),clock=()=>instant+7000,projectId=f.plannerConfig.template.authority.projectId;
    const saved=await seedRecoveryRun(f,e,projectId,clock,"b3c-bootstrap");await e.edit(saved.run,{state:"stopped"});
    const status=await e.raw.status(saved.run);
    const start=(await f.db.query<{command_id:string;binding:unknown}>("SELECT command_id,binding FROM control_loop_improvement_commands WHERE request_id=$1 AND entry_kind='claim' AND operation='start'",[saved.id])).rows[0]!;
    const auth=(await f.db.query<{id:string}>("SELECT id FROM control_loop_improvement_authorizations WHERE request_id=$1",[saved.id])).rows[0]!;
    const target={schemaVersion:1 as const,...f.scope,projectId,requestId:saved.id,ownerIdentityId:"identity:test",runLinkId:saved.link,localVersion:1,
      authorizationId:auth.id,startCommandId:start.command_id,startBindingDigest:sha256Digest(start.binding),run:status.run,inputVersion:status.inputVersion,
      requestSha256:status.confirmation!.sha256,settingsSha256:status.settingsSha256,settingsDigest:status.settingsDigest,expectedRevision:status.revision,schemaDigest:e.adapter.schemaDigest};
    const bytes=Buffer.from("SYNTHETIC stopped output retained independently of scratch");await writeFile(join(e.root,"output.txt"),bytes);
    const inventory={"output.txt":sha256Digest([...bytes])};
    const state:FixtureState={target,ended:true,retentionDigest:sha256Digest(inventory),corpus:inventory,
      observation:{schemaVersion:1,binding:{...target,eventDigest:sha256Digest("SYNTHETIC durable stopped event")},outcome:"stopped",reasonCode:"STOPPED",
        evidenceDigest:sha256Digest("SYNTHETIC Stop proof"),completionDigest:null,inventoryDigest:sha256Digest(inventory),observedAt:new Date(clock()).toISOString()}};
    await writeFile(join(e.root,"finalization-state.json"),JSON.stringify(state));
    const unavailable=async()=>{throw new Error("SYNTHETIC non-success never publishes");};
    const capability=await persistentFinalizationCapability(e.root,{source:{toolingRevision:e.adapter.toolingRevision,schemaDigest:e.adapter.schemaDigest,readVerifiedCompletion:unavailable},repository:{observe:unavailable}});
    const bootstrap=createPrivateTaskBootstrap({openDatabase:f.openDatabase,clock,install:()=>{}});
    const app=await bootstrap.start({...f.config,loopBridge:{integrityKey:recoveryKey,adapter:{...e.configuration,contract:{...e.configuration.contract,finalization:capability}}}});
    try{
      const deadline=Date.now()+5000;
      while((await capability.readRecord(target))?.phase!=="cleanup"&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
      const record=await capability.readRecord(target);assert.equal(record?.phase,"cleanup");assert.equal(record?.cleanup?.state,"refused");
      assert.equal((await e.traces()).filter(x=>["advance","wait"].includes(x.op)).length,0);
    }finally{await app.close();}
  });
  test("B3c scan retains once publishes through B4 and keeps the same card after two restarts",async t=>{
    const f=await using(t),before=await Promise.all(Object.keys(f.state.corpus).map(name=>readFile(join(f.retained,name))));
    let drivers=0;
    const worker=createImproveControlRoomLoopRecoveryV1({enabled:()=>true,createCycle:()=>({tick(){},close:async()=>{}}),
      observe:f.bridge.finalizationPort().observe,port:{scan:async()=>({targets:[f.internalTarget],nextCursor:null}),reconcile:async()=>{drivers++;return{state:"blocked"};}}});
    try{await worker.tick();}finally{await worker.close();}
    assert.equal(drivers,1);
    const first=await f.capability.readRecord(f.target);assert.equal(first?.phase,"cleanup");assert.equal(first?.sequence,5);
    assert.equal(first?.cleanup?.state,"refused");assert.equal(first?.termination?.state,"already-ended");
    assert.equal(first?.custody?.retentionDigest,f.evidence().retentionDigest);
    for(let restart=0;restart<2;restart++){
      await f.service().finalizationPort().observe(f.internalTarget,signal());
      assert.deepEqual(await f.capability.readRecord(f.target),first,"B3c stable frozen record and timestamp across restart");
      const attention=await f.service().readAttention(f.identity);assert.equal(attention.state,"available");
      if(attention.state!=="available")throw new Error("attention missing");
      assert.equal(attention.items.length,1);assert.equal(attention.items[0]!.kind,"stall");
      assert.equal("reasonCode"in attention.items[0]!&&attention.items[0].reasonCode,"CLEANUP_REFUSED");
      assert.match(attention.items[0]!.summary,/Scratch is retained/);
      const card=(await f.desk.readLoopCandidate(f.identity,f.project.projectId,f.requestId)).candidate;
      assert.equal(card?.candidateRevision,"b".repeat(40));assert.equal(card?.evidence.retentionDigest,first!.custody!.retentionDigest);
    }
    const after=await Promise.all(Object.keys(f.state.corpus).map(name=>readFile(join(f.retained,name))));assert.deepEqual(after,before);
    assert.equal((await f.client.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidates")).rows[0]!.n,1);
    assert.deepEqual(f.forbidden,[]);
  });
  test("B3c both compositions expose the same retained card without GET effects",async t=>{
    const f=await using(t);await f.observe();const record=await f.capability.readRecord(f.target);
    for(const embedded of [false,true])for(const local of [false,true]){
      const carrier={loopBridge:{integrityKey:KEY,adapter:f.adapter,...(embedded?{loopCandidates:f.config}:{})},...(embedded?{}:{loopCandidates:f.config})};
      let handle:(path:string)=>Promise<Response>,close:()=>Promise<void>;
      if(!local){
        const app=createPrivateWebProcess({origin,...trust,tenantId:"tenant:web",workspaceId:"workspace:web",loadKeys:async()=>trust.keys,clock:()=>now,
          database:{client:f.client,close:async()=>{}},...carrier});
        handle=path=>app.handle(request(path),()=>new Response("unused",{status:404}));close=()=>app.close();
      }else{
        const {LOCAL_OWNER_SESSION_PROFILE_V1}=await import("../src/web/v1/local-owner-session");
        const localOrigin="http://127.0.0.1:60349",ownerCode="SYNTHETIC-B3c-owner-code-long";
        const app=createMacLocalWebProcessV1({origin:localOrigin,workspaceId:"workspace:web",clock:()=>now,
          localOwnerSession:{schema:LOCAL_OWNER_SESSION_PROFILE_V1,origin:localOrigin,tenantId:"tenant:web",provider:trust.issuer,subject:"test-owner",ownerCodeDigest:sha256Digest({ownerCode}),sessionSeconds:900},
          database:{client:f.client,close:async()=>{},isAvailable:()=>true},...carrier});
        const login=await app.handle(new Request(localOrigin+"/api/v1/local-owner-session",{method:"POST",headers:{origin:localOrigin,"content-type":"application/json"},body:JSON.stringify({ownerCode})}),()=>new Response("unused"));
        assert.equal(login.status,201);const cookie=login.headers.get("set-cookie")!;
        handle=path=>app.handle(new Request(localOrigin+path,{headers:{cookie}}),()=>new Response("unused",{status:404}));close=()=>app.close();
      }
      try{
        const response=await handle("/api/v1/needs-me/action-items");
        assert.equal(response.status,200);assert.equal((await response.json()).loop.items.length,1);
        const card=await handle(`/api/v1/projects/${f.project.projectId}/improvements/loop/${f.requestId}/candidate`);
        assert.equal(card.status,200);assert.equal((await card.json()).candidate.candidateRevision,"b".repeat(40));
      }finally{await close();}
    }
    assert.deepEqual(await f.capability.readRecord(f.target),record);assert.deepEqual(f.forbidden,[]);
  });
  test("B3c pinned failures stopped and stalls keep one truthful current row",async t=>{
    const f=await using(t);
    for(const [outcome,reason,state,kind] of [["failed","FAILED","refused","failed"],["stopped","STOPPED","stopped","stopped"],["stalled","PROVIDER_UNAVAILABLE","running","stall"]] as const){
      f.editStatus({state});f.state.observation={...f.state.observation,outcome,reasonCode:reason,completionDigest:null,
        binding:{...f.state.observation.binding,eventDigest:sha256Digest({outcome,reason})},evidenceDigest:sha256Digest({outcome,reason,inputVersion:f.target.inputVersion})};await f.save();
      await f.observe();const source=await f.bridge.readAttention(f.identity);assert.equal(source.state,"available");
      if(source.state!=="available")throw new Error("source");assert.equal(source.items.length,1);assert.equal(source.items[0]!.kind,kind);
      assert.equal("reasonCode"in source.items[0]!&&source.items[0].reasonCode,reason);
      assert.equal((await f.capability.readRecord(f.target))?.publication,null);
    }
    assert.equal((await f.client.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidates")).rows[0]!.n,0);
  });
  test("B3c absent disabled and throwing opt-ins are inert",async t=>{
    const f=await using(t);let effects=0;
    for(const enabled of [()=>false,()=>{throw new Error("SYNTHETIC disabled");}]){
      const c={...f.capability,enabled,inspect:async(target:typeof f.target)=>{effects++;return f.capability.inspect(target);}};
      const bridge=new ImproveControlRoomLoopServiceV1(f.client,f.scope,{integrityKey:KEY,adapter:{...f.adapter,finalization:c},loopCandidates:f.config},()=>now);
      await bridge.finalizationPort().observe(f.internalTarget,signal());await bridge.readAttention(f.identity);
    }
    assert.equal(effects,0);assert.equal(await f.capability.readRecord(f.target),null);
  });
  test("B3c Stop and changed input fence each retained phase without destructive effects",async t=>{
    for(const phase of ["retained","terminated","published","announced","cleanup"] as const){
      const f=await finalizationFixture();let changed=false;
      try{
        const c={...f.capability,appendRecord:async(b:Parameters<typeof f.capability.appendRecord>[0],r:LoopFinalizationRecordV1)=>{
          const saved=await f.capability.appendRecord(b,r);if(r.phase===phase)changed=true;return saved;
        }};
        await assert.rejects(direct(f,c,f.publish,async()=>changed?{...f.target,expectedRevision:f.target.expectedRevision+1}:f.target));
        assert.equal((await f.capability.readRecord(f.target))?.phase,phase);
        assert.deepEqual(f.forbidden,[]);
      }finally{await f.close();}
    }
  });
  test("B3c active authority blocks source effects before inspection",async t=>{
    const f=await using(t);let effects=0;
    const c={...f.capability,inspect:async(target:typeof f.target)=>{effects++;return f.capability.inspect(target);}};
    const bridge=new ImproveControlRoomLoopServiceV1(f.client,f.scope,{integrityKey:KEY,adapter:{...f.adapter,finalization:c},loopCandidates:f.config},()=>now);
    await f.client.query("UPDATE control_role_grants SET revoked_at=$1",[new Date(now).toISOString()]);
    await assert.rejects(bridge.finalizationPort().observe(f.internalTarget,signal()));assert.equal(effects,0);
  });
  test("B3c current binding admission forbids publication",async t=>{
    const f=await using(t);let publications=0;
    await direct(f,f.capability,async()=>{publications++;return f.publish();},async()=>({...f.target,ownerIdentityId:"identity:foreign"})).catch(()=>{});
    assert.equal(publications,0,"B3c forbidden binding publication count is zero");
  });
  test("B3c terminal and quiescent admission forbids publication",async t=>{
    const f=await using(t);let publications=0;
    for(const outcome of ["running","owner_gate","uncertain"] as const){
      f.state.observation={...f.state.observation,outcome,completionDigest:null};f.state.ended=false;await f.save();
      await direct(f,f.capability,async()=>{publications++;return f.publish();}).catch(()=>{});
      await rm(join(f.retained,"finalization-record.json"),{force:true});
    }
    f.state.observation={...f.state.observation,outcome:"candidate_ready",completionDigest:f.evidence().completionDigest};await f.save();
    await direct(f,f.capability,async()=>{publications++;return f.publish();}).catch(()=>{});
    assert.equal(publications,0,"B3c forbidden live writer publication count is zero");
  });
  test("B3c uncertain admission never starts custody",async t=>{
    const f=await using(t);f.state.ended=false;await f.save();let custody=0,publications=0;
    const c={...f.capability,retain:async(b:Parameters<typeof f.capability.retain>[0],inventory:string)=>{custody++;return f.capability.retain(b,inventory);}};
    await direct(f,c,async()=>{publications++;return f.publish();}).catch(()=>{});
    assert.equal(custody,0,"B3c forbidden quiescent admission custody count is zero");
    assert.equal(publications,0);
  });
  test("B3c late revoked owner clears lifecycle result",async t=>{
    const f=await using(t);await f.observe();
    const c={...f.capability,readRecord:async(target:typeof f.target)=>{
      const record=await f.capability.readRecord(target);
      await f.client.query("UPDATE control_role_grants SET revoked_at=$1",[new Date(now).toISOString()]);return record;
    }};
    const bridge=new ImproveControlRoomLoopServiceV1(f.client,f.scope,{integrityKey:KEY,adapter:{...f.adapter,finalization:c},loopCandidates:f.config},()=>now);
    let protectedRows=0;
    try{const source=await bridge.readAttention(f.identity);if(source.state==="available")protectedRows=source.items.filter(i=>"reasonCode"in i).length;}catch{/* Access loss clears the whole source in the real client. */}
    assert.equal(protectedRows,0,"B3c late protected lifecycle row count is zero");
  });
  test("B3c retention verification forbids publication and announcement",async t=>{
    const f=await using(t);let publications=0;
    await writeFile(join(f.retained,"output.txt"),"SYNTHETIC corrupt retained output");
    await direct(f,f.capability,async()=>{publications++;return f.publish();}).catch(()=>{});
    assert.equal(publications,0,"B3c missing corpus publication count is zero");
    assert.equal(await f.capability.readRecord(f.target),null,"B3c missing corpus announcement count is zero");
  });
  test("B3c destructive callbacks are never invoked",async t=>{
    const f=await using(t);let destructive=0;
    const malicious={...f.capability,stopOwned:async()=>{destructive++;},removeOwnedScratch:async()=>{destructive++;}};
    const captured=captureLoopFinalizationCapabilityV1(malicious)!;
    assert.equal("stopOwned"in captured,false);assert.equal("removeOwnedScratch"in captured,false);
    const sentinel=spawn(process.execPath,["--import","tsx",join(process.cwd(),"tests/helpers/improve-control-room-loop-finalization.ts"),"--fixture-host","second-run-sentinel",f.retained],
      {shell:false,stdio:["ignore","ignore","ignore","ipc"],env:{PATH:process.env.PATH,NODE_ENV:"test",CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:"1"}});
    try{
      await once(sentinel,"message");await direct(f,malicious);
      assert.equal(sentinel.exitCode,null);assert.equal(sentinel.signalCode,null);assert.equal(sentinel.killed,false);
      assert.equal(destructive,0,"B3c sentinel destructive callback count is zero");
    }finally{const exited=once(sentinel,"close");sentinel.send("close");await exited;}
    assert.equal((await f.capability.readRecord(f.target))?.cleanup?.state,"refused");
  });
  test("B3c duplicate finalizers enter retention once",async t=>{
    const f=await using(t);let entries=0;
    const capability={...f.capability,retain:async(b:Parameters<typeof f.capability.retain>[0],inventory:string)=>{entries++;return f.capability.retain(b,inventory);}};
    await Promise.allSettled([direct(f,capability),direct(f,capability)]);
    assert.equal(entries,2,"B3c one finalizer alone reaches two custody verifications");
    assert.equal((await f.capability.readRecord(f.target))?.sequence,5);
  });
  test("B3c forged publisher receipt never creates finish",async t=>{
    const f=await using(t);
    await direct(f,f.capability,async()=>({...await f.publish(),requestId:"request:foreign"})).catch(()=>{});
    const record=await f.capability.readRecord(f.target);
    assert.equal(record?.publication,null,"B3c forged publisher finish count is zero");
  });
  test("B3c append boundaries and publisher reply loss reconcile twice",async t=>{
    for(const phase of ["retained","terminated","published","announced","cleanup"] as const)for(const after of [false,true]){
      const f=await finalizationFixture();
      try{
        let crashed=false;
        const c={...f.capability,appendRecord:async(binding:Parameters<typeof f.capability.appendRecord>[0],record:LoopFinalizationRecordV1)=>{
          if(record.phase===phase&&!crashed){crashed=true;if(after)await f.capability.appendRecord(binding,record);throw new Error("SYNTHETIC append crash");}
          return f.capability.appendRecord(binding,record);
        }};
        await assert.rejects(direct(f,c));
        for(let restart=0;restart<2;restart++)await direct(f);
        const last=await f.capability.readRecord(f.target);assert.equal(last?.phase,"cleanup");assert.equal(last?.sequence,5);
        assert.equal((await f.client.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidates")).rows[0]!.n,1);
      }finally{await f.close();}
    }
    const f=await using(t);let lose=true;
    await assert.rejects(direct(f,f.capability,async()=>{const p=await f.publish();if(lose){lose=false;throw new Error("SYNTHETIC B4 committed reply lost");}return p;}));
    await direct(f);await direct(f);
    assert.equal((await f.client.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidates")).rows[0]!.n,1);
  });
  test("B3c CI commands remain unconditional on both manifest paths",async()=>{
    const {reachableTests,workflowCommands}=await import("../scripts/check-test-lane-coverage.mjs");
    const manifest=JSON.parse(await readFile("package.json","utf8")),workflow=await readFile(".github/workflows/ci.yml","utf8");
    for(const name of ["test:improve-control-room-loop-finalization-mutations","test:improve-control-room-loop-finalization-load","test:improve-control-room-loop-finalization-browser"]){
      const command=`run: pnpm run ${name}`,at=workflow.indexOf(command);assert.ok(at>=0);
      const preceding=workflow.slice(workflow.lastIndexOf("      - name:",at),at);assert.doesNotMatch(preceding,/\n\s+if:/u);
    }
    for(const source of [workflow,workflow.replace(/steps\.manifest\.outputs\.exists == 'true'/g,"false")]){
      const commands=workflowCommands(source),reached=reachableTests(manifest.scripts,commands);
      assert.ok(reached.has("tests/improve-control-room-loop-finalization.test.tsx"));assert.ok(reached.has("tests/improve-control-room-loop-finalization-mutations.test.ts"));
      assert.ok(commands.includes("pnpm run test:improve-control-room-loop-finalization-browser"));
    }
    assert.match(manifest.scripts["test:improve-control-room-loop-finalization-browser"],/^CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 playwright test tests\/browser\/improve-control-room-loop-finalization\.spec\.ts$/);
    assert.equal(reachableTests(manifest.scripts,["pnpm run test:components"]).has("tests/improve-control-room-loop-finalization-mutations.test.ts"),false);
  });
  test("B3c strict records and stable lifecycle keys preserve legacy keys",async t=>{
    const f=await using(t);await f.observe();const r=(await f.capability.readRecord(f.target))!;
    assert.throws(()=>verifyFinalizationRecordV1({...r,sequence:r.sequence+1},f.target));
    assert.throws(()=>verifyFinalizationRecordV1({...r,extra:true},f.target));
    assert.throws(()=>verifyFinalizationRecordV1({...r,cleanup:{...r.cleanup,state:"complete"}},f.target));
    const source=await f.bridge.readAttention(f.identity);if(source.state!=="available")throw new Error("source");
    const i=source.items[0]!,key=loopAttentionKey(i);
    assert.equal(loopAttentionKey({...i,localVersion:i.localVersion+1,observedAt:new Date(now+5000).toISOString()}),key);
    assert.notEqual(loopAttentionKey({...i,projectId:"project:different"}),key);assert.notEqual(loopAttentionKey({...i,requestId:"request:different"}),key);
    const legacy=loopAttentionItemSchemaV1.parse({projectId:"project:old",requestId:"request:old",runLinkId:"link:old",localVersion:1,engineRevision:2,
      kind:"blocked",identity:{kind:"blocked",code:"UNAVAILABLE"},title:"Check saved request",summary:"Unavailable",observedAt:new Date(now).toISOString()});
    assert.equal(loopAttentionKey(legacy),JSON.stringify([legacy.projectId,legacy.requestId,legacy.runLinkId,legacy.localVersion,legacy.identity]));
    assert.equal(loopAttentionComplete({schemaVersion:1,state:"available",truncated:true,items:[]}),false);
    const finished=loopAttentionItemSchemaV1.parse({...i,kind:"finish",identity:{kind:"finish",completionDigest:r.publication!.completionDigest},reasonCode:"FINISHED",candidate:r.publication!.candidate});
    assert.equal(loopAttentionKey(finished),JSON.stringify(["finish",i.projectId,i.requestId,i.runLinkId,r.publication!.completionDigest]));
  });
}

if(process.env.CONTROL_ROOM_B3C_REQUIRE_A2==="1")test("B3c reviewed retention and refused cleanup contract",async()=>{
  const modulePath=process.env.CONTROL_ROOM_B3C_A2_CONTRACT;
  assert.ok(modulePath&&isAbsolute(modulePath)&&!/(?:^|[/\\])(?:\.env|\.codex|\.hermes|\.aws|auth\.json|tokens?)(?:[/\\]|$)/i.test(modulePath),"B3c requires a lead-supplied nonsecret reviewed A2 contract");
  const contract=await import(pathToFileURL(modulePath).href);
  assert.equal(typeof contract.qualifyB3cRetention,"function");
  const proof=await contract.qualifyB3cRetention({createImproveControlRoomLoopFinalizerV1,ImproveControlRoomLoopServiceV1});
  for(const field of ["reviewed","productionCapability","retainedBytesVerified","outwardRoutesDenied","scratchRetained","cleanupRefused"])assert.equal(proof[field],true);
  assert.equal(proof.serviceRestarts,2);assert.equal(proof.signals,0);assert.equal(proof.removals,0);
  for(const field of ["toolingRevision","schemaDigest","implementationDigest"])assert.match(proof[field],/^sha256:[a-f0-9]{64}$/);
  assert.ok(Array.isArray(proof.entrypoints)&&proof.entrypoints.length>0);
});

import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
if(process.env.CONTROL_ROOM_B3C_LOAD==="1")test("B3c 24 finalizers retain once and refuse destruction",{timeout:150000},async t=>{
  const f=await using(t),other=await using(t),children=new Set<ChildProcess>();
  const events:{child:ChildProcess;kind:string;[key:string]:unknown}[]=[];
  let publications=0;
  const waitFor=async(predicate:()=>boolean)=>{
    const deadline=Date.now()+60000;
    while(!predicate()){assert.ok(Date.now()<deadline,"B3c measured host barrier reached");await new Promise(r=>setTimeout(r,10));}
  };
  const start=()=>{
    const child=spawn(process.execPath,["--import","tsx",join(process.cwd(),"tests/helpers/improve-control-room-loop-finalization.ts"),"--fixture-host","finalizer-host",f.retained],
      {shell:false,stdio:["ignore","ignore","pipe","ipc"],env:{PATH:process.env.PATH,NODE_ENV:"test",CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:"1"}});
    children.add(child);let stderr="";child.stderr?.on("data",chunk=>{stderr+=String(chunk);});
    child.on("message",async(raw:unknown)=>{
      const message=raw as {kind:string;input?:{runLinkId:string;completionDigest:string}};
      events.push({child,...message});
      if(message.kind==="publish"){
        try{
          publications++;const receipt=await f.publisher.publishCompletion(message.input!);
          if(publications===1){events.push({child,kind:"committed-reply-dropped"});return;}
          await new Promise(r=>setTimeout(r,40));child.send({kind:"publication",receipt});
        }
        catch{events.push({child,kind:"publisher-error"});child.send({kind:"publication",receipt:null});}
      }
    });
    child.on("close",()=>{if(child.exitCode!==0&&child.signalCode===null)events.push({child,kind:"host-error",stderr});});
    return child;
  };
  const close=async(child:ChildProcess)=>{
    if(child.exitCode!==null||child.signalCode!==null)return;
    const closed=once(child,"close");child.kill("SIGTERM");let timer:ReturnType<typeof setTimeout>|undefined;
    try{timer=setTimeout(()=>child.kill("SIGKILL"),2000);await closed;}finally{clearTimeout(timer);}
  };
  try{
    const cohort=Array.from({length:24},start);await waitFor(()=>events.filter(e=>e.kind==="ready").length===24);
    const began=Date.now();for(const child of cohort)child.send({kind:"go"});
    await waitFor(()=>events.filter(e=>e.kind==="busy").length===23&&events.some(e=>e.kind==="acquired"));
    assert.equal(events.filter(e=>e.kind==="acquired").length,1);assert.equal(events.filter(e=>e.kind==="busy").length,23);
    const held=events.find(e=>e.kind==="acquired")!.child;
    const responseBegan=Date.now();let stopped=false;
    const otherCapability={...other.capability,appendRecord:async(b:Parameters<typeof other.capability.appendRecord>[0],r:LoopFinalizationRecordV1)=>{
      const record=await other.capability.appendRecord(b,r);if(r.phase==="retained"){stopped=true;other.editStatus({state:"stopped",revision:other.target.expectedRevision+1});}return record;
    }};
    await direct(other,otherCapability,other.publish,async()=>stopped?{...other.target,expectedRevision:other.target.expectedRevision+1}:other.target).catch(()=>{});
    assert.equal((await other.capability.readRecord(other.target))?.phase,"retained","B3c loaded Stop halfway retains evidence before refusal");
    await other.bridge.status(other.identity,other.project.projectId,other.requestId);
    assert.ok(Date.now()-responseBegan<=2000,"B3c another run progresses with status within two seconds");
    // Crash the holder while its OS fence is held. No age/PID takeover is used.
    const dead=once(held,"close");held.kill("SIGKILL");await dead;
    assert.equal(await f.capability.readRecord(f.target),null);assert.equal(publications,0);
    const retry=start();await waitFor(()=>events.some(e=>e.child===retry&&e.kind==="ready"));retry.send({kind:"go"});
    await waitFor(()=>events.some(e=>e.child===retry&&e.kind==="acquired"));retry.send({kind:"release"});
    await waitFor(()=>events.some(e=>e.child===retry&&e.kind==="committed-reply-dropped"));
    const lost=once(retry,"close");retry.kill("SIGKILL");await lost;
    assert.equal((await f.capability.readRecord(f.target))?.phase,"terminated");
    const replay=start();await waitFor(()=>events.some(e=>e.child===replay&&e.kind==="ready"));replay.send({kind:"go"});
    await waitFor(()=>events.some(e=>e.child===replay&&e.kind==="acquired"));replay.send({kind:"release"});
    await waitFor(()=>events.some(e=>e.child===replay&&e.kind==="done"));
    assert.equal(events.filter(e=>["error","host-error","publisher-error"].includes(e.kind)).length,0,JSON.stringify(events.filter(e=>e.kind.endsWith("error")).map(e=>({kind:e.kind,stderr:e.stderr}))));
    for(let restart=0;restart<2;restart++)await f.service().finalizationPort().observe(f.internalTarget,signal());
    const record=await f.capability.readRecord(f.target);assert.equal(record?.sequence,5);assert.equal(record?.cleanup?.state,"refused");
    assert.equal(publications,2,"B3c committed publication reply loss replays the same candidate");
    assert.equal((await f.client.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidates")).rows[0]!.n,1);
    console.log(`B3c load hosts=24 losing_paths=23 retained_corpora=1 publications=1 publication_requests=2 announcements=1 signals=0 removals=0 elapsed_ms=${Date.now()-began}`);
  }finally{await Promise.all([...children].map(close));}
});
