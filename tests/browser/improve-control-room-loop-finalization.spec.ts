import { test,expect,type BrowserContext } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { finalizationFixture, KEY } from "../helpers/improve-control-room-loop-finalization";
import { createPrivateWebProcess } from "../../src/web/v1/private-process";
import { sha256Digest } from "../../src/security";
import { now,origin,request,trust } from "../helpers/web-foundation";
const emptyTasks={items:[],nextCursor:null,examined:0,observedAt:new Date(now).toISOString(),startsWork:false,planningSource:"configured",deliverySource:"configured",sources:{ordinary:"included",ideas:"not_configured"}};
for(const width of [360,1280])test(`B3c retained finish refusal reaches shared surfaces at ${width}px`,async({browser})=>{
  const f=await finalizationFixture();let context:BrowserContext|undefined,deny=false,unavailable=false,truncated=false;
  const unexpected:string[]=[],posts:string[]=[];
  const app=createPrivateWebProcess({origin,...trust,tenantId:"tenant:web",workspaceId:"workspace:web",loadKeys:async()=>trust.keys,clock:()=>now,
    database:{client:f.client,close:async()=>{}},loopBridge:{integrityKey:KEY,adapter:f.adapter,loopCandidates:f.config}});
  try{
    const bundle=await build({write:false,bundle:true,platform:"browser",format:"iife",jsx:"automatic",stdin:{resolveDir:process.cwd(),loader:"tsx",contents:`
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {HomeDashboard} from './private-app/app/home-workspace';
      import {PrivateHeader} from './private-app/app/private-header';
      import {PrivateActionInbox} from './private-app/app/needs-me/action-inbox';
      import {PrivateImproveControlRoomWorkspace} from './private-app/app/improve-control-room-workspace';
      import {LocalRuntimeContextV1} from './private-app/app/local-runtime';
      import {useSharedTaskAttention} from './private-app/app/shared-task-attention';
      function Home(){const attention=useSharedTaskAttention(true);return <><PrivateHeader/><main><HomeDashboard data={{activity:{state:'unavailable'},projects:{state:'unavailable'},connections:{state:'unavailable'},attention}}/></main></>}
      const path=window.location.pathname;
      createRoot(document.getElementById('root')).render(<LocalRuntimeContextV1.Provider value={{mode:'hosted'}}>{path==='/'?<Home/>:path==='/needs-me'?<><PrivateHeader/><PrivateActionInbox/></>:<PrivateImproveControlRoomWorkspace projectId=${JSON.stringify(f.project.projectId)}/>}</LocalRuntimeContextV1.Provider>);
    `},plugins:[{name:"unused-legacy-crypto",setup(b){b.onResolve({filter:/^node:crypto$/},()=>({path:"node:crypto",namespace:"unused"}));b.onLoad({filter:/.*/,namespace:"unused"},()=>({contents:'export function createHash(){throw new Error("unused_legacy_crypto")}',loader:"js"}));}}]});
    const css=(await Promise.all(["node_modules/tailwindcss/preflight.css","styles/control-room.css","private-app/app/private.css"].map(p=>readFile(p,"utf8")))).join("\n");
    const open=async(path="/")=>{
      context=await browser.newContext({viewport:{width,height:850},isMobile:width<500,hasTouch:width<500});
      await context.route("**/*",async route=>{
        const r=route.request(),url=new URL(r.url());
        if(url.origin!=="https://product.invalid"){unexpected.push(r.url());await route.abort();return;}
        if(url.pathname==="/bundle.js"){await route.fulfill({contentType:"application/javascript",body:bundle.outputFiles[0]!.text});return;}
        if(r.isNavigationRequest()){await route.fulfill({contentType:"text/html",body:`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>`});return;}
        if(r.method()!=="GET")posts.push(url.pathname);
        if(url.pathname==="/api/v1/needs-me/tasks"){await route.fulfill({json:emptyTasks});return;}
        if(url.pathname==="/api/v1/needs-me/action-items"&&deny){await route.fulfill({status:403,json:{error:"access_denied"}});return;}
        if(url.pathname==="/api/v1/needs-me/action-items"&&unavailable){await route.fulfill({status:503,json:{error:"unavailable"}});return;}
        if(url.pathname.startsWith("/api/")){
          const response=await app.handle(request(url.pathname,r.method(),r.postData()?JSON.parse(r.postData()!):undefined),()=>new Response("unused",{status:404}));
          if(url.pathname==="/api/v1/needs-me/action-items"&&truncated&&response.status===200){const body=await response.json();body.loop.truncated=true;await route.fulfill({json:body});return;}
          await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});return;
        }
        unexpected.push(r.url());await route.abort();
      });
      const page=await context.newPage();await page.goto("https://product.invalid"+path);return page;
    };
    const savedPath=`/projects/${encodeURIComponent(f.project.projectId)}/improvements#request=${encodeURIComponent(f.requestId)}`;
    const observation=structuredClone(f.state.observation);f.editStatus({state:"running"});f.state.observation={...observation,outcome:"running",completionDigest:null};await f.save();
    let page=await open(savedPath);await expect(page.getByText("SYNTHETIC finished improvement",{exact:true}).first()).toBeVisible();
    await context!.close();context=undefined;
    f.editStatus({state:"finished"});f.state.observation=observation;await f.save();await f.observe();
    const record=await f.capability.readRecord(f.target);
    page=await open();const home=page.locator('[aria-labelledby="home-attention"]');
    await expect(home).toContainText("Run cleanup refused");await expect(home).toContainText("Scratch is retained");
    await expect(page.locator('header [aria-label="Needs attention"]')).toContainText("Scratch is retained");
    if(width<500)await page.getByRole("button",{name:"Menu",exact:true}).click();
    const nav=page.locator('nav a[href="/needs-me"]');await expect(nav).toHaveAccessibleDescription("1");
    if(width<500)await page.getByRole("button",{name:"Menu",exact:true}).press("Escape");
    const action=home.getByRole("link",{name:"Ask the lead to check retained evidence",exact:true});
    expect(await action.evaluate(e=>e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await action.focus();await expect(action).toBeFocused();await action.press("Enter");await expect(page).toHaveURL("https://product.invalid"+savedPath);
    await expect(page.getByRole("heading",{name:"Saved request",exact:true})).toBeFocused();
    await expect(page.getByText("b".repeat(40),{exact:false}).first()).toBeVisible();
    await page.reload();await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await page.goto("https://product.invalid/needs-me");await expect(page.getByText("Run cleanup refused",{exact:true}).last()).toBeVisible();
    await page.goBack();expect(posts).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    truncated=true;await page.goto("https://product.invalid/");await expect(page.locator('header [aria-label="Needs attention"]')).toContainText("1+");
    unavailable=true;await page.reload();await expect(page.locator('header [aria-label="Needs attention"] [role="alert"]').first()).toBeVisible();
    unavailable=false;deny=true;await page.reload();await expect(page.locator('header [aria-label="Needs attention"]')).not.toContainText("Run cleanup refused");
    expect(posts).toEqual([]);expect(unexpected).toEqual([]);expect(await f.capability.readRecord(f.target)).toEqual(record);
    deny=false;truncated=false;
    for(const [outcome,reason,state,title] of [["failed","FAILED","refused","Saved run failed"],["stopped","STOPPED","stopped","Saved run stopped"],["stalled","PROVIDER_UNAVAILABLE","running","Saved provider unavailable"]] as const){
      f.editStatus({state});f.state.observation={...f.state.observation,outcome,reasonCode:reason,completionDigest:null,
        binding:{...f.state.observation.binding,eventDigest:sha256Digest({outcome,reason})},evidenceDigest:sha256Digest({outcome,reason,inputVersion:f.target.inputVersion})};await f.save();
      await context!.close();context=undefined;await f.observe();page=await open();
      await expect(page.locator('[aria-labelledby="home-attention"]')).toContainText(title);
      if(width<500)await page.getByRole("button",{name:"Menu",exact:true}).click();
      await expect(page.locator('nav a[href="/needs-me"]')).toHaveAccessibleDescription("1");
      expect(posts).toEqual([]);
    }
  }finally{await context?.close();await app.close();await f.close();}
});
