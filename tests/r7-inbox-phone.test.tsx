import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivateHeader } from "../private-app/app/private-header";
import { PrivateActionInbox, ActionInboxPanel } from "../private-app/app/needs-me/action-inbox";
import { LocalRuntimeContextV1 } from "../private-app/app/local-runtime";
import { refreshSharedOwnerPush } from "../private-app/app/shared-owner-push";
import { OwnerWebPushSettings } from "../private-app/app/owner-web-push";
import { buildActionInbox } from "../src/web/v1/action-inbox";
import { actionInboxItemSchemaV1 } from "../src/operator-surfaces/v1/validators";
import { mounted, button, browserSub, vapid, statusReply } from "./support/owner-notify-fixtures";
// Recent relative to the wall clock: the Checked line renders "N minutes ago" only for a
// recent read, and a fixed date turned into "yesterday" the day after this was written.
const observedAt = new Date(Date.now() - 5 * 60_000).toISOString();
const page = (title: string) => ({ items: [{ task: { projectId: "project:alpha", jobId: `job:${title}`, requestId: "request:fixture", title,
  state: "waiting_approval", version: 1, createdAt: observedAt, updatedAt: observedAt }, inputDigest: `sha256:${"a".repeat(64)}`, reasons: ["approval"] }],
  nextCursor: null, examined: 1, observedAt, startsWork: false, planningSource: "configured", deliverySource: "configured", sources: { ordinary: "included", ideas: "not_configured" } });
const Wrapped = () => h(LocalRuntimeContextV1.Provider, { value: { mode: "local" } }, h(React.Fragment, null, h(PrivateHeader), h(PrivateActionInbox)));
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });

test("R7I-03: one shared refresh updates count and list; a slow burst retains the last list", { timeout: 15000 }, async () => {
  let title = "Approve", reads = 0, held = false;
  const replies: Array<() => void> = [];
  await mounted(Wrapped, async (path: any) => {
    if (!String(path).includes("needs-me")) return new Response(null, { status: 404 });
    const reply = () => Response.json(String(path).includes("action-items") ? { observedAt, items: [], truncated: false } : page(title));
    if (String(path).includes("/tasks")) reads++;
    return held ? new Promise<Response>(resolve => replies.push(() => resolve(reply()))) : reply();
  }, {}, async dom => {
    await settle(); assert.equal(reads, 1, "header and list share the initial read");
    const inbox = () => dom.window.document.querySelector('[aria-labelledby="action-inbox-heading"]')!.textContent!;
    assert.match(inbox(), /Approve/);
    title = "Failure"; held = true;
    try {
      await act(async () => { for (let n = 0; n < 50; n++) dom.window.dispatchEvent(new dom.window.Event("focus")); });
      assert.equal(reads, 2, "50 concurrent focus signals coalesce");
      assert.match(inbox(), /Approve/); assert.match(inbox(), /Checking/i);
      assert.doesNotMatch(inbox(), /No actions are waiting/);
    } finally { held = false; await act(async () => replies.forEach(reply => reply())); }
    assert.match(inbox(), /Failure/); assert.doesNotMatch(inbox(), /Approve/);
    assert.match(dom.window.document.querySelector('[aria-label="Needs attention"]')!.textContent!, /Failure/);
    await act(async () => button(dom, "Check Action Inbox again").click());
    assert.equal(reads, 3, "manual refresh also drives both");
    assert.match(inbox(), /Checked.*ago/);
  });
});

