import assert from "node:assert/strict";
import { Buffer as NodeBuffer } from "node:buffer";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { PrivateImproveControlRoomWorkspace } from "../private-app/app/improve-control-room-workspace";
import { now, origin, request, trust } from "./helpers/web-foundation";
import { ImproveControlRoomLoopServiceV1 } from "../src/web/v1/improve-control-room-loop-service";
import { createImproveControlRoomHttpHandlerV1 } from "../src/web/v1/improve-control-room-http";
import { loopImprovementDraftSchemaV1, loopBridgeBindingSchemaV1, loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1, type LoopBridgeBindingV1 } from "../src/improve-control-room/v1/schemas";
import { loopByteHashV1, type LoopEngineStatusV1, type LoopAdapterV1 } from "../src/web/v1/improve-control-room-loop-adapter";
import { type LoopImprovementDecisionsV1 } from "../src/web/v1/improve-control-room-loop-attention-wire";
import { loopDecisionsBrowserClient as decisionClient } from "../src/web/v1/improve-control-room-loop-decisions-browser-client";
import { LoopReadError } from "../src/web/v1/improve-control-room-loop-browser-client";
import { useSharedTaskAttention, refreshSharedTaskAttention } from "../private-app/app/shared-task-attention";
import { PrivateHeader } from "../private-app/app/private-header";
import { HomeDashboard } from "../private-app/app/home-workspace";
import { ActionInboxPanel } from "../private-app/app/needs-me/action-inbox";
import { LocalRuntimeContextV1 } from "../private-app/app/local-runtime";
import { loopAttentionItemSchemaV1, loopAttentionKey, loopDecisionStatusSchemaV1, loopAttentionComplete, loopAttentionUnknown } from "../src/web/v1/improve-control-room-loop-attention-wire";
import { buildActionInbox } from "../src/web/v1/action-inbox";
import { readFile } from "node:fs/promises";
import { reachableTests, workflowCommands } from "../scripts/check-test-lane-coverage.mjs";
import { sha256Digest, hmacSha256Tag } from "../src/security";
import { taskFixture } from "./helpers/web-task";
import { ImproveControlRoomDeskServiceV1 } from "../src/improve-control-room/v1/service";

