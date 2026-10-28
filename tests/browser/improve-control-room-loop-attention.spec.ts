import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { taskFixture } from "../helpers/web-task";
import { now, origin, request, trust } from "../helpers/web-foundation";
import { ImproveControlRoomDeskServiceV1 } from "../../src/improve-control-room/v1/service";
import { ImproveControlRoomLoopServiceV1 } from "../../src/web/v1/improve-control-room-loop-service";
import { createImproveControlRoomHttpHandlerV1 } from "../../src/web/v1/improve-control-room-http";
import { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1, type LoopBridgeBindingV1 } from "../../src/improve-control-room/v1/schemas";
import { loopByteHashV1, type LoopEngineStatusV1, type LoopAdapterV1 } from "../../src/web/v1/improve-control-room-loop-adapter";
import { type LoopImprovementDecisionsV1 } from "../../src/web/v1/improve-control-room-loop-attention-wire";
import { sha256Digest } from "../../src/security";
const KEY = new Uint8Array(32).fill(64);
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

const emptyTaskPage={items:[],nextCursor:null,examined:0,observedAt:new Date(now).toISOString(),startsWork:false,planningSource:"configured",deliverySource:"configured",sources:{ordinary:"included",ideas:"not_configured"}};
for(const width of [360,1280])test(`B2b phone owner returns to exact waiting decision at ${width}px`,async({browser})=>{
  const f=await fixture();let context:BrowserContext|undefined,loseAnswer=true,releaseAnswer:()=>void=()=>{};
  const unexpected:string[]=[],description="  Improve café 🧭\nKeep exact pasted text.  ";
  let failLoop=false,truncated=false;
  try{
    const bundle=await build({write:false,bundle:true,platform:"browser",format:"iife",jsx:"automatic",stdin:{resolveDir:process.cwd(),loader:"tsx",contents:`
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {PrivateImproveControlRoomWorkspace} from './private-app/app/improve-control-room-workspace';
      import {HomeDashboard} from './private-app/app/home-workspace';
      import {PrivateHeader} from './private-app/app/private-header';
      import {PrivateActionInbox} from './private-app/app/needs-me/action-inbox';
      import {LocalRuntimeContextV1} from './private-app/app/local-runtime';
      import {useSharedTaskAttention} from './private-app/app/shared-task-attention';
      function Home(){const attention=useSharedTaskAttention(true);return <><PrivateHeader/><main><HomeDashboard data={{activity:{state:'unavailable'},projects:{state:'unavailable'},
        connections:{state:'ready',value:{source:'local',value:{taskWorkersStarted:true,workers:[],projectSections:[]}}},
        attention:attention.state==='ready'?{state:'ready',value:attention.value}:{state:attention.state}}}/></main></>}
      const path=window.location.pathname;
      createRoot(document.getElementById('root')).render(<LocalRuntimeContextV1.Provider value={{mode:'hosted'}}>{path==='/'?<Home/>:path==='/needs-me'?<><PrivateHeader/><PrivateActionInbox/></>:<PrivateImproveControlRoomWorkspace projectId=${JSON.stringify(f.project.projectId)}/>}</LocalRuntimeContextV1.Provider>);
    `},plugins:[{name:"unexercised-legacy-crypto",setup(builder){builder.onResolve({filter:/^node:crypto$/},()=>({path:"node:crypto",namespace:"unexercised"}));builder.onLoad({filter:/.*/,namespace:"unexercised"},()=>({contents:'export function createHash(){throw new Error("unexercised_legacy_crypto")}',loader:"js"}));}}]});
    const css=(await Promise.all(["node_modules/tailwindcss/preflight.css","styles/control-room.css","private-app/app/private.css"].map(p=>readFile(p,"utf8")))).join("\n");
    const projectPath=`/projects/${encodeURIComponent(f.project.projectId)}/improvements`;
    async function open(path=projectPath){
      context=await browser.newContext({viewport:{width,height:850},isMobile:width<500,hasTouch:width<500});
      await context.addInitScript(()=>Object.defineProperty(navigator,"onLine",{get:()=>true}));
      await context.route("**/*",async route=>{
        const req=route.request(),url=new URL(req.url());
        if(url.origin!=="https://product.invalid"){unexpected.push(req.url());await route.abort();return;}
        if(url.pathname==="/bundle.js"){await route.fulfill({contentType:"application/javascript",body:bundle.outputFiles[0]!.text});return;}
        if(req.isNavigationRequest()){await route.fulfill({contentType:"text/html",body:`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>`});return;}
        if(url.pathname==="/api/v1/needs-me/tasks"){await route.fulfill({json:emptyTaskPage});return;}
        if(url.pathname==="/api/v1/needs-me/action-items"){
          if(failLoop){await route.fulfill({status:503,json:{}});return;}
          const loop=await f.bridge.readAttention(f.identity);if(loop.state==="available"&&truncated)loop.truncated=true;
          await route.fulfill({json:{observedAt:new Date(now).toISOString(),items:[],truncated:false,loop}});return;
        }
        if(url.pathname.includes("/improvements")){
          const response=await f.transport(url.pathname,{method:req.method(),headers:req.headers(),...(req.postData()?{body:req.postData()}: {})});
          if(url.pathname.endsWith("/answer")&&loseAnswer){
            await new Promise<void>(r=>{releaseAnswer=r;});loseAnswer=false;await route.abort("failed");return;
          }
          await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});return;
        }
        if(url.pathname.startsWith("/api/")){await route.fulfill({status:404,json:{}});return;}
        unexpected.push(req.url());await route.abort();
      });
      const page=await context.newPage();await page.goto("https://product.invalid"+path);return page;
    }
    async function badge(page:Page,value:string){
      if(width<500){await page.getByRole("button",{name:"Menu",exact:true}).click();}
      const inbox=page.locator('nav a[href="/needs-me"]');
      await expect(inbox).toHaveAccessibleName("Action Inbox");
      await expect(inbox).toHaveAccessibleDescription(value);
      const countId=await inbox.getAttribute("aria-describedby");
      expect(countId).toBeTruthy();
      await expect(page.locator(`[id="${countId}"]`)).toHaveText(value);
      if(width<500){await page.getByRole("button",{name:"Menu",exact:true}).click();}
    }
    let page=await open();await expect(page.getByRole("button",{name:"Prepare request",exact:true})).toBeVisible();expect(f.posts).toHaveLength(0);
    await page.getByLabel("What would you like improved?").fill(description);await page.getByRole("button",{name:"Prepare request",exact:true}).click();
    await expect(page.getByRole("button",{name:"Confirm this exact request"})).toBeEnabled();
    expect(JSON.parse(f.posts[0]!.body)).toEqual({description});expect(f.calls).toEqual(["intake"]);
    const id=(await f.desk.viewLoopDesk(f.identity,f.project.projectId)).loopRequests[0]!.requestId,savedPath=projectPath+`#request=${encodeURIComponent(id)}`;
    await page.goto("https://product.invalid/");await expect(page.locator('[aria-labelledby="home-attention"]')).toContainText("Confirm saved request");await badge(page,"1");
    await page.locator('[aria-labelledby="home-attention"]').getByRole("link",{name:"Open request",exact:true}).click();
    await expect(page).toHaveURL("https://product.invalid"+savedPath);await expect(page.getByRole("heading",{name:"Saved owner decision",exact:true})).toBeFocused();
    expect(await page.locator('[aria-label="Saved owner decision"]').textContent()).toContain(description);
    const confirm=page.getByRole("button",{name:"Confirm this exact request"});expect(await confirm.evaluate(e=>e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await confirm.focus();await page.keyboard.press("Enter");await expect(page.getByRole("button",{name:"Start confirmed work",exact:true})).toBeEnabled();
    expect(f.calls).toEqual(["intake","confirm"]);
    await page.getByRole("button",{name:"Start confirmed work",exact:true}).click();await expect(page.getByText("running",{exact:true})).toBeVisible();
    for(const step of ["plan","spec"] as const){
      const text=`Complete sealed ${step}.\r\n`+"All saved evidence and constraints.\n".repeat(3000);f.document(text);
      f.edit({state:"waiting",revision:step==="plan"?6:8,approval:{step,inputVersion:"SYNTHETIC:1",head:"a".repeat(40),reportSha256:loopByteHashV1(text)}});
      await page.getByRole("button",{name:"Refresh status",exact:true}).click();await expect(page.locator('[aria-label="Saved owner decision"] pre')).toHaveText(text);
      const approve=page.getByRole("button",{name:`Approve this ${step}`,exact:true});await expect(approve).toBeEnabled();await approve.click();
      await expect(page.getByText("running",{exact:true})).toBeVisible();
    }
    const question={questionId:"question:owner",inputVersion:"SYNTHETIC:1",reportSha256:"e".repeat(64),owner:true,changesInput:false};
    f.edit({state:"waiting",revision:10,approval:null,question});await page.getByRole("button",{name:"Refresh status",exact:true}).click();
    await expect(page.getByLabel("Your answer")).toBeVisible();await context!.close();context=undefined;
    page=await open("/needs-me");await expect(page.getByRole("link",{name:"Answer question",exact:true}).last()).toBeVisible();await badge(page,"1");
    await page.getByRole("link",{name:"Answer question",exact:true}).last().click();await expect(page).toHaveURL("https://product.invalid"+savedPath);
    expect(await page.locator('[aria-label="Saved owner decision"]').textContent()).toContain("Choose the saved scope.\r\nKeep café?");
    const old=await f.bridge.status(f.identity,f.project.projectId,id);f.keepQuestion();await page.getByLabel("Your answer").fill("Keep the agreed scope.");
    const answer=page.getByRole("button",{name:"Send answer",exact:true});expect(await answer.evaluate(e=>e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await answer.click();await expect(answer).toBeDisabled();expect(f.posts.filter(p=>p.path.endsWith("/answer"))).toHaveLength(1);
    releaseAnswer();await expect(page.getByRole("button",{name:"Retry this exact answer"})).toBeEnabled();await page.getByRole("button",{name:"Retry this exact answer"}).click();
    const answers=f.posts.filter(p=>p.path.endsWith("/answer"));expect(answers).toHaveLength(2);expect(answers[1]).toEqual(answers[0]);expect(f.calls.filter(c=>c==="answer")).toHaveLength(1);
    const stale=await f.handler(request(`/api/v1/projects/${encodeURIComponent(f.project.projectId)}/improvements/loop/${encodeURIComponent(id)}/answer`,"POST",
      {expectedVersion:1,expectedRevision:old.engine.revision,questionId:question.questionId,inputVersion:question.inputVersion,questionReportSha256:question.reportSha256,text:"Stale answer"},"b2b-browser-stale-0001"));
    expect(stale.status).toBe(409);expect(f.calls.filter(c=>c==="answer")).toHaveLength(1);
    for(const gate of [{kind:"blocked",code:"QUESTION_LIMIT",message:"Saved question limit reached."},{kind:"blocked",code:"INPUT_CHANGED",message:"Changed inputs require renewed approvals."}]as const){
      f.setGate(gate);await page.getByRole("button",{name:"Refresh status",exact:true}).click();await expect(page.getByText(gate.message,{exact:true})).toBeVisible();expect(await page.getByRole("button",{name:"Send answer",exact:true}).count()).toBe(0);
    }
    f.setGate({kind:"question",text:"Technical choice waits for the orchestrator."});f.edit({question:{...question,owner:false}});
    await page.getByRole("button",{name:"Refresh status",exact:true}).click();await expect(page.getByText(/No owner answer is requested/)).toBeVisible();
    f.setGate(undefined);f.edit({question});await page.getByRole("button",{name:"Refresh status",exact:true}).click();
    await page.getByRole("button",{name:"Stop this run",exact:true}).click();await expect(page.getByText("Stopped",{exact:true})).toBeVisible();
    const postCount=f.posts.length;await page.reload();await expect(page.getByText("Stopped",{exact:true})).toBeVisible();
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));expect(f.posts).toHaveLength(postCount);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    truncated=true;await page.goto("https://product.invalid/");await expect(page.getByText("Older saved requests were not checked.").first()).toBeVisible();await badge(page,"0+");
    failLoop=true;await page.reload();await expect(page.getByText(/Attention could not be checked/).first()).toBeVisible();await badge(page,"?");
    expect(unexpected).toEqual([]);expect(f.calls.filter(c=>c==="start")).toHaveLength(1);
  }finally{releaseAnswer();await context?.close();await f.close();}
});
