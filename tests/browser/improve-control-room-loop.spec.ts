import { S4_FIXTURE_ROUTE, s4FixtureRoutes, s4FixtureContractRoutes, s4ProviderServiceV1, s4TaskFixture } from '../helpers/improve-control-room-loop-recovery';
import { test, expect, type BrowserContext } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { ImproveControlRoomDeskServiceV1 } from "../../src/improve-control-room/v1/service";
import { ImproveControlRoomLoopServiceV1 } from "../../src/web/v1/improve-control-room-loop-service";
import { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1, type LoopBridgeBindingV1 } from "../../src/improve-control-room/v1/schemas";
import { type LoopAdapterV1, type LoopEngineStatusV1, loopByteHashV1 } from "../../src/web/v1/improve-control-room-loop-adapter";
import { createImproveControlRoomHttpHandlerV1 } from "../../src/web/v1/improve-control-room-http";
import { sha256Digest } from "../../src/security";
import { taskFixture } from "../helpers/web-task";
import { now, origin, request, trust } from "../helpers/web-foundation";

const KEY = new Uint8Array(32).fill(64);
const settingsText = JSON.stringify({project:{host_adapter:'local-loop'},fixture:'SYNTHETIC',providerRoute:S4_FIXTURE_ROUTE});
const description = "  Improve the saved request.\nKeep exact text.  ";
async function fixture() {
  const f = await s4TaskFixture();
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
    '{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}'::jsonb) WHERE id=$1`, [f.project.projectId]);
  const toolingRevision = sha256Digest({ fixture: "SYNTHETIC B2a", scalar: "string" });
  const run = { adapterId: "adapter:synthetic", loopRunId: "synthetic-run:001", toolingRevision, a2SchemaVersion: 1 as const };
  const contract = { toolingRevision, decodeRunIdentity: (input: unknown) => loopImprovementRunIdentitySchemaV1.parse(input),
    decodeObservation: (input: unknown) => loopImprovementObservationSchemaV1.parse(input),
    matchesSavedInput: (_run: unknown, observation: { settingsDigest: string; confirmation: { sha256: string; path: string } }, input: { description: string; settingsText: string }) =>
      observation.settingsDigest === loopByteHashV1(input.settingsText) && observation.confirmation.sha256 === loopByteHashV1(input.description)
      && observation.confirmation.path === "request.md" };
  let saved: LoopEngineStatusV1 = { run, revision: 4, inputVersion: "SYNTHETIC:1", state: "ready", description,
    settingsSha256: loopByteHashV1(settingsText), settingsDigest: loopByteHashV1(settingsText),
    confirmation: { path: "request.md", sha256: loopByteHashV1(description), at: new Date(now).toISOString(), who: "owner", input_version: "SYNTHETIC:1" },
    approval: null, question: null, progress: { step: "plan", completed: 0, attention: "none" }, receipts: [] };
  const calls: string[] = [];
  const unexpected = async () => { throw new Error("unexpected SYNTHETIC operation"); };
  const apply = async (op: "start" | "stop", commandId: string, binding: LoopBridgeBindingV1, beforeSpawn: () => void) => {
    beforeSpawn(); calls.push(op);
    saved = { ...saved, state: op === "start" ? "running" : "stopped", revision: saved.revision + 1,
      receipts: [...saved.receipts, { commandId, bindingDigest: sha256Digest(binding), state: "accepted", evidenceDigest: sha256Digest({ op, commandId }), error: null }] };
    return structuredClone(saved);
  };
  const adapter: LoopAdapterV1 = {providerRoutes:s4FixtureRoutes, adapterId: run.adapterId, toolingRevision, schemaDigest: sha256Digest({ fixture: "SYNTHETIC schema" }),
    settingsText, contract, reserveRun: () => run.loopRunId, available: () => true,
    status: async () => { calls.push("status"); return structuredClone(saved); },
    start: (id, b, fence) => apply("start", id, b, fence), stop: (id, b, fence) => apply("stop", id, b, fence),
    intake: unexpected, confirmRequest: unexpected, approve: unexpected, answer: unexpected, close: async () => {} };
  const desk = new ImproveControlRoomDeskServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, KEY, undefined, () => now, contract);
  const draft = await desk.saveLoopDraft(f.identity, f.project.projectId, { description, settingsText }, "b2a-synthetic-draft-0001");
  const linked = await desk.recordLoopRunLink({ projectId: f.project.projectId, requestId: draft.request.requestId, initialInputVersion: 1, run });
  await desk.authorizeLoopStart(f.identity, f.project.projectId, { requestId: draft.request.requestId, expectedVersion: 1,
    runLinkId: linked.runLink.runLinkId, requestSha256: loopByteHashV1(description), settingsSha256: loopByteHashV1(settingsText) },
    "b2a-synthetic-authority-0001", { inputVersion: saved.inputVersion, settingsDigest: saved.settingsDigest, revision: saved.revision, confirmation: saved.confirmation! });
  const bridge = new ImproveControlRoomLoopServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, {providers:s4ProviderServiceV1(f.client,{ tenantId: "tenant:web", workspaceId: "workspace:web" },() => now), integrityKey: KEY, adapter }, () => now);
  const handler = createImproveControlRoomHttpHandlerV1({ origin, trust, loopBridge: bridge, service: desk, clock: () => now });
  return { ...f, desk, bridge, handler, calls, requestId: draft.request.requestId, link: linked.runLink.runLinkId,
    edit: (change: Partial<LoopEngineStatusV1>) => { saved = { ...saved, ...change }; },
    close: async () => { await bridge.close(); await f.db.close(); } };
}

for (const width of [360, 1280]) test(`B2a browser closes and reopens the saved run at ${width}px`, async ({ browser }) => {
  const f = await fixture();
  const posts: { path: string; body: string; key: string }[] = [], unexpected: string[] = [];
  let loseStart = true, context: BrowserContext | undefined;
  try {
  const bundle = await build({ write: false, bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { PrivateImproveControlRoomWorkspace } from './private-app/app/improve-control-room-workspace';
      createRoot(document.getElementById('root')).render(<PrivateImproveControlRoomWorkspace projectId={${JSON.stringify(f.project.projectId)}} />);
    ` }, plugins: [{ name: "unexercised-legacy-crypto", setup(builder) {
      builder.onResolve({ filter: /^node:crypto$/ }, () => ({ path: "node:crypto", namespace: "unexercised" }));
      builder.onLoad({ filter: /.*/, namespace: "unexercised" }, () => ({ contents: 'export function createHash(){throw new Error("unexercised_legacy_crypto")}', loader: "js" }));
    } }] });
  const css = (await Promise.all(["node_modules/tailwindcss/preflight.css", "styles/control-room.css", "private-app/app/private.css"].map(path => readFile(path, "utf8")))).join("\n");
  const savedLink = `https://product.invalid/projects/${encodeURIComponent(f.project.projectId)}/improvements#request=${encodeURIComponent(f.requestId)}`;
  async function open() {
    context = await browser.newContext({ viewport: { width, height: 850 }, isMobile: width < 500, hasTouch: width < 500 });
    // All traffic is intercepted locally; connectivity must not depend on the runner's network namespace.
    await context.addInitScript(() => { Object.defineProperty(navigator, "onLine", { get: () => true }); });
    await context.route("**/*", async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== "https://product.invalid") { unexpected.push(req.url()); await route.abort(); return; }
      if (url.pathname === "/bundle.js") { await route.fulfill({ contentType: "application/javascript", body: bundle.outputFiles[0]!.text }); return; }
      if (req.isNavigationRequest()) {
        await route.fulfill({ contentType: "text/html", body: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>` }); return;
      }
      if (url.pathname.includes("/improvements")) {
        if (req.method() === "POST") posts.push({ path: url.pathname, body: req.postData()!, key: req.headers()["idempotency-key"]! });
        const response = await f.handler(request(url.pathname, req.method(), req.postData() ? JSON.parse(req.postData()!) : undefined, req.headers()["idempotency-key"] ?? "b2a-browser-read-0001"));
        if (url.pathname.endsWith("/start") && loseStart) { loseStart = false; await route.abort("failed"); return; }
        await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() }); return;
      }
      if (url.pathname.startsWith("/api/")) { await route.fulfill({ status: 404, contentType: "application/json", body: "{}" }); return; }
      unexpected.push(req.url()); await route.abort();
    });
    const page = await context.newPage(); await page.goto(savedLink);
    expect(await page.evaluate(() => navigator.onLine)).toBe(true);
    await expect(page.getByRole("heading", { name: "Saved request", exact: true })).toBeFocused();
    return page;
  }
    let page = await open();
    await expect(page.getByRole("button", { name: "Start confirmed work", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Start confirmed work", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Start could not be confirmed" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry this exact Start" })).toBeEnabled();
    await page.getByRole("button", { name: "Retry this exact Start" }).click();
    expect(posts[1]).toEqual(posts[0]); expect(f.calls.filter(x => x === "start")).toHaveLength(1);
    await page.getByText("Run details",{exact:true}).click();
    await expect(page.getByText("Requested model: Not reported yet", { exact: true })).toBeVisible();
    await expect(page.getByText("Observed model: Not verified yet", { exact: true })).toBeVisible();
    await expect(page.getByText(/Repairs: Not reported yet/)).toBeVisible();
    f.edit({ state: "waiting", revision: 8 }); await page.getByRole("button", { name: "Refresh status" }).click();
    await expect(page.getByText("Waiting for your decision", { exact: true })).toBeVisible();
    f.edit({ state: "refused", revision: 9, progress: { step: "build", completed: 1, attention: "blocked" } });
    await page.getByRole("button", { name: "Refresh status" }).click(); await expect(page.getByText("The saved run is blocked.", { exact: true })).toBeVisible();
    await context!.close(); context = undefined;
    // Progress changes independently while no browser is open. No execution driver is claimed.
    f.edit({ state: "running", revision: 10, progress: { step: "final", completed: 2, attention: "none" } });
    page = await open();
    await page.getByText("Run details",{exact:true}).click(); await expect(page.getByText(/Step: final/)).toBeVisible(); expect(posts).toHaveLength(2);
    await page.reload(); await page.getByText("Run details",{exact:true}).click(); await expect(page.getByText(/Step: final/)).toBeVisible();
    await page.goto("about:blank"); await page.goBack(); await page.getByText("Run details",{exact:true}).click(); await expect(page.getByText(/Step: final/)).toBeVisible(); expect(posts).toHaveLength(2);
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); });
    await page.getByRole("button", { name: "Refresh status" }).click(); expect(posts).toHaveLength(2);
    const stop = page.getByRole("button", { name: "Stop this run", exact: true }); await stop.focus(); await page.keyboard.press("Enter");
    await expect(page.getByText("Stopped", { exact: true })).toBeVisible();
    expect(JSON.parse(posts[2]!.body)).toEqual({ runLinkId: f.link }); expect(posts[2]!.key).toMatch(/^loop-stop:/);
    expect(f.calls.filter(x => x !== "status")).toEqual(["start", "stop"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(unexpected).toEqual([]);
  } finally { await context?.close(); await f.close(); }
});

for(const width of [390,1280])test(`S4 next request starts with fresh unchecked consent and empty cap at ${width}px`,async({browser})=>{
 const fixtures=[await fixture(),await fixture()];let context:BrowserContext|undefined,index=0;
 const unexpected:string[]=[],posts:unknown[]=[];
 try{
  const bundles=await Promise.all(fixtures.map(async f=>{
   const rows=(await f.desk.viewLoopDesk(f.identity,f.project.projectId)).loopRequests;
   const result=await build({write:false,bundle:true,platform:'browser',format:'iife',jsx:'automatic',stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {ImprovementRunPanel} from './private-app/app/improvement-run-panel';
    createRoot(document.getElementById('root')).render(<ImprovementRunPanel projectId={${JSON.stringify(f.project.projectId)}} requests={${JSON.stringify(rows)}} fresh={true}/>);
   `},plugins:[{name:'unexercised-legacy-crypto',setup(builder){
    builder.onResolve({filter:/^node:crypto$/},()=>({path:'node:crypto',namespace:'unexercised'}));
    builder.onLoad({filter:/.*/,namespace:'unexercised'},()=>({contents:'export function createHash(){throw new Error("unexercised_legacy_crypto")}',loader:'js'}));
   }}]});return result.outputFiles[0]!.text;
  }));
  context=await browser.newContext({viewport:{width,height:850},isMobile:width<500,hasTouch:width<500});
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),f=fixtures[index]!;
   if(url.origin!=='https://product.invalid'){unexpected.push(req.url());await route.abort();return;}
   if(url.pathname==='/bundle.js'){await route.fulfill({contentType:'application/javascript',body:bundles[index]});return;}
   if(req.isNavigationRequest()){await route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script src="/bundle.js"></script>'});return;}
   if(url.pathname.includes('/improvements/loop/')){
    const body=req.postData()?JSON.parse(req.postData()!):undefined;
    if(req.method()==='POST')posts.push(body);
    const response=await f.handler(request(url.pathname,req.method(),body,req.headers()['idempotency-key']??'s4-browser-read-0001'));
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});return;
   }
   if(url.pathname.startsWith('/api/')){await route.fulfill({status:404,json:{}});return;}
   unexpected.push(req.url());await route.abort();
  });
  const page=await context.newPage();await page.goto('https://product.invalid/first');
  expect(await page.evaluate(()=>navigator.onLine),'the isolated browser fixture needs an online interface').toBe(true);
  const consent=()=>page.getByRole('checkbox',{name:'Allow a paid route for this run'}),cap=()=>page.getByLabel('Cap in nano-USD');
  await expect(consent()).not.toBeChecked();await expect(cap()).toHaveValue('');
  await consent().check();await cap().fill('123');
  await expect(consent()).toBeChecked();await expect(cap()).toHaveValue('123');
  index=1;await page.goto('https://product.invalid/second');
  await expect(consent()).not.toBeChecked();await expect(cap()).toHaveValue('');
  await expect(page.getByRole('button',{name:'Start confirmed work',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Start confirmed work',exact:true}).click();
  await expect(page.getByRole('button',{name:'Start confirmed work',exact:true})).toBeDisabled();
  await expect.poll(()=>posts.length).toBe(1);
  expect(posts[0]).toEqual({route:S4_FIXTURE_ROUTE,expectedVersion:1,expectedRevision:4,runLinkId:fixtures[1]!.link});
  expect(unexpected).toEqual([]);expect(fixtures[0]!.calls.filter(x=>x==='start')).toEqual([]);
  expect(fixtures[1]!.calls.filter(x=>x==='start')).toEqual(['start']);
 }finally{await context?.close();for(const f of fixtures)await f.close();}
});