async function settle() { for (let i = 0; i < 12; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); }
async function mount(projectId: string, fetcher: typeof fetch, fragment = "", content?: React.ReactNode) {
  const dom = new JSDOM("<div id='root'></div>", { url: `https://product.invalid/projects/${projectId}/improvements${fragment}`, pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, fetch: fetcher, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(content ?? <PrivateImproveControlRoomWorkspace projectId={projectId} />));
  return { dom, root, text: () => dom.window.document.body.textContent!,
    button: (text: string) => [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === text)!,
    close: async () => { await act(async () => root.unmount()); dom.window.close();
      for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } };
}

const KEY = new Uint8Array(32).fill(64);
test("B2b browser schemas preserve UTF-8 byte limits without Buffer", () => {
  const binding: LoopBridgeBindingV1 = { schemaVersion:1, body:{text:""}, localVersion:1,
    adapterId:"adapter:synthetic", loopRunId:"run:synthetic", toolingRevision:`sha256:${"a".repeat(64)}`,
    a2SchemaVersion:1, schemaDigest:`sha256:${"b".repeat(64)}`, requestSha256:"c".repeat(64),
    settingsSha256:"d".repeat(64), runLinkId:null, authorizationId:null, inputVersion:null,
    expectedRevision:null, evidence:null };
  for (const [label, unit, width] of [["ASCII","x",1],["multibyte","é",2],["three-byte","€",3],["astral","🧭",4]] as const) {
    for (const bytes of [65536, 65537]) {
      const fill = (overhead: number) => {
        const available = bytes - overhead;
        return unit.repeat(Math.floor(available / width)) + "x".repeat(available % width);
      };
      const settingsText = JSON.stringify({text:fill(NodeBuffer.byteLength(JSON.stringify({text:""}),"utf8"))});
      const input = {...binding, body:{text:fill(NodeBuffer.byteLength(JSON.stringify(binding),"utf8"))}};
      assert.equal(NodeBuffer.byteLength(settingsText,"utf8"),bytes,`${label} settings fixture`);
      assert.equal(NodeBuffer.byteLength(JSON.stringify(input),"utf8"),bytes,`${label} binding fixture`);
      const original = globalThis.Buffer;
      try {
        Reflect.deleteProperty(globalThis,"Buffer");
        const draft = loopImprovementDraftSchemaV1.safeParse({description:"SYNTHETIC request",settingsText});
        const command = loopBridgeBindingSchemaV1.safeParse(input);
        assert.equal(draft.success,bytes === 65536,`${label} settings at ${bytes} UTF-8 bytes`);
        assert.equal(command.success,bytes === 65536,`${label} binding at ${bytes} UTF-8 bytes`);
        if (draft.success) assert.equal(draft.data.settingsText,settingsText);
        if (command.success) assert.deepEqual(command.data,input);
      } finally { globalThis.Buffer = original; }
    }
  }
});
const settingsText = '{"project":{"host_adapter":"local-loop"},"fixture":"SYNTHETIC B2b"}';
const exact = "  Draft with café 🧭\r\nKeep every byte.  ";
async function fixture() {
  const f = await taskFixture();
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
    '{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}'::jsonb) WHERE id=$1`, [f.project.projectId]);
  const toolingRevision = sha256Digest({ fixture: "SYNTHETIC B2b" });
  const contract = { toolingRevision, decodeRunIdentity: (v: unknown) => loopImprovementRunIdentitySchemaV1.parse(v),
    decodeObservation: (v: unknown) => loopImprovementObservationSchemaV1.parse(v),
    matchesSavedInput: (_r: unknown, o: {settingsDigest:string;confirmation:{sha256:string}}, input: {description:string;settingsText:string}) =>
      o.settingsDigest === loopByteHashV1(input.settingsText) && o.confirmation.sha256 === loopByteHashV1(input.description) };
  let saved: LoopEngineStatusV1, sequence = 0, keepQuestion = false;
  const calls: string[] = [];
  const complete = async (op: string, id: string, b: LoopBridgeBindingV1, text?: string) => {
    calls.push(op);
    if (op === "intake") saved = { run: { adapterId:"adapter:synthetic", loopRunId:b.loopRunId, toolingRevision, a2SchemaVersion:1 },
      revision:1, inputVersion:"SYNTHETIC:1", state:"draft", description:text!, settingsSha256:loopByteHashV1(settingsText), settingsDigest:loopByteHashV1(settingsText),
      confirmation:null, approval:null, question:null, progress:{step:"intake",completed:0,attention:"none"}, receipts:[] };
    else {
      saved.revision++;
      if (op === "confirm") { saved.confirmation = {path:"request.md",sha256:loopByteHashV1(saved.description),at:new Date(now).toISOString(),who:"owner",input_version:saved.inputVersion}; saved.state="ready"; }
      if (op === "start") saved.state="running";
      if (op === "stop") saved.state="stopped";
      if (op === "approve") { saved.approval=null; saved.state="running"; }
      if (op === "answer" && !keepQuestion) { saved.question=null; saved.state="running"; }
    }
    saved.receipts.push({commandId:id,bindingDigest:sha256Digest(b),state:"accepted",error:null,evidenceDigest:sha256Digest({op,id})});
    return snapshot();
  };
  let override: LoopImprovementDecisionsV1["gate"] | undefined;
  const snapshot = (): LoopEngineStatusV1 => structuredClone({ ...saved, decisions: { observedAt:new Date(now).toISOString(), gate:
    override !== undefined ? override : ["stopped","finished"].includes(saved.state) ? null : saved.question ? {kind:"question",text:"Choose the saved scope.\r\nKeep café?"}
      : saved.approval ? {kind:"approve"} : !saved.confirmation ? {kind:"confirm"} : null } });
  let documentText = "Sealed complete plan.\n".repeat(4000), documentCalls = 0;
  const adapter: LoopAdapterV1 = { adapterId:"adapter:synthetic", toolingRevision, schemaDigest:sha256Digest({fixture:"SYNTHETIC B2b schema"}),settingsText,contract,
    available:()=>true,reserveRun:()=>`synthetic-run:${++sequence}`,
    intake:(id,b,text)=>complete("intake",id,b,text),confirmRequest:(id,b)=>complete("confirm",id,b),start:(id,b)=>complete("start",id,b),stop:(id,b)=>complete("stop",id,b),
    approve:(id,b)=>complete("approve",id,b),answer:(id,b,text)=>complete("answer",id,b,text),status:async()=>snapshot(),
    readApprovalDocument:async()=>{documentCalls++;return documentText;},close:async()=>{} };
  const desk = new ImproveControlRoomDeskServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},KEY,undefined,()=>now,contract);
  const bridge = new ImproveControlRoomLoopServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},{integrityKey:KEY,adapter},()=>now);
  const handler = createImproveControlRoomHttpHandlerV1({origin,trust,service:desk,loopBridge:bridge,clock:()=>now});
  const posts: {path:string;body:string;key:string}[] = [];
  const transport: typeof fetch = async (input, options) => {
    const path=String(input),method=options?.method??"GET",key=new Headers(options?.headers).get("idempotency-key")??"b2b-read-0000000001";
    if(path==="/api/v1/needs-me/action-items") return Response.json({observedAt:new Date(now).toISOString(),items:[],truncated:false,loop:await bridge.readAttention(f.identity)});
    if(!path.includes("/improvements")) return Response.json({}, {status:404});
    if(method==="POST") posts.push({path,body:String(options?.body),key});
    return handler(request(path,method,options?.body?JSON.parse(String(options.body)):undefined,key));
  };
  const intake=async()=> { const r=await bridge.mutate(f.identity,f.project.projectId,null,"intake",{description:exact},`b2b-intake-fixture-${++sequence}`); return r.requestId; };
  const confirm=async(id:string)=> { const s=await bridge.status(f.identity,f.project.projectId,id); return bridge.mutate(f.identity,f.project.projectId,id,"confirm",
    {expectedVersion:s.request.currentVersion,expectedRevision:s.engine.revision,requestSha256:s.engine.requestSha256,settingsSha256:s.engine.settingsSha256},`b2b-confirm-fixture-${++sequence}`); };
  return { ...f, desk, bridge, handler, adapter, calls, posts, transport, intake, confirm, snapshot,
    edit:(v:Partial<LoopEngineStatusV1>)=>{saved={...saved,...v};}, setGate:(gate: typeof override)=>{override=gate;},
    keepQuestion:()=>{keepQuestion=true;}, documentCalls:()=>documentCalls, document:(text:string)=>{documentText=text;},
    close:async()=>{await bridge.close();await f.db.close();} };
}
async function type(m: Awaited<ReturnType<typeof mount>>, selector: string, value: string) {
  const field=m.dom.window.document.querySelector(selector) as HTMLTextAreaElement;
  assert.ok(field, `field ${selector} exists`);
  await act(async()=>{Object.getOwnPropertyDescriptor(m.dom.window.HTMLTextAreaElement.prototype,"value")!.set!.call(field,value);
    field.dispatchEvent(new m.dom.window.Event("input",{bubbles:true}));field.dispatchEvent(new m.dom.window.Event("change",{bubbles:true}));});
}
const question = {questionId:"question:scope",inputVersion:"SYNTHETIC:1",reportSha256:"e".repeat(64),owner:true,changesInput:false};

test("B2b exact intake confirmation reaches attention", async () => {
  const f=await fixture(),m=await mount(f.project.projectId,f.transport);
  try {
    await settle();assert.match(m.text(),/No improvement requests have been recorded/);
    assert.ok(m.button("Prepare request"),"B2b Prepare request control exists");
    assert.equal(f.posts.length,0,"mount never writes");
    await type(m,"#loop-intake-description",exact);
    // jsdom has no native typing implementation; send React's controlled change through its props.
    const field=m.dom.window.document.querySelector("#loop-intake-description")!;
    const props=(field as unknown as Record<string,{onChange?:(e:unknown)=>void}>)[Object.keys(field).find(k=>k.startsWith("__reactProps"))!];
    await act(async()=>props!.onChange!({target:{value:exact}}));
    await act(async()=>m.button("Prepare request").click());await settle();
    const id=f.posts.length? (await f.desk.viewLoopDesk(f.identity,f.project.projectId)).loopRequests[0]!.requestId : "";
    assert.ok(id);assert.deepEqual(JSON.parse(f.posts[0]!.body),{description:exact});
    assert.equal((await f.bridge.readAttention(f.identity)).state,"available");
    assert.ok(m.text().includes(exact));assert.equal(m.button("Confirm this exact request").disabled,false);
    await act(async()=>m.button("Confirm this exact request").click());await settle();
    assert.equal((await f.bridge.status(f.identity,f.project.projectId,id)).display.confirmationCurrent,true);
    assert.equal(f.calls.filter(c=>c==="start").length,0);
    assert.deepEqual(f.calls,["intake","confirm"]);
    assert.equal(m.button("Start confirmed work").disabled,false);
  }finally{await m.close();await f.close();}
});

test("B2b stale duplicate answer", async()=>{
  const f=await fixture(),id=await f.intake();await f.confirm(id);f.edit({state:"waiting",question});
  const old=await f.bridge.status(f.identity,f.project.projectId,id);
  const body={expectedVersion:1,expectedRevision:old.engine.revision,questionId:question.questionId,inputVersion:question.inputVersion,questionReportSha256:question.reportSha256,text:exact};
  const previous=globalThis.fetch;globalThis.fetch=f.transport;
  try {
    assert.equal((await decisionClient.command(f.project.projectId,id,"answer",{key:"b2b-answer-first-0001",body:JSON.stringify(body)})).state,"accepted");
    await assert.rejects(decisionClient.command(f.project.projectId,id,"answer",{key:"b2b-answer-stale-0001",body:JSON.stringify(body)}),e=>e instanceof LoopReadError&&e.status===409);
    assert.equal(f.calls.filter(c=>c==="answer").length,1);
  }finally{globalThis.fetch=previous;await f.close();}
});

test("B2b lost response answer retry",async()=>{
  const f=await fixture(),id=await f.intake();await f.confirm(id);f.edit({state:"waiting",question});f.keepQuestion();
  let release!:()=>void,lose=true;const held=new Promise<void>(r=>{release=r;});
  const m=await mount(f.project.projectId,(async(p,o)=>{const response=await f.transport(p,o);if(String(p).endsWith("/answer")&&lose){await held;lose=false;throw new Error("SYNTHETIC lost response");}return response;})as typeof fetch,`#request=${encodeURIComponent(id)}`);
  try{
    await settle();await type(m,"#loop-owner-answer",exact);
    const field=m.dom.window.document.querySelector("#loop-owner-answer")!;
    const props=(field as unknown as Record<string,{onChange:(e:unknown)=>void}>)[Object.keys(field).find(k=>k.startsWith("__reactProps"))!];
    await act(async()=>props!.onChange({target:{value:exact}}));
    await act(async()=>{m.button("Send answer").click();m.button("Send answer").click();});
    assert.equal(f.posts.filter(p=>p.path.endsWith("/answer")).length,1,"synchronous answer latch");
    release();await settle();assert.ok(m.button("Retry this exact answer"));
    await act(async()=>m.button("Retry this exact answer").click());await settle();
    const answers=f.posts.filter(p=>p.path.endsWith("/answer"));assert.equal(answers.length,2);assert.deepEqual(answers[1],answers[0]);
    assert.equal(f.calls.filter(c=>c==="answer").length,1);assert.equal(f.calls.filter(c=>c==="start").length,0);
  }finally{release();await m.close();await f.close();}
});

