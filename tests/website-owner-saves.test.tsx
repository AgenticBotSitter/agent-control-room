import { FleetGatewayStoreV1, type FleetWorkerPrincipalV1 } from "../src/fleet/v1/gateway-store";
import type { DatabaseClient } from "../src/persistence/database";
import { FleetWorkers } from "../private-app/app/workers/fleet-workers";
import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { JSDOM, VirtualConsole } from "jsdom";
import { ProjectSettingsPanel } from "../private-app/app/project-settings-panel";
import { ConnectBotWorkspace } from "../private-app/app/workers/connect/connect-bot-workspace";
import { FleetOfferControl } from "../private-app/app/workers/fleet-offer";
import { renderLocalOwnerSignOutPageV1 } from "../src/web/v1/local-owner-session";
import { createProjectSettingsBrowserClient } from "../src/web/v1/project-settings-browser-client";
import { createFleetOwnerHttpHandlerV1 } from "../src/web/v1/fleet-owner-http";
import { WebAccessError } from "../src/web/v1/access-verifier";

async function mounted(element: React.ReactNode, fetcher: typeof fetch, run: (dom: JSDOM) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control.example", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "fetch", "IS_REACT_ACT_ENVIRONMENT"].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, fetch: fetcher, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  try { await act(async () => root.render(element)); await run(dom); }
  finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}
async function edit(dom: JSDOM, selector: string, value: string) {
  const input = dom.window.document.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
function button(dom: JSDOM, text: string) {
  const value = [...dom.window.document.querySelectorAll("button")].find(item => item.textContent === text);
  assert.ok(value, text); return value;
}
function settingsFixture() {
  let saved = { projectId: "project:settings", version: 1, eligibleWorkerKinds: null, maxConcurrentTasks: 2,
    defaultWorkerKind: null, defaultModel: null, defaultEffort: null, updatedAt: "2026-10-01T12:00:00.000Z" };
  const writes: Record<string, unknown>[] = [];
  const transport: typeof fetch = async (_url, init) => {
    if (init?.method === "POST") { const draft = JSON.parse(String(init.body)); writes.push(draft);
      const { expectedVersion, ...values } = draft;
      saved = { ...saved, ...values, version: saved.version + 1 }; }
    return Response.json(saved);
  };
  return { transport, writes, read: () => saved };
}

test("B03: fractional and out-of-range limits are refused before a request; only blank removes the limit", async () => {
  const f = settingsFixture();
  await mounted(<ProjectSettingsPanel projectId="project:settings" client={createProjectSettingsBrowserClient(f.transport)} />,
    f.transport, async dom => {
      for (const invalid of ["1.5", "0", "21", "-1"]) {
        await edit(dom, "#project-settings-max-concurrent", invalid);
        await act(async () => button(dom, "Save settings").click());
        assert.equal(f.writes.length, 0, invalid); assert.equal(f.read().maxConcurrentTasks, 2);
        assert.match(dom.window.document.querySelector('[role="alert"]')?.textContent ?? "", /whole number from 1 to 20/);
      }
      for (const valid of ["1", "20", ""]) {
        await edit(dom, "#project-settings-max-concurrent", valid);
        await act(async () => { const save = button(dom, "Save settings"); for (let i = 0; i < 50; i++) save.click(); });
        assert.equal(f.read().maxConcurrentTasks, valid === "" ? null : Number(valid));
      }
      assert.equal(f.writes.length, 3, "each burst saves once");
    });
});

test("B05: every settings draft edit clears the confirmed saved message", async () => {
  const f = settingsFixture();
  await mounted(<ProjectSettingsPanel projectId="project:settings" client={createProjectSettingsBrowserClient(f.transport)} />,
    f.transport, async dom => {
      const save = async () => { await act(async () => button(dom, "Save settings").click());
        assert.match(dom.window.document.body.textContent ?? "", /Settings saved/); };
      const cleared = () => assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Settings saved/);
      await save(); await edit(dom, "#project-settings-max-concurrent", "3"); cleared();
      assert.equal(f.read().maxConcurrentTasks, 2);
      await save(); await act(async () => dom.window.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()); cleared();
      await act(async () => dom.window.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click());
      await save(); await act(async () => dom.window.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[2]!.click()); cleared();
      await save();
      const select = dom.window.document.querySelector<HTMLSelectElement>("#project-settings-default-worker")!;
      await act(async () => { select.value = "codex"; select.dispatchEvent(new dom.window.Event("change", { bubbles: true })); }); cleared();
      await save(); await edit(dom, "#project-settings-default-model", "model-one"); cleared();
      await save();
      const effort = dom.window.document.querySelector<HTMLSelectElement>("#project-settings-default-effort")!;
      await act(async () => { effort.value = "high"; effort.dispatchEvent(new dom.window.Event("change", { bubbles: true })); }); cleared();
    });
});

