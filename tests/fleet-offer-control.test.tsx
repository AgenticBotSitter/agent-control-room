// "Offer to other machines": the optional "Choose bots" control.
//
// The default MUST stay "any bot with the chosen skill". The picker is behind
// its own choice so the common case is one obvious action, and it only lists a
// bot that could ever claim the offer: in this project, with the chosen skill,
// and not removed. These tests drive the real component with real fetch calls
// and assert on the exact body posted to the real route.
//
// int10 (lead decision D1) replaced int9's single-bot select with offerui's
// multi-bot picker. Its deliberate differences are kept here as the picker's
// own contract: several bots may be chosen, and an OFFLINE bot (or one that
// needs a new key) can be chosen, because a saved offer waits until a chosen bot
// reconnects. int9's skill rule is kept in the picker: a bot without the chosen
// skill is never listed and never posted, whatever order the owner acts in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { FleetOfferControl } from "../private-app/app/workers/fleet-offer";

const projectId = "project:test", jobId = "job:test";
const shape = { maxConcurrent: 1, activeClaims: 0, platform: null, credentialExpiresAt: null, lastSeenAt: null };
const bots = [
  { ...shape, workerId: "fleet-worker:a".padEnd(46, "0"), displayName: "Night Codex", workerKind: "codex", status: "connected",
    capabilities: ["code.change"], projectIds: [projectId] },
  { ...shape, workerId: "fleet-worker:b".padEnd(46, "0"), displayName: "Studio Claude", workerKind: "claude-code", status: "working",
    capabilities: ["code.change", "writing"], projectIds: [projectId] },
  // Never claimable: wrong project, wrong skill, removed.
  { ...shape, workerId: "fleet-worker:c".padEnd(46, "0"), displayName: "Other project", workerKind: "codex", status: "connected",
    capabilities: ["code.change"], projectIds: ["project:elsewhere"] },
  { ...shape, workerId: "fleet-worker:d".padEnd(46, "0"), displayName: "Wrong skill", workerKind: "codex", status: "connected",
    capabilities: ["writing"], projectIds: [projectId] },
  { ...shape, workerId: "fleet-worker:f".padEnd(46, "0"), displayName: "Removed bot", workerKind: "codex", status: "revoked",
    capabilities: ["code.change"], projectIds: [projectId] },
  // Claimable once they reconnect: offerui lets the owner choose them.
  { ...shape, workerId: "fleet-worker:e".padEnd(46, "0"), displayName: "Offline bot", workerKind: "codex", status: "offline",
    capabilities: ["code.change"], projectIds: [projectId] },
  { ...shape, workerId: "fleet-worker:g".padEnd(46, "0"), displayName: "No key", workerKind: "codex", status: "needs_new_key",
    capabilities: ["code.change"], projectIds: [projectId] },
];
const board = (workers: unknown[]) => ({ workers, pendingCodes: [], results: [], gatewayConfigured: true });

/** Mounts the real component. `board` answers every /api/v1/fleet GET; every
 * POST to /api/v1/fleet/offers is recorded and answered 201. */