test("R7I-04: a wrong-key subscription is replaced only on owner action", { timeout: 15000 }, async () => {
  let local: any = { ...browserSub(), options: { applicationServerKey: new Uint8Array(65).fill(7).buffer },
    async unsubscribe() { removed++; local = null; return true; } };
  let created = 0, removed = 0; const posted: any[] = [];
  const worker = { ready: Promise.resolve({ pushManager: { async getSubscription() { return local; }, async subscribe(options: any) {
    created++; assert.equal(Buffer.from(options.applicationServerKey).toString("base64url"), vapid.publicKey);
    return local = { ...browserSub(), endpoint: "https://fcm.googleapis.com/fcm/send/new", options,
      toJSON() { return { ...browserSub().toJSON(), endpoint: this.endpoint }; } };
  } } }) };
  await mounted(OwnerWebPushSettings, async (path: any, init: any) => {
    if (String(path).endsWith("/status")) return Response.json({ subscribed: true });
    if (init?.method === "POST") { posted.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    return statusReply();
  }, worker, async dom => {
    assert.match(dom.window.document.body.textContent!, /Phone notifications stopped/);
    assert.equal(created, 0); assert.equal(removed, 0);
    await act(async () => button(dom, "Subscribe this browser").click());
    assert.equal(created, 1); assert.equal(removed, 1); assert.equal(posted.length, 1);
    assert.equal(posted[0].endpoint, "https://fcm.googleapis.com/fcm/send/new");
    assert.match(dom.window.document.body.textContent!, /This browser is subscribed/);
  });
});

test("R7I-04: the attention box detects a missing server registration and can restore it", { timeout: 15000 }, async () => {
  let saved = true, saves = 0;
  const worker = { ready: Promise.resolve({ pushManager: { async getSubscription() { return { ...browserSub(), options: { applicationServerKey: Buffer.from(vapid.publicKey, "base64url") } }; } } }) };
  await mounted(Wrapped, async (path: any, init: any) => {
    if (String(path).includes("needs-me")) return Response.json(String(path).includes("action-items") ? { observedAt, items: [], truncated: false } : page("Approve"));
    if (String(path).endsWith("/status")) return Response.json({ subscribed: saved });
    if (init?.method === "POST") { saves++; saved = true; return new Response(null, { status: 204 }); }
    return statusReply();
  }, worker, async dom => {
    await settle(); saved = false;
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    const top = dom.window.document.querySelector('[aria-label="Needs attention"]')!;
    assert.match(top.textContent!, /Phone notifications stopped — tap to turn back on/);
    await act(async () => button(dom, "Phone notifications stopped — tap to turn back on").click());
    assert.equal(saves, 1); assert.doesNotMatch(top.textContent!, /Phone notifications stopped/);
  });
});

const decision = actionInboxItemSchemaV1.parse({ id: "attention:r7:authority", tenantId: "tenant:t", projectId: "project:p", workItemId: "job:x",
  kind: "authority_expiry", state: "open", requestedAction: "Renew authority before it lapses", reasonCode: "authority_expiring", blockedWorkItemIds: [],
  legalResponses: [{ id: "response:renew", kind: "open_source", label: "Renew", requiresConfirmation: false, available: true }], evidence: [],
  createdAt: "2026-10-01T08:00:00.000Z", expiresAt: "2026-10-01T10:00:00.000Z", deliveryState: "not_requested" });
test("R7I-05: expired decisions show what happens now and drop response options", () => {
  const now = Date.parse("2026-10-02T23:00:00Z");
  const rows = buildActionInbox([], [decision], now);
  assert.equal(rows[0].kind, "expired"); assert.deepEqual(rows[0].availableResponses, []);
  const html = renderToStaticMarkup(h(ActionInboxPanel, { data: { tasks: { state: "available", pages: [], truncated: false },
    operator: { state: "available", source: { observedAt: new Date(now).toISOString(), items: [decision], truncated: false } } } }));
  assert.match(html, /Expired/); assert.match(html, /deadline has passed/i); assert.match(html, /Review.*current/i);
  assert.doesNotMatch(html, /Recorded response options|Approval needed|>Expires</);
  assert.equal(buildActionInbox([], [decision], Date.parse(decision.expiresAt!) - 1)[0].kind, "approval");
  assert.equal(buildActionInbox([], [decision], Date.parse(decision.expiresAt!))[0].kind, "expired");
  assert.equal(buildActionInbox([], [{ ...decision, expiresAt: undefined }], now)[0].kind, "approval");
});

test("R7I-04: rotation messages persist until owner recovery, including after remount", { timeout: 15000 }, async () => {
  const handlers = new Set<(event: any) => void>();
  const worker = { addEventListener(_name: string, callback: any) { handlers.add(callback); }, removeEventListener(_name: string, callback: any) { handlers.delete(callback); },
    ready: Promise.resolve({ pushManager: { async getSubscription() { return browserSub(); } } }) };
  await mounted(OwnerWebPushSettings, async (path: any, init: any) => String(path).endsWith("/status") ? Response.json({ subscribed: true })
    : init?.method === "POST" ? new Response(null, { status: 204 }) : statusReply(), worker, async (dom, root) => {
    assert.match(dom.window.document.body.textContent!, /This browser is subscribed/);
    await act(async () => handlers.forEach(fn => fn({ data: { type: "ignored" } })));
    assert.doesNotMatch(dom.window.document.body.textContent!, /stopped/);
    await act(async () => handlers.forEach(fn => fn({ data: { type: "control-room.push-stopped" } })));
    assert.match(dom.window.document.body.textContent!, /Phone notifications stopped/);
    await act(async () => root.render(null)); assert.equal(handlers.size, 0);
    await act(async () => root.render(h(OwnerWebPushSettings)));
    assert.match(dom.window.document.body.textContent!, /Phone notifications stopped/);
    await act(async () => button(dom, "Subscribe this browser").click());
    assert.match(dom.window.document.body.textContent!, /This browser is subscribed/);
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    assert.doesNotMatch(dom.window.document.body.textContent!, /stopped/);
  });
  assert.equal(handlers.size, 0);
});

test("R7I-04: absent or expired local subscription warns only when this phone was previously enabled", { timeout: 15000 }, async () => {
  let local: any = browserSub();
  await mounted(OwnerWebPushSettings, async (path: any) => String(path).endsWith("/status") ? Response.json({ subscribed: true }) : statusReply(),
    { ready: Promise.resolve({ pushManager: { async getSubscription() { return local; } } }) }, async dom => {
      assert.doesNotMatch(dom.window.document.body.textContent!, /stopped/);
      local = { ...browserSub(), expirationTime: 1 };
      await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
      assert.match(dom.window.document.body.textContent!, /stopped/);
      local = null;
      await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
      assert.match(dom.window.document.body.textContent!, /stopped/);
    });
  await mounted(OwnerWebPushSettings, async () => statusReply(), { ready: Promise.resolve({ pushManager: { async getSubscription() { return null; } } }) }, async dom => {
    assert.doesNotMatch(dom.window.document.body.textContent!, /stopped/);
  });
});

test("R7I-04: failed old-key removal and failed save stay recoverable; retry uses the latest key", { timeout: 15000 }, async () => {
  for (const failAt of ["remove", "server-remove", "save"]) {
    let failed = true, local: any = { ...browserSub(), options: { applicationServerKey: new Uint8Array(Buffer.from(vapid.publicKey, "base64url").subarray(0, 3)).buffer } }, creations = 0;
    let removals = 0;
    local.unsubscribe = async () => { if (failAt === "remove" && failed) return false; removals++; local = null; return true; };
    const transport = async (path: any, init: any) => {
      if (String(path).endsWith("/status")) return Response.json({ subscribed: true });
      if (init?.method === "DELETE") return new Response(null, { status: failed && failAt === "server-remove" ? 503 : 204 });
      if (init?.method === "POST") return new Response(null, { status: failed && failAt === "save" ? 503 : 204 });
      return statusReply();
    };
    const worker = { ready: Promise.resolve({ pushManager: { async getSubscription() { return local; }, async subscribe(options: any) {
      creations++; local = { ...browserSub(), options, async unsubscribe() { local = null; return true; } }; return local;
    } } }) };
    await mounted(OwnerWebPushSettings, transport, worker, async dom => {
      await act(async () => button(dom, "Subscribe this browser").click());
      assert.doesNotMatch(dom.window.document.body.textContent!, /This browser is subscribed/);
      assert.equal(button(dom, "Subscribe this browser").disabled, false);
      assert.equal(creations, failAt === "save" ? 1 : 0);
      if (failAt === "save") assert.equal(local, null, "a failed save removes the new local subscription");
      failed = false; await act(async () => button(dom, "Subscribe this browser").click());
      assert.match(dom.window.document.body.textContent!, /This browser is subscribed/); assert.equal(removals, 1);
    });
  }
});

test("R7I-04: 50 taps across two controls share one subscription mutation; unmount stops late setup", { timeout: 15000 }, async () => {
  let release: (value: string) => void = () => {}, saves = 0, permissions = 0;
  const worker = { ready: Promise.resolve({ pushManager: { async getSubscription() { return browserSub(); } } }) };
  await mounted(() => h(React.Fragment, null, h(OwnerWebPushSettings), h(OwnerWebPushSettings)), async (path: any, init: any) => {
    if (String(path).endsWith("/status")) return Response.json({ subscribed: false });
    if (init?.method === "POST") { saves++; return new Response(null, { status: 204 }); }
    return statusReply();
  }, worker, async (dom, root) => {
    (globalThis as any).Notification.requestPermission = () => new Promise<string>(resolve => { permissions++; release = resolve; });
    try {
      await act(async () => { const buttons = [...dom.window.document.querySelectorAll("button")].filter(b => b.textContent === "Subscribe this browser");
        for (let i = 0; i < 50; i++) buttons[i % 2].click(); });
      assert.equal(permissions, 1, "both panels share the owner-action lock");
      await act(async () => release("granted")); assert.equal(saves, 1);
      // A second setup is cancelled by unmount before permission returns.
      await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
      await act(async () => button(dom, "Subscribe this browser").click());
      await act(async () => root.render(null));
      await act(async () => release("granted")); assert.equal(saves, 1);
    } finally { release("denied"); }
  });
});

test("R7I-04: stale health replies cannot undo recovery; action reads a newly rotated server key", { timeout: 15000 }, async () => {
  let hold = false, release: (value: Response) => void = () => {}, saves = 0, creations = 0;
  let serverKey = vapid.publicKey, local: any = browserSub();
  const worker = { ready: Promise.resolve({ pushManager: { async getSubscription() { return local; }, async subscribe(options: any) {
    creations++; assert.equal(Buffer.from(options.applicationServerKey).toString("base64url"), serverKey);
    return local = { ...browserSub(), options };
  } } }) };
  await mounted(OwnerWebPushSettings, async (path: any, init: any) => {
    if (String(path).endsWith("/status")) return hold ? new Promise<Response>(resolve => { release = resolve; }) : Response.json({ subscribed: false });
    if (init?.method === "POST") { saves++; return new Response(null, { status: 204 }); }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ enabled: true, publicKey: serverKey, subscribed: false, message: "Can subscribe" });
  }, worker, async dom => {
    hold = true;
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
    try {
      serverKey = Buffer.from(new Uint8Array(65).fill(9)).toString("base64url");
      await act(async () => button(dom, "Subscribe this browser").click());
      assert.equal(saves, 1); assert.equal(creations, 1);
      await act(async () => release(Response.json({ subscribed: false })));
      assert.match(dom.window.document.body.textContent!, /This browser is subscribed/);
    } finally { hold = false; release(Response.json({ subscribed: true })); }
  });
});

