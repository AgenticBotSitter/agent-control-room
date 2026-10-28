import assert from "node:assert/strict";
import { test,expect,type BrowserContext } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createPrivateWebProcess } from "../../src/web/v1/private-process";
import { taskFixture } from "../helpers/web-task";
import { now, origin, request, trust } from "../helpers/web-foundation";
import { loopImprovementRunIdentitySchemaV1,loopImprovementObservationSchemaV1 } from "../../src/improve-control-room/v1/schemas";
import { sha256Digest } from "../../src/security";
const KEY=new Uint8Array(32).fill(64),toolingRevision=sha256Digest({fixture:"SYNTHETIC B4 tooling"}),schemaDigest=sha256Digest({fixture:"SYNTHETIC B4 schema"});
const contract={toolingRevision,decodeRunIdentity:(v:unknown)=>loopImprovementRunIdentitySchemaV1.parse(v),decodeObservation:(v:unknown)=>loopImprovementObservationSchemaV1.parse(v),matchesSavedInput:()=>true};
async function syntheticFixture() {
  const f = await taskFixture();
  const { ImproveControlRoomDeskServiceV1 } = await import("../../src/improve-control-room/v1/service");
  const { ImproveControlRoomLoopServiceV1 } = await import("../../src/web/v1/improve-control-room-loop-service");
  const { LoopCandidatePublisherV1, LoopCandidateStaleCompletionV1 } = await import("../../src/improve-control-room/v1/loop-candidate-publisher");
  const { loopByteHashV1 } = await import("../../src/web/v1/improve-control-room-loop-adapter");
  const { loopCandidateEvidenceSchemaV1 } = await import("../../src/improve-control-room/v1/loop-candidate-wire");
  const { canonicalJson, hmacSha256Tag } = await import("../../src/security");
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
    '{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}'::jsonb) WHERE id=$1`,[f.project.projectId]);
  const settingsText='{"fixture":"SYNTHETIC B4"}', description="SYNTHETIC finished improvement";
  const run={adapterId:"adapter:synthetic",loopRunId:"synthetic-run:b4",toolingRevision,a2SchemaVersion:1 as const};
  const confirmedContract={...contract,matchesSavedInput:(_run:unknown,o:{settingsDigest:string;confirmation:{sha256:string}},i:{description:string;settingsText:string}) =>
    o.settingsDigest===loopByteHashV1(i.settingsText) && o.confirmation.sha256===loopByteHashV1(i.description)};
  let status: import("../../src/web/v1/improve-control-room-loop-adapter").LoopEngineStatusV1={run,revision:4,inputVersion:"SYNTHETIC:1",state:"ready",description,
    settingsSha256:loopByteHashV1(settingsText),settingsDigest:loopByteHashV1(settingsText),
    confirmation:{path:"request.md",sha256:loopByteHashV1(description),at:new Date(now).toISOString(),who:"owner",input_version:"SYNTHETIC:1"},
    approval:null,question:null,progress:{step:"final",completed:1,attention:"none"},receipts:[]};
  const forbidden:string[]=[], unexpected=async()=>{forbidden.push("unexpected operation");throw new Error("SYNTHETIC forbidden");};
  const adapter:import("../../src/web/v1/improve-control-room-loop-adapter").LoopAdapterV1={adapterId:run.adapterId,toolingRevision,schemaDigest,settingsText,contract:confirmedContract,
    reserveRun:()=>run.loopRunId,available:()=>true,status:async()=>structuredClone(status),intake:unexpected,confirmRequest:unexpected,approve:unexpected,answer:unexpected,
    start:async(id,b,fence)=>{fence();status={...status,state:"running",revision:5,receipts:[{commandId:id,bindingDigest:sha256Digest(b),state:"accepted",error:null,evidenceDigest:sha256Digest({fixture:"SYNTHETIC Start"})}]};return structuredClone(status);},
    stop:unexpected,close:async()=>{}};
  const lineage=new ImproveControlRoomDeskServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},KEY,undefined,()=>now,confirmedContract);
  const draft=await lineage.saveLoopDraft(f.identity,f.project.projectId,{description,settingsText},"b4-synthetic-draft-0001");
  const link=await lineage.recordLoopRunLink({projectId:f.project.projectId,requestId:draft.request.requestId,initialInputVersion:1,run});
  await lineage.authorizeLoopStart(f.identity,f.project.projectId,{requestId:draft.request.requestId,expectedVersion:1,runLinkId:link.runLink.runLinkId,
    requestSha256:loopByteHashV1(description),settingsSha256:loopByteHashV1(settingsText)},"b4-synthetic-start-0001",{
    inputVersion:status.inputVersion,settingsDigest:status.settingsDigest,revision:status.revision,confirmation:status.confirmation!});
  const bridge=new ImproveControlRoomLoopServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},{integrityKey:KEY,adapter},()=>now);
  await bridge.mutate(f.identity,f.project.projectId,draft.request.requestId,"start",{expectedVersion:1,expectedRevision:4,runLinkId:link.runLink.runLinkId},"b4-synthetic-start-0001");
  const head="b".repeat(40),base="a".repeat(40),d=sha256Digest({fixture:"SYNTHETIC B4 custody"});
  const startedAt=new Date(now-1000).toISOString(),endedAt=new Date(now).toISOString();
  let evidence:import("../../src/improve-control-room/v1/loop-candidate-wire").LoopCandidateEvidenceV1=loopCandidateEvidenceSchemaV1.parse({schemaVersion:1,
    binding:{projectId:f.project.projectId,requestId:draft.request.requestId,runLinkId:link.runLink.runLinkId,localVersion:1,...run,a2InputVersion:"SYNTHETIC:1",engineRevision:6,
      requestSha256:loopByteHashV1(description),settingsSha256:loopByteHashV1(settingsText),baseRevision:base,candidateRevision:head,inputsDigest:d,recipeDigest:d,environmentDigest:d},
    summary:"SYNTHETIC finished candidate",changedAreas:["Owner finish card"],databaseChanges:{kind:"none"},
    checks:[{id:"check:synthetic",required:true,commandLabel:"SYNTHETIC fixture checks",receiptDigest:d,outputDigest:d,candidateRevision:head,status:"PASS",exitCode:0,
      completed:3,passed:3,failed:0,skipped:0,durationMs:1000,startedAt,endedAt}],
    reviews:[{current:true,stepId:"review:final",role:"final",attempt:2,requestedModel:"SYNTHETIC final",observedModel:"SYNTHETIC observed",identityVerified:true,
      family:"synthetic-reviewer",verdict:"CLEAN",candidateRevision:head,inputVersion:"SYNTHETIC:1",reportDigest:d,sidecarDigest:d,startedAt,endedAt},
      {current:false,stepId:"review:old",role:"code",attempt:1,requestedModel:"SYNTHETIC requested",observedModel:null,identityVerified:false,
        family:null,verdict:"NEEDS-FIX",candidateRevision:base,inputVersion:"SYNTHETIC:1",reportDigest:d,sidecarDigest:d,startedAt,endedAt}],
    findings:[{origin:"review:old",id:"finding:one",severity:"HIGH",disposition:"FIXED",summary:"SYNTHETIC repair retained",evidenceDigest:d}],
    rounds:{attempts:2,reviewRejections:1,repairs:1,redesigns:0},timing:{startedAt,finishedAt:endedAt,durationMs:1000},
    assumptions:[{id:"assumption:one",text:"SYNTHETIC input validated",status:"validated",evidenceDigest:d}],
    validations:[{id:"validation:one",text:"SYNTHETIC receipt checked",status:"PASS",evidenceDigest:d}],
    overrides:{allowSameFamilyReview:false,allowStandardFinal:false,waivedConflicts:[],fallback:null},completionDigest:d,retentionDigest:d});
  status={...status,state:"finished",revision:6};
  let calls=0,unavailable=false,dirty=false;
  const fs=await import("node:fs"),path=await import("node:path"),crypto=await import("node:crypto");
  fs.mkdirSync(path.resolve(".test-tmp"),{recursive:true});
  const retained=fs.mkdtempSync(path.resolve(".test-tmp/b4-retained-")),rootIdentity=fs.lstatSync(retained);
  const bytesDigest=(bytes:string|Buffer)=>`sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  const recipe={argv:["synthetic-check","--fixture"],parser:"SYNTHETIC counts/v1",requiredIds:["check:synthetic"]};
  const output="completed=3 passed=3 failed=0 skipped=0\n";
  const rawReceipt={schemaVersion:1,argv:recipe.argv,parser:recipe.parser,candidateRevision:head,baseRevision:base,
    requestSha256:evidence.binding.requestSha256,settingsSha256:evidence.binding.settingsSha256,inputsDigest:d,
    recipeDigest:sha256Digest(recipe),environmentDigest:d,buildAttempt:2,inputVersion:"SYNTHETIC:1",exitCode:0,
    completed:3,passed:3,failed:0,skipped:0,startedAt,endedAt,durationMs:1000,outputDigest:bytesDigest(output)};
  const receiptBytes=JSON.stringify(rawReceipt);
  evidence.binding.recipeDigest=sha256Digest(recipe);evidence.checks[0]!.receiptDigest=bytesDigest(receiptBytes);evidence.checks[0]!.outputDigest=bytesDigest(output);
  let proof={argv:true,output:true,seals:true,approvals:true,policy:true,retention:true};
  const writeRetained=()=>{
    const {completionDigest:_completion,retentionDigest:_retention,...terminalEvidence}=evidence;
    const terminal=JSON.stringify({schemaVersion:1,state:"finished",evidence:terminalEvidence});
    evidence.completionDigest=bytesDigest(terminal);
    const retention=JSON.stringify({terminalDigest:bytesDigest(terminal),receiptDigest:bytesDigest(receiptBytes),outputDigest:bytesDigest(output)});
    evidence.retentionDigest=bytesDigest(retention);
    fs.writeFileSync(path.join(retained,"terminal.json"),terminal);fs.writeFileSync(path.join(retained,"retention.json"),retention);
    const manifest=JSON.stringify({evidence,receiptDigest:bytesDigest(receiptBytes),outputDigest:bytesDigest(output),
      policy:{ownerApprovals:proof.approvals,checkerEligible:proof.policy,builderFamily:"synthetic-builder",finalFamily:"synthetic-reviewer"},
      retentionDigest:proof.retention?evidence.retentionDigest:sha256Digest({wrong:"retention"})});
    fs.writeFileSync(path.join(retained,"completion.json"),manifest);
    fs.writeFileSync(path.join(retained,"completion.auth"),proof.seals?hmacSha256Tag(KEY,{fixture:"SYNTHETIC retained manifest",manifest}):`hmac-sha256:${"0".repeat(64)}`);
    fs.writeFileSync(path.join(retained,"receipt.json"),proof.argv?receiptBytes:JSON.stringify({...rawReceipt,argv:["different-check"]}));
    fs.writeFileSync(path.join(retained,"output.txt"),proof.output?output:"completed=999 passed=999 failed=0 skipped=0\n");
  };
  writeRetained();
  const source={toolingRevision,schemaDigest,readVerifiedCompletion:async(runLinkId:string)=>{
    calls++;if(unavailable)throw new Error("SYNTHETIC unavailable");if(status.state!=="finished")throw new LoopCandidateStaleCompletionV1();
    const fail=()=>{throw new Error("SYNTHETIC custody verification refused");};
    const current=fs.lstatSync(retained);
    if(runLinkId!==link.runLink.runLinkId || current.isSymbolicLink() || !current.isDirectory()
      || current.dev!==rootIdentity.dev || current.ino!==rootIdentity.ino)fail();
    for(const name of ["completion.json","completion.auth","receipt.json","output.txt","terminal.json","retention.json"]){
      const st=fs.lstatSync(path.join(retained,name));if(!st.isFile()||st.isSymbolicLink()||st.size>131072)fail();
    }
    const manifest=fs.readFileSync(path.join(retained,"completion.json"),"utf8"),seal=fs.readFileSync(path.join(retained,"completion.auth"),"utf8");
    if(seal!==hmacSha256Tag(KEY,{fixture:"SYNTHETIC retained manifest",manifest}))fail();
    const saved=JSON.parse(manifest),raw=fs.readFileSync(path.join(retained,"receipt.json")),out=fs.readFileSync(path.join(retained,"output.txt"));
    if(bytesDigest(raw)!==saved.receiptDigest||bytesDigest(out)!==saved.outputDigest
      || !saved.policy.ownerApprovals || !saved.policy.checkerEligible || saved.policy.builderFamily===saved.policy.finalFamily
      || saved.retentionDigest!==saved.evidence.retentionDigest
      || bytesDigest(fs.readFileSync(path.join(retained,"terminal.json")))!==saved.evidence.completionDigest
      || bytesDigest(fs.readFileSync(path.join(retained,"retention.json")))!==saved.evidence.retentionDigest
      || saved.evidence.reviews.find((r:{current:boolean;role:string})=>r.current&&r.role==="final")?.family!==saved.policy.finalFamily)fail();
    const receipt=JSON.parse(raw.toString("utf8")),e=saved.evidence as typeof evidence,b=e.binding,c=e.checks[0];
    if(!c || e.checks.length!==recipe.requiredIds.length || c.id!==recipe.requiredIds[0] || !c.required || canonicalJson(receipt.argv)!==canonicalJson(recipe.argv)||receipt.parser!==recipe.parser
      || b.recipeDigest!==sha256Digest(recipe)||receipt.candidateRevision!==b.candidateRevision||receipt.baseRevision!==b.baseRevision
      || receipt.requestSha256!==b.requestSha256||receipt.settingsSha256!==b.settingsSha256||receipt.inputVersion!==b.a2InputVersion
      || receipt.inputsDigest!==b.inputsDigest||receipt.environmentDigest!==b.environmentDigest
      || c.receiptDigest!==bytesDigest(raw)||c.outputDigest!==bytesDigest(out)
      || receipt.completed!==c.completed||receipt.passed!==c.passed||receipt.failed!==c.failed||receipt.skipped!==c.skipped
      || receipt.exitCode!==c.exitCode||receipt.startedAt!==c.startedAt||receipt.endedAt!==c.endedAt||receipt.durationMs!==c.durationMs
      || out.toString("utf8")!==`completed=${c.completed} passed=${c.passed} failed=${c.failed} skipped=${c.skipped}\n`)fail();
    return structuredClone(e);
  }};
  let observations=0,stopAt=Infinity,repositoryHead=head;
  const repository={observe:async()=>{observations++;if(observations===stopAt)status={...status,state:"stopped"};if(dirty)throw new Error("SYNTHETIC dirty repository");return {baseRevision:base,candidateRevision:repositoryHead,
    changedPaths:["src/fixture.ts"],addedPaths:["src/fixture.ts"],commitSubjects:["SYNTHETIC candidate"]};}};
  const config={integrityKey:KEY,contract:confirmedContract,schemaDigest,source,repository};
  const desk=new ImproveControlRoomDeskServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},KEY,undefined,()=>now,confirmedContract,config);
  const publisher=new LoopCandidatePublisherV1(desk,config);
  const app=createPrivateWebProcess({origin,...trust,tenantId:"tenant:web",workspaceId:"workspace:web",loadKeys:async()=>trust.keys,clock:()=>now,
    database:{client:f.client,close:async()=>{}},loopCandidates:config,loopBridge:{integrityKey:KEY,adapter}});
  const handle=(r:Request)=>app.handle(r,()=>new Response("unused",{status:404}));
  return {...f,config,adapter,desk,lineage,bridge,app,publisher,handle,forbidden,requestId:draft.request.requestId,runLinkId:link.runLink.runLinkId,
    evidence:()=>structuredClone(evidence),edit:(change:(e:typeof evidence)=>void)=>{change(evidence);writeRetained();},retained,calls:()=>calls,
    unavailable:(v:boolean)=>{unavailable=v;},stop:()=>{status={...status,state:"stopped"};},stopAtLastSnapshot:()=>{stopAt=observations+2;},moveRepositoryHead:(v:string)=>{repositoryHead=v;},dirty:(v:boolean)=>{dirty=v;},proof:(name:keyof typeof proof,v:boolean)=>{proof={...proof,[name]:v};writeRetained();},
    publish:()=>publisher.publishCompletion({runLinkId:link.runLink.runLinkId,completionDigest:evidence.completionDigest}),
    close:async()=>{await app.close();await bridge.close();await f.db.close();fs.rmSync(retained,{recursive:true,force:true});}};
}

