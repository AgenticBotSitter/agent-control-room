import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
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
async function fixture(startOutcome: "accepted" | "waiting" | "refused" | "missing" = "accepted", startError: "REFUSED" | "INELIGIBLE" | "LAUNCH_UNCERTAIN" | null = null) {
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
    saved = { ...saved, state: op === "stop" ? "stopped" : startOutcome === "accepted" ? "running" : "ready", revision: saved.revision + 1,
      receipts: op === "start" && startOutcome === "missing" ? saved.receipts : [...saved.receipts, { commandId, bindingDigest: sha256Digest(binding),
        state: op === "start" && startOutcome !== "missing" ? startOutcome : "accepted", evidenceDigest: sha256Digest({ op, commandId }), error: op === "start" && startError !== "LAUNCH_UNCERTAIN" ? startError : null }] };
    // Deliberately malformed SYNTHETIC adapter data must be rejected by the real result decoder.
    if (op === "start" && startError === "LAUNCH_UNCERTAIN") return structuredClone({ ...saved,
      receipts: saved.receipts.map(receipt => ({ ...receipt, error: "LAUNCH_UNCERTAIN" })) }) as unknown as LoopEngineStatusV1;
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
    snapshot: () => structuredClone(saved),
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

test("B2a unconfigured loop desk keeps the original legacy intro", async () => {
  const f = await fixture(), wire = transport(f);
  const m = await mount(f.project.projectId, ((input, options) => String(input).endsWith("/loop/desk")
    ? Promise.resolve(Response.json({}, { status: 404 })) : wire.fetcher(input, options)) as typeof fetch);
  try {
    await settle();
    assert.match(m.text(), /Loop work is not configured\./); assert.match(m.text(), /No improvement requests have been recorded/);
    assert.match(m.text(), /Ask for an improvement, choose the existing worker pipeline/);
    assert.doesNotMatch(m.text(), /Start confirmed saved work and follow its progress/);
  } finally { await m.close(); await f.close(); }
});

test("B2a confirmed run Start progress Stop", async () => {
  const f = await fixture(), wire = transport(f);
  const m = await mount(f.project.projectId, wire.fetcher);
  try {
    await settle();
    assert.match(m.text(), /No improvement requests have been recorded/, "valid legacy desk control read");
    assert.ok(m.button("Start confirmed work"), "B2a confirmed-run Start control exists");
    assert.equal(m.button("Start confirmed work").disabled, false);
    await act(async () => m.button("Start confirmed work").click()); await settle();
    assert.match(m.text(), /Work is running/); assert.match(m.text(), /Requested model: Not reported yet/); assert.match(m.text(), /Observed model: Not verified yet/);
    assert.match(m.text(), /Repairs: Not reported yet/); assert.ok(m.text().includes(description));
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
  try { for (const field of ["projectId", "requestId"] as const) {
  const m = await mount(f.project.projectId, (async (path, options) => {
    const response = await wire.fetcher(path, options);
    if (!String(path).endsWith("/status")) return response;
    const body = await response.json(); body.display[field] = `${field}:foreign`;
    body.display.attention = { code: "FOREIGN", message: "FOREIGN SAVED PROGRESS", nextAction: "Wait." };
    return Response.json(body);
  }) as typeof fetch);
  try { await settle(); assert.ok(!m.text().includes("FOREIGN SAVED PROGRESS"), "B2a foreign display never reaches DOM");
    assert.equal(m.button("Start confirmed work").disabled, true); }
  finally { await m.close(); }
  } } finally { await f.close(); }
});

test("B2a stale response suppression", async () => {
  const f = await fixture(), wire = transport(f); let hold = false, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const m = await mount(f.project.projectId, (async (path, options) => {
    const reply = await wire.fetcher(path, options);
    if (hold && String(path).endsWith("/status")) await held;
    return reply;
  }) as typeof fetch);
  try {
    await settle(); await act(async () => m.button("Start confirmed work").click()); await settle();
    await act(async () => m.button("Stop this run").click()); await settle(); assert.match(m.text(), /Stopped/);
    f.edit({ state: "running", revision: 1 }); hold = true;
    await act(async () => m.button("Refresh status").click()); await settle();
    release(); await settle();
    assert.match(m.text(), /Stopped/, "B2a older running reply cannot erase known stopped");
    assert.equal(m.button("Start confirmed work").disabled, true);
  } finally { release(); await m.close(); await f.close(); }
});

test("B2a transient refresh retains only Stop and protected failures clear the target", async () => {
  const f = await fixture(), wire = transport(f); let fail = 0;
  const m = await mount(f.project.projectId, (async (path, options) => {
    if (String(path).endsWith("/status") && fail) return Response.json({}, { status: fail });
    return wire.fetcher(path, options);
  }) as typeof fetch);
  try {
    await settle(); await act(async () => m.button("Start confirmed work").click()); await settle();
    fail = 503; await act(async () => m.button("Refresh status").click()); await settle();
    assert.equal(m.button("Start confirmed work").disabled, true); assert.equal(m.button("Stop this run").disabled, false);
    assert.match(m.text(), /Could not refresh/); fail = 403;
    await act(async () => m.button("Refresh status").click()); await settle();
    assert.equal(m.button("Stop this run").disabled, true); assert.doesNotMatch(m.text(), /Confirmation current/);
    assert.equal(wire.posts.length, 1);
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
    const baseline = f.snapshot();
    for (const change of [{ confirmation: null }, { inputVersion: 1 }, { description: `${description}changed` }, { settingsSha256: "0".repeat(64) }]) {
      f.edit({ ...baseline, ...change });
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
    if (String(path).endsWith("/stop") && dropStop) { dropStop = false; f.edit({ state: "running", revision: 6 }); throw new TypeError("SYNTHETIC lost Stop reply"); }
    return reply;
  }) as typeof fetch);
  try {
    await settle(); await act(async () => m.button("Start confirmed work").click()); await settle();
    assert.equal(f.calls.filter(x => x === "start").length, 0);
    assert.equal(m.button("Stop this run").disabled, true, "dropped-before-admission Start has no owned operation to Stop");
    await act(async () => m.button("Retry this exact Start").click()); await settle();
    assert.deepEqual(attempted[1], attempted[0]); assert.equal(f.calls.filter(x => x === "start").length, 1);
    await act(async () => m.button("Stop this run").click()); await settle();
    assert.doesNotMatch(m.text(), /Stopped/); assert.match(m.text(), /Stop could not be confirmed/);
    await act(async () => m.button("Retry this exact Stop").click()); await settle();
    assert.deepEqual(attempted[3], attempted[2]); assert.match(m.text(), /Stop requested/); assert.doesNotMatch(m.text(), /Stopped/);
    f.edit({ state: "stopped", revision: 7 }); await act(async () => m.button("Refresh status").click()); await settle(); assert.match(m.text(), /Stopped/);
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
    assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int n FROM control_loop_improvement_commands WHERE operation='start' AND entry_kind='claim'")).rows[0]!.n, 1);
  } finally { globalThis.fetch = previous; await f.close(); }
});

test("B2a reviewed display evidence separates requested and observed identities", async () => {
  const f = await fixture(), wire = transport(f);
  const m = await mount(f.project.projectId, (async (path, options) => {
    const response = await wire.fetcher(path, options);
    if (!String(path).endsWith("/status")) return response;
    const value = await response.json();
    // Explicit product projection fixture, not guessed raw A2 keys.
    value.display.progress = { stepId: "build", role: "builder", attempt: 3, requestedModel: "requested-model",
      observedModel: "observed-model", identityVerified: true, repairCount: 2 };
    return Response.json(value);
  }) as typeof fetch);
  try { await settle(); assert.match(m.text(), /Requested model: requested-model/); assert.match(m.text(), /Observed model: observed-model/);
    assert.match(m.text(), /Attempt: 3 · Repairs: 2/); assert.match(m.text(), /Step: build · Role: builder/); }
  finally { await m.close(); await f.close(); }
});

test("B2a request deadline aborts an unresponsive transport without a POST retry", async t => {
  const previous = globalThis.fetch; let aborted = false, requests = 0;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  globalThis.fetch = async (_url, options) => { requests++; options?.signal?.addEventListener("abort", () => { aborted = true; }); return new Promise<Response>(() => {}); };
  try {
    const result = client.readStatus("project:synthetic", "request:synthetic", new AbortController().signal);
    t.mock.timers.tick(10_000); await assert.rejects(result); assert.equal(aborted, true); assert.equal(requests, 1);
  } finally { globalThis.fetch = previous; t.mock.timers.reset(); }
});

test("B2a status link version and hashes must match the server-listed request", async () => {
  const f = await fixture(), wire = transport(f);
  try {
    for (const change of [{ runLinkId: "link:foreign" }, { localVersion: 2 }, { requestSha256: "0".repeat(64) }, { settingsSha256: "0".repeat(64) }]) {
      const m = await mount(f.project.projectId, (async (path, options) => {
        const reply = await wire.fetcher(path, options);
        if (!String(path).endsWith("/status")) return reply;
        const value = await reply.json(); Object.assign(value.display, change); return Response.json(value);
      }) as typeof fetch);
      try { await settle(); assert.equal(m.button("Start confirmed work").disabled, true); assert.equal(m.button("Stop this run").disabled, true); }
      finally { await m.close(); }
    }
    assert.equal(wire.posts.length, 0); assert.equal(f.calls.filter(x => x !== "status").length, 0);
  } finally { await f.close(); }
});

test("B2a forged browser Start booleans cannot create service authority", async () => {
  const f = await fixture(), wire = transport(f); f.edit({ confirmation: null });
  const m = await mount(f.project.projectId, (async (path, options) => {
    const reply = await wire.fetcher(path, options);
    if (!String(path).endsWith("/status")) return reply;
    const value = await reply.json(); value.display.canStart = true; value.display.confirmationCurrent = true; return Response.json(value);
  }) as typeof fetch);
  try {
    await settle(); await act(async () => m.button("Start confirmed work").click()); await settle();
    assert.equal(wire.posts.length, 1, "forged browser flags reach the real reauthorization boundary");
    assert.equal(f.calls.filter(x => x === "start").length, 0);
    assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int n FROM control_loop_improvement_commands")).rows[0]!.n, 0);
  } finally { await m.close(); await f.close(); }
});

for (const error of ["REFUSED", "INELIGIBLE"] as const) test(`B2a F1 refused Start shows ${error} after reopen`, async () => {
  const f = await fixture("refused", error), wire = transport(f);
  try {
    const receipt = await f.bridge.mutate(f.identity, f.project.projectId, f.requestId, "start",
      { expectedVersion: 1, expectedRevision: 4, runLinkId: f.link }, "loop-start:refused-0001");
    assert.equal(receipt.state, "refused");
    const { display } = await f.bridge.status(f.identity, f.project.projectId, f.requestId);
    assert.equal(display.startState, "not_started", "B2a refused Start is not dispatched");
    assert.equal(display.state, "blocked"); assert.equal(display.canStart, false);
    assert.equal(display.attention?.code, error, "B2a saved refusal reason is retained");
    assert.match(display.attention!.message, error === "INELIGIBLE" ? /ineligible/i : /refused/i);
    const m = await mount(f.project.projectId, wire.fetcher);
    try {
      await settle(); assert.match(m.text(), /Work needs attention/);
      assert.ok(m.text().includes(display.attention!.message), "B2a owner sees why Start is unavailable");
      assert.equal(m.button("Start confirmed work").disabled, true);
      assert.equal(wire.posts.length, 0);
    } finally { await m.close(); }
    await assert.rejects(f.bridge.mutate(f.identity, f.project.projectId, f.requestId, "start",
      { expectedVersion: 1, expectedRevision: 5, runLinkId: f.link }, "loop-start:refused-new-key"));
    assert.equal(f.calls.filter(x => x === "start").length, 1, "B2a refusal never permits redispatch");
  } finally { await f.close(); }
});

for (const outcome of ["waiting", "missing"] as const) test(`B2a F1 ${outcome} Start remains visible`, async () => {
  const f = await fixture(outcome), wire = transport(f);
  try {
    const receipt = await f.bridge.mutate(f.identity, f.project.projectId, f.requestId, "start",
      { expectedVersion: 1, expectedRevision: 4, runLinkId: f.link }, "loop-start:waiting-0001");
    assert.equal(receipt.state, outcome === "waiting" ? "waiting" : "uncertain");
    const { display } = await f.bridge.status(f.identity, f.project.projectId, f.requestId);
    assert.equal(display.startState, outcome === "waiting" ? "dispatched" : "uncertain");
    assert.equal(display.canStart, false); assert.equal(display.canStop, true);
    assert.equal(display.attention?.code, outcome === "waiting" ? "WAITING_OWNER" : "LAUNCH_UNCERTAIN",
      "B2a journal wait or missing result explains unavailable Start");
    if (outcome === "waiting") assert.equal(display.state, "waiting_owner");
    const m = await mount(f.project.projectId, wire.fetcher);
    try {
      await settle(); assert.ok(m.text().includes(display.attention!.message));
      assert.equal(m.button("Start confirmed work").disabled, true);
      assert.equal(m.button("Stop this run").disabled, false); assert.equal(wire.posts.length, 0);
    } finally { await m.close(); }
  } finally { await f.close(); }
});

test("B2a F2 stopped run retains exact saved confirmation", async () => {
  const f = await fixture(), wire = transport(f);
  try {
    await f.bridge.mutate(f.identity, f.project.projectId, f.requestId, "start",
      { expectedVersion: 1, expectedRevision: 4, runLinkId: f.link }, "loop-start:confirmation-0001");
    await f.bridge.mutate(f.identity, f.project.projectId, f.requestId, "stop", { runLinkId: f.link }, "loop-stop:confirmation-0001");
    const { display } = await f.bridge.status(f.identity, f.project.projectId, f.requestId);
    assert.equal(display.confirmationCurrent, true, "B2a stopped exact confirmation remains current");
    assert.equal(display.canStart, false); assert.equal(display.canStop, false);
    const m = await mount(f.project.projectId, wire.fetcher);
    try {
      await settle(); assert.match(m.text(), /Stopped/); assert.match(m.text(), /Confirmation current/);
      assert.doesNotMatch(m.text(), /Confirmation needed/); assert.equal(wire.posts.length, 0);
    } finally { await m.close(); }
    f.edit({ confirmation: null });
    assert.equal((await f.bridge.status(f.identity, f.project.projectId, f.requestId)).display.confirmationCurrent, false);
  } finally { await f.close(); }
});

test("B2a F2 confirmation is unavailable before accepted status", async () => {
  const f = await fixture(), wire = transport(f); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const m = await mount(f.project.projectId, (async (path, options) => {
    if (String(path).endsWith("/status")) await held;
    return wire.fetcher(path, options);
  }) as typeof fetch);
  try {
    await settle(); assert.ok(m.button("Start confirmed work"));
    assert.doesNotMatch(m.text(), /Confirmation needed/, "B2a unread confirmation is not a missing confirmation");
    assert.match(m.text(), /Confirmation could not be checked/);
    release(); await settle(); assert.match(m.text(), /Confirmation current/);
  } finally { release(); await m.close(); await f.close(); }
});

test("B2a F3 Stop requires an admitted Start", async () => {
  const f = await fixture(), wire = transport(f);
  try {
    const { display } = await f.bridge.status(f.identity, f.project.projectId, f.requestId);
    assert.equal(display.startState, "not_started");
    assert.equal(display.canStop, false, "B2a service offers no Stop before admitted Start");
    const m = await mount(f.project.projectId, wire.fetcher);
    try {
      await settle(); assert.equal(m.button("Stop this run").disabled, true);
      await act(async () => m.button("Stop this run").click()); assert.equal(wire.posts.length, 0);
      await act(async () => m.button("Start confirmed work").click()); await settle();
      assert.equal(m.button("Stop this run").disabled, false);
    } finally { await m.close(); }
  } finally { await f.close(); }
});

test("B2a F3 panel rejects canStop without a Start claim", async () => {
  const f = await fixture(), wire = transport(f);
  const m = await mount(f.project.projectId, (async (path, options) => {
    const response = await wire.fetcher(path, options);
    if (!String(path).endsWith("/status")) return response;
    const body = await response.json(); body.display.canStop = true;
    return Response.json(body);
  }) as typeof fetch);
  try {
    await settle(); assert.equal(m.button("Stop this run").disabled, true, "B2a panel requires admitted Start even with canStop");
    await act(async () => m.button("Stop this run").click());
    assert.equal(wire.posts.length, 0); assert.equal(f.calls.filter(x => x === "stop").length, 0);
  } finally { await m.close(); await f.close(); }
});


test("B2a R3 website mutation step has its own timeout", async () => {
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  const step = workflow.split("      - name: Prove saved loop website guards\n")[1]!.split("      - name:")[0]!;
  assert.match(step, /^        timeout-minutes: 5$/m, "B2a website guards have a five-minute step budget");
  assert.match(step, /^        run: pnpm run test:improve-control-room-loop-ui-mutations$/m);
  assert.doesNotMatch(step, /^        if:/m);
});

test("B2a R3 forged started display cannot Stop a never-started run", async () => {
  const f = await fixture(), wire = transport(f);
  const m = await mount(f.project.projectId, (async (path, options) => {
    const response = await wire.fetcher(path, options);
    if (!String(path).endsWith("/status")) return response;
    const body = await response.json(); body.display.canStop = true; body.display.startState = "started";
    return Response.json(body);
  }) as typeof fetch);
  try {
    const before = (await f.db.query("SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind")).rows;
    await settle(); assert.equal(m.button("Stop this run").disabled, false);
    await act(async () => m.button("Stop this run").click()); await settle();
    assert.equal(wire.posts.length, 1, "forged display exercises the server Stop boundary");
    assert.equal(f.calls.filter(x => x === "stop").length, 0, "B2a never-started run reaches zero adapter Stop calls");
    assert.deepEqual((await f.db.query("SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind")).rows,
      before, "refused Stop appends no command claim or result");
    const response = await f.handler(request(`/api/v1/projects/${f.project.projectId}/improvements/loop/${f.requestId}/stop`,
      "POST", { runLinkId: f.link }, "loop-stop:forged-direct-0001"));
    assert.equal(response.status, 409, "direct Stop also requires a signed admitted Start");
  } finally { await m.close(); await f.close(); }
});

test("B2a R3 stopped run refuses fresh Start and confirm", async () => {
  const f = await fixture();
  try {
    await f.bridge.mutate(f.identity, f.project.projectId, f.requestId, "start",
      { expectedVersion: 1, expectedRevision: 4, runLinkId: f.link }, "loop-start:stopped-0001");
    await f.bridge.mutate(f.identity, f.project.projectId, f.requestId, "stop", { runLinkId: f.link }, "loop-stop:stopped-0001");
    // Fresh local version has no prior authorization/confirmation claim that could mask the stopped guard.
    const revised = await f.desk.reviseLoopDraft(f.identity, f.project.projectId, { requestId: f.requestId, expectedVersion: 1,
      description, settingsText }, "b2a-stopped-revision-0001");
    assert.equal(revised.request.currentVersion, 2);
    const saved = f.snapshot();
    const before = (await f.db.query("SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind")).rows;
    const base = `/api/v1/projects/${f.project.projectId}/improvements/loop/${f.requestId}`;
    const confirm = { expectedVersion: 2, expectedRevision: saved.revision,
      requestSha256: loopByteHashV1(description), settingsSha256: loopByteHashV1(settingsText) };
    assert.equal((await f.handler(request(`${base}/confirm`, "POST", confirm, "loop-confirm:stopped-0001"))).status,
      409, "B2a stopped confirmation refuses before dispatch");
    assert.equal((await f.handler(request(`${base}/start`, "POST", { expectedVersion: 2,
      expectedRevision: saved.revision, runLinkId: f.link }, "loop-start:stopped-fresh-0001"))).status,
      409, "B2a stopped Start refuses before dispatch");
    assert.deepEqual(f.calls.filter(x => x !== "status"), ["start", "stop"]);
    assert.deepEqual((await f.db.query("SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind")).rows, before);
  } finally { await f.close(); }
});

test("B2a R3 LAUNCH_UNCERTAIN outcome never says refused", async () => {
  const f = await fixture("refused", "LAUNCH_UNCERTAIN");
  try {
    const receipt = await f.bridge.mutate(f.identity, f.project.projectId, f.requestId, "start",
      { expectedVersion: 1, expectedRevision: 4, runLinkId: f.link }, "loop-start:uncertain-wording-0001");
    assert.equal(receipt.state, "uncertain"); assert.equal(receipt.error, "LAUNCH_UNCERTAIN");
    const { display } = await f.bridge.status(f.identity, f.project.projectId, f.requestId);
    assert.equal(display.startState, "uncertain");
    assert.equal(display.attention?.code, "LAUNCH_UNCERTAIN");
    assert.equal(display.attention?.message, "Start could not be confirmed.", "B2a uncertain outcome describes uncertainty");
    assert.doesNotMatch(display.attention!.message, /refused/i);
    assert.equal(display.canStart, false); assert.equal(display.canStop, true);
    const stopped = await f.handler(request(`/api/v1/projects/${f.project.projectId}/improvements/loop/${f.requestId}/stop`,
      "POST", { runLinkId: f.link }, "loop-stop:uncertain-wording-0001"));
    assert.equal(stopped.status, 202, "admitted uncertain Start still permits owned Stop");
    assert.deepEqual(f.calls.filter(x => x !== "status"), ["start", "stop"]);
    assert.equal((await f.bridge.status(f.identity, f.project.projectId, f.requestId)).display.state, "stopped");
  } finally { await f.close(); }
});

test("B2a R3 offline panel sends zero mutations", async () => {
  const f = await fixture(), wire = transport(f), m = await mount(f.project.projectId, wire.fetcher);
  try {
    Object.defineProperty(m.dom.window.navigator, "onLine", { get: () => false });
    await settle();
    await act(async () => m.button("Start confirmed work").click());
    assert.equal(wire.posts.length, 0, "B2a offline Start sends no POST");
    await f.bridge.mutate(f.identity, f.project.projectId, f.requestId, "start",
      { expectedVersion: 1, expectedRevision: 4, runLinkId: f.link }, "loop-start:offline-0001");
    await act(async () => m.button("Refresh status").click()); await settle();
    assert.equal(m.button("Stop this run").disabled, false);
    await act(async () => m.button("Stop this run").click());
    assert.equal(wire.posts.length, 0, "B2a offline Stop sends no POST");
    assert.deepEqual(f.calls.filter(x => x !== "status"), ["start"]);
  } finally { await m.close(); await f.close(); }
});


test("B2a R3 stopped engine cannot admit its first website Start", async () => {
  const f = await fixture();
  try {
    f.edit({ state: "stopped" });
    const status = await f.bridge.status(f.identity, f.project.projectId, f.requestId);
    assert.equal(status.display.confirmationCurrent, true);
    const response = await f.handler(request(`/api/v1/projects/${f.project.projectId}/improvements/loop/${f.requestId}/start`,
      "POST", { expectedVersion: 1, expectedRevision: 4, runLinkId: f.link }, "loop-start:stopped-engine-0001"));
    assert.equal(response.status, 409, "B2a stopped engine refuses Start despite current confirmation");
    assert.deepEqual(f.calls.filter(x => x !== "status"), []);
    assert.equal((await f.db.query<{ n: number }>("SELECT count(*)::int n FROM control_loop_improvement_commands")).rows[0]!.n, 0);
  } finally { await f.close(); }
});


test("B5 failed desk load gives an actionable retry and no endless loading", async () => {
  const f = await fixture(), wire = transport(f); let fail = true;
  const m = await mount(f.project.projectId, ((input, options) => fail
    ? Promise.resolve(Response.json({}, { status: 503 })) : wire.fetcher(input, options)) as typeof fetch);
  try {
    await settle();
    assert.doesNotMatch(m.text(), /Loading saved improvement desk/);
    assert.match(m.text(), /could not be checked/i);
    assert.ok(m.button("Retry loading desk"));
    fail = false;
    await act(async () => m.button("Retry loading desk").click()); await settle();
    assert.ok(m.button("Start confirmed work"));
  } finally { await m.close(); await f.close(); }
});

test("B5 desk loading watchdog bounds a stuck read and recovers on retry", async t => {
  const f = await fixture(), wire = transport(f);
  const original = client.readDesk;
  client.readDesk = async () => new Promise<never>(() => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const m = await mount(f.project.projectId, wire.fetcher);
  try {
    assert.match(m.text(), /Loading saved improvement desk/);
    await act(async () => { t.mock.timers.tick(15_000); });
    assert.doesNotMatch(m.text(), /Loading saved improvement desk/);
    assert.match(m.text(), /taking too long/i);
    assert.ok(m.button("Retry loading desk"));
    client.readDesk = original; t.mock.timers.reset();
    await act(async () => m.button("Retry loading desk").click()); await settle();
    assert.ok(m.button("Start confirmed work"));
  } finally { await m.close(); await f.close(); client.readDesk = original; t.mock.timers.reset(); }
});

test("B5 refused first planning step renders reason and recovery without Start authority", async () => {
  const f = await fixture(), wire = transport(f);
  f.edit({ state: "refused", confirmation: null, progress: { step: "orchestrator", completed: 0, attention: "blocked" },
    decisions: { observedAt: new Date(now).toISOString(), gate: { kind: "blocked", code: "UNAVAILABLE",
      message: "The first planning step could not start because the launch checks rejected the request." } } });
  const m = await mount(f.project.projectId, wire.fetcher);
  try {
    await settle();
    assert.match(m.text(), /first planning step could not start/);
    assert.match(m.text(), /Check the project settings, then use Prepare request to retry/);
    assert.match(m.text(), /Prepare request/);
    assert.equal(m.button("Start confirmed work").disabled, true);
    assert.doesNotMatch(m.text(), /Loading saved improvement desk/);
  } finally { await m.close(); await f.close(); }
});

for (const pending of [true, false]) test(`B5 unlinked intake renders ${pending ? "progress" : "timeout"} without owner command authority`, async () => {
  const f = await fixture(), wire = transport(f);
  const saved = await f.bridge.status(f.identity, f.project.projectId, f.requestId);
  const attention = pending ? { code: "INTAKE_IN_PROGRESS", message: "Intake in progress.",
    nextAction: "Wait while the saved request is linked. This status is limited to two minutes from intake." }
    : { code: "INTAKE_TIMEOUT", message: "Intake could not be confirmed within two minutes.",
      nextAction: "Ask the lead to check this saved request before preparing another one." };
  const local = { ...saved, request: { ...saved.request, runLink: null, savedAuthorization: false },
    display: { ...saved.display, runLinkId: null, state: pending ? null : "blocked", startState: "not_started",
      confirmationCurrent: false, canStart: false, canStop: false, attention },
    engine: { ...saved.engine, state: pending ? "draft" : "refused", confirmation: null },
    decisions: { gate: pending ? null : { kind: "blocked", code: "UNAVAILABLE", message: attention.message }, observedAt: saved.display.observedAt } };
  const fetcher = (async (input, options) => {
    const path = String(input);
    if (path.endsWith(`/${encodeURIComponent(f.requestId)}/status`)) return Response.json(local);
    const response = await wire.fetcher(input, options);
    if (path.endsWith("/loop/desk")) {
      const desk = await response.json();
      return Response.json({ ...desk, loopRequests: desk.loopRequests.map((row: typeof saved.request) => ({ ...row, runLink: null, savedAuthorization: false })) });
    }
    return response;
  }) as typeof fetch;
  const m = await mount(f.project.projectId, fetcher);
  try {
    await settle();
    assert.match(m.text(), pending ? /Intake in progress\./ : /Intake could not be confirmed within two minutes\./);
    assert.ok([...m.dom.window.document.querySelectorAll(pending ? '[role="status"]' : '[role="alert"]')]
      .some(node => node.textContent?.includes(attention.message)));
    assert.equal(m.button("Start confirmed work"), undefined); assert.equal(m.button("Stop this run"), undefined);
    assert.equal(wire.posts.length, 0);
  } finally { await m.close(); await f.close(); }
});

// Drive the real workspace and polling hook with an intake snapshot, without
// waiting two wall-clock minutes or starting an engine/controller process.
for (const scenario of ["gate", "cap", "unlinked", "link", "settled", "old"] as const) test(`B5 first-gate polling ${scenario}`, async t => {
  const f = await fixture(), wire = transport(f);
  const saved = await f.bridge.status(f.identity, f.project.projectId, f.requestId);
  const desk = await (await wire.fetcher(`/api/v1/projects/${f.project.projectId}/improvements/loop/desk`)).json();
  const start = now;
  const unlinked = scenario === "unlinked" || scenario === "link";
  desk.loopRequests = desk.loopRequests.map((row: typeof saved.request) => ({ ...row,
    createdAt: new Date(start - (scenario === "old" ? 120_001 : 0)).toISOString(),
    savedAuthorization: scenario === "settled", ...(unlinked ? { runLink: null } : {}) }));
  let gate = false;
  const reads: { status: number[]; desk: number[] } = { status: [], desk: [] };
  const fetcher = (async (input, options) => {
    assert.equal(options?.method ?? "GET", "GET", "polling never issues a command");
    const path = String(input);
    if (path.endsWith("/loop/desk")) { reads.desk.push(Date.now()); return Response.json(desk); }
    if (path.endsWith("/status")) {
      reads.status.push(Date.now());
      return Response.json({ ...saved, request: desk.loopRequests[0],
        display: { ...saved.display, ...(!desk.loopRequests[0].runLink ? { runLinkId: null } : {}),
          state: scenario === "settled" ? "ready" : null, confirmationCurrent: scenario === "settled", canStart: false, canStop: false },
        engine: { ...saved.engine, state: scenario === "settled" ? "ready" : "draft", confirmation: null },
        decisions: { observedAt: saved.display.observedAt, gate: gate ? { kind: "confirm" } : null } });
    }
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: start });
  const flush = async () => { await act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); }); };
  const tick = async (ms: number) => { await act(async () => { t.mock.timers.tick(ms); }); await flush(); };
  const m = await mount(f.project.projectId, fetcher, `#request=${encodeURIComponent(f.requestId)}`);
  try {
    await flush();
    assert.ok(reads.status.length > 0, "initial status read accepted");
    if (scenario === "settled" || scenario === "old") {
      const before = reads.status.length;
      await tick(5_000);
      assert.equal(reads.status.length, before, "settled and old work keep ordinary cadence");
    } else {
      const before = reads.status.length;
      await tick(2_500); await tick(2_500);
      assert.ok(reads.status.length >= before + 2, "unchanged first-gate status polls every 2.5 seconds");
      if (scenario === "gate") {
        gate = true; await tick(2_500);
        assert.ok(m.button("Confirm this exact request"), "gate appears promptly from status polling");
        const afterGate = reads.status.length;
        gate = false; // Later snapshots cannot reopen the first-gate window.
        await tick(2_500); await tick(2_500);
        assert.equal(reads.status.length, afterGate, "first gate restores ordinary cadence");
      } else if (scenario === "link") {
        desk.loopRequests[0].runLink = saved.request.runLink;
        await tick(2_500);
        const afterLink = reads.desk.length;
        await tick(2_500); await tick(2_500);
        assert.equal(reads.desk.length, afterLink, "linked request restores ordinary desk cadence");
      } else {
        if (unlinked) assert.ok(reads.desk.length >= 3, "missing link refreshes desk promptly");
        for (let i = 0; i < 46; i++) await tick(2_500);
        const afterCap = { status: reads.status.length, desk: reads.desk.length };
        await tick(2_500); await tick(2_500);
        assert.equal(reads.status.length, afterCap.status, "two-minute cap restores status cadence");
        assert.equal(reads.desk.length, afterCap.desk, "two-minute cap restores desk cadence");
        await tick(25_000);
        assert.ok(reads.status.length > afterCap.status, "ordinary polling continues after cap");
      }
    }
    assert.equal(wire.posts.length, 0);
  } finally { await m.close(); t.mock.timers.reset(); await f.close(); }
});

