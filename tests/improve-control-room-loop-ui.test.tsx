import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { PrivateImproveControlRoomWorkspace } from "../private-app/app/improve-control-room-workspace";
import { ImproveControlRoomDeskServiceV1 } from "../src/improve-control-room/v1/service";
import { ImproveControlRoomLoopServiceV1 } from "../src/web/v1/improve-control-room-loop-service";
import { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1, type LoopBridgeBindingV1 } from "../src/improve-control-room/v1/schemas";
import { type LoopAdapterV1, type LoopEngineStatusV1, loopByteHashV1 } from "../src/web/v1/improve-control-room-loop-adapter";
import { createImproveControlRoomHttpHandlerV1 } from "../src/web/v1/improve-control-room-http";
import { sha256Digest } from "../src/security";
import { taskFixture } from "./helpers/web-task";
import { now, origin, request, trust } from "./helpers/web-foundation";
import { loopImprovementBrowserClient as client } from "../src/web/v1/improve-control-room-loop-browser-client";

const KEY = new Uint8Array(32).fill(64);
const settingsText = '{"project":{"host_adapter":"local-loop"},"fixture":"SYNTHETIC"}';
const description = "  Improve the saved request.\nKeep exact text.  ";
async function fixture() {
  const f = await taskFixture();
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
  const adapter: LoopAdapterV1 = { adapterId: run.adapterId, toolingRevision, schemaDigest: sha256Digest({ fixture: "SYNTHETIC schema" }),
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
  const bridge = new ImproveControlRoomLoopServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, { integrityKey: KEY, adapter }, () => now);
  const handler = createImproveControlRoomHttpHandlerV1({ origin, trust, loopBridge: bridge, service: desk, clock: () => now });
  return { ...f, desk, bridge, handler, calls, requestId: draft.request.requestId, link: linked.runLink.runLinkId,
    edit: (change: Partial<LoopEngineStatusV1>) => { saved = { ...saved, ...change }; },
    close: async () => { await bridge.close(); await f.db.close(); } };
}