test("B2b complete plan and spec, missing text and engine waits",async()=>{
  const f=await fixture(),id=await f.intake();await f.confirm(id);
  const text="Complete sealed document.\n".repeat(4000);f.document(text);
  f.edit({state:"waiting",approval:{step:"plan",inputVersion:"SYNTHETIC:1",head:"a".repeat(40),reportSha256:loopByteHashV1(text)}});
  const m=await mount(f.project.projectId,f.transport,`#request=${encodeURIComponent(id)}`);
  try{
    await settle();assert.equal(m.dom.window.document.querySelector("pre")?.textContent,text);
    assert.equal(m.button("Approve this plan").disabled,false);await act(async()=>m.button("Approve this plan").click());await settle();
    assert.equal(f.calls.filter(c=>c==="approve").length,1);assert.equal(f.calls.filter(c=>c==="start").length,0);
    f.edit({revision:8,state:"waiting",approval:null,question});f.setGate({kind:"question",text:null});
    await act(async()=>m.button("Refresh status").click());await settle();assert.equal(m.button("Send answer"),undefined);
    const unavailable=await f.bridge.readAttention(f.identity);assert.equal(unavailable.state,"available");
    if(unavailable.state==="available")assert.deepEqual(unavailable.items[0]!.identity,{kind:"blocked",code:"UNAVAILABLE"});
    f.setGate({kind:"blocked",code:"QUESTION_LIMIT",message:"Three saved questions were already asked."});
    await act(async()=>m.button("Refresh status").click());await settle();assert.match(m.text(),/Three saved questions/);
    f.setGate({kind:"question",text:"Change scope?"});f.edit({question:{...question,changesInput:true}});
    await act(async()=>m.button("Refresh status").click());await settle();assert.match(m.text(),/Ask the lead to pause/);assert.equal(m.button("Send answer"),undefined);
    const inputQuestion=await f.bridge.readAttention(f.identity);assert.equal(inputQuestion.state,"available");
    if(inputQuestion.state==="available")assert.equal(inputQuestion.items[0]!.identity.kind,"question","a changes-input descriptor never invents a blocked code outside decisions.gate");
    f.edit({question:{...question,owner:false}});await act(async()=>m.button("Refresh status").click());await settle();assert.match(m.text(),/waiting for the orchestrator/);
    f.edit({state:"stopped",revision:9});f.setGate(undefined);await act(async()=>m.button("Refresh status").click());await settle();assert.equal(m.button("Send answer"),undefined);
  }finally{await m.close();await f.close();}
});