for(const width of [360,1280])for(const colorScheme of ["light","dark"] as const)for(const decision of ["accept","decline"] as const)test(`B4 SYNTHETIC finished candidate Home saved request and inert ${decision} retry at ${width}px ${colorScheme}`,async({browser},testInfo)=>{
 const f=await syntheticFixture();const decidedState=decision==="accept"?"Accepted":"Declined";let context:BrowserContext|undefined,release:()=>void=()=>{},lost=true,deny=false;
 const posts:{path:string;body:string;key:string}[]=[],unexpected:string[]=[];
 try{
  // Completion is recorded with no browser open. This is the agreed synthetic receipt link, not B3c attention proof.
  const rows=(await f.lineage.viewLoopDesk(f.identity,f.project.projectId)).loopRequests;
  const href=`/projects/${encodeURIComponent(f.project.projectId)}/improvements#request=${encodeURIComponent(f.requestId)}`;
  const bundle=await build({write:false,bundle:true,platform:"browser",format:"iife",jsx:"automatic",stdin:{resolveDir:process.cwd(),loader:"tsx",contents:`
   import React from 'react';import {createRoot} from 'react-dom/client';
   import {HomeDashboard} from './private-app/app/home-workspace';
   import {ImprovementRunPanel} from './private-app/app/improvement-run-panel';
   const root=createRoot(document.getElementById('root'));
   root.render(window.location.pathname==='/'?<HomeDashboard data={{activity:{state:'unavailable'},projects:{state:'unavailable'},connections:{state:'ready',value:{source:'local',value:{taskWorkersStarted:true,workers:[],projectSections:[]}}},attention:{state:'unavailable'}}}/>:<ImprovementRunPanel projectId=${JSON.stringify(f.project.projectId)} requests={${JSON.stringify(rows)}} fresh={true}/>);
  `},plugins:[{name:"unexercised-legacy-crypto",setup(builder){builder.onResolve({filter:/^node:crypto$/},()=>({path:"node:crypto",namespace:"unused"}));builder.onLoad({filter:/.*/,namespace:"unused"},()=>({contents:'export function createHash(){throw new Error("unused_legacy_crypto")}',loader:"js"}));}}]});
  const css=(await Promise.all(["node_modules/tailwindcss/preflight.css","styles/control-room.css","private-app/app/private.css"].map(p=>readFile(p,"utf8")))).join("\n");
  context=await browser.newContext({viewport:{width,height:850},isMobile:width<500,hasTouch:width<500,colorScheme});
  await context.route("**/*",async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin!=="https://product.invalid"){unexpected.push(req.url());await route.abort();return;}
   if(url.pathname==="/bundle.js"){await route.fulfill({contentType:"application/javascript",body:bundle.outputFiles[0]!.text});return;}
   if(req.isNavigationRequest()){await route.fulfill({contentType:"text/html",body:`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>`});return;}
   if(url.pathname.includes("loop-update-candidates")||url.pathname.endsWith("/candidate")||url.pathname.endsWith("/status")){
    if(deny){await route.fulfill({status:403,json:{error:"access_denied"}});return;}
    if(req.method()==="POST")posts.push({path:url.pathname,body:req.postData()!,key:req.headers()["idempotency-key"]!});
    const response=await f.handle(request(url.pathname,req.method(),req.postData()?JSON.parse(req.postData()!):undefined,req.headers()["idempotency-key"]??"b4-browser-read-0001"));
    if(req.method()==="POST"&&lost){await new Promise<void>(r=>{release=r;});lost=false;await route.abort("failed");return;}
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});return;
   }
   if(url.pathname.startsWith("/api/")){await route.fulfill({status:404,json:{}});return;}
   unexpected.push(req.url());await route.abort();
  });
  const emptyPage=await context.newPage();await emptyPage.goto("https://product.invalid"+href);
  await expect(emptyPage.getByText("No verified candidate is recorded for this view.",{exact:true})).toBeVisible();
  await expect(emptyPage.getByText("Completion reported; candidate evidence unavailable",{exact:true})).toBeVisible();
  await expect(emptyPage.getByRole("article",{name:"Finished candidate",exact:true})).toHaveCount(0);
  // Finish publication while the page is closed; reopen Home to find it.
  await emptyPage.close();const receipt=await f.publish();
  const page=await context.newPage();await page.goto("https://product.invalid/");
  const card=page.getByRole("article",{name:"Finished candidate",exact:true});await expect(card).toContainText("b".repeat(40));
  await expect(card).toContainText("Finished candidate — waiting for your decision");
  await expect(card).toContainText("Evidence checked just now");
  expect(posts).toHaveLength(0);
  f.unavailable(true);await page.getByRole("button",{name:"Refresh candidate",exact:true}).click();
  await expect(page.getByText("Candidate evidence unavailable. Decisions are blocked.",{exact:true})).toBeVisible();
  await expect(card).toContainText("Evidence retained; current status unverified");
  await expect(card).not.toContainText("Evidence checked just now");
  await page.screenshot({path:testInfo.outputPath("retained.png"),fullPage:true});
  await expect(card.getByRole("button",{name:decision==="accept"?"Accept this candidate — record only":"Decline this candidate — record only",exact:true})).toBeDisabled();
  f.unavailable(false);await page.getByRole("button",{name:"Refresh candidate",exact:true}).click();
  await expect(card.getByRole("button",{name:decision==="accept"?"Accept this candidate — record only":"Decline this candidate — record only",exact:true})).toBeEnabled();
  expect(posts).toHaveLength(0);await card.getByText("Show evidence",{exact:true}).click();
  await expect(card).toContainText("3 completed, 3 passed, 0 failed, 0 skipped · 1 second");
  await expect(card.locator('span[title="1000 milliseconds"]')).toHaveCount(2);await expect(card).toContainText("Unverified");
  for(const label of ["Findings","Assumptions and validations","Recorded overrides"])await card.getByText(label,{exact:true}).click();
  await expect(card).toContainText("SYNTHETIC repair retained");await expect(card).toContainText("Same-family review override: Disabled");
  await card.getByRole("link",{name:"Open saved request",exact:true}).click();await expect(page).toHaveURL("https://product.invalid"+receipt.href);
  await expect(card).toContainText("b".repeat(40));
  await expect(page.getByText("Finished",{exact:true})).toBeVisible();
  await expect(page.getByText("Completion reported; candidate evidence unavailable",{exact:true})).toHaveCount(0);
  await card.getByText("Show evidence",{exact:true}).click();
  for(const label of ["Findings","Assumptions and validations","Recorded overrides"])await card.getByText(label,{exact:true}).click();
  await page.screenshot({path:testInfo.outputPath("saved-request.png"),fullPage:true});
  const accept=card.getByRole("button",{name:decision==="accept"?"Accept this candidate — record only":"Decline this candidate — record only",exact:true});
  await expect(accept).toBeEnabled();expect(await accept.evaluate(e=>e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  const stale=await context.newPage();await stale.goto("https://product.invalid"+receipt.href);
  const staleAction=stale.getByRole("button",{name:decision==="accept"?"Accept this candidate — record only":"Decline this candidate — record only",exact:true});
  await expect(staleAction).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await accept.click();await expect(accept).toBeDisabled();expect(posts).toHaveLength(1);
  release();const retry=card.getByRole("button",{name:"Retry this exact decision",exact:true});await expect(retry).toBeEnabled();await retry.click();
  await expect(card).toContainText(decidedState);expect(posts).toHaveLength(2);expect(posts[1]).toEqual(posts[0]);
  await staleAction.evaluate(element=>(element as HTMLButtonElement).click());
  await expect(stale.getByText("Decision refused. Refresh the saved candidate.",{exact:true})).toBeVisible();
  expect(posts).toHaveLength(3);expect(posts[2]!.key).not.toBe(posts[0]!.key);await stale.close();
  expect((await f.db.query<{n:number}>("SELECT count(*)::int n FROM control_loop_update_candidate_decisions")).rows[0]!.n).toBe(1);
  const postCount=posts.length;await page.reload();await expect(card).toContainText(decidedState);await page.evaluate(()=>window.dispatchEvent(new Event("focus")));expect(posts).toHaveLength(postCount);
  f.stop();await page.getByRole("button",{name:"Refresh candidate",exact:true}).click();await expect(card).toContainText("Evidence is out of date; decisions are blocked.");
  await expect(card).not.toContainText("Evidence checked just now");
  await expect(page.getByText("Completion reported; candidate evidence unavailable",{exact:true})).toBeVisible();
  deny=true;await page.getByRole("button",{name:"Refresh candidate",exact:true}).click();await expect(page.getByText("Candidate evidence unavailable. Decisions are blocked.",{exact:true})).toBeVisible();
  await expect(card).toHaveCount(0);expect(unexpected).toEqual([]);expect(f.forbidden).toEqual([]);
 }finally{release();await context?.close();await f.close();}
});