async function settle() { for (let i = 0; i < 12; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); }
async function mount(projectId: string, fetcher: typeof fetch, fragment = "") {
  const dom = new JSDOM("<div id='root'></div>", { url: `https://product.invalid/projects/${projectId}/improvements${fragment}`, pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, fetch: fetcher, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(<PrivateImproveControlRoomWorkspace projectId={projectId} />));
  return { dom, root, text: () => dom.window.document.body.textContent!,
    button: (text: string) => [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === text)!,
    close: async () => { await act(async () => root.unmount()); dom.window.close();
      for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } };
}
function transport(f: Awaited<ReturnType<typeof fixture>>) {
  const posts: { path: string; body: string; key: string }[] = [], gets: string[] = [];
  const fetcher = async (input: string | URL | Request, options?: RequestInit) => {
    const path = String(input); const method = options?.method ?? "GET";
    if (!path.includes("/improvements")) return Response.json({}, { status: 404 });
    if (method === "POST") posts.push({ path, body: String(options?.body), key: new Headers(options?.headers).get("idempotency-key")! }); else gets.push(path);
    return f.handler(request(path, method, options?.body ? JSON.parse(String(options.body)) : undefined, new Headers(options?.headers).get("idempotency-key") ?? "b2a-read-0000000001"));
  };
  return { posts, gets, fetcher: fetcher as typeof fetch };
}

test("B2a confirmed run Start progress Stop", async () => {
  const f = await fixture(), wire = transport(f);
  const m = await mount(f.project.projectId, wire.fetcher);
  try {
    await settle();
    assert.match(m.text(), /No improvement requests have been recorded/, "valid legacy desk control read");
    assert.ok(m.button("Start confirmed work"), "B2a confirmed-run Start control exists");
    assert.equal(m.button("Start confirmed work").disabled, false);
    await act(async () => m.button("Start confirmed work").click()); await settle();
    assert.match(m.text(), /running/); assert.match(m.text(), /Requested model: Unavailable/); assert.match(m.text(), /Observed model: Unverified/);
    assert.match(m.text(), /Repairs: Unavailable/); assert.ok(m.text().includes(description));
    assert.deepEqual(JSON.parse(wire.posts[0]!.body), { expectedVersion: 1, runLinkId: f.link, expectedRevision: 4 });
    assert.match(wire.posts[0]!.key, /^loop-start:/);
    await act(async () => m.button("Stop this run").click()); await settle();
    assert.match(m.text(), /Stopped/); assert.deepEqual(JSON.parse(wire.posts[1]!.body), { runLinkId: f.link });
    assert.deepEqual(f.calls.filter(x => x !== "status"), ["start", "stop"]);
    assert.equal(wire.gets.filter(path => path.endsWith("/improvements")).length, 0, "one loop desk read supplies legacy");
  } finally { await m.close(); await f.close(); }
});

test("B2a lost Start reply replays frozen action after revision increases and independent Stop", async () => {
  const f = await fixture(), wire = transport(f); let lose = true;
  const m = await mount(f.project.projectId, (async (path, options) => {
    const response = await wire.fetcher(path, options);
    if (String(path).endsWith("/start") && lose) { lose = false; throw new TypeError("SYNTHETIC lost accepted reply"); }
    return response;
  }) as typeof fetch);
  try {
    await settle(); await act(async () => m.button("Start confirmed work").click()); await settle();
    assert.match(m.text(), /Start could not be confirmed/); assert.equal(m.button("Start confirmed work").disabled, true);
    await act(async () => m.button("Retry this exact Start").click()); await settle();
    assert.equal(wire.posts.length, 2); assert.deepEqual(wire.posts[1], wire.posts[0], "revision increase preserves exact Start body/key");
    assert.equal(f.calls.filter(x => x === "start").length, 1);
    await act(async () => m.button("Stop this run").click()); await settle(); assert.match(m.text(), /Stopped/);
  } finally { await m.close(); await f.close(); }
});

test("B2a synchronous duplicate latch", async () => {
  const f = await fixture(), wire = transport(f); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const m = await mount(f.project.projectId, (async (path, options) => {
    if (String(path).endsWith("/start")) { const reply = wire.fetcher(path, options); await held; return reply; }
    return wire.fetcher(path, options);
  }) as typeof fetch);
  try {
    await settle(); const start = m.button("Start confirmed work");
    await act(async () => { for (let i = 0; i < 50; i++) start.click(); });
    assert.equal(wire.posts.length, 1, "B2a synchronous clicks attempt exactly one POST");
    release(); await settle();
  } finally { release(); await m.close(); await f.close(); }
});

test("B2a Start freshness gate", async () => {
  const f = await fixture(), wire = transport(f); let hold = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const m = await mount(f.project.projectId, (async (path, options) => {
    if (hold && String(path).endsWith("/status")) { const reply = wire.fetcher(path, options); await held; return reply; }
    return wire.fetcher(path, options);
  }) as typeof fetch);
  try {
    await settle(); hold = true;
    await act(async () => m.button("Refresh status").click()); await settle();
    await act(async () => m.button("Start confirmed work").click());
    assert.equal(wire.posts.length, 0, "B2a checking status attempts zero Start POSTs");
    release(); await settle();
  } finally { release(); await m.close(); await f.close(); }
});

test("B2a display identity binding", async () => {
  const f = await fixture(), wire = transport(f);
  const m = await mount(f.project.projectId, (async (path, options) => {
    const response = await wire.fetcher(path, options);
    if (!String(path).endsWith("/status")) return response;
    const body = await response.json(); body.display.projectId = "project:foreign";
    body.display.attention = { code: "FOREIGN", message: "FOREIGN SAVED PROGRESS", nextAction: "Wait." };
    return Response.json(body);
  }) as typeof fetch);
  try { await settle(); assert.ok(!m.text().includes("FOREIGN SAVED PROGRESS"), "B2a foreign display never reaches DOM");
    assert.equal(m.button("Start confirmed work").disabled, true); }
  finally { await m.close(); await f.close(); }
});

test("B2a stale response suppression", async () => {
  const f = await fixture(), wire = transport(f); const m = await mount(f.project.projectId, wire.fetcher);
  try {
    await settle(); await act(async () => m.button("Stop this run").click()); await settle(); assert.match(m.text(), /Stopped/);
    f.edit({ state: "running", revision: 1 });
    await act(async () => m.button("Refresh status").click()); await settle();
    assert.match(m.text(), /Stopped/, "B2a older running reply cannot erase known stopped");
    assert.equal(m.button("Start confirmed work").disabled, true);
  } finally { await m.close(); await f.close(); }
});

test("B2a transient refresh retains only Stop and protected failures clear the target", async () => {
  const f = await fixture(), wire = transport(f); let fail = 0;
  const m = await mount(f.project.projectId, (async (path, options) => {
    if (String(path).endsWith("/status") && fail) return Response.json({}, { status: fail });
    return wire.fetcher(path, options);
  }) as typeof fetch);
  try {
    await settle(); fail = 503; await act(async () => m.button("Refresh status").click()); await settle();
    assert.equal(m.button("Start confirmed work").disabled, true); assert.equal(m.button("Stop this run").disabled, false);
    assert.match(m.text(), /Could not refresh/); fail = 403;
    await act(async () => m.button("Refresh status").click()); await settle();
    assert.equal(m.button("Stop this run").disabled, true); assert.doesNotMatch(m.text(), /Confirmation current/);
    assert.equal(wire.posts.length, 0);
  } finally { await m.close(); await f.close(); }
});

test("B2a no automatic work on reopen focus fragment or terminal progress", async () => {
  const f = await fixture(), wire = transport(f);
  try {
    for (const state of ["ready", "waiting", "refused", "stopped", "finished"] as const) {
      f.edit({ state, revision: 10 });
      const m = await mount(f.project.projectId, wire.fetcher, `#request=${encodeURIComponent(f.requestId)}`);
      try {
        await settle(); await act(async () => { for (let i = 0; i < 50; i++) m.dom.window.dispatchEvent(new m.dom.window.Event("focus")); }); await settle();
        assert.equal(wire.posts.length, 0); assert.equal(m.dom.window.document.activeElement?.textContent, "Saved request");
        if (state !== "ready") assert.equal(m.button("Start confirmed work").disabled, true);
        if (state === "finished") assert.match(m.text(), /Finished candidate/);
      } finally { await m.close(); }
    }
    const unknown = await mount(f.project.projectId, wire.fetcher, "#request=request%3Aforeign");
    try { await settle(); assert.match(unknown.text(), /This saved request is unavailable/); assert.equal(unknown.button("Start confirmed work"), undefined); }
    finally { await unknown.close(); }
    assert.equal(f.calls.filter(x => x !== "status").length, 0);
  } finally { await f.close(); }
});

test("B2a missing confirmation and changed A2 scalar refuse Start with zero writes", async () => {
  const f = await fixture(), wire = transport(f);
  try {
    for (const change of [{ confirmation: null }, { inputVersion: 1 }, { description: `${description}changed` }, { settingsSha256: "0".repeat(64) }]) {
      f.edit(change);
      const before = (await f.db.query("SELECT count(*)::int n FROM control_loop_improvement_commands")).rows[0];
      const m = await mount(f.project.projectId, wire.fetcher);
      try { await settle(); await act(async () => m.button("Start confirmed work").click()); assert.equal(wire.posts.length, 0); }
      finally { await m.close(); }
      const response = await f.handler(request(`/api/v1/projects/${encodeURIComponent(f.project.projectId)}/improvements/loop/${encodeURIComponent(f.requestId)}/start`, "POST",
        { expectedVersion: 1, expectedRevision: 4, runLinkId: f.link }, "b2a-refused-start-0001"));
      assert.equal(response.status, 409); assert.deepEqual((await f.db.query("SELECT count(*)::int n FROM control_loop_improvement_commands")).rows[0], before);
    }
    assert.equal(f.calls.filter(x => x !== "status").length, 0);
  } finally { await f.close(); }
});

test("B2a browser client uses strict desk and status response boundaries", async () => {
  const previous = globalThis.fetch;
  const legacy = { projectId: "project:synthetic", templates: [], requests: [], startsWork: false, grantsDeployAuthority: false };
  try {
    for (const response of [Response.json({}), new Response('{"broken":', { headers: { "content-type": "application/json" } }),
      new Response("x".repeat(1_048_577), { headers: { "content-type": "application/json" } }), new Response("{}", { headers: { "content-type": "text/html" } })]) {
      globalThis.fetch = async () => response;
      await assert.rejects(client.readStatus("project:synthetic", "request:synthetic", new AbortController().signal));
    }
    const paths: string[] = [];
    globalThis.fetch = async (url, options) => {
      paths.push(String(url)); assert.equal(options?.credentials, "same-origin"); assert.equal(options?.cache, "no-store"); assert.equal(options?.redirect, "error");
      return String(url).endsWith("/loop/desk") ? Response.json({}, { status: 404 }) : Response.json(legacy);
    };
    assert.deepEqual(await client.readDesk(legacy.projectId, new AbortController().signal), { kind: "legacy", legacy });
    assert.equal(paths.length, 2);
    globalThis.fetch = async () => Response.json({}, { status: 503 });
    await assert.rejects(client.readDesk(legacy.projectId, new AbortController().signal));
  } finally { globalThis.fetch = previous; }
});

test("B2a dropped-before-admission and uncertain Stop retain separate replay keys", async () => {
  const f = await fixture(), wire = transport(f); let dropStart = true, dropStop = true;
  const attempted: { path: string; key: string; body: string }[] = [];
  const m = await mount(f.project.projectId, (async (path, options) => {
    if (options?.method === "POST") attempted.push({ path: String(path), key: new Headers(options.headers).get("idempotency-key")!, body: String(options.body) });
    if (String(path).endsWith("/start") && dropStart) { dropStart = false; throw new TypeError("SYNTHETIC drop before admission"); }
    const reply = await wire.fetcher(path, options);
    if (String(path).endsWith("/stop") && dropStop) { dropStop = false; throw new TypeError("SYNTHETIC lost Stop reply"); }
    return reply;
  }) as typeof fetch);
  try {
    await settle(); await act(async () => m.button("Start confirmed work").click()); await settle();
    assert.equal(f.calls.filter(x => x === "start").length, 0);
    assert.equal(m.button("Stop this run").disabled, false, "uncertain Start never blocks Stop");
    await act(async () => m.button("Retry this exact Start").click()); await settle();
    assert.deepEqual(attempted[1], attempted[0]); assert.equal(f.calls.filter(x => x === "start").length, 1);
    await act(async () => m.button("Stop this run").click()); await settle(); assert.match(m.text(), /Stopped/);
    assert.notEqual(attempted[2]!.key, attempted[0]!.key); assert.equal(f.calls.filter(x => x === "stop").length, 1);
  } finally { await m.close(); await f.close(); }
});

test("B2a two independently frozen browser Starts contend on the one journal", async () => {
  const f = await fixture(), wire = transport(f), previous = globalThis.fetch; globalThis.fetch = wire.fetcher;
  try {
    const body = JSON.stringify({ expectedVersion: 1, expectedRevision: 4, runLinkId: f.link });
    const results = await Promise.allSettled([client.start(f.project.projectId, f.requestId, { body, key: "loop-start:browser-one-0001" }),
      client.start(f.project.projectId, f.requestId, { body, key: "loop-start:browser-two-0001" })]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(f.calls.filter(x => x === "start").length, 1);
    assert.equal((await f.db.query("SELECT count(*)::int n FROM control_loop_improvement_commands WHERE operation='start' AND entry_kind='claim'")).rows[0]!.n, 1);
  } finally { globalThis.fetch = previous; await f.close(); }
});