for (const result of ["saved", "absent", "unavailable", "closed", "malformed", "non-array", "null-row", "wrong-job", "503-valid"] as const) test(`B04: a lost fleet reply stays unconfirmed until a saved-offer read (${result})`, async () => {
  const offer = { offerId: `fleet-offer:${"a".repeat(32)}`, jobId: "job:offer", capability: "code.change", state: "open" };
  let posts = 0, reads = 0;
  const handler = createFleetOwnerHttpHandlerV1({ origin: "https://control.example", localOwnerSession: {
    assertLocalRequest() {}, verify() { return {}; } } as never, service: {
    listWorkers: async () => ({ workers: [], pendingCodes: [] }), listResults: async () => [],
    offerTask: async () => { posts++; return offer; },
    projectOffers: async (_identity: unknown, projectId: string) => {
      assert.equal(projectId, "project:offer"); reads++;
      if (result === "unavailable") throw new Error("read unavailable");
      return result === "non-array" ? {} : result === "null-row" ? [null] : result === "wrong-job" ? [{ ...offer, jobId: 17 }] : (result === "saved" || result === "503-valid") ? [offer] : result === "closed" ? [{ ...offer, state: "closed" }]
        : result === "malformed" ? [{ jobId: offer.jobId }] : [];
    },
  } as never });
  const transport: typeof fetch = async (path, init) => {
    const response = await handler(new Request(new URL(String(path), "https://control.example"), init));
    if (init?.method === "POST") throw new Error("lost reply after commit");
    if (result === "503-valid" && String(path).endsWith("/offers")) return Response.json([offer], { status: 503 });
    return response;
  };
  await mounted(<FleetOfferControl projectId="project:offer" jobId="job:offer" state="proposed" />, transport, async dom => {
    await act(async () => { const offer = button(dom, "Offer to other machines"); for (let i = 0; i < 50; i++) offer.click(); });
    assert.equal(posts, 1);
    assert.equal(button(dom, "Offer to other machines").disabled, true);
    assert.equal(dom.window.document.querySelector("select")!.disabled, true);
    assert.match(dom.window.document.body.textContent ?? "", /may have been saved/);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Nothing was offered/);
    await act(async () => { const check = button(dom, "Check saved offer"); for (let i = 0; i < 50; i++) check.click(); });
    assert.equal(posts, 1, "checking never offers work"); assert.equal(reads, 1);
    assert.match(dom.window.document.body.textContent ?? "", result === "saved" ? /saved offer is open/ :
      result === "absent" ? /No saved offer for this task was found/ : result === "closed" ? /saved offer is closed/ : /could not be read/);
  });
});