const emptyTaskPage={items:[],nextCursor:null,examined:0,observedAt:new Date(now).toISOString(),startsWork:false,planningSource:"configured",deliverySource:"configured",sources:{ordinary:"included",ideas:"not_configured"}};
const loopRow=()=>loopAttentionItemSchemaV1.parse({projectId:"project:alpha",requestId:"request:alpha",runLinkId:null,localVersion:1,engineRevision:null,
  kind:"blocked",identity:{kind:"blocked",code:"UNAVAILABLE"},title:"Saved protected request",summary:"Check the saved request.",observedAt:new Date(now).toISOString()});
function SharedSurfaces(){
  const attention=useSharedTaskAttention(true);
  return <LocalRuntimeContextV1.Provider value={{mode:"hosted"}}><PrivateHeader />
    <HomeDashboard data={{activity:{state:"unavailable"},projects:{state:"unavailable"},connections:{state:"ready",value:{source:"local",value:{taskWorkersStarted:true,workers:[],projectSections:[]}}},
      attention}}/>
    {attention.state!=="loading"&&attention.data&&<ActionInboxPanel data={attention.data} items={attention.state==="ready"?attention.value.items:undefined}/>}
  </LocalRuntimeContextV1.Provider>;
}

test("B2b shared attention clears protected rows on 403",async()=>{
  let refused=false;
  const fetcher:typeof fetch=async p=>String(p).includes("action-items")?refused?Response.json({}, {status:403}):Response.json({observedAt:new Date(now).toISOString(),items:[],truncated:false,
    loop:{schemaVersion:1,state:"available",items:[loopRow()],truncated:false}}):String(p).includes("/needs-me/tasks")?refused?Response.json({}, {status:503}):Response.json({...emptyTaskPage,examined:1,items:[{
      task:{projectId:"project:alpha",jobId:"job:protected",requestId:"request:task",title:"Saved protected request",state:"failed",version:1,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()},
      inputDigest:`sha256:${"a".repeat(64)}`,reasons:["failed"]}]}):Response.json({}, {status:404});
  const m=await mount("project:alpha",fetcher,"",<SharedSurfaces/>);
  try{
    await settle();assert.match(m.text(),/Saved protected request/);
    refused=true;await act(async()=>{await refreshSharedTaskAttention();});await settle();
    assert.ok(!m.text().includes("Saved protected request"),"B2b access loss removes retained protected rows");
    assert.doesNotMatch(m.text(),/All clear\.|No actions are waiting/);
  }finally{await m.close();}
});

