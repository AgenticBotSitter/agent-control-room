import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createUpdaterHomeStatusReaderV1 } from "../src/web/v1/updater-home-status";
import { readUpdaterHomeStatusV1 } from "../src/web/v1/updater-home-status-browser";
import { UPDATER_OWNER_UI_SCHEMA_V1, type UpdaterOwnerUiPortV1, type UpdaterOwnerUiReadV1 } from "../src/web/v1/updater-owner-ui-wire";
import { updaterOwnerUiReadSchemaV1 } from "../src/web/v1/updater-owner-ui-wire";
import { UpdaterHomeStatus } from "../private-app/app/updater-home-status";
import { sha256Digest } from "../src/security";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";

const now = Date.parse("2026-09-30T12:00:00.000Z");
const publicStatus = (changes: Record<string, unknown> = {}) => JSON.stringify({
  schema: "control-room.updater-status/v1", state: "idle", releaseId: "r1", lastHealthAt: null,
  needsYou: false, updaterRestartsLastHour: 0, selfUpdate: "Off", ...changes,
});
const ownerUi = (changes: Partial<UpdaterOwnerUiReadV1> = {}): UpdaterOwnerUiReadV1 => ({
  schema: UPDATER_OWNER_UI_SCHEMA_V1, observedAt: "2026-09-30T12:00:00.000Z", state: "ready_for_approval", selfUpdate: "On",
  activeSubscriptions: 1, availableControls: ["pause", "backup_now", "check_now", "repair", "rollback"],
  message: "The updater checked this update.", plan: { planId: "plan:one", classes: ["database", "updater"], filesChanged: 4,
    filesAdded: 2, filesDeleted: 1, changesDatabase: true, changesUpdater: true, downtimeEstimateSeconds: 30,
    restoreMayLoseRecentWrites: true, macConfirmationRequired: true, botSays: { title: "Update <img src=x onerror=alert(1)>",
      changedAreas: ["**not** updater facts", "\u202E<svg/onload=alert(1)>"] } }, ...changes,
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
  if (process.platform !== "win32") {
    await rm(file); execFileSync("mkfifo", [file]);
    const fifo = await Promise.race([read(), new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), 2_000).unref())]);
    assert.notEqual(fifo, "hung", "a FIFO at the status path must not block the reader");
    assert.equal((fifo as Awaited<ReturnType<typeof read>>).state, "attention", "FIFO");
  }
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