for (const next of ["/session", "/cdn-cgi/access/logout"] as const) test(`B01: served sign-out has a usable form and executable handler (${next})`, async () => {
  const calls: string[] = [], vc = new VirtualConsole(); vc.on("jsdomError", () => {});
  const dom = new JSDOM(await renderLocalOwnerSignOutPageV1(next).text(), { url: "https://control.example/sign-out",
    runScripts: "dangerously", virtualConsole: vc, beforeParse(window) {
      window.fetch = (async (path, init) => { calls.push(`${init?.method} ${path}`); return new Response(null, { status: 204 }); }) as typeof fetch;
    } });
  try {
    assert.equal(dom.window.document.querySelector("h1")?.textContent, "Sign out");
    const form = dom.window.document.querySelector("form#sign-out"); assert.ok(form);
    assert.equal(dom.window.document.querySelectorAll("body script").length, 1);
    assert.doesNotMatch(dom.window.document.querySelector("style")!.textContent!, /<form id="sign-out"/);
    assert.deepEqual(calls, [], "loading the page does not sign out");
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(calls, ["DELETE /api/v1/local-owner-session"]);
  } finally { dom.window.close(); }
});


test("B06: a committed bot code with a dropped reply is unconfirmed and links to cancellation", async () => {
  let codes = 0;
  const transport: typeof fetch = async (path, init) => {
    if (String(path) === "/api/v1/fleet") return Response.json({ workers: [], pendingCodes: [], connectBot: { available: true } });
    if (String(path) === "/api/v1/projects") return Response.json({ projects: [{ projectId: "project:bot", title: "Bot project" }] });
    assert.equal(String(path), "/api/v1/fleet/connect-codes"); assert.equal(init?.method, "POST");
    codes++; throw new Error("lost reply after commit");
  };
  await mounted(<ConnectBotWorkspace />, transport, async dom => {
    await edit(dom, 'input[name="bot-name"]', "Lost reply bot");
    const projects = [...dom.window.document.querySelectorAll("fieldset")].find(item => item.querySelector("legend")?.textContent === "Projects")!;
    await act(async () => projects.querySelector<HTMLInputElement>("input")!.click());
    await act(async () => button(dom, "Create code").click());
    assert.equal(codes, 1);
    assert.match(dom.window.document.body.textContent ?? "", /may have been saved/);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /code was not created|Nothing changed/);
    assert.equal(dom.window.document.querySelector('a[data-field="pending-code-recovery"]')?.getAttribute("href"), "/workers");
    assert.equal(button(dom, "Create code").disabled, true, "recover the pending code before creating another");
    await act(async () => { for (let i = 0; i < 50; i++) button(dom, "Create code").click(); });
    assert.equal(codes, 1);
  });
});