for (const state of ["draft", "failed"] as const) test(`B5 prepared request status text: ${state}`, async () => {
  const f = await fixture(), wire = transport(f);
  const saved = await f.bridge.status(f.identity, f.project.projectId, f.requestId);
  const m = await mount(f.project.projectId, (async (path, options) => {
    if (!String(path).endsWith("/status")) return wire.fetcher(path, options);
    if (state === "failed") return Response.json({}, { status: 503 });
    return Response.json({ ...saved,
      display: { ...saved.display, state: null, confirmationCurrent: false, canStart: false, canStop: false },
      engine: { ...saved.engine, state: "draft", confirmation: null },
      decisions: { observedAt: saved.display.observedAt, gate: { kind: "confirm" } } });
  }) as typeof fetch);
  try {
    await settle();
    if (state === "draft") {
      assert.match(m.text(), /Request prepared; awaiting your confirmation/);
      assert.doesNotMatch(m.text(), /Saved progress could not be checked/);
      assert.equal(m.button("Confirm this exact request").disabled, false);
    } else {
      assert.match(m.text(), /Saved progress could not be checked/);
      assert.doesNotMatch(m.text(), /Request prepared; awaiting your confirmation/);
      assert.equal(m.button("Confirm this exact request"), undefined);
    }
    assert.equal(m.button("Start confirmed work").disabled, true);
    assert.equal(m.button("Stop this run").disabled, true);
    assert.equal(wire.posts.length, 0);
  } finally { await m.close(); await f.close(); }
});