test("R7I-03/04: 30-second checks skip hidden pages and resume once visible", { timeout: 15000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  await mounted(Wrapped, async (path: any) => {
    // int9's /needs-me resolves each visible project's name once per list; that is a
    // lookup, not one of the 30-second checks this test counts.
    if (!String(path).startsWith("/api/v1/projects/")) reads++;
    if (String(path).includes("needs-me")) return Response.json(String(path).includes("action-items") ? { observedAt, items: [], truncated: false } : page("Approve"));
    return statusReply();
  }, { ready: Promise.resolve({ pushManager: { async getSubscription() { return null; } } }) }, async dom => {
    assert.equal(reads, 3);
    await act(async () => t.mock.timers.tick(30_000)); assert.equal(reads, 6);
    Object.defineProperty(dom.window.document, "hidden", { value: true, configurable: true });
    await act(async () => {
      t.mock.timers.tick(30_000); dom.window.dispatchEvent(new dom.window.Event("focus"));
      dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
    }); assert.equal(reads, 6);
    Object.defineProperty(dom.window.document, "hidden", { value: false, configurable: true });
    await act(async () => dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange")));
    assert.equal(reads, 9);
  });
  t.mock.timers.reset();
});

test("R7I-04: missing fresh configuration cannot replace or save a subscription", { timeout: 15000 }, async () => {
  for (const failure of ["http", "disabled", "missing-key"]) {
    let calls = 0, mutations = 0;
    await mounted(OwnerWebPushSettings, async (path: any, init: any) => {
      if (String(path).endsWith("/status")) return Response.json({ subscribed: false });
      if (init?.method) { mutations++; return new Response(null, { status: 204 }); }
      calls++;
      return calls === 1 ? statusReply() : Response.json({ enabled: failure !== "disabled", publicKey: failure === "missing-key" ? undefined : vapid.publicKey }, { status: failure === "http" ? 503 : 200 });
    }, { ready: Promise.resolve({ pushManager: { async getSubscription() { return browserSub(); } } }) }, async dom => {
      await act(async () => button(dom, "Subscribe this browser").click()); assert.equal(mutations, 0);
      assert.doesNotMatch(dom.window.document.body.textContent!, /This browser is subscribed/);
    });
  }
});

test("R7I-04: subscriptions with unavailable keys never claim phone notifications are working", { timeout: 15000 }, async () => {
  for (const missing of ["browser", "server"]) {
    await mounted(OwnerWebPushSettings, async (path: any) => String(path).endsWith("/status") ? Response.json({ subscribed: true })
      : Response.json({ enabled: true, publicKey: missing === "server" ? undefined : vapid.publicKey, message: "Can subscribe" }),
    { ready: Promise.resolve({ pushManager: { async getSubscription() { return { ...browserSub(), options: { applicationServerKey: missing === "browser" ? null : Buffer.from(vapid.publicKey, "base64url") } }; } } }) }, async dom => {
      assert.match(dom.window.document.body.textContent!, /Phone notifications stopped/);
      assert.equal(button(dom, "Send test").disabled, true);
    });
  }
});

test("R7I-05: an expired canonical decision cannot fold into a live task card", () => {
  const warning = { ...decision, id: "attention:supervisor:expired", projectId: "project:alpha", workItemId: "job:Approve",
    reasonCode: "stalled_outcome_uncertain", blockedWorkItemIds: ["job:Approve"] };
  const rows = buildActionInbox([page("Approve") as any], [warning], Date.parse("2026-10-02T23:00:00Z"));
  assert.equal(rows.length, 2); assert.equal(rows.filter(row => row.kind === "expired").length, 1);
  assert.doesNotMatch(rows.find(row => row.kind !== "expired")!.summary, /deadline has passed/);
});

test("R7I-04: stalled phone reads expire, warn and release a retry; late replies cannot overwrite it", { timeout: 15000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const heldAt of ["config", "body", "subscription", "status", "status-body"]) {
    let held = false, release: (value: any) => void = () => {};
    const hold = () => new Promise<any>(resolve => { release = resolve; });
    const worker = { ready: Promise.resolve({ pushManager: { async getSubscription() { return held && heldAt === "subscription" ? hold() : browserSub(); } } }) };
    await mounted(Wrapped, async (path: any) => {
      if (String(path).includes("needs-me")) return Response.json(String(path).includes("action-items") ? { observedAt, items: [], truncated: false } : page("Approve"));
      if (String(path).endsWith("/status")) return held && heldAt === "status" ? hold() : held && heldAt === "status-body" ? { ok: true, json: () => hold() } : Response.json({ subscribed: true });
      return held && heldAt === "config" ? hold() : held && heldAt === "body" ? { ok: true, json: () => hold() } : statusReply();
    }, worker, async dom => {
      held = true;
      await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
      try {
        await act(async () => t.mock.timers.tick(10_000));
        const top = dom.window.document.querySelector('[aria-label="Needs attention"]')!;
        assert.match(top.textContent!, /Phone notifications could not be checked/);
        held = false;
        await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
        assert.doesNotMatch(top.textContent!, /Phone notifications could not be checked/);
        await act(async () => release(heldAt === "subscription" ? browserSub() : heldAt === "status" ? Response.json({ subscribed: false })
          : heldAt === "status-body" ? { subscribed: false } : heldAt === "config" ? statusReply() : { enabled: false }));
        assert.doesNotMatch(top.textContent!, /Phone notifications stopped|Phone notifications could not be checked/);
      } finally { held = false; release(statusReply()); }
    });
  }
  t.mock.timers.reset();
});

