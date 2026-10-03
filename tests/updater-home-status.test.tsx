import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createUpdaterHomeStatusReaderV1 } from "../src/web/v1/updater-home-status";
import { UPDATER_RUN_REASON_V1, UPDATER_RUN_STATE_REASON_V1 } from "../src/updater/v1/contracts.mjs";
import { publicStatusV1 } from "../src/updater/v1/contracts.mjs";
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

test("R7U-01: the owner action is a KEY and the reason is a SENTENCE, and each is bounded", async t => {
  const f = await fixture(t), read = () => createUpdaterHomeStatusReaderV1({ root: f.root, now: () => now }).read();
  // THE HAPPY PATH, and the two fields are checked SEPARATELY because they are
  // separate kinds of value: an allowlisted KEY the card dispatches on, and the
  // sentence for THIS outcome. One field could not be both — that collision is
  // what made cook/r7ufix and cook/r7ufix1 unmergeable, and the merged tree
  // refused whichever the other branch's loop wrote.
  await f.write(publicStatus({ selfUpdate: "On", state: "needs_attention", needsYou: true,
    nextAction: "review_recovery", reason: UPDATER_RUN_REASON_V1.updater_rollback_chain_exhausted }));
  const actioned = await read();
  assert.equal(actioned.state, "needs_owner");
  assert.equal(actioned.nextAction, "review_recovery", "the key did not reach the reader");
  assert.equal(actioned.reason, UPDATER_RUN_REASON_V1.updater_rollback_chain_exhausted);
  // AND THE CROSSED-OVER PAIR IS REFUSED, which is the other half of the merge's
  // fix: a sentence is not a key, and a key is not a sentence.
  await f.write(publicStatus({ selfUpdate: "On", state: "needs_attention", needsYou: true,
    nextAction: UPDATER_RUN_REASON_V1.updater_rollback_chain_exhausted }));
  assert.equal((await read()).state, "attention", "a sentence was accepted as a next-action key");
  await f.write(publicStatus({ selfUpdate: "On", state: "needs_attention", needsYou: true,
    nextAction: "review_recovery", reason: "review_recovery" }));
  assert.equal((await read()).state, "attention", "a key was accepted as a sentence");
  // An ABSENT action and reason is the ordinary healthy case. Measured: requiring
  // the key made every status file written by the previous build read as
  // `attention` forever, which is a permanently alarming Home card on exactly the
  // machines that have the old file.
  await f.write(publicStatus());
  const quiet = await read();
  assert.equal(quiet.state, "off", "a status file without an action is not a refusal");
  assert.equal(quiet.nextAction, undefined, "and it does not invent one");
  assert.equal(quiet.reason, undefined);
  // A PRESENT reason must be a real sentence: printable, one line, no path. Every
  // one of these is refused, which lands the card on `attention` rather than
  // rendering something the owner's phone cannot show safely.
  for (const [name, reason] of Object.entries({
    empty: "", tooLong: "x".repeat(201), newline: "first\nsecond", carriageReturn: "first\rsecond",
    nul: "first\u0000second", escapeByte: "first\u001bsecond", path: "see /Library/Application Support/x",
    backslash: "see C:\\path", c1Byte: "first\u0085second", nonString: 42,
    array: ["do", "this"], object: { action: "do this" },
  })) {
    await f.write(publicStatus({ selfUpdate: "On", state: "needs_attention", needsYou: true,
      nextAction: "review_recovery", reason }));
    assert.equal((await read()).state, "attention", `${name}: a malformed owner reason was rendered`);
  }
  // AND A KEY THAT IS NOT IN THE ALLOWLIST is refused too — including a sentence,
  // which is what the pre-merge shape sent.
  for (const [name, nextAction] of Object.entries({
    sentence: UPDATER_RUN_REASON_V1.updater_rollback_chain_exhausted,
    invented: "review_something_else", empty: "", nonString: 42,
  })) {
    await f.write(publicStatus({ selfUpdate: "On", state: "needs_attention", needsYou: true, nextAction }));
    assert.equal((await read()).state, "attention", `${name}: a key outside the allowlist was rendered`);
  }
  // THE BOUNDARY, ON THE FIELD THAT HAS ONE. `reason` is the only field bounded by
  // length, and even there the length bound is not what admits a value — the
  // allowlist is — so 200 characters of prose is refused. That is the point: the
  // bound is a second wall for a future edit to the table, not the rule.
  //
  // MEASURED: this loop used to assert that `"x".repeat(200)` was ACCEPTED, which
  // was true while the bound was the only check and stopped being true the moment
  // the allowlist arrived. The reader was right and the assertion was the thing
  // that had to change.
  const longest = Math.max(...Object.values(UPDATER_RUN_STATE_REASON_V1).map(s => s.length),
    ...Object.values(UPDATER_RUN_REASON_V1).map(s => s.length));
  assert.ok(longest <= 200, `the longest fixed sentence is ${longest} characters, over the reader's bound`);
  // EVERY REAL SENTENCE THE UPDATER CAN PUBLISH is accepted, checked over the whole
  // table rather than one case — so a sentence added later is proved acceptable by
  // this loop without anyone editing it.
  for (const [state, sentence] of Object.entries(UPDATER_RUN_STATE_REASON_V1)) {
    await f.write(publicStatus({ selfUpdate: "On", state: "needs_attention", needsYou: true,
      nextAction: "review_recovery", reason: sentence }));
    assert.equal((await read()).state, "needs_owner", `the real ${state} sentence was refused (${sentence.length})`);
  }
});