test("B07: the uncertain connect-code state has an explicit way back on the page", async () => {
  // m-rvint6 finding 3. The refused/uncertain split and the one-request guard are
  // right, but the uncertain state rendered ONLY a link away to /workers, so one
  // dropped reply permanently disabled "Create code" for that visit with no way back
  // — even after the owner cancelled the pending code. `fleet-offer.tsx:50` solved the
  // identical problem in the identical codebase; this is that control.
  let codes = 0, posts = 0;
  const transport: typeof fetch = async (path, init) => {
    if (String(path) === "/api/v1/fleet") return Response.json({ workers: [], pendingCodes: [], connectBot: { available: true } });
    if (String(path) === "/api/v1/projects") return Response.json({ projects: [{ projectId: "project:bot", title: "Bot project" }] });
    assert.equal(String(path), "/api/v1/fleet/connect-codes"); assert.equal(init?.method, "POST");
    posts++; codes++;
    // The first request is committed but the reply is lost; the retry succeeds.
    if (codes === 1) throw new Error("lost reply after commit");
    return Response.json({ codeId: `fleet-code:${"a".repeat(32)}`, workerId: `fleet-worker:${"b".repeat(32)}`,
      expiresAt: "2099-01-01T00:00:00.000Z", operatingSystem: "macos", botKind: "claude-code",
      profileName: "safe-profile", unattended: false, ownerNextStep: "Codex is registered.",
      release: { version: "1.2.3", file: "connector.tar.gz", sha256: "a".repeat(64), size: 1,
        builtFrom: "a".repeat(40) }, installLine: "safe line" });
  };
  await mounted(<ConnectBotWorkspace />, transport, async dom => {
    await edit(dom, 'input[name="bot-name"]', "Lost reply bot");
    const projects = [...dom.window.document.querySelectorAll("fieldset")].find(item => item.querySelector("legend")?.textContent === "Projects")!;
    await act(async () => projects.querySelector<HTMLInputElement>("input")!.click());
    await act(async () => button(dom, "Create code").click());
    assert.equal(posts, 1);
    assert.equal(button(dom, "Create code").disabled, true, "the unconfirmed state blocks another code");
    // The control the review asked for, present and plainly named.
    const recover = dom.window.document.querySelector<HTMLButtonElement>('button[data-field="pending-code-resolved"]');
    assert.ok(recover, "the uncertain state offers an explicit way back");
    assert.match(recover!.textContent ?? "", /cancelled it/u);
    assert.equal(recover!.disabled, false, "the owner is never stuck behind a disabled control");
    assert.equal(dom.window.document.querySelector('a[data-field="pending-code-recovery"]')?.getAttribute("href"), "/workers",
      "the link to Workers is kept: cancelling in Workers is the other route back");
    await act(async () => recover!.click());
    // Back on the page: the message clears, the form is usable, and a second POST
    // becomes possible without a page reload.
    assert.equal(dom.window.document.querySelector('button[data-field="pending-code-resolved"]'), null,
      "the recovery control disappears once the owner has dealt with it");
    assert.equal(button(dom, "Create code").disabled, false);
    await act(async () => button(dom, "Create code").click());
    assert.equal(posts, 2, "a second code request is possible after the explicit recovery");
    assert.match(dom.window.document.body.textContent ?? "", /Code created/u);
  });
});

for (const fault of ["drop", "503"] as const) test(`B01: failed sign-out stays on the page and permits an explicit retry (${fault})`, async () => {
  let calls = 0, navigations = 0, finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const vc = new VirtualConsole(); vc.on("jsdomError", error => { if (/navigation/.test(error.message)) navigations++; });
  const dom = new JSDOM(await renderLocalOwnerSignOutPageV1("/session").text(), { url: "https://control.example/sign-out",
    runScripts: "dangerously", virtualConsole: vc, beforeParse(window) {
      window.fetch = (async () => { calls++; await pending;
        if (calls === 1) { if (fault === "drop") throw new Error("dropped connection"); return new Response(null, { status: 503 }); }
        return new Response(null, { status: 204 });
      }) as typeof fetch;
    } });
  try {
    const form = dom.window.document.querySelector("form#sign-out")!;
    for (let i = 0; i < 50; i++) form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    assert.equal(calls, 1, "one pending sign-out despite a request burst");
    finish(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(navigations, 0);
    assert.match(dom.window.document.querySelector("#message")!.textContent!, /could not be confirmed/);
    assert.equal(dom.window.document.querySelector("button")!.disabled, false);
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 2); assert.equal(navigations, 1);
  } finally { finish(); await new Promise(resolve => setTimeout(resolve, 0)); dom.window.close(); }
});


test("B01: an already expired session can continue to sign in", async () => {
  let navigations = 0;
  const vc = new VirtualConsole(); vc.on("jsdomError", error => { if (/navigation/.test(error.message)) navigations++; });
  const dom = new JSDOM(await renderLocalOwnerSignOutPageV1("/session").text(), { url: "https://control.example/sign-out",
    runScripts: "dangerously", virtualConsole: vc, beforeParse(window) {
      window.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
    } });
  try {
    dom.window.document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(navigations, 1);
  } finally { dom.window.close(); }
});

