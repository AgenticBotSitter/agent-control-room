import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createUpdaterHomeStatusReaderV1 } from "../src/web/v1/updater-home-status";
import { readUpdaterHomeStatusV1 } from "../src/web/v1/updater-home-status-browser";
import { UpdaterHomeStatus } from "../private-app/app/updater-home-status";
import { sha256Digest } from "../src/security";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";

const now = Date.parse("2026-09-30T12:00:00.000Z");
const publicStatus = (changes: Record<string, unknown> = {}) => JSON.stringify({
  schema: "control-room.updater-status/v1", state: "idle", releaseId: "r1", lastHealthAt: null,
  needsYou: false, updaterRestartsLastHour: 0, selfUpdate: "Off", ...changes,
});

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), "updater-home-status-")), status = join(root, "status");
  await mkdir(status); t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const write = async (value = publicStatus()) => {
    const file = join(status, "status.json"); await writeFile(file, value); await utimes(file, now / 1000, now / 1000);
    return file;
  };
  return { root, status, write };
}

test("the updater Home reader exposes only calm Off or attention, never public updater fields", async t => {
  const f = await fixture(t); await f.write();
  const reader = createUpdaterHomeStatusReaderV1({ root: f.root, now: () => now });
  assert.deepEqual(await reader.read(), { schema: "control-room.updater-home-status/v1", state: "off" });
  const replies = await Promise.all(Array.from({ length: 50 }, () => reader.read()));
  assert.equal(replies.filter(reply => reply.state === "off").length, 50, "50 concurrent Home loads stay display-only and complete");
  assert.ok(replies.every(reply => Object.keys(reply).join(",") === "schema,state"), "no release, health or raw status crosses the web boundary");
});

test("missing, corrupt, huge, symlinked, stale, unknown and HTML-shaped updater status all require attention", async t => {
  const f = await fixture(t), read = () => createUpdaterHomeStatusReaderV1({ root: f.root, now: () => now }).read();
  assert.equal((await read()).state, "attention", "missing");
  const file = await f.write("not json"); assert.equal((await read()).state, "attention", "corrupt");
  await f.write("x".repeat(8_193)); assert.equal((await read()).state, "attention", "bounded file");
  await rm(file); await writeFile(join(f.root, "outside.json"), publicStatus()); await symlink(join(f.root, "outside.json"), file);
  assert.equal((await read()).state, "attention", "symlink");
  await rm(file); await f.write(); await utimes(file, (now - 90_001) / 1000, (now - 90_001) / 1000);
  assert.equal((await read()).state, "attention", "stale file");
  await f.write(publicStatus({ state: "made_up" })); assert.equal((await read()).state, "attention", "unknown state");
  await f.write(publicStatus({ releaseId: "<img src=x onerror=alert(1)>" }));
  assert.equal((await read()).state, "attention", "HTML-shaped field");
  await f.write(publicStatus({ needsYou: true })); assert.equal((await read()).state, "attention", "needs owner");
  await f.write(publicStatus({ state: "uncertain" })); assert.equal((await read()).state, "attention", "uncertain");
});

test("the browser reader rejects an oversized or unexpected response as attention", async () => {
  const good = await readUpdaterHomeStatusV1(async () => Response.json({ schema: "control-room.updater-home-status/v1", state: "off" }));
  assert.equal(good.state, "off");
  const html = await readUpdaterHomeStatusV1(async () => Response.json({ schema: "control-room.updater-home-status/v1", state: "off", releaseId: "<b>r1</b>" }));
  assert.equal(html.state, "attention");
  const huge = await readUpdaterHomeStatusV1(async () => new Response(JSON.stringify({ schema: "control-room.updater-home-status/v1",
    state: "off", padding: "x".repeat(1_000) }), { headers: { "content-type": "application/json" } }));
  assert.equal(huge.state, "attention");
});

test("the authenticated web endpoint returns the reduced display projection and no updater control", async t => {
  const f = await fixture(t); await f.write();
  const origin = "http://127.0.0.1:4310", ownerCode = "updater-home-owner-code-0001";
  const app = createMacLocalWebProcessV1({ origin, workspaceId: "workspace:updater-home", database: {
    client: {} as never, close: async () => {},
  }, localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: "tenant:updater-home",
    provider: "fixture", subject: "owner", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 },
  updaterHomeStatus: createUpdaterHomeStatusReaderV1({ root: f.root, now: () => now }) });
  t.after(async () => { await app.close(); });
  const render = () => new Response("unused");
  assert.equal((await app.handle(new Request(`${origin}/api/v1/updater-status`), render)).status, 401, "status remains owner-only");
  const signedIn = await app.handle(new Request(`${origin}/api/v1/local-owner-session`, { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), render);
  const cookie = signedIn.headers.get("set-cookie"); assert.equal(signedIn.status, 201); assert.ok(cookie);
  const response = await app.handle(new Request(`${origin}/api/v1/updater-status`, { headers: { cookie } }), render);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { schema: "control-room.updater-home-status/v1", state: "off" });
  assert.equal((await app.handle(new Request(`${origin}/api/v1/updater-status`, { method: "POST", headers: { cookie, origin } }), render)).status,
    404, "the display route never accepts a control request");
});

async function mountedStatus(response: Response) {
  const { JSDOM } = await import("jsdom"), React = await import("react");
  const dom = new JSDOM("<div id=root></div>", { url: "https://control.invalid/", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch"].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (async () => response.clone()) as typeof fetch });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => { root.render(createElement(UpdaterHomeStatus)); });
  for (let attempt = 0; attempt < 20; attempt += 1) await React.act(async () => { await new Promise(resolve => dom.window.setTimeout(resolve, 5)); });
  const text = dom.window.document.body.textContent ?? "", alert = dom.window.document.querySelector("[role=alert]");
  await React.act(async () => { root.unmount(); }); dom.window.close();
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
  }
  return { text, alert };
}

test("Home says Off calmly and reserves red attention for an unreadable updater answer", async () => {
  const off = await mountedStatus(Response.json({ schema: "control-room.updater-home-status/v1", state: "off" }));
  assert.match(off.text, /Self-update: Off — fixes are installed by you on this Mac\./u); assert.equal(off.alert, null);
  const warning = await mountedStatus(Response.json({ schema: "control-room.updater-home-status/v1", state: "attention" }));
  assert.match(warning.text, /Self-update needs your attention/u); assert.ok(warning.alert);
});