test("R7U-01: publicStatusV1 refuses an action that is not an allowlisted key, and a reason that is not a fixed sentence", () => {
  // THE WRITER's bounds, which are the other half of the readers': the status file
  // is produced here, so this is the last place a path or a paragraph could enter
  // it. Both readers validate the same bytes again, which are the second and third
  // walls.
  const written = publicStatusV1({ state: "needs_attention", needsYou: true,
    nextAction: "review_recovery", reason: UPDATER_RUN_REASON_V1.updater_rollback_chain_exhausted,
    selfUpdate: "On" });
  assert.equal(written.nextAction, "review_recovery");
  assert.equal(written.reason, UPDATER_RUN_REASON_V1.updater_rollback_chain_exhausted);
  // ABSENT MEANS THE FIELD IS OMITTED, not written as null. Asserting `null` would
  // assert the wrong shape and would pass on a file carrying `nextAction: ""`.
  // Omission is also what keeps a status file written by the previous build — which
  // has neither field — reading as the ordinary settled card.
  assert.equal("nextAction" in publicStatusV1({ state: "idle", selfUpdate: "Off" }), false);
  assert.equal("reason" in publicStatusV1({ state: "idle", nextAction: null, selfUpdate: "Off" }), false);
  // An explicit `null` is the same as absent on BOTH fields, which is what the
  // loop passes when it has nothing outstanding.
  assert.equal("reason" in publicStatusV1({ state: "idle", reason: null, selfUpdate: "Off" }), false);
  assert.equal("nextAction" in publicStatusV1({ state: "idle", nextAction: null, selfUpdate: "Off" }), false);
  // A KEY OUTSIDE THE ALLOWLIST is refused. The pre-merge shape — a SENTENCE in
  // `nextAction` — is one of these, which is exactly the collision that made the
  // two branches unmergeable.
  for (const [name, nextAction] of Object.entries({
    sentence: UPDATER_RUN_REASON_V1.updater_rollback_chain_exhausted,
    invented: "review_something_else", empty: "", nonString: 42, array: ["a"], object: {},
    upperCase: "REVIEW_RECOVERY", padded: " review_recovery",
  })) assert.throws(() => publicStatusV1({ state: "needs_attention", nextAction }),
    /updater_status_next_action_refused/u, `${name}: a key outside the allowlist was accepted`);
  // AND A REASON THAT IS NOT ONE OF THE FIXED SENTENCES is refused — the bound
  // alone would accept any 200 printable characters, so the allowlist is what
  // actually stops this field from being a place a caller composes wording.
  for (const [name, reason] of Object.entries({
    empty: "", tooLong: "x".repeat(201), newline: "a\nb", carriageReturn: "a\rb",
    tab: "a\tb", nul: "a\u0000b", escape: "a\u001bb", del: "a\u007fb",
    path: "see /tmp/x", backslash: "see C:\\x",
    composed: "Please tell the operator to run rm -rf /", nonString: 42,
    array: ["a"], object: {},
    // THE TWO THAT ONLY THE ALLOWLIST CATCHES, and they are what the length bound
    // alone would have rendered. Every case above is refused by the BOUND — an
    // empty string, a control byte, a path, 201 characters — so a mutant that drops
    // only the allowlist would still pass all of them, which is what the mutation
    // verifier measured on the first version of this list.
    //
    //   a KEY               — the crossed-over shape, and the exact collision that
    //                         made the two branches unmergeable;
    //   ordinary PROSE      — printable, one line, well under 200 characters, and
    //                         not a word anyone reviewed.
    // Both are the class "anything the length bound accepts that the table does
    // not", which is the whole reason the allowlist exists.
    key: "review_recovery", prose: "Everything is fine, nothing to see here.",
  })) assert.throws(() => publicStatusV1({ state: "needs_attention", reason }),
    /updater_status_reason_refused/u, `${name}: an unsafe owner reason was accepted`);
  // THE BOUNDARY IS INCLUSIVE AT 200 — but only for a reason that is IN the table,
  // which no 200-character prose can be. So the inclusive boundary is asserted on
  // the real longest sentence instead, and the 200-case above proves the bound.
  const longest = Math.max(...Object.values(UPDATER_RUN_STATE_REASON_V1).map(s => s.length),
    ...Object.values(UPDATER_RUN_REASON_V1).map(s => s.length));
  assert.ok(longest <= 200, `the longest fixed sentence is ${longest} characters, over the bound`);
  assert.equal(publicStatusV1({ state: "needs_attention",
    reason: UPDATER_RUN_STATE_REASON_V1.needs_attention }).reason, UPDATER_RUN_STATE_REASON_V1.needs_attention);
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

test("fixed public next actions reach the owner card even with an idle owner UI", async () => {
  for (const [nextAction, words] of [["check_and_continue", /Tap Check and continue/u],
    ["review_rescue_on_mac", /clear the rescue marker/u], ["review_recovery", /Review the failed update and recovery/u],
    ["upgrade_on_mac", /Complete the attended upgrade/u], ["rescue_resolved", /rescue review is resolved/u]] as const) {
    const status = { schema: "control-room.updater-home-status/v1", state: nextAction === "rescue_resolved" ? "healthy" : "needs_owner", nextAction };
    const ready = await mountedStatus(Response.json(ownerUi({ state: "idle", plan: null })), Response.json(status));
    assert.match(ready.text, words);
    const fallback = await mountedStatus(new Response(null, { status: 404 }), Response.json(status));
    assert.match(fallback.text, words);
    if (nextAction === "rescue_resolved") assert.doesNotMatch(fallback.text, /Healthy|no update is running/u);
    else assert.ok(ready.alert);
  }
});

test("the authenticated web endpoint returns the reduced display projection and no updater control", async t => {
  const f = await fixture(t); await f.write();
  const origin = "http://127.0.0.1:4310", ownerCode = "updater-home-owner-code-0001";
  const app = createMacLocalWebProcessV1({ origin, workspaceId: "workspace:updater-home", database: {
    client: {} as never, close: async () => {}, isAvailable: () => true,
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

// R7U-01 (lead decision 3): THE OWNER'S ANSWER, END TO END THROUGH THE ROUTE.
//
// The default-path rule asks for a test with no injected port for each function
// this touches, so the chain is real: a real owner session over the real
// `createMacLocalWebProcessV1`, the real route, the real request validation, and
// the real port shape the updater's composition supplies. The ONE thing stubbed is
// the updater's own database write, which cannot run without a cluster and is
// covered by tests/updater-owner-attention-postgres.test.ts — and the boundary is
// the port interface itself, so a change to what the route SENDS is caught here
// even though what the updater DOES with it is caught there.
test("R7U-01: the owner answers a published outcome through the owner session, and the request carries no run id", async t => {
  const f = await fixture(t); await f.write();
  const origin = "http://127.0.0.1:4311", ownerCode = "updater-attention-owner-0001";
  const seen: { ownerSubject?: string; ownerSessionDigest?: string }[] = [];
  const app = createMacLocalWebProcessV1({ origin, workspaceId: "workspace:updater-attention", database: {
    client: {} as never, close: async () => {}, isAvailable: () => true,
  }, localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: "tenant:updater-attention",
    provider: "fixture", subject: "owner-fixture-subject", ownerCodeDigest: sha256Digest({ ownerCode }),
    sessionSeconds: 900 },
  updaterOwnerAttention: { acknowledge: async input => {
    seen.push({ ownerSubject: input.ownerSubject, ownerSessionDigest: input.ownerSessionDigest });
    return Object.freeze({ schema: "control-room.updater-owner-attention/v1", acknowledged: true,
      nothingOutstanding: false, requestId: "owner-request:00000000-0000-4000-8000-0000000000aa" });
  } } });
  t.after(async () => { await app.close(); });
  const render = () => new Response("unused");
  const route = `${origin}/api/v1/updater-owner-attention`;
  // NO SESSION. The route sits below `verifyLive`, exactly like the status read, so
  // an unauthenticated press must be refused before it reaches the port.
  assert.equal((await app.handle(new Request(route, { method: "POST", headers: { origin, "content-type": "application/json" },
    body: "{}" }), render)).status, 401, "an unauthenticated press reached the updater");
  assert.equal(seen.length, 0, "and the port was called anyway");
  const signedIn = await app.handle(new Request(`${origin}/api/v1/local-owner-session`, { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), render);
  const cookie = signedIn.headers.get("set-cookie"); assert.equal(signedIn.status, 201); assert.ok(cookie);
  // THE PRESS. An EMPTY body, which is the whole design: the page cannot name a run
  // to acknowledge because the web login is not granted the `run_id` column, so
  // there is no replayable value in the request at all.
  const pressed = await app.handle(new Request(route, { method: "POST",
    headers: { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: "{}" }), render);
  assert.equal(pressed.status, 200, "the owner could not answer their own card");
  assert.deepEqual(await pressed.json(), { schema: "control-room.updater-owner-attention/v1", acknowledged: true,
    nothingOutstanding: false, requestId: "owner-request:00000000-0000-4000-8000-0000000000aa" });
  assert.equal(seen.length, 1, "the press did not reach the updater's port exactly once");
  assert.equal(seen[0]?.ownerSubject, "owner-fixture-subject",
    "the acknowledgement must be recorded against the VERIFIED session subject, not a composed one");
  assert.match(String(seen[0]?.ownerSessionDigest), /^sha256:[a-f0-9]{64}$/u,
    "and against the session digest, never the token");
  // AND THE SHAPE IS REFUSED rather than silently ignored: a body that tries to
  // NAME a run is the forgery the withheld column exists to make impossible, and
  // accepting it quietly would mean the check is only advisory.
  for (const [name, body] of Object.entries({ runId: { runId: "run:" + "0".repeat(8) + "-0000-4000-8000-000000000000" },
    run_id: { run_id: "run:x" }, extra: { acknowledged: true } })) {
    const attempt = await app.handle(new Request(route, { method: "POST",
      headers: { cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify(body) }), render);
    assert.equal(attempt.status, 400, `${name}: a request naming a run was accepted`);
  }
  assert.equal(seen.length, 1, "a refused request still reached the updater's port");
  // AND A GET IS NOT A PRESS: the route is POST-only, so a link or a prefetch
  // cannot acknowledge anything on the owner's behalf.
  //
  // 403, not 400, and that is the CSRF boundary speaking first: `assertLocalRequest`
  // runs before the method check, so a GET carrying no `sec-fetch-site` is refused
  // as a cross-origin request rather than as a wrong verb. Either way it is refused
  // and the port is not reached, which is the property under test — MEASURED: the
  // first version of this asserted 400 and the 403 is the correct answer.
  assert.equal((await app.handle(new Request(route, { headers: { cookie } }), render)).status, 403);
  assert.equal(seen.length, 1, "a GET acknowledged something");
  // And a GET that DOES look same-origin is then refused for the verb, which is
  // the other half and would be masked if only the first case were asserted.
  assert.equal((await app.handle(new Request(route, { headers: { cookie, origin, "sec-fetch-site": "same-origin" } }),
    render)).status, 400, "a same-origin GET was not refused for its verb");
  assert.equal(seen.length, 1, "a same-origin GET acknowledged something");
});

async function mountedStatus(response: Response, legacy = response) {
  const dom = new JSDOM("<div id=root></div>", { url: "https://control.invalid/", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT", "fetch"].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (async (input: RequestInfo | URL) => String(input).includes("/updater-status") ? legacy.clone() : response.clone()) as typeof fetch });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => { root.render(createElement(UpdaterHomeStatus)); });
  for (let attempt = 0; attempt < 20; attempt += 1) await React.act(async () => { await new Promise(resolve => dom.window.setTimeout(resolve, 5)); });
  const text = dom.window.document.body.textContent ?? "", alert = dom.window.document.querySelector("[role=alert]");
  const cardClass = dom.window.document.querySelector(".private-updater-card")?.className ?? "";
  await React.act(async () => { root.unmount(); }); dom.window.close();
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
  }
  return { text, alert, cardClass };
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

test("Install names protected and dependency classes from updater facts", async () => {
  const value = ownerUi(), plan: NonNullable<UpdaterOwnerUiReadV1["plan"]> = {
    ...value.plan!, classes: ["protected", "dependency"],
    changesDatabase: false, changesUpdater: false, restoreMayLoseRecentWrites: false,
    macConfirmationRequired: false };
  const card = await mountedStatus(Response.json(ownerUi({ plan })));
  assert.match(card.text, /Safety-sensitive change/u);
  assert.match(card.text, /requires independent review/u);
  assert.match(card.text, /Installed software change/u);
  assert.match(card.text, /software dependencies/u);
  assert.ok(card.alert, "the safety-sensitive warning is an alert");
  assert.match(card.cardClass, /private-attention-box/u, "protected and dependency plans use the red card");
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
  const app = createMacLocalWebProcessV1({ origin, workspaceId: "workspace:updater-owner", database: {
    client: {} as never, close: async () => {}, isAvailable: () => true },
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

test("SELFUPD-04: default Home distinguishes healthy, progress, refused, rollback and owner states", async t => {
  const f = await fixture(t), reader = createUpdaterHomeStatusReaderV1({ root: f.root, now: () => now });
  const cases = [
    ["idle", "healthy", /Self-update: Healthy/u],
    ["watching", "in_progress", /Self-update: In progress/u],
    ["building", "in_progress", /Self-update: In progress/u],
    ["running", "in_progress", /Self-update: In progress/u],
    ["awaiting_approval", "in_progress", /Self-update: In progress/u],
    ["paused", "needs_owner", /Check the update on this Mac/u],
    ["stopped", "needs_owner", /Check the update on this Mac/u],
    ["refused", "failed_before_switch", /Update failed before switching/u],
    ["rolled_back", "rolled_back", /Previous version restored/u],
    ["needs_attention", "needs_owner", /Self-update needs your attention/u],
    ["uncertain", "needs_owner", /Self-update needs your attention/u],
    ["attended_upgrade_required", "needs_owner", /Self-update needs your attention/u],
  ] as const;
  const origin = "http://127.0.0.1:4310", ownerCode = "updater-home-owner-code-0002";
  const app = createMacLocalWebProcessV1({ origin, workspaceId: "workspace:updater-home", database: {
    client: {} as never, close: async () => {}, isAvailable: () => true,
  }, localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: "tenant:updater-home",
    provider: "fixture", subject: "owner", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 }, updaterHomeStatus: reader });
  t.after(() => app.close()); const render = () => new Response("unused");
  const login = await app.handle(new Request(`${origin}/api/v1/local-owner-session`, { method: "POST", headers: {
    origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) }), render);
  assert.equal(login.status, 201); const cookie = login.headers.get("set-cookie")!;
  const noPort = await app.handle(new Request(`${origin}/api/v1/updater-owner-ui`, { headers: { cookie } }), render);
  assert.equal(noPort.status, 404);
  for (const [state, projected, words] of cases) {
    await f.write(publicStatus({ state, selfUpdate: "On" }));
    const status = await (await app.handle(new Request(`${origin}/api/v1/updater-status`, { headers: { cookie } }), render)).json();
    assert.equal(status.state, projected, state);
    assert.equal((await readUpdaterHomeStatusV1(async () => Response.json(status))).state, projected);
    const shown = await mountedStatus(noPort, Response.json(status)); assert.match(shown.text, words);
  }
  const reads = await Promise.all(Array.from({ length: 50 }, () => reader.read()));
  assert.ok(reads.every(value => value.state === "needs_owner"));
  await f.write(publicStatus({ selfUpdate: "On", needsYou: true }));
  assert.equal((await reader.read()).state, "needs_owner");
  await f.write(publicStatus({ selfUpdate: "Unexpected" })); assert.equal((await reader.read()).state, "attention");
  assert.equal((await readUpdaterHomeStatusV1(async () => Response.json({ schema: "control-room.updater-home-status/v1", state: "Unexpected" }))).state, "attention");
});