test("B2b lower bounds, unknown counts and loop item dedup",async()=>{
  let mode:"truncated"|"rows"|"failed"|"empty"="truncated";
  const fetcher:typeof fetch=async p=>String(p).includes("action-items")?mode==="failed"?Response.json({}, {status:503}):Response.json({observedAt:new Date(now).toISOString(),items:[],truncated:false,
    loop:{schemaVersion:1,state:"available",items:mode==="rows"?[loopRow()]:[],truncated:mode==="truncated"}}):String(p).includes("/needs-me/tasks")?Response.json(emptyTaskPage):Response.json({}, {status:404});
  const m=await mount("project:alpha",fetcher,"",<SharedSurfaces/>);
  try{
    await settle();assert.match(m.text(),/Older saved requests were not checked/);assert.match(m.text(),/attention could not be checked completely/);
    assert.equal(m.dom.window.document.querySelector('[aria-labelledby="home-attention"] .private-count')?.textContent,"0+");
    assert.doesNotMatch(m.text(),/All clear\.|No actions are waiting/);
    mode="rows";await act(async()=>{await refreshSharedTaskAttention();});await settle();
    assert.equal(m.dom.window.document.querySelector('[data-field="attention-count"]')?.textContent,"1");
    assert.equal(m.dom.window.document.querySelector('[aria-labelledby="home-attention"] .private-count')?.textContent,"1");
    mode="failed";await act(async()=>{await refreshSharedTaskAttention();});await settle();
    assert.equal(m.dom.window.document.querySelector('[data-field="attention-count"]')?.textContent,"?");
    assert.equal(m.dom.window.document.querySelector('[aria-labelledby="home-attention"] .private-count')?.textContent,"?");
    mode="empty";await act(async()=>{await refreshSharedTaskAttention();});await settle();
    assert.match(m.text(),/All clear\./);assert.equal(m.dom.window.document.querySelector('[data-field="attention-count"]')?.textContent,"0");
    const a=loopRow(),b={...a,engineRevision:9};assert.equal(loopAttentionKey(a),loopAttentionKey(b));
    assert.equal(buildActionInbox([],[],now,[a,b]).length,1,"revision refresh never duplicates an attention identity");
    assert.equal(buildActionInbox([],[],now,[a])[0]!.href,"/projects/project%3Aalpha/improvements#request=request%3Aalpha");
  }finally{await m.close();}
});

test("B2b per-root unavailable is incomplete rather than an unknown source",()=>{
  const source={schemaVersion:1 as const,state:"available" as const,truncated:false,items:[loopAttentionItemSchemaV1.parse({
    ...loopRow(),runLinkId:"link:alpha",engineRevision:null,kind:"blocked",identity:{kind:"blocked",code:"UNAVAILABLE"}})]};
  assert.equal(loopAttentionComplete(source),false,"an unavailable linked decision cannot certify completeness");
  assert.equal(loopAttentionUnknown(source),false,"B2b fresh root failure preserves a counted lower bound");
  assert.equal(loopAttentionUnknown({schemaVersion:1,state:"unavailable",code:"unavailable"}),true);
});

test("B2b fresh partial task pages keep lower bounds until a stale refresh",async()=>{
  let failed=false;
  const fresh={...emptyTaskPage,nextCursor:"job:zzzz",examined:25,items:[{
    task:{projectId:"project:alpha",jobId:"job:partial",requestId:"request:partial",title:"Fresh partial task",state:"failed",version:1,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()},
    inputDigest:`sha256:${"a".repeat(64)}`,reasons:["failed"]}]};
  const fetcher:typeof fetch=async p=>String(p).includes("action-items")?Response.json({observedAt:new Date(now).toISOString(),items:[],truncated:false})
    :String(p).includes("/needs-me/tasks")?failed||String(p).includes("after=")?Response.json({}, {status:503}):Response.json(fresh):Response.json({}, {status:404});
  const m=await mount("project:alpha",fetcher,"",<SharedSurfaces/>);
  try{
    await settle();
    assert.equal(m.dom.window.document.querySelector('[data-field="attention-count"]')?.textContent,"1+","B2b fresh partial pages keep the known lower bound");
    assert.match(m.text(),/Fresh partial task/);assert.doesNotMatch(m.text(),/All clear\.|No actions are waiting/);
    failed=true;await act(async()=>{await refreshSharedTaskAttention();});await settle();
    assert.equal(m.dom.window.document.querySelector('[data-field="attention-count"]')?.textContent,"?","a retained stale task is not a current lower bound");
    assert.match(m.text(),/Fresh partial task/);assert.doesNotMatch(m.text(),/All clear\.|No actions are waiting/);
  }finally{await m.close();}
});

test("B2b fresh unavailable roots keep lower bounds and navigation has a stable name",async()=>{
  let failed=false;
  const row=loopRow();
  const blocked=loopAttentionItemSchemaV1.parse({...row,runLinkId:"link:alpha",engineRevision:null,kind:"blocked",identity:{kind:"blocked",code:"UNAVAILABLE"}});
  const fetcher:typeof fetch=async p=>String(p).includes("action-items")?Response.json({observedAt:new Date(now).toISOString(),items:[],truncated:false,
    loop:failed?{schemaVersion:1,state:"unavailable",code:"unavailable"}:{schemaVersion:1,state:"available",items:[blocked],truncated:true}})
    :String(p).includes("/needs-me/tasks")?Response.json(emptyTaskPage):Response.json({}, {status:404});
  const m=await mount("project:alpha",fetcher,"",<SharedSurfaces/>);
  try{
    await settle();
    const nav=m.dom.window.document.querySelector('nav a[href="/needs-me"]')!;
    assert.equal(nav.getAttribute("aria-label"),"Action Inbox","B2b navigation name excludes the changing badge count");
    const description=nav.getAttribute("aria-describedby");
    assert.ok(description,"B2b navigation describes its count separately");
    assert.equal(m.dom.window.document.getElementById(description!)?.getAttribute("aria-label"),null,
      "B2b count description exposes the number rather than replacing it with a label");
    assert.equal(m.dom.window.document.getElementById(description!)?.textContent,"1+");
    assert.equal(m.dom.window.document.querySelector('[aria-labelledby="home-attention"] .private-count')?.textContent,"1+",
      "B2b fresh per-root failure keeps its observed lower bound");
    assert.doesNotMatch(m.text(),/current count is unknown|All clear\.|No actions are waiting/);
    failed=true;await act(async()=>{await refreshSharedTaskAttention();});await settle();
    assert.equal(m.dom.window.document.getElementById(description!)?.textContent,"?","B2b failed whole source is unknown");
    assert.doesNotMatch(m.text(),/All clear\.|No actions are waiting/);
  }finally{await m.close();}
});

