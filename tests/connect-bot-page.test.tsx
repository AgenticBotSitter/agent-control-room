import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import { ConnectBotWorkspace, InstallLine, type ConnectBotInstallResult }
  from "../private-app/app/workers/connect/connect-bot-workspace";
import { FLEET_CAPABILITY_OPTIONS_V1, FLEET_CONNECT_BOT_CAPABILITY_OPTIONS_V1, FLEET_CONNECT_BOT_OPTIONS_V1,
  FLEET_WORKER_OPTIONS_V1 } from "../src/fleet/v1/catalog";
import { WebAccessError } from "../src/web/v1/access-verifier";
import { createFleetOwnerHttpHandlerV1, fleetConnectorProfileNameV1, fleetJoinCommandsV1 } from "../src/web/v1/fleet-owner-http";
import { FLEET_CONNECTOR_RELEASE_SCHEMA_V1, type FleetConnectorReleaseManifestV1 }
  from "../src/fleet/v1/connector-release";

const code = `crj_${"A".repeat(43)}`;
const workerId = `fleet-worker:${"d".repeat(32)}`;
const commandIdentity = Object.freeze({ displayName: "Desktop Codex", workerId });
const release: FleetConnectorReleaseManifestV1 = Object.freeze({ schema: FLEET_CONNECTOR_RELEASE_SCHEMA_V1,
  version: "0.3.0", file: "connector-0.3.0.mjs", sha256: "b".repeat(64), size: 1234, builtFrom: "c".repeat(40) });

test("one fleet catalog includes the separate local-tool flow without offering it as a bot install", () => {
  assert.equal(FLEET_WORKER_OPTIONS_V1.find(option => option.kind === "tool")?.label, "Local tool adapter");
  assert.equal(FLEET_CONNECT_BOT_OPTIONS_V1.map(option => String(option.kind)).includes("tool"), false);
  assert.equal(FLEET_CAPABILITY_OPTIONS_V1.find(option => option.capability === "tool.whisper")?.label,
    "Whisper transcription");
  assert.equal(FLEET_CONNECT_BOT_CAPABILITY_OPTIONS_V1.map(option => String(option.capability)).includes("tool.whisper"), false);
});

function saveGlobals(keys: string[]) { return Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])); }
function restoreGlobals(saved: Record<string, PropertyDescriptor | undefined>) {
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
  }
}