const offerWorkers = [
  { workerId: `fleet-worker:${"a".repeat(32)}`, displayName: "Alpha", status: "connected", projectIds: ["project:offer"] },
  { workerId: `fleet-worker:${"b".repeat(32)}`, displayName: "Beta", status: "connected", projectIds: ["project:offer"] },
  { workerId: `fleet-worker:${"c".repeat(32)}`, displayName: "Sleepy", status: "offline", projectIds: ["project:offer"] },
  { workerId: `fleet-worker:${"d".repeat(32)}`, displayName: "Foreign", status: "connected", projectIds: ["project:other"] },
  { workerId: `fleet-worker:${"e".repeat(32)}`, displayName: "Removed", status: "revoked", projectIds: ["project:offer"] },
].map(worker => ({ ...worker, workerKind: "codex", capabilities: ["code.change"], lastSeenAt: "2026-10-01T12:00:00.000Z",
  maxConcurrent: 1, activeClaims: 0, platform: null, credentialExpiresAt: null }));
function offerRouteFixture() {
  const writes: Record<string, unknown>[] = [];
  let workers = offerWorkers;
  const handler = createFleetOwnerHttpHandlerV1({ origin: "https://control.example", localOwnerSession: {
    assertLocalRequest() {}, verify() { return {}; } } as never, service: {
    listWorkers: async () => ({ workers, pendingCodes: [] }), listResults: async () => [],
    offerTask: async (_actor: unknown, body: Record<string, unknown>) => { writes.push(body); return { replayed: false }; },
  } as never });
  const transport: typeof fetch = async (path, init) => handler(new Request(new URL(String(path), "https://control.example"), init));
  return { writes, transport, remove: () => { workers = []; }, restore: () => { workers = offerWorkers; } };
}
async function chooseOfferBot(dom: JSDOM, name: string) {
  const label = [...dom.window.document.querySelectorAll("label")].find(item => item.textContent?.startsWith(name));
  assert.ok(label, name); const input = label.querySelector<HTMLInputElement>("input")!;
  await act(async () => input.click()); return input;
}
for (const names of [[], ["Alpha"], ["Beta", "Alpha"], ["Sleepy"]]) test(`Offer choice sends exact IDs: ${names.join(",") || "any"}`, async () => {
  const f = offerRouteFixture();
  await mounted(<FleetOfferControl projectId="project:offer" jobId="job:offer" state="ready" />, f.transport, async dom => {
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[type="radio"]')!.checked, true);
    if (names.length) {
      await chooseOfferBot(dom, "Choose bots");
      assert.doesNotMatch(dom.window.document.body.textContent!, /Foreign|Removed/);
      assert.match(dom.window.document.body.textContent!, /Offline/);
      assert.match(dom.window.document.body.textContent!, /Last seen/);
      assert.match(dom.window.document.body.textContent!, /wait until one reconnects/);
      for (const name of names) await chooseOfferBot(dom, name);
    }
    await act(async () => { for (let i = 0; i < 50; i++) button(dom, "Offer to other machines").click(); });
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.writes[0], { projectId: "project:offer", jobId: "job:offer", capability: "code.change",
      ...(names.length ? { allowedWorkerIds: names.map(name => offerWorkers.find(worker => worker.displayName === name)!.workerId) } : {}) });
  });
});
// R6F-06: a changed chosen-bot list is a conflict, and a conflict is its own
// plain sentence rather than the generic "refused" line. The owner's choices stay
// on screen, because a saved offer cannot be changed and the picker is where
// they will look for the one that is already saved.
for (const conflict of [true, false]) test(`Offer words a ${conflict ? "409" : "403"} answer plainly and keeps every choice (${conflict})`, async () => {
  const f = offerRouteFixture();
  const handler = createFleetOwnerHttpHandlerV1({ origin: "https://control.example", localOwnerSession: {
    assertLocalRequest() {}, verify() { return {}; } } as never, service: {
    listWorkers: async () => ({ workers: offerWorkers, pendingCodes: [] }), listResults: async () => [],
    offerTask: async () => { throw conflict ? new WebAccessError("conflict") : new WebAccessError("access_denied"); },
  } as never });
  await mounted(<FleetOfferControl projectId="project:offer" jobId="job:offer" state="ready" />, async (path, init) =>
    handler(new Request(new URL(String(path), "https://control.example"), init)), async dom => {
    await chooseOfferBot(dom, "Choose bots");
    const chosen = await chooseOfferBot(dom, "Sleepy");
    await act(async () => button(dom, "Offer to other machines").click());
    const status = dom.window.document.querySelector('[role="status"]')?.textContent ?? "";
    if (conflict) {
      assert.match(status, /already offered/i, "a conflict says the task is already offered");
      assert.match(status, /cannot be changed/i, "and that a saved offer cannot be changed");
      assert.doesNotMatch(status, /may no longer belong to this project/,
        "the conflict is not dressed up as a bad bot choice");
    } else assert.match(status, /may no longer belong to this project/, "another refusal keeps its own wording");
    // The owner's choices survive: the chosen bot is still ticked AND the picker
    // is still on "Choose bots" rather than quietly reverting to "any". The
    // retry control is still operable, because a conflict is about the saved
    // offer, not about this draft being wrong.
    assert.equal(chosen.checked, true, "the chosen bot is still ticked after a conflict");
    assert.equal(button(dom, "Offer to other machines").disabled, false);
    assert.equal(dom.window.document.querySelector('input[type="radio"]:checked')?.parentElement?.textContent,
      "Choose bots", "the owner is still looking at their own chosen-bot draft");
    void f;
  });
});
test("Offer refuses an empty selection locally and keeps selected bots after a route refusal", async () => {
  const f = offerRouteFixture();
  await mounted(<FleetOfferControl projectId="project:offer" jobId="job:offer" state="ready" />, f.transport, async dom => {
    await chooseOfferBot(dom, "Choose bots");
    await act(async () => button(dom, "Offer to other machines").click());
    assert.equal(f.writes.length, 0); assert.match(dom.window.document.body.textContent!, /Choose from 1 to 20 bots/);
    const chosen = await chooseOfferBot(dom, "Sleepy"); f.remove();
    await act(async () => button(dom, "Offer to other machines").click());
    assert.equal(f.writes.length, 0); assert.equal(chosen.checked, true);
    assert.match(dom.window.document.body.textContent!, /offer was refused/);
    assert.equal(button(dom, "Offer to other machines").disabled, false);
    // Retry after an explicit refusal still sends the retained draft to validation.
    await act(async () => button(dom, "Offer to other machines").click()); assert.equal(chosen.checked, true);
    f.restore(); await act(async () => button(dom, "Offer to other machines").click());
    assert.equal(f.writes.length, 1); assert.deepEqual(f.writes[0]!.allowedWorkerIds, [offerWorkers[2]!.workerId]);
  });
});
test("edited Offer requests cannot select foreign, revoked, duplicate, malformed or zero bots under a burst", async () => {
  const f = offerRouteFixture();
  const bad = [[], [offerWorkers[3]!.workerId], [offerWorkers[4]!.workerId], [offerWorkers[0]!.workerId, offerWorkers[0]!.workerId],
    ["bad"], "bad", Array(21).fill(offerWorkers[0]!.workerId)];
  const responses = await Promise.all(Array.from({ length: 50 }, (_, index) => f.transport("/api/v1/fleet/offers", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "project:offer",
      jobId: "job:offer", capability: "code.change", allowedWorkerIds: bad[index % bad.length] }) })));
  assert.ok(responses.every(response => response.status === 400)); assert.equal(f.writes.length, 0);
});