test("B2b strict same-response gate evidence and current bindings",async()=>{
  const f=await fixture(),id=await f.intake();
  try{
    const status=await f.bridge.status(f.identity,f.project.projectId,id);
    assert.ok(loopDecisionStatusSchemaV1.safeParse(status).success);
    for(const change of [{decisionEvidence:{text:"parallel evidence"}},{decisions:{gate:{kind:"unknown"},observedAt:new Date(now).toISOString()}},
      {engine:{...status.engine,revision:99}},{display:{...status.display,localVersion:2}},
      {decisions:{gate:{kind:"question",text:"no descriptor"},observedAt:new Date(now).toISOString()}}])
      assert.equal(loopDecisionStatusSchemaV1.safeParse({...status,...change}).success,false);
  }finally{await f.close();}
});

test("B2b CI registrations stay unconditional and separate",async()=>{
  const manifest=JSON.parse(await readFile("package.json","utf8")),workflow=await readFile(".github/workflows/ci.yml","utf8");
  const mutation=workflow.slice(workflow.indexOf("  mutation-checks:"),workflow.indexOf("\n  pr-claims:"));
  const browser=workflow.slice(workflow.indexOf("  owner-browser-journey:"),workflow.indexOf("\n  full-gate:"));
  for(const lane of [mutation,mutation.replace(/steps\.manifest\.outputs\.exists == 'true'/g,"false")]){
    const reached=reachableTests(manifest.scripts,workflowCommands(lane));
    assert.ok(reached.has("tests/improve-control-room-loop-attention-mutations.test.ts"));
    const step=lane.slice(lane.indexOf("      - name: Prove saved loop owner decision guards"),lane.indexOf("      - name: Validate every declared mutation anchor"));
    assert.doesNotMatch(step,/\n\s+if:/);assert.match(step,/timeout-minutes: 10/);
    assert.match(lane,/timeout-minutes: 45/);assert.ok(lane.indexOf("test:improve-control-room-loop-ui-mutations")<lane.indexOf("test:improve-control-room-loop-attention-mutations"));
  }
  assert.ok(reachableTests(manifest.scripts,workflowCommands(workflow)).has("tests/improve-control-room-loop-attention.test.tsx"));
  assert.ok(!reachableTests(manifest.scripts,["pnpm run test:components"]).has("tests/improve-control-room-loop-attention-mutations.test.ts"));
  assert.match(manifest.scripts["test:improve-control-room-loop-attention-browser"],/playwright test tests\/browser\/improve-control-room-loop-attention\.spec\.ts$/);
  const browserStep=browser.slice(browser.indexOf("      - name: Prove saved loop intake and owner decisions"),browser.indexOf("      - name: Inbox phone target geometry"));
  assert.doesNotMatch(browserStep,/\n\s+if:/);assert.match(browserStep,/pnpm run test:improve-control-room-loop-attention-browser/);
  assert.match(browserStep,/timeout-minutes: 5/,"B2b browser step has its own five-minute budget");
  assert.ok(browser.indexOf("Install Chromium for the CI journey only")<browser.indexOf("test:improve-control-room-loop-attention-browser"));
});

test("B2b late document cannot restore an old gate",async()=>{
  const f=await fixture(),id=await f.intake();await f.confirm(id);
  const text="Old sealed document.";f.document(text);f.edit({state:"waiting",approval:{step:"plan",inputVersion:"SYNTHETIC:1",head:"a".repeat(40),reportSha256:loopByteHashV1(text)}});
  let release!:()=>void;const held=new Promise<void>(r=>{release=r;});
  const m=await mount(f.project.projectId,(async(p,o)=>{const response=await f.transport(p,o);if(String(p).endsWith("/approval-document"))await held;return response;})as typeof fetch);
  try{
    await settle();assert.equal(m.button("Approve this plan").disabled,true);
    f.edit({state:"waiting",revision:8,approval:null,question});await act(async()=>m.button("Refresh status").click());await settle();
    release();await settle();assert.equal(m.button("Approve this plan"),undefined);assert.ok(!m.text().includes(text));
    assert.equal(f.calls.filter(c=>c==="approve").length,0);
  }finally{release();await m.close();await f.close();}
});