test("the owner page shows the exact versioned fleet command, including its current digest and chosen bot", () => {
  for (const [bot, os, command] of [["claude-code", "macos", "unix"], ["codex", "linux", "unix"],
    ["hermes", "windows", "windows"], ["cursor", "windows", "windows"], ["claude-desktop", "macos", "unix"],
    ["mcp-agent", "linux", "unix"]] as const) {
    const commands = fleetJoinCommandsV1("https://control.example.ts.net", code, bot, release, commandIdentity);
    const exact = commands[command];
    assert.equal(exact.includes("\n"), false);
    assert.match(exact, /connector-0\.3\.0\.mjs/u);
    assert.match(exact, /connector-manifest\.json/u);
    assert.match(exact, / b{64} 1234 c{40}/u);
    assert.match(exact, new RegExp(` install .*--bot ${bot} .*--name desktop-codex-d{12} .*--i-am-the-installer$`, "u"));
    assert.doesNotMatch(exact, /\sjoin\s/u);
    assert.equal(exact.slice(0, exact.indexOf(" --code ")).includes(code), false, `${os}: code before argument`);
    assert.equal([...exact.matchAll(/https?:\/\/[^ ']+/gu)].some(match => match[0].includes(code)), false, `${os}: code in URL`);
  }
  assert.throws(() => fleetJoinCommandsV1("https://control.example.ts.net", code, "wrong-kind", release, commandIdentity));
  assert.throws(() => fleetJoinCommandsV1("https://control.example.ts.net", "crj_short", "codex", release, commandIdentity));
  assert.throws(() => fleetConnectorProfileNameV1("safe", workerId, "wrong-kind"));
  assert.throws(() => fleetJoinCommandsV1("https://control.example.ts.net", code, "codex", release,
    { displayName: "line\nbreak", workerId }));
  assert.throws(() => fleetJoinCommandsV1("https://control.example.ts.net", code, "codex", release,
    { displayName: "safe", workerId: "fleet-worker:short" }));
});

test("the connect-code route binds the chosen kind and returns only the current release command", async () => {
  const issued: unknown[] = [];
  const service = { createEnrollmentCode: async (_identity: unknown, input: unknown) => {
    issued.push(input);
    return { codeId: `fleet-code:${"a".repeat(32)}`, workerId: `fleet-worker:${"b".repeat(32)}`,
      code, workerKind: (input as { workerKind: string }).workerKind,
      displayName: (input as { displayName: string }).displayName, expiresAt: "2099-01-01T00:00:00.000Z" };
  } };
  const handler = createFleetOwnerHttpHandlerV1({ origin: "https://control.example", service: service as never,
    gatewayOrigin: "https://control.example.ts.net", connectorRelease: release,
    localOwnerSession: { assertLocalRequest() {}, verify() { return {}; } } as never });
  const post = (body: unknown) => handler(new Request("https://control.example/api/v1/fleet/connect-codes", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const body = { botKind: "cursor", name: "<desktop> Ω", operatingSystem: "windows",
    projectIds: ["project:alpha"], capabilities: ["writing"], unattended: false,
    workerModel: "", workerProfile: "", workerProvider: "" };
  const response = await post(body);
  assert.equal(response.status, 201);
  const value = await response.json() as { installLine: string; profileName: string; ownerNextStep: string;
    release: FleetConnectorReleaseManifestV1 };
  assert.deepEqual(value.release, release);
  const expected = fleetJoinCommandsV1("https://control.example.ts.net", code, "cursor", release,
    { displayName: body.name, workerId: `fleet-worker:${"b".repeat(32)}` });
  assert.equal(value.installLine, expected.windows);
  assert.equal(value.profileName, "desktop-bbbbbbbbbbbb");
  assert.match(value.ownerNextStep, /Cursor is registered.*Close and reopen Cursor.*no background service/u);
  assert.deepEqual(issued, [{ displayName: "<desktop> Ω", workerKind: "cursor",
    projectIds: ["project:alpha"], capabilities: ["writing"] }]);
  const missingHermesSelection = await post({ ...body, botKind: "hermes", unattended: true });
  assert.equal(missingHermesSelection.status, 400, "Hermes model choices are refused before an enrollment code is created");
  const hermes = await post({ ...body, botKind: "hermes", unattended: true,
    workerProfile: "night", workerModel: "hermes-3", workerProvider: "local" });
  assert.equal(hermes.status, 201);
  assert.match((await hermes.json() as { installLine: string }).installLine,
    /--worker-profile night --worker-model hermes-3 --worker-provider local --unattended/u);
  for (const refused of [{ ...body, botKind: "other" }, { ...body, operatingSystem: "android" }, { ...body, extra: true },
    { ...body, unattended: true }]) {
    const invalid = await post(refused);
    assert.equal(invalid.status, 400);
  }
  assert.equal(issued.length, 2, "invalid page choices are refused before an enrollment code is created");
});

test("the result says plainly when a code expired and disables copying it", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: "https://control.example/workers/connect" });
  const saved = saveGlobals(["window", "document", "IS_REACT_ACT_ENVIRONMENT"]);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const result: ConnectBotInstallResult = { codeId: `fleet-code:${"a".repeat(32)}`,
    workerId: `fleet-worker:${"b".repeat(32)}`, expiresAt: "2000-01-01T00:00:00.000Z", operatingSystem: "macos",
    botKind: "codex", profileName: "safe-profile", unattended: false, ownerNextStep: "Codex is registered.", release,
    installLine: "safe line" };
  try {
    await act(async () => root.render(<InstallLine result={result} />));
    assert.match(dom.window.document.body.textContent ?? "", /This code expired\. Create a new code/u);
    assert.equal(dom.window.document.querySelector("button")?.disabled, true);
  } finally { await act(async () => root.unmount()); dom.window.close(); restoreGlobals(saved); }
});

test("at a 375px viewport, every picker is present and hostile display names remain text", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: "https://control.example/workers/connect" });
  Object.defineProperty(dom.window, "innerWidth", { value: 375, configurable: true });
  const saved = saveGlobals(["window", "document", "Event", "EventTarget", "HTMLElement", "HTMLInputElement",
    "HTMLSelectElement", "MouseEvent", "confirm", "fetch", "IS_REACT_ACT_ENVIRONMENT"]);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    Event: dom.window.Event, EventTarget: dom.window.EventTarget, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement,
    MouseEvent: dom.window.MouseEvent, confirm: () => true, IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.fetch = async (path, init) => {
    const value = String(path);
    if (value === "/api/v1/fleet") return Response.json({ workers: [{ workerId: `fleet-worker:${"c".repeat(32)}`,
      displayName: '<img src=x onerror=alert(1)> Ω', workerKind: "codex", status: "connected", lastSeenAt: null }], pendingCodes: [],
      results: [], connectBot: { available: true, release }, gatewayConfigured: true });
    if (value === "/api/v1/projects") return Response.json({ projects: [{ projectId: "project:alpha", title: "Alpha" }] });
    if (value.endsWith("/revoke")) return Response.json({ revoked: true });
    throw new Error(`unexpected fetch ${value}`);
  };
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => { root.render(<ConnectBotWorkspace />); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.deepEqual([...dom.window.document.querySelectorAll('select[name="bot-kind"] option')].map(option => option.textContent),
      ["Claude Code", "Codex", "Hermes", "Cursor", "Claude Desktop", "Generic MCP"]);
    assert.equal(dom.window.document.querySelectorAll('input[name="operating-system"]').length, 3);
    const unattended = dom.window.document.querySelector('input[name="unattended"]') as HTMLInputElement;
    assert.equal(unattended.checked, false);
    assert.equal(unattended.disabled, false);
    await act(async () => unattended.click());
    assert.equal(unattended.checked, true);
    const botPicker = dom.window.document.querySelector('select[name="bot-kind"]') as HTMLSelectElement;
    await act(async () => { botPicker.value = "hermes"; botPicker.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(dom.window.document.querySelectorAll('input[name^="worker-"]').length, 3,
      "Hermes unattended setup asks for its protected profile, model and provider before creating a code");
    await act(async () => { botPicker.value = "cursor"; botPicker.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
    assert.equal(unattended.checked, false);
    assert.equal(unattended.disabled, true, "interactive MCP-only kinds cannot promise unattended work");
    assert.match(dom.window.document.body.textContent ?? "", /Let this bot pick up approved work on its own[\s\S]*Off by default/iu);
    assert.match(dom.window.document.body.textContent ?? "", /If the fingerprint does not match,\s*stop and show the failure message to the lead/u);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Create a fresh code instead of editing/u);
    assert.equal(dom.window.document.querySelector("img"), null, "an HTML display name stays text");
    assert.match(dom.window.document.body.textContent ?? "", /<img src=x onerror=alert\(1\)> Ω/iu);
  } finally { await act(async () => root.unmount()); dom.window.close(); restoreGlobals(saved); }
});

test('R6C-04: expired sign-in and missing authority direct the owner to the correct recovery', {timeout:20000},async()=>{
  const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'https://control.example/workers/connect'});
  const keys=['window','document','Event','EventTarget','HTMLElement','HTMLInputElement','HTMLSelectElement','MouseEvent',
    'InputEvent','fetch','IS_REACT_ACT_ENVIRONMENT'];
  const saved=Object.fromEntries(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const key of keys)if(key in dom.window)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:(dom.window as any)[key]});
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const {createRoot}=await import('react-dom/client');
  const root=createRoot(dom.window.document.getElementById('root')!);
  let refusal:'authentication_required'|'access_denied'='authentication_required',posts=0;
  const handler=createFleetOwnerHttpHandlerV1({origin:'https://control.example',gatewayOrigin:'https://control.example',connectorRelease:release,
    service:{createEnrollmentCode:async()=>{throw new WebAccessError('access_denied');}} as any,
    localOwnerSession:{assertLocalRequest(){},verify(){if(refusal==='authentication_required')throw new WebAccessError('authentication_required');return {};}} as any});
  globalThis.fetch=async(path,init)=>{
    if(String(path)==='/api/v1/fleet')return Response.json({workers:[],pendingCodes:[],connectBot:{available:true,release}});
    if(String(path)==='/api/v1/projects')return Response.json({projects:[{projectId:'project:one',title:'One'}]});
    if(String(path)==='/api/v1/fleet/connect-codes'){
      posts++;return handler(new Request('https://control.example/api/v1/fleet/connect-codes',init));
    }
    assert.fail('unexpected page route');
  };
  try {
    await act(async()=>{root.render(<ConnectBotWorkspace/>);await new Promise(resolve=>setTimeout(resolve,0));});
    const input=dom.window.document.querySelector('input[name="bot-name"]') as HTMLInputElement;
    const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!;
    await act(async()=>{setter.call(input,'Fixture bot');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
      input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
    const project=[...dom.window.document.querySelectorAll('fieldset')].find(x=>x.querySelector('legend')?.textContent==='Projects')!;
    await act(async()=>{(project.querySelector('input') as HTMLInputElement).click();});
    const submit=dom.window.document.querySelector('button[type="submit"]') as HTMLButtonElement;
    assert.equal(submit.disabled,false,'valid selections must enable the real form');
    const messages:string[]=[];
    for(const status of ['authentication_required','access_denied'] as const){
      refusal=status;
      for(let i=0;i<20;i++)await act(async()=>{submit.click();await new Promise(resolve=>setTimeout(resolve,0));});
      const message=dom.window.document.querySelector('main > p[role="status"]')?.textContent??'';
      messages.push(message);
      assert.equal(dom.window.document.querySelector('main > p[role="status"] a')?.getAttribute('href'),
        status==='authentication_required' ? '/session' : undefined);

    }
    assert.equal(posts,40);
    assert.match(messages[0],/sign in again/i);
    assert.match(messages[1],/owner permission/i);
  } finally {
    await act(async()=>root.unmount());dom.window.close();
    for(const [key,descriptor]of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete(globalThis as any)[key];}
  }
});

test('R6C-04: each remaining connection failure has one plain recovery action', {timeout:20000},async()=>{
  const dom=new JSDOM('<div id="root"></div>',{pretendToBeVisual:true,url:'https://control.example/workers/connect'});
  const keys=['window','document','Event','EventTarget','HTMLElement','HTMLInputElement','HTMLSelectElement','MouseEvent',
    'InputEvent','fetch','IS_REACT_ACT_ENVIRONMENT'];
  const saved=Object.fromEntries(keys.map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  for(const key of keys)if(key in dom.window)Object.defineProperty(globalThis,key,{configurable:true,writable:true,value:(dom.window as any)[key]});
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  const {createRoot}=await import('react-dom/client');
  const root=createRoot(dom.window.document.getElementById('root')!);
  let failure: number | 'network' | 'bad-json' = 400, posts=0;
  globalThis.fetch=async(path,init)=>{
    if(String(path)==='/api/v1/fleet')return Response.json({workers:[],pendingCodes:[],connectBot:{available:true,release}});
    if(String(path)==='/api/v1/projects')return Response.json({projects:[{projectId:'project:one',title:'One'}]});
    if(String(path)==='/api/v1/fleet/connect-codes'){
      posts++;
      if(failure==='network') throw new TypeError('fixture connection dropped');
      if(failure==='bad-json') return new Response('{bad}',{status:201});
      return Response.json({error:'fixture_refusal'},{status:failure});
    }
    assert.fail('unexpected page route');
  };
  try {
    await act(async()=>{root.render(<ConnectBotWorkspace/>);await new Promise(resolve=>setTimeout(resolve,0));});
    const input=dom.window.document.querySelector('input[name="bot-name"]') as HTMLInputElement;
    const setter=Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value')!.set!;
    await act(async()=>{setter.call(input,'Fixture bot');input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
      input.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
    const project=[...dom.window.document.querySelectorAll('fieldset')].find(x=>x.querySelector('legend')?.textContent==='Projects')!;
    await act(async()=>{(project.querySelector('input') as HTMLInputElement).click();});
    const submit=dom.window.document.querySelector('button[type="submit"]') as HTMLButtonElement;
    assert.equal(submit.disabled,false,'valid selections must enable the real form');
    const cases: Array<[number | 'network' | 'bad-json',RegExp]> = [
      [400,/Check the choices and try again/], [404,/Reload this page before trying again/],
      [409,/Reload this page before trying again/], [429,/Open Workers to check for a waiting code before trying again/],
      [500,/Open Workers to check for a waiting code before trying again/], [503,/Open Workers to check for a waiting code before trying again/],
      ['network',/Open Workers to check for a waiting code before trying again/], ['bad-json',/Open Workers to check for a waiting code before trying again/],
    ];
    for(const [value,expected] of cases) {
      failure=value;
      await act(async()=>{submit.click();await new Promise(resolve=>setTimeout(resolve,0));});
      const message=dom.window.document.querySelector('main > p[role="status"]')?.textContent??'';
      assert.match(message,expected,String(value));
      assert.doesNotMatch(message,/Nothing changed/);
      // int9 B07: an unconfirmed code blocks "Create code" until the owner says the
      // pending code is dealt with; take that explicit way back before the next case.
      const recover=dom.window.document.querySelector('button[data-field="pending-code-resolved"]') as HTMLButtonElement|null;
      if(recover)await act(async()=>{recover.click();});
    }
    assert.equal(posts,cases.length);
  } finally {
    await act(async()=>root.unmount());dom.window.close();
    for(const [key,descriptor]of Object.entries(saved)){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete(globalThis as any)[key];}
  }
});