test("the real claim guard refuses 50 calls by an in-project worker outside the selected list without a database", async () => {
  let laterReads = 0;
  const query: DatabaseClient["query"] = async statement => {
    if (statement.includes("FROM fleet_claims")) return { rows: [] };
    if (statement.includes("FROM tenants")) return { rows: [] };
    if (statement.includes("FROM fleet_work_offers")) return { rows: [{ project_id: "project:offer", job_id: "job:offer",
      capability: "code.change", state: "open", allowed_worker_ids: [offerWorkers[0]!.workerId] }] } as never;
    laterReads++; throw new Error("claim passed selection guard");
  };
  const db: DatabaseClient = { query, transaction: async work => work({ query }),
    transactionWithPreCommitCheck: async (work, check) => { const value = await work({ query }); await check(); return value; } };
  const store = new FleetGatewayStoreV1(db, { tenantId: "tenant:offer", operationsMode: async () => "running" });
  const principal = { tenantId: "tenant:offer", workerId: offerWorkers[1]!.workerId, projectIds: ["project:offer"],
    capabilities: ["code.change"], nodeId: "node:offer", identityId: "identity:offer", workerKind: "codex",
    displayName: "Beta", maxConcurrent: 1, credentialId: "credential:offer", credentialExpiresAt: "2099-01-01T00:00:00.000Z" } satisfies FleetWorkerPrincipalV1;
  await Promise.all(Array.from({ length: 50 }, () => assert.rejects(store.claim(principal, {
    offerId: `fleet-offer:${"f".repeat(32)}`, idempotencyKey: "claim-selection-0001" }), /not_found/)));
  assert.equal(laterReads, 0);
});