test("B2b discovery creator predicate",async()=>{
  const f=await fixture();await f.intake();
  try{
    await f.db.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
      VALUES('identity:foreign','tenant:web','human','Other fixture owner','test',$1,'active',$2,$2)`,[sha256Digest({provider:"test",subject:"other-fixture-owner"}),new Date(now).toISOString()]);
    const root={tenant_id:"tenant:web",id:"request:foreign",project_id:f.project.projectId,owner_identity_id:"identity:foreign",idempotency_key:"b2b-foreign-root-0001",created_at:new Date(now).toISOString()};
    const input={tenant_id:"tenant:web",request_id:root.id,project_id:root.project_id,owner_identity_id:root.owner_identity_id,version:1,description:"Other owner's saved request",settings_text:settingsText,
      request_sha256:loopByteHashV1("Other owner's saved request"),settings_sha256:loopByteHashV1(settingsText),idempotency_key:"b2b-foreign-input-0001",created_at:root.created_at};
    await f.db.query(`INSERT INTO control_loop_improvement_requests(tenant_id,id,project_id,owner_identity_id,idempotency_key,created_at,record_digest,auth_tag) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [...Object.values(root),sha256Digest(root),hmacSha256Tag(KEY,{purpose:"loop-improvement-request/v1",record:root})]);
    await f.db.query(`INSERT INTO control_loop_improvement_inputs(tenant_id,request_id,project_id,owner_identity_id,version,description,settings_text,request_sha256,settings_sha256,idempotency_key,created_at,record_digest,auth_tag)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[...Object.values(input),sha256Digest(input),hmacSha256Tag(KEY,{purpose:"loop-improvement-input/v1",record:input})]);
    const discovered=await f.desk.viewLoopAttentionRequests(f.identity);
    assert.ok(!discovered.requests.some(r=>r.requestId===root.id),"B2b discovery excludes foreign creators before status");
    assert.equal(discovered.requests.length,1);
  }finally{await f.close();}
});

test("B2b Stop synchronously invalidates a waiting answer",async()=>{
  const f=await fixture(),id=await f.intake();await f.confirm(id);const saved=await f.bridge.status(f.identity,f.project.projectId,id);
  await f.bridge.mutate(f.identity,f.project.projectId,id,"start",{expectedVersion:1,expectedRevision:saved.engine.revision,runLinkId:saved.display.runLinkId},"b2b-start-before-stop-0001");
  f.edit({state:"waiting",question});const m=await mount(f.project.projectId,f.transport);
  try{
    await settle();const field=m.dom.window.document.querySelector("#loop-owner-answer")!;
    const props=(field as unknown as Record<string,{onChange:(e:unknown)=>void}>)[Object.keys(field).find(k=>k.startsWith("__reactProps"))!];
    await act(async()=>props!.onChange({target:{value:"Keep scope"}}));
    await act(async()=>{m.button("Stop this run").click();m.button("Send answer").click();});await settle();
    assert.equal(f.posts.filter(p=>p.path.endsWith("/answer")).length,0,"Stop's synchronous epoch fence prevents a sibling stale answer");
    assert.equal((await f.bridge.status(f.identity,f.project.projectId,id)).engine.state,"stopped");
  }finally{await m.close();await f.close();}
});

test("B2b unconfirmed sealed wait never becomes an empty attention scan",async()=>{
  const f=await fixture(),id=await f.intake();await f.confirm(id);
  try{
    f.edit({state:"waiting",approval:{step:"plan",inputVersion:"SYNTHETIC:1",head:"a".repeat(40),reportSha256:"b".repeat(64)}});
    await f.desk.reviseLoopDraft(f.identity,f.project.projectId,{requestId:id,expectedVersion:1,description:"Changed saved input",settingsText},"b2b-revised-saved-input-0001");
    const attention=await f.bridge.readAttention(f.identity);assert.equal(attention.state,"available");
    if(attention.state==="available"){
      assert.equal(attention.items.length,1);assert.deepEqual(attention.items[0]!.identity,{kind:"blocked",code:"UNAVAILABLE"});
      assert.equal(attention.items[0]!.localVersion,2,"attention binds the latest status input, not an earlier discovery snapshot");
    }
  }finally{await f.close();}
});


test("UI fix status refresh updates shared attention without focus or polling",async()=>{
  const f=await fixture(),id=await f.intake();await f.confirm(id);
  let attentionReads=0;
  const transport:typeof fetch=async(p,o)=>{
    if(String(p).includes("/needs-me/tasks"))return Response.json(emptyTaskPage);
    if(String(p).includes("action-items"))attentionReads++;
    return f.transport(p,o);
  };
  const m=await mount(f.project.projectId,transport,"",<><SharedSurfaces/><PrivateImproveControlRoomWorkspace projectId={f.project.projectId}/></>);
  try{
    await settle();assert.match(m.text(),/All clear/);
    const reads=attentionReads;
    f.edit({state:"waiting",revision:8,question});
    await act(async()=>m.button("Refresh status").click());await settle();
    assert.match(m.text(),/Your answer/);
    assert.equal(m.dom.window.document.querySelector('[data-field="attention-count"]')?.textContent,"1","header updates with the saved waiting decision");
    assert.equal(m.dom.window.document.querySelector('[aria-labelledby="home-attention"] .private-count')?.textContent,"1");
    assert.doesNotMatch(m.text(),/All clear/);
    assert.ok(attentionReads>reads,"explicit status refresh reads shared attention");
    const before=attentionReads;
    await act(async()=>m.button("Refresh status").click());await settle();
    assert.ok(attentionReads>before,"unchanged explicit status refresh still checks attention");
    assert.equal(f.posts.length,0,"reads never start work");
  }finally{await m.close();await f.close();}
});

for(const status of [401,403])test(`UI fix ${status} says sign in again on header and Home`,async()=>{
  let mode="ready";
  const fetcher:typeof fetch=async p=>String(p).includes("action-items")?mode==="ready"?Response.json({observedAt:new Date(now).toISOString(),items:[],truncated:false,
    loop:{schemaVersion:1,state:"available",items:[loopRow()],truncated:false}}):Response.json({}, {status:mode==="access"?status:503})
    :String(p).includes("/needs-me/tasks")?Response.json(emptyTaskPage):Response.json({}, {status:404});
  const m=await mount("project:alpha",fetcher,"",<SharedSurfaces/>);
  try{
    await settle();mode="access";await act(async()=>{await refreshSharedTaskAttention();});await settle();
    for(const selector of ['header [aria-label="Needs attention"]','[aria-labelledby="home-attention"]'])
      assert.match(m.dom.window.document.querySelector(selector)!.textContent!,/sign in again/i,"access loss gives the owner a next action");
    assert.doesNotMatch(m.text(),/Saved protected request|All clear/);
    mode="unknown";await act(async()=>{await refreshSharedTaskAttention();});await settle();
    assert.doesNotMatch(m.text(),/sign in again/i,"ordinary unknown is distinct from access loss");
  }finally{await m.close();}
});

test("UI fix plain status and exact technical details behind disclosures",async()=>{
  const f=await fixture(),id=await f.intake();
  const m=await mount(f.project.projectId,f.transport);
  try{
    await settle();
    const confirm=m.dom.window.document.querySelector('[aria-label="Saved owner decision"]')!;
    const hashes=confirm.querySelector('details');assert.ok(hashes,"confirmation hashes are collapsed");assert.equal(hashes.open,false);
    assert.ok(hashes.textContent!.includes(f.snapshot().settingsSha256));
    await act(async()=>m.button("Confirm this exact request").click());await settle();
    const text="Complete sealed plan.\n".repeat(120);f.document(text);
    f.edit({state:"waiting",revision:8,approval:{step:"plan",inputVersion:"SYNTHETIC:1",head:"a".repeat(40),reportSha256:loopByteHashV1(text)}});
    await act(async()=>m.button("Refresh status").click());await settle();
    assert.match(m.text(),/Waiting for your approval/);
    assert.doesNotMatch(m.text(),/waiting approval|Unavailable|Last checked \d{4}-\d{2}-\d{2}T/);
    const decision=m.dom.window.document.querySelector('[aria-label="Saved owner decision"]')!;
    const details=decision.querySelector('details')!;assert.ok(details,"approval binding has a details toggle");assert.equal(details.open,false);
    assert.ok(details.textContent!.includes("a".repeat(40)));assert.ok(details.textContent!.includes(loopByteHashV1(text)));
    assert.equal(decision.querySelector('pre')!.textContent,text,"the entire sealed document stays before approval");
    const jump=[...decision.querySelectorAll('a')].find(a=>a.textContent==="Jump to approval");assert.ok(jump,"long documents offer a jump to the action");
    assert.equal(jump.getAttribute('href'),`#${m.button("Approve this plan").id}`);
    assert.ok(decision.querySelector('pre')!.compareDocumentPosition(m.button("Approve this plan"))&m.dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  }finally{await m.close();await f.close();}
});


test("UI fix long sealed document offers a jump to approval",async()=>{
  const f=await fixture(),id=await f.intake();await f.confirm(id);
  const text="Complete sealed document.\n".repeat(120);f.document(text);
  f.edit({state:"waiting",approval:{step:"plan",inputVersion:"SYNTHETIC:1",head:"a".repeat(40),reportSha256:loopByteHashV1(text)}});
  const m=await mount(f.project.projectId,f.transport);
  try{
    await settle();assert.equal(m.dom.window.document.querySelector('pre')!.textContent,text);
    const jump=[...m.dom.window.document.querySelectorAll('a')].find(a=>a.textContent==="Jump to approval");
    assert.ok(jump,"complete long documents have a jump to the approval control");
    assert.equal(jump.getAttribute('href'),`#${m.button("Approve this plan").id}`);
    assert.equal(f.posts.length,0,"jump availability never submits approval");
  }finally{await m.close();await f.close();}
});


test("UI fix attention refresh during an in-flight read is coalesced and kept",async()=>{
  let rows=false,hold=false,reads=0,release=()=>{};
  const fetcher:typeof fetch=async p=>{
    if(String(p).includes("/needs-me/tasks"))return Response.json(emptyTaskPage);
    if(!String(p).includes("action-items"))return Response.json({}, {status:404});
    reads++;const items=rows?[loopRow()]:[];
    if(hold){hold=false;await new Promise<void>(r=>{release=r;});}
    return Response.json({observedAt:new Date(now).toISOString(),items:[],truncated:false,loop:{schemaVersion:1,state:"available",items,truncated:false}});
  };
  const m=await mount("project:alpha",fetcher,"",<SharedSurfaces/>);
  try{
    await settle();hold=true;
    let pending:Promise<void>;
    await act(async()=>{pending=refreshSharedTaskAttention();});await settle();
    rows=true;
    await act(async()=>{await Promise.all([refreshSharedTaskAttention(true),refreshSharedTaskAttention(true),refreshSharedTaskAttention(true)]);});
    await act(async()=>{release();await pending!;});await settle();
    assert.equal(m.dom.window.document.querySelector('[data-field="attention-count"]')?.textContent,"1","a pending refresh cannot swallow the new decision");
    assert.equal(reads,3,"one initial read, one held read and one coalesced fresh read");
  }finally{release();await m.close();}
});