async function mountOffer(t: { after(fn: () => unknown): void }, options: {
  board?: unknown; state?: string; offerStatus?: number;
} = {}) {
  const { JSDOM } = await import("jsdom");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/" });
  const saved = Object.fromEntries(["window", "document", "fetch", "IS_REACT_ACT_ENVIRONMENT"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const posts: Record<string, unknown>[] = [];
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string, init: RequestInit = {}) => {
      if (String(url) === "/api/v1/fleet" && (init.method ?? "GET") === "GET")
        return Response.json(options.board ?? board(bots));
      posts.push(JSON.parse(String(init.body)));
      return Response.json({ offerId: "fleet-offer:test" },
        { status: options.offerStatus ?? 201 });
    } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => { root.render(createElement(FleetOfferControl,
    { projectId, jobId, state: options.state ?? "proposed" })); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const body = () => dom.window.document.body.textContent ?? "";
  const button = (label: string) => {
    const found = [...dom.window.document.querySelectorAll("button")]
      .find(item => item.textContent?.trim() === label);
    assert.ok(found, `no button named ${label}: ${body()}`);
    return found as HTMLButtonElement;
  };
  const labelled = (name: string) => {
    const found = [...dom.window.document.querySelectorAll("label")]
      .find(item => item.textContent?.includes(name))?.querySelector("input");
    assert.ok(found, `no choice named ${name}: ${body()}`);
    return found as HTMLInputElement;
  };
  const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const choose = async (name: string) => { await act(async () => { labelled(name).click(); }); await flush(); };
  const skill = async (value: string) => {
    const select = dom.window.document.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await flush();
  };
  const listed = () => [...dom.window.document.querySelectorAll('input[type="checkbox"]')]
    .map(input => input.closest("label")?.textContent?.split(" · ")[0]);
  t.after(async () => {
    await act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  return { dom, posts, body, button, labelled, flush, choose, skill, listed, act };
}

test("one owner gesture offers at most once, however fast the owner clicks", async t => {
  // Offering is the owner's consent for work to start, so a double click (or a
  // keyboard repeat) must post ONE request. A `disabled` attribute alone is not
  // enough: React state does not change until the next render, so a second click
  // in the same tick sees a stale `false`.
  const view = await mountOffer(t);
  await view.act(async () => {
    const button = view.button("Offer to other machines");
    button.click(); button.click(); button.click();
  });
  await view.flush();
  assert.equal(view.posts.length, 1, "one gesture must post at most one offer");
  assert.match(view.body(), /Offered\. Any connected bot in this project with that skill can claim it\./);
  // A settled offer frees the control again: the owner may offer a revision.
  await view.act(async () => { view.button("Offer to other machines").click(); });
  await view.flush();
  assert.equal(view.posts.length, 2, "a later deliberate offer is still allowed");
});

test("the default offer still means any bot with the skill, and sends no bot list", async t => {
  const view = await mountOffer(t);
  // Attention-first: the picker is not open until the owner asks for it.
  assert.equal(view.labelled("Any connected bot").checked, true);
  assert.equal(view.labelled("Choose bots").checked, false);
  assert.deepEqual(view.listed(), [], "the picker must not be open by default");
  await view.act(async () => { view.button("Offer to other machines").click(); });
  await view.flush();
  assert.equal(view.posts.length, 1);
  assert.deepEqual(view.posts[0], { projectId, jobId, capability: "code.change" },
    "no allowedWorkerIds at all: the server keeps its own any-bot default");
  assert.match(view.body(), /Offered\. Any connected bot in this project with that skill can claim it\./);
});

test("a chosen bot is offered alone, and only bots that could claim are listed", async t => {
  const view = await mountOffer(t);
  await view.choose("Choose bots");
  assert.deepEqual(view.listed(), ["Night Codex", "Studio Claude", "Offline bot", "No key"],
    "every bot in this project with the skill, connected or waiting to reconnect");
  const text = view.body();
  for (const name of ["Other project", "Wrong skill", "Removed bot"])
    assert.ok(!text.includes(name), `${name} can never claim and must not be offered`);
  assert.equal(view.labelled("Any connected bot").checked, false);
  await view.choose("Studio Claude");
  await view.act(async () => { view.button("Offer to other machines").click(); });
  await view.flush();
  assert.deepEqual(view.posts[0], { projectId, jobId, capability: "code.change",
    allowedWorkerIds: ["fleet-worker:b".padEnd(46, "0")] });
  assert.match(view.body(), /Offered to your chosen bots\./);
});

test("changing the skill re-reads the bot list and drops a bot that no longer qualifies", async t => {
  // Studio Claude has "writing"; Night Codex does not. Offering the task to
  // Night Codex with skill=writing would be a promise the fleet cannot keep.
  const view = await mountOffer(t);
  await view.choose("Choose bots");
  await view.skill("writing");
  assert.deepEqual(view.listed(), ["Studio Claude", "Wrong skill"],
    "the list is re-read for the new skill: a bot without it must not stay listed");
  assert.ok(!view.body().includes("Night Codex"));
  // Nothing is chosen after the change, so nothing is offered: a reset selection
  // must never post a stale id.
  await view.act(async () => { view.button("Offer to other machines").click(); });
  await view.flush();
  assert.equal(view.posts.length, 0, "an empty choice is refused before any request");
  assert.match(view.body(), /Choose from 1 to 20 bots, or choose Any connected bot\./);
  await view.choose("Any connected bot");
  await view.act(async () => { view.button("Offer to other machines").click(); });
  await view.flush();
  assert.deepEqual(view.posts[0], { projectId, jobId, capability: "writing" },
    "back on the default, the offer is any bot with the new skill");
});

test("a bot already selected stops being offered once the owner changes the skill", async t => {
  // The dangerous ordering: pick Night Codex for code.change, then switch the
  // skill to writing. Night Codex has no writing capability, so keeping it
  // selected would post an offer that can never be claimed and the owner would
  // see no explanation.
  const view = await mountOffer(t);
  await view.choose("Choose bots");
  await view.choose("Night Codex");
  await view.choose("Studio Claude");
  assert.equal(view.labelled("Night Codex").checked, true);
  await view.skill("writing");
  assert.ok(!view.body().includes("Night Codex"),
    "the selection must not survive a change that makes the bot ineligible");
  assert.equal(view.labelled("Studio Claude").checked, true, "an eligible choice is kept");
  await view.act(async () => { view.button("Offer to other machines").click(); });
  await view.flush();
  assert.deepEqual(view.posts[0], { projectId, jobId, capability: "writing",
    allowedWorkerIds: ["fleet-worker:b".padEnd(46, "0")] },
  "an ineligible bot must never be posted to the offer route");
});

test("Any connected bot closes the picker and returns to the default", async t => {
  const view = await mountOffer(t);
  await view.choose("Choose bots");
  await view.choose("Night Codex");
  await view.choose("Any connected bot");
  assert.deepEqual(view.listed(), []);
  await view.act(async () => { view.button("Offer to other machines").click(); });
  await view.flush();
  assert.deepEqual(view.posts[0], { projectId, jobId, capability: "code.change" });
});

test("no eligible bot means nothing is offered rather than offering nobody", async t => {
  const view = await mountOffer(t, { board: board([]) });
  await view.choose("Choose bots");
  assert.match(view.body(), /No bots are connected to this project yet\./);
  await view.act(async () => { view.button("Offer to other machines").click(); });
  await view.flush();
  assert.equal(view.posts.length, 0, "an offer to nobody must never be posted");
});

test("bots in the project but none with this skill: said plainly, and nothing is offered", async t => {
  const view = await mountOffer(t, { board: board([bots[3]]) });
  await view.choose("Choose bots");
  assert.match(view.body(), /No bot in this project has this skill yet\./);
  await view.act(async () => { view.button("Offer to other machines").click(); });
  await view.flush();
  assert.equal(view.posts.length, 0);
});

test("the control stays hidden off the connector route and after a task has started", async t => {
  for (const [answer, state, why] of [
    [undefined, "proposed", "a 404 hides it: this installation runs no fleet gateway"],
    [board(bots), "running", "an offered task is no longer the owner's to offer"],
    [board(bots), "succeeded", "finished work is not offered"],
  ] as const) {
    const { JSDOM } = await import("jsdom");
    const { createRoot } = await import("react-dom/client");
    const { act } = await import("react");
    const dom = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/" });
    const saved = Object.fromEntries(["window", "document", "fetch", "IS_REACT_ACT_ENVIRONMENT"]
      .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
      fetch: async (url: string) => String(url) === "/api/v1/fleet"
        ? (answer === undefined ? new Response(null, { status: 404 }) : Response.json(answer))
        : new Response(null, { status: 404 }) });
    const root = createRoot(dom.window.document.getElementById("root")!);
    await act(async () => { root.render(createElement(FleetOfferControl, { projectId, jobId, state })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(dom.window.document.body.textContent?.trim(), "", `${why} (${state})`);
    await act(async () => { root.unmount(); }); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("a refused offer says nothing was offered (409)", async t => {
  const view = await mountOffer(t, { offerStatus: 409 });
  await view.act(async () => { view.button("Offer to other machines").click(); });
  await view.flush();
  assert.match(view.body(), /This task is already offered, and a saved offer cannot be changed\./);
  assert.doesNotMatch(view.body(), /Offered\.|may have been saved/, "409 is a definite refusal");
  assert.equal(view.button("Offer to other machines").disabled, false, "a refusal leaves the control usable");
});

test("a refused offer says nothing was offered (400)", async t => {
  const view = await mountOffer(t, { offerStatus: 400 });
  await view.act(async () => { view.button("Offer to other machines").click(); });
  await view.flush();
  assert.match(view.body(), /The offer was refused\./);
  assert.doesNotMatch(view.body(), /Offered\.|may have been saved/, "400 is a definite refusal");
  assert.equal(view.button("Offer to other machines").disabled, false, "a refusal leaves the control usable");
});

test("the control fits a 375px phone with no horizontal overflow", async t => {
  const view = await mountOffer(t);
  await view.choose("Choose bots");
  const { document } = view.dom.window;
  const panel = document.querySelector("section")!;
  // Every control the owner can reach at 375px must be a real block that fits:
  // no fixed pixel width, and no child wider than the panel it sits in.
  for (const element of panel.querySelectorAll("select, button, label, p, input")) {
    assert.ok((element as HTMLElement).style.width === "",
      `${element.tagName} must not carry a fixed width at phone size`);
  }
  const overflow = [...panel.querySelectorAll("select, button, input")]
    .filter(element => (element as HTMLElement).getBoundingClientRect().width > 375);
  assert.deepEqual(overflow.map(element => element.tagName), [],
    "the picker must not force horizontal scrolling on a 375px phone");
});