test("R7I-04: an expired subscription is recreated on owner action even with the same server key", { timeout: 15000 }, async () => {
  let local: any = { ...browserSub(), expirationTime: 1, async unsubscribe() { local = null; return true; } }, creations = 0;
  const worker = { ready: Promise.resolve({ pushManager: { async getSubscription() { return local; }, async subscribe(options: any) { creations++; return local = { ...browserSub(), options }; } } }) };
  await mounted(OwnerWebPushSettings, async (path: any, init: any) => String(path).endsWith("/status") ? Response.json({ subscribed: true })
    : init?.method ? new Response(null, { status: 204 }) : statusReply(), worker, async dom => {
    assert.match(dom.window.document.body.textContent!, /Phone notifications stopped/);
    await act(async () => button(dom, "Subscribe this browser").click());
    assert.equal(creations, 1); assert.match(dom.window.document.body.textContent!, /This browser is subscribed/);
  });
});

const SettingsAndHeader = ({ settings = true }: { settings?: boolean }) => h(LocalRuntimeContextV1.Provider, { value: { mode: "local" } },
  h(React.Fragment, null, h(PrivateHeader), settings ? h(OwnerWebPushSettings) : null));

test("R7IPOL: header and Settings share exactly one poll per 30 seconds and retain status through failure", { timeout: 15000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0, statuses = 0, held = false, failed = false;
  let lastSignal: AbortSignal | undefined;
  let release: (reply: Response) => void = () => {};
  const worker = { ready: Promise.resolve({ pushManager: { async getSubscription() { return browserSub(); } } }) };
  try {
    await mounted(SettingsAndHeader, async (path: any, init: any) => {
      if (String(path).includes("needs-me")) return Response.json(String(path).includes("action-items")
        ? { observedAt, items: [], truncated: false } : page("Approve"));
      if (String(path).endsWith("/status")) { statuses++; return Response.json({ subscribed: true }); }
      reads++; lastSignal = init?.signal;
      return held ? new Promise<Response>(resolve => { release = resolve; }) : failed ? new Response(null, { status: 503 }) : statusReply();
    }, worker, async (dom, root) => {
      const panel = () => dom.window.document.querySelector('[aria-labelledby="owner-web-push-heading"]')!.textContent!;
      assert.equal(reads, 1); assert.equal(statuses, 1);
      await act(async () => t.mock.timers.tick(29_999)); assert.equal(reads, 1);
      await act(async () => t.mock.timers.tick(1)); assert.equal(reads, 2); assert.equal(statuses, 2);
      await act(async () => t.mock.timers.tick(30_000)); assert.equal(reads, 3); assert.equal(statuses, 3);
      held = true;
      await act(async () => t.mock.timers.tick(30_000)); assert.equal(reads, 4);
      assert.match(panel(), /This browser is subscribed.*Checking…/);
      assert.match(dom.window.document.querySelector('[aria-label="Needs attention"]')!.textContent!, /This browser is subscribed.*Checking…/);
      assert.equal(button(dom, "Send test").disabled, false, "last known subscription is retained");
      await act(async () => { for (let n = 0; n < 50; n++) dom.window.dispatchEvent(new dom.window.Event("focus")); });
      assert.equal(reads, 4, "50 concurrent signals coalesce during a stalled read");
      await act(async () => t.mock.timers.tick(10_000));
      assert.match(panel(), /This browser is subscribed.*Couldn't refresh/);
      assert.doesNotMatch(panel(), /Checking…/);
      held = false; failed = true;
      await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
      assert.equal(reads, 5); assert.match(panel(), /This browser is subscribed.*Couldn't refresh/);
      failed = false;
      await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus")));
      assert.equal(reads, 6); assert.equal(statuses, 4);
      assert.doesNotMatch(panel(), /Couldn't refresh|Checking…/);
      await act(async () => release(Response.json({ enabled: false, message: "obsolete reply" })));
      assert.doesNotMatch(panel(), /obsolete reply/);
      // Removing Settings leaves the header's single poll running.
      await act(async () => root.render(h(SettingsAndHeader, { settings: false })));
      await act(async () => t.mock.timers.tick(30_000)); assert.equal(reads, 7);
      held = true;
      await act(async () => dom.window.dispatchEvent(new dom.window.Event("focus"))); assert.equal(reads, 8);
      await act(async () => root.render(null));
      assert.equal(lastSignal?.aborted, true, "last unmount aborts the shared request");
      await act(async () => { void refreshSharedOwnerPush(); });
      assert.equal(reads, 8, "an unmounted store refuses a read");
      await act(async () => { t.mock.timers.tick(90_000); release(statusReply()); });
      assert.equal(reads, 8, "last unmount stops polling and late work");
    });
  } finally { release(statusReply()); t.mock.timers.reset(); }
});

test("R7IPOL: shared expiry classification agrees before, at, and after the boundary and across a later render", { timeout: 15000 }, async t => {
  const expiry = Date.parse(decision.expiresAt!);
  t.mock.timers.enable({ apis: ["Date"], now: expiry - 1 });
  try {
    await mounted(Wrapped, async (path: any) => {
      if (!String(path).includes("needs-me")) return statusReply();
      return Response.json(String(path).includes("action-items") ? { observedAt, items: [decision], truncated: false }
        : { ...page("Approve"), items: [], examined: 0 });
    }, { ready: Promise.resolve({ pushManager: { async getSubscription() { return null; } } }) }, async (dom, root) => {
      const top = () => dom.window.document.querySelector('[aria-label="Needs attention"]')!.textContent!;
      const list = () => dom.window.document.querySelector('[aria-labelledby="action-inbox-heading"]')!.textContent!;
      const live = () => { assert.match(list(), /Approval needed/); assert.match(list(), /Recorded response options/); assert.doesNotMatch(top(), /Expired decision/); assert.doesNotMatch(top(), /Review current status/); };
      const expired = () => { assert.match(list(), /Expired/); assert.doesNotMatch(list(), /Recorded response options/); assert.match(top(), /Expired decision/); };
      live();
      t.mock.timers.setTime(expiry);
      await act(async () => root.render(h(Wrapped))); live(); // No second classification at render time.
      await act(async () => button(dom, "Check Action Inbox again").click()); expired();
      t.mock.timers.setTime(expiry + 1);
      await act(async () => button(dom, "Check Action Inbox again").click()); expired();
      t.mock.timers.setTime(expiry - 1);
      await act(async () => button(dom, "Check Action Inbox again").click()); live();
      // A later re-render must keep both surfaces' classification too.
      t.mock.timers.setTime(expiry + 1);
      await act(async () => root.render(h(Wrapped))); live();
      assert.equal(buildActionInbox([], [decision], expiry - 1)[0].kind, "approval");
      assert.equal(buildActionInbox([], [decision], expiry)[0].kind, "expired");
      assert.equal(buildActionInbox([], [decision], expiry + 1)[0].kind, "expired");
    });
  } finally { t.mock.timers.reset(); }
});


test("R7IPOL: exactly one push timer exists for two panels and none after the last unmount", { timeout: 15000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scheduled = new Map<ReturnType<typeof setTimeout>, number>();
  const schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout;
  globalThis.setTimeout = ((callback: any, delay: number, ...args: any[]) => {
    const id = schedule(callback, delay, ...args); scheduled.set(id, delay); return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (id: string | number | NodeJS.Timeout | undefined) => { if (id) scheduled.delete(id as ReturnType<typeof setTimeout>); cancel(id); };
  try {
    await mounted(() => h(React.Fragment, null, <OwnerWebPushSettings attentionOnly />, h(OwnerWebPushSettings)),
      async () => statusReply(), { ready: Promise.resolve({ pushManager: { async getSubscription() { return null; } } }) }, async (_dom, root) => {
        const polls = () => [...scheduled.values()].filter(delay => delay === 30_000).length;
        assert.equal(polls(), 1);
        await act(async () => root.render(h(OwnerWebPushSettings)));
        assert.equal(polls(), 1);
        await act(async () => root.render(null));
        assert.equal(polls(), 0);
        assert.equal(scheduled.size, 0, "all read deadlines and poll timers are released");
      });
  } finally { globalThis.setTimeout = schedule; globalThis.clearTimeout = cancel; t.mock.timers.reset(); }
});

test("R7IPOL: polling resumes after an owner action spans a poll deadline", { timeout: 15000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0, permit: (value: string) => void = () => {};
  try {
    await mounted(OwnerWebPushSettings, async () => { reads++; return statusReply(); },
      { ready: Promise.resolve({ pushManager: { async getSubscription() { return null; } } }) }, async dom => {
        (globalThis.Notification as any).requestPermission = () => new Promise(resolve => { permit = resolve; });
        await act(async () => button(dom, "Subscribe this browser").click());
        await act(async () => t.mock.timers.tick(30_000)); assert.equal(reads, 1, "no read during the owner's pending action");
        await act(async () => permit("denied"));
        await act(async () => t.mock.timers.tick(29_999)); assert.equal(reads, 1);
        await act(async () => t.mock.timers.tick(1)); assert.equal(reads, 2, "next single poll survives a slow action");
      });
  } finally { permit("denied"); t.mock.timers.reset(); }
});

test("R7IPOL: an unmounted panel cannot overwrite the remaining panel's status with a late action reply", { timeout: 15000 }, async () => {
  let deleting = false, release: () => void = () => {};
  try {
    await mounted(SettingsAndHeader, async (path: any, init: any) => {
      if (String(path).includes("needs-me")) return Response.json(String(path).includes("action-items")
        ? { observedAt, items: [], truncated: false } : page("Approve"));
      if (init?.method === "DELETE") { deleting = true; return new Promise<Response>(resolve => { release = () => resolve(new Response(null, { status: 204 })); }); }
      return String(path).endsWith("/status") ? Response.json({ subscribed: true }) : statusReply();
    }, { ready: Promise.resolve({ pushManager: { async getSubscription() { return browserSub(); } } }) }, async (dom, root) => {
      await act(async () => button(dom, "Unsubscribe this browser").click());
      assert.equal(deleting, true);
      await act(async () => root.render(h(SettingsAndHeader, { settings: false })));
      await act(async () => root.render(h(SettingsAndHeader, { settings: true })));
      await act(async () => release());
      const panel = dom.window.document.querySelector('[aria-labelledby="owner-web-push-heading"]')!.textContent!;
      assert.match(panel, /This browser is subscribed/);
      assert.doesNotMatch(panel, /This browser is unsubscribed/);
    });
  } finally { release(); }
});