test("Offer cannot silently apply new choices to a saved offer on replay", async () => {
  const handler = createFleetOwnerHttpHandlerV1({ origin: "https://control.example", localOwnerSession: {
    assertLocalRequest() {}, verify() { return {}; } } as never, service: {
    offerTask: async () => ({ offerId: `fleet-offer:${"a".repeat(32)}`, replayed: true }),
  } as never });
  const response = await handler(new Request("https://control.example/api/v1/fleet/offers", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "project:offer", jobId: "job:offer", capability: "code.change" }) }));
  assert.equal(response.status, 409);
});
for (const workers of [[], null, [{ workerId: "bad" }]]) test(`Offer handles missing or malformed bot data: ${JSON.stringify(workers)}`, async () => {
  let posts = 0;
  const transport: typeof fetch = async (_path, init) => {
    if (init?.method === "POST") posts++;
    return Response.json({ workers });
  };
  await mounted(<FleetOfferControl projectId="project:offer" jobId="job:offer" state="ready" />, transport, async dom => {
    await chooseOfferBot(dom, "Choose bots");
    assert.match(dom.window.document.body.textContent!, workers === null || workers.length ? /bot list could not be read/ : /No bots/);
    await act(async () => button(dom, "Offer to other machines").click()); assert.equal(posts, 0);
  });
});
test("a slow Offer locks choices, sends one request for 50 taps and aborts when the screen closes", async () => {
  let posts = 0; let signal: AbortSignal | null | undefined; let finish!: (value: Response) => void;
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const transport: typeof fetch = async (_path, init) => {
    if (init?.method !== "POST") return Response.json({ workers: offerWorkers });
    posts++; signal = init.signal; return pending;
  };
  try {
    await mounted(<FleetOfferControl projectId="project:offer" jobId="job:offer" state="ready" />, transport, async dom => {
      await chooseOfferBot(dom, "Choose bots"); await chooseOfferBot(dom, "Alpha");
      await act(async () => { for (let i = 0; i < 50; i++) button(dom, "Offer to other machines").click(); });
      assert.equal(posts, 1); assert.equal(dom.window.document.querySelector("fieldset")!.disabled, true);
      assert.equal(signal?.aborted, false);
    });
    assert.equal(signal?.aborted, true);
  } finally { await act(async () => { finish(Response.json({ replayed: false })); }); }
});