async function mountedStatus(response: Response, legacy = response) {
  const { JSDOM } = await import("jsdom"), React = await import("react");
  const dom = new JSDOM("<div id=root></div>", { url: "https://control.invalid/", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch"].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (async (input: RequestInfo | URL) => String(input).includes("/updater-status") ? legacy.clone() : response.clone()) as typeof fetch });
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

test("Install leads with updater facts, isolates bot text, names the database loss boundary and fits the phone controls", async () => {
  const card = await mountedStatus(Response.json(ownerUi()));
  assert.match(card.text, /Install/u); assert.match(card.text, /4 files changed/u); assert.match(card.text, /This update changes the database/u);
  assert.match(card.text, /work saved during the final health check may be lost/u, "R20c is on database cards");
  assert.match(card.text, /What the bot says/u); assert.match(card.text, /<img src=x onerror=alert\(1\)>/u,
    "untrusted bot text stays text");
  assert.match(card.text, /type the code of words Control Room shows on your Mac/u); assert.doesNotMatch(card.text, /\d-word|four-word|six-word/iu); assert.match(card.text, /Confirm with Face ID/u);
  for (const control of ["Pause", "Resume", "Back up now", "Check now", "Repair address", "Roll back with Face ID"])
    assert.match(card.text, new RegExp(control, "u"));
});

test("the legacy Off/attention safety read remains the fallback until the updater owner port is installed", async () => {
  const noPort = new Response(null, { status: 404 });
  const off = await mountedStatus(noPort, Response.json({ schema: "control-room.updater-home-status/v1", state: "off" }));
  assert.match(off.text, /Self-update: Off/u);
  const attention = await mountedStatus(noPort, Response.json({ schema: "control-room.updater-home-status/v1", state: "attention" }));
  assert.match(attention.text, /Self-update needs your attention/u); assert.ok(attention.alert);
});

test("every updater state has plain owner wording", async () => {
  const states = ["building", "ready_for_approval", "approval_required", "approved", "prechecked", "staged", "quick_backup",
    "draining", "quiesced", "backup_verified", "preimage_taken", "migrating", "migrated", "switched", "restarted", "healthy",
    "succeeded", "rollback_started", "restore_started", "db_restored", "code_restored", "rolled_back", "refused_build", "superseded",
    "uncertain", "attended_upgrade_required", "paused", "stopped", "needs_attention"] as const;
  for (const state of states) {
    const shown = await mountedStatus(Response.json(ownerUi({ state, plan: null, message: "Updater fact." })));
    assert.ok(shown.text.length > 15, `${state} has owner-facing wording`);
  }
});

test("a database plan cannot hide the R20c restore-loss warning", () => {
  assert.throws(() => updaterOwnerUiReadSchemaV1.parse(ownerUi({ plan: { ...ownerUi().plan!, restoreMayLoseRecentWrites: false } })),
    /database plans must carry the R20c restore warning exactly/u);
});

test("the updater owner port is owner-only, origin-checked, bounded and preserves idempotency under 50 concurrent requests", async t => {
  const f = await fixture(t), origin = "http://127.0.0.1:4311", ownerCode = "updater-owner-ui-code-0001";
  const effects = new Set<string>(), calls: string[] = []; let reads = 0;
  const port: UpdaterOwnerUiPortV1 = {
    read: async () => { reads += 1; return ownerUi(); },
    request: async input => { calls.push(input.idempotencyKey); effects.add(input.idempotencyKey); return { schema: "control-room.updater-owner-request/v1",
      action: input.action, idempotencyKey: input.idempotencyKey, accepted: true, replayed: calls.filter(key => key === input.idempotencyKey).length > 1 }; },
    beginPasskeyApproval: async input => ({ schema: "control-room.updater-owner-request/v1", action: input.action,
      idempotencyKey: input.idempotencyKey, accepted: true, replayed: false }),
  };
  const app = createMacLocalWebProcessV1({ origin, workspaceId: "workspace:updater-owner", database: { client: {} as never, close: async () => {} },
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: "tenant:updater-owner", provider: "fixture",
      subject: "owner", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 }, updaterHomeStatus: createUpdaterHomeStatusReaderV1({ root: f.root, now: () => now }), updaterOwnerUi: port });
  t.after(async () => { await app.close(); }); const render = () => new Response("unused");
  const signedIn = await app.handle(new Request(`${origin}/api/v1/local-owner-session`, { method: "POST", headers: { origin,
    "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), render);
  const cookie = signedIn.headers.get("set-cookie")!;
  assert.equal((await app.handle(new Request(`${origin}/api/v1/updater-owner-ui`), render)).status, 401);
  assert.equal((await app.handle(new Request(`${origin}/api/v1/updater-owner-ui`, { headers: { cookie } }), render)).status, 200);
  const pollReads = await Promise.all(Array.from({ length: 10 }, () => app.handle(new Request(`${origin}/api/v1/updater-owner-ui`, { headers: { cookie } }), render)));
  assert.ok(pollReads.every(response => response.status === 200)); assert.equal(reads, 11, "10 open tabs only read the updater port");
  const post = (key: string) => app.handle(new Request(`${origin}/api/v1/updater-owner-requests`, { method: "POST", headers: { cookie, origin,
    "sec-fetch-site": "same-origin", "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ action: "check_now", planId: "plan:one" }) }), render);
  const duplicate = "updater-owner:burst:same-key";
  const responses = await Promise.all(Array.from({ length: 50 }, () => post(duplicate)));
  assert.ok(responses.every(response => response.status === 200)); assert.equal(effects.size, 1, "50 double-taps produce one effect key");
  assert.equal(calls.length, 50, "the web process never coalesces or invents authority; the updater port decides the durable replay");
  const passkey = await app.handle(new Request(`${origin}/api/v1/updater-owner-passkey`, { method: "POST", headers: { cookie, origin,
    "sec-fetch-site": "same-origin", "content-type": "application/json", "idempotency-key": "updater-owner:passkey:0001" },
    body: JSON.stringify({ action: "rollback", planId: null }) }), render);
  assert.equal(passkey.status, 200, "rollback reaches the separate passkey port");
  assert.equal((await app.handle(new Request(`${origin}/api/v1/updater-owner-requests`, { method: "POST", headers: { cookie,
    "content-type": "application/json", "idempotency-key": "updater-owner:missing-origin" }, body: JSON.stringify({ action: "pause", planId: null }) }), render)).status, 403);
});