test("Offer refuses more than 20 chosen bots before sending", async () => {
  let posts = 0;
  const workers = Array.from({ length: 21 }, (_, index) => ({ ...offerWorkers[0]!,
    workerId: `fleet-worker:${index.toString(16).padStart(32, "0")}`, displayName: `Bot ${index}` }));
  const transport: typeof fetch = async (_path, init) => { if (init?.method === "POST") posts++; return Response.json({ workers }); };
  await mounted(<FleetOfferControl projectId="project:offer" jobId="job:offer" state="ready" />, transport, async dom => {
    await chooseOfferBot(dom, "Choose bots");
    for (const input of dom.window.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) await act(async () => input.click());
    await act(async () => button(dom, "Offer to other machines").click());
    assert.equal(posts, 0); assert.match(dom.window.document.body.textContent!, /Choose from 1 to 20 bots/);
  });
});
test("a stopped Offer cannot show an old success on the next task", async () => {
  let change!: (job: string) => void, finish!: (response: Response) => void;
  function Screen() {
    const [job, setJob] = React.useState("job:first"); change = setJob;
    return <FleetOfferControl projectId="project:offer" jobId={job} state="ready" />;
  }
  const pending = new Promise<Response>(resolve => { finish = resolve; });
  const transport: typeof fetch = async (_path, init) => init?.method === "POST" ? pending : Response.json({ workers: offerWorkers });
  try {
    await mounted(<Screen />, transport, async dom => {
      await act(async () => button(dom, "Offer to other machines").click());
      await act(async () => change("job:second"));
      await act(async () => finish(Response.json({ replayed: false })));
      assert.doesNotMatch(dom.window.document.body.textContent!, /Offered\./);
      assert.equal(button(dom, "Offer to other machines").disabled, false);
    });
  } finally { finish(Response.json({ replayed: false })); }
});

test("Offer route bounds and ID checks still refuse even if the worker read contains those IDs", async () => {
  const workers = Array.from({ length: 21 }, (_, index) => ({ ...offerWorkers[0]!,
    workerId: `fleet-worker:${index.toString(16).padStart(32, "0")}` }));
  workers.push({ ...offerWorkers[0]!, workerId: "bad" });
  let writes = 0;
  const handler = createFleetOwnerHttpHandlerV1({ origin: "https://control.example", localOwnerSession: {
    assertLocalRequest() {}, verify() { return {}; } } as never, service: {
    listWorkers: async () => ({ workers, pendingCodes: [] }), offerTask: async () => { writes++; return { replayed: false }; },
  } as never });
  for (const allowedWorkerIds of [workers.slice(0,21).map(worker => worker.workerId), ["bad"]]) {
    const response = await handler(new Request("https://control.example/api/v1/fleet/offers", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "project:offer", jobId: "job:offer",
        capability: "code.change", allowedWorkerIds }) }));
    assert.equal(response.status, 400);
  }
  assert.equal(writes, 0);
});

test("a stopped saved-offer read cannot show old evidence on the next task", async () => {
  let change!: (job: string) => void, finish!: (body: unknown) => void;
  function Screen() {
    const [job, setJob] = React.useState("job:first"); change = setJob;
    return <FleetOfferControl projectId="project:offer" jobId={job} state="ready" />;
  }
  const pending = new Promise<unknown>(resolve => { finish = resolve; });
  const transport: typeof fetch = async (path, init) => {
    if (init?.method === "POST") throw new Error("lost reply");
    if (String(path).endsWith("/offers")) {
      const response = Response.json([]); Object.defineProperty(response, "json", { value: () => pending }); return response;
    }
    return Response.json({ workers: offerWorkers });
  };
  try {
    await mounted(<Screen />, transport, async dom => {
      await act(async () => button(dom, "Offer to other machines").click());
      await act(async () => button(dom, "Check saved offer").click());
      await act(async () => change("job:second"));
      await act(async () => finish([{ jobId: "job:first", state: "open" }]));
      assert.doesNotMatch(dom.window.document.body.textContent!, /saved offer is open/);
      assert.equal(button(dom, "Offer to other machines").disabled, false);
    });
  } finally { finish([]); }
});
