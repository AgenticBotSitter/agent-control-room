import assert from "node:assert/strict";
import test, { mock } from "node:test";
import React, { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { OwnerWebPushSettings } from "../private-app/app/owner-web-push";
import { PwaRegistration } from "../private-app/app/pwa-registration";
import { HomeDashboard } from "../private-app/app/home-workspace";
import { UpdaterHomeStatus } from "../private-app/app/updater-home-status";
import { UpdaterMainLoopV1 } from "../src/updater/v1/runtime.mjs";
import { now, vapid, AlertStore, mounted, browserSub, statusReply, button } from "./support/owner-notify-fixtures";

test("N03: failed save rolls back a new subscription and leaves an existing subscription retryable", async () => {
  let local: any = null, saves = 0, creations = 0;
  const worker = { ready: Promise.resolve({ pushManager: { async getSubscription() { return local; }, async subscribe() { creations++; return local = { ...browserSub(), async unsubscribe() { local = null; return true; } }; } } }) };
  const transport = async (path: any, init?: any) => {
    if (path.endsWith("/status")) return Response.json({ subscribed: false });
    if (init?.method === "POST") { saves++; return new Response(null, { status: saves === 1 ? 503 : 204 }); }
    return statusReply();
  };
  await mounted(OwnerWebPushSettings, transport, worker, async dom => {
    await act(async () => button(dom, "Subscribe this browser").click());
    assert.equal(local, null, "failed save rolls back a newly created browser registration");
    assert.equal(button(dom, "Subscribe this browser").disabled, false);
  });
  local = browserSub();
  await mounted(OwnerWebPushSettings, transport, worker, async dom => {
    assert.equal(button(dom, "Subscribe this browser").disabled, false, "a revoked server record can be saved again");
    assert.doesNotMatch(dom.window.document.body.textContent!, /This browser is subscribed/);
    await act(async () => button(dom, "Subscribe this browser").click());
    assert.equal(saves, 2); assert.equal(creations, 1, "an existing browser registration is reused"); assert.match(dom.window.document.body.textContent!, /This browser is subscribed/);
  });
});

test("N03: false browser removal reports partial failure and permits retry", async () => {
  const sub = { ...browserSub(), async unsubscribe() { return false; } };
  await mounted(OwnerWebPushSettings, async (path: any, init?: any) => path.endsWith("/status") ? Response.json({ subscribed: true }) : init?.method === "DELETE" ? new Response(null, { status: 204 }) : statusReply(),
    { ready: Promise.resolve({ pushManager: { async getSubscription() { return sub; } } }) }, async dom => {
      await act(async () => button(dom, "Unsubscribe this browser").click());
      assert.doesNotMatch(dom.window.document.body.textContent!, /This browser is unsubscribed/);
      assert.match(dom.window.document.body.textContent!, /browser.*could not be removed/);
      assert.equal(button(dom, "Unsubscribe this browser").disabled, false);
      assert.equal(button(dom, "Send test").disabled, true);
    });
});

test("N04: registration failure settles checking and exposes retry", async () => {
  const worker: any = { addEventListener() {}, removeEventListener() {}, ready: new Promise(() => {}), async register() { throw new Error("fixture_registration_failed"); } };
  await mounted(() => createElement(React.Fragment, null, createElement(PwaRegistration), createElement(OwnerWebPushSettings)), async () => statusReply(), worker, async dom => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    assert.doesNotMatch(dom.window.document.body.textContent!, /Checking phone notifications/);
    assert.match(dom.window.document.body.textContent!, /unavailable/);
    assert.equal(button(dom, "Retry notification setup").disabled, false);
    worker.register = async () => { worker.ready = Promise.resolve({ pushManager: { async getSubscription() { return null; } } }); return worker.ready; };
    await act(async () => button(dom, "Retry notification setup").click());
    assert.equal(button(dom, "Subscribe this browser").disabled, false);
  });
});
test("N06: error and rollback outcomes queue an owner alert in the default main-loop mapping", async () => {
  for (const status of ["error", "rolled_back", "needs_attention", "uncertain"]) {
    const store = new AlertStore(); const facts: any[] = [], publicStates: any[] = [];
    const loop = new UpdaterMainLoopV1({ runner: { async runOnce() { return { status }; } }, store: { async unhandledOwnerRequests() { return []; } },
      stateFiles: { async readSelfUpdate() { return "On"; }, async hasRescueMarker() { return false; }, async writeStatus(value: any) { publicStates.push(value); } }, mode: { async read() { return "running"; } },
      ownerActions: {}, alerts: { async reconcile(value: any) { facts.push(value); for (const [key, active] of Object.entries(value)) if (active) await store.queue(key); }, async tick() {} } } as any);
    await loop.tick();
    assert.equal(store.queued.length, 1); assert.equal(publicStates[0].needsYou, true);
  }
});

test("N06: rolled-back code update renders an attention Home Install card", async () => {
  const value = { schema: "control-room.updater-owner-ui/v1", observedAt: new Date(now).toISOString(), state: "rolled_back", selfUpdate: "On", activeSubscriptions: 1,
    availableControls: [], message: "Previous version restored.", plan: null };
  await mounted(UpdaterHomeStatus, async () => Response.json(value), {}, async dom => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    const card = dom.window.document.querySelector(".private-updater-card");
    assert.ok(card, dom.window.document.body.textContent!); assert.ok(card.classList.contains("has-items"));
    assert.match(dom.window.document.body.textContent!, /previous version is back/);
  });
});
test("N11: Home attention identifies an offline worker when the worker route is unavailable", () => {
  const html = renderToStaticMarkup(createElement(HomeDashboard, { data: {
    projects: { state: "unavailable" }, activity: { state: "unavailable" },
    attention: { state: "ready", value: { items: [], nextCursor: null, sources: { ordinary: "included", ideas: "excluded" }, examined: 0, observedAt: new Date(now).toISOString(), startsWork: false, planningSource: "not_configured" } },
    connections: { state: "ready", value: { source: "local", value: { taskWorkersStarted: false, projectSections: [], workers: [{ kind: "codex", state: "unavailable", proof: "not_proven" }] } } },
  } } as any));
  const doc = new JSDOM(html).window.document; const attention = doc.querySelector("[aria-labelledby=home-attention]")!;
  assert.ok(attention.classList.contains("has-items")); assert.match(attention.textContent!, /Worker warning/); assert.doesNotMatch(attention.textContent!, /All clear/); assert.match(doc.querySelector("[aria-labelledby=home-stuck]")!.textContent!, /codex/);
});

test("N04: a worker that never becomes ready times out and setup can retry", async () => {
  const { readyOwnerPushWorkerV1 } = await import("../private-app/app/pwa-registration");
  await assert.rejects(readyOwnerPushWorkerV1({ ready: new Promise(() => {}) } as any, 5), /owner_push_worker_unavailable/);
  const registration = {} as ServiceWorkerRegistration;
  assert.equal(await readyOwnerPushWorkerV1({ ready: Promise.resolve(registration) } as any, 5), registration);
});

test("N10: waiting worker update is offered without automatic reload or activation", async () => {
  let activated = 0;
  const registration = { waiting: { state: "installed", addEventListener() {}, removeEventListener() {}, postMessage(value: any) { assert.deepEqual(value, { type: "control-room.activate-update" }); activated++; } },
    addEventListener() {}, removeEventListener() {} };
  const listeners: Record<string, () => void> = {};
  const worker = { controller: {}, async register() { return registration; }, addEventListener(name: string, callback: () => void) { listeners[name] = callback; }, removeEventListener() {} };
  await mounted(PwaRegistration, async () => statusReply(), worker, async dom => {
    const errors: Error[] = [];
    const console = (dom as any).virtualConsole;
    console.removeAllListeners("jsdomError"); console.on("jsdomError", (error: Error) => errors.push(error));
    listeners.controllerchange(); assert.equal(errors.length, 0, "activation must be owner-requested");
    assert.equal(activated, 0);
    await act(async () => button(dom, "Reload for update").click());
    assert.equal(activated, 1); listeners.controllerchange();
    assert.equal(errors.length, 1, "the owner-requested controller change calls reload");
  });
});

test("N02: mounted Send test binds this browser and distinguishes failed from accepted requests", async () => {
  let failed = true, endpoint: string | undefined;
  const sub = browserSub();
  await mounted(OwnerWebPushSettings, async (path: any, init?: any) => {
    if (path.endsWith("/status")) return Response.json({ subscribed: true });
    if (path.endsWith("/test")) { endpoint = JSON.parse(init.body).endpoint; return failed ? new Response(null, { status: 503 }) : Response.json({ accepted: true }); }
    return statusReply();
  }, { ready: Promise.resolve({ pushManager: { async getSubscription() { return sub; } } }) }, async dom => {
    await act(async () => button(dom, "Send test").click()); assert.equal(endpoint, sub.endpoint);
    assert.match(dom.window.document.body.textContent!, /could not be sent/);
    failed = false; await act(async () => button(dom, "Send test").click());
    assert.match(dom.window.document.body.textContent!, /accepted a test/);
    assert.doesNotMatch(dom.window.document.body.textContent!, /was sent to this browser/);
  });
});


test("N03: failed registration reads and denied permission never claim a saved subscription", async () => {
  const sub = browserSub();
  const worker = { ready: Promise.resolve({ pushManager: { async getSubscription() { return sub; } } }) };
  for (const failAt of ["config", "status"]) await mounted(OwnerWebPushSettings, async (path: any) => {
    const value = path.endsWith("/status") ? { subscribed: true } : { enabled: true, publicKey: vapid.publicKey, message: "Can subscribe" };
    return Response.json(value, { status: (failAt === "config" ? !path.endsWith("/status") : path.endsWith("/status")) ? 503 : 200 });
  }, worker, async dom => {
    assert.match(dom.window.document.body.textContent!, /unavailable/);
    assert.equal(button(dom, "Send test").disabled, true);
  });
  let saves = 0;
  await mounted(OwnerWebPushSettings, async (_path: any, init?: any) => { if (init?.method) saves++; return statusReply(); },
    { ready: Promise.resolve({ pushManager: { async getSubscription() { return null; }, async subscribe() { throw new Error("must_not_subscribe"); } } }) }, async dom => {
      (globalThis as any).Notification.requestPermission = async () => "denied";
      await act(async () => button(dom, "Subscribe this browser").click());
      assert.equal(saves, 0); assert.match(dom.window.document.body.textContent!, /did not grant/);
    });
});

test("N03: failed server removal never calls browser removal", async () => {
  let removed = 0;
  const sub = { ...browserSub(), async unsubscribe() { removed++; return true; } };
  await mounted(OwnerWebPushSettings, async (path: any, init?: any) => path.endsWith("/status") ? Response.json({ subscribed: true })
    : init?.method === "DELETE" ? new Response(null, { status: 503 }) : statusReply(),
    { ready: Promise.resolve({ pushManager: { async getSubscription() { return sub; } } }) }, async dom => {
      await act(async () => button(dom, "Unsubscribe this browser").click());
      assert.equal(removed, 0); assert.equal(button(dom, "Send test").disabled, false);
      assert.match(dom.window.document.body.textContent!, /could not be removed/);
    });
});

test("N03: 50 overlapping subscribe taps create and save one browser subscription", async () => {
  let creations = 0, saves = 0;
  const worker = { ready: Promise.resolve({ pushManager: { async getSubscription() { return null; }, async subscribe() { creations++; return browserSub(); } } }) };
  await mounted(OwnerWebPushSettings, async (_path: any, init?: any) => { if (init?.method === "POST") { saves++; return new Response(null, { status: 204 }); } return statusReply(); }, worker, async dom => {
    await act(async () => { for (let i = 0; i < 50; i++) button(dom, "Subscribe this browser").click(); });
    assert.equal(creations, 1); assert.equal(saves, 1);
  });
});

test("R6I-06: held Send test and body reads expire, release controls and allow an honest retry", { timeout: 15000 }, async () => {
  const worker = { ready: Promise.resolve({ pushManager: { async getSubscription() { return browserSub(); } } }) };
  for (const heldAt of ["headers", "body"]) {
    let writes = 0, signal: AbortSignal | undefined;
    await mounted(OwnerWebPushSettings, async (path: any, init?: any) => {
      if (!path.endsWith("/test")) return path.endsWith("/status") ? Response.json({ subscribed: true }) : statusReply();
      writes++; signal = init?.signal;
      if (writes > 1) return Response.json({ accepted: true });
      // Deliberately ignores cancellation: the UI deadline must still settle.
      return heldAt === "headers" ? new Promise<Response>(() => {}) : { ok: true, json: () => new Promise(() => {}) };
    }, worker, async dom => {
      mock.timers.enable({ apis: ["setTimeout"] });
      try {
        await act(async () => { for (let n = 0; n < 50; n++) button(dom, "Send test").click(); });
        assert.equal(writes, 1);
        assert.equal(button(dom, "Unsubscribe this browser").disabled, true);
        await act(async () => mock.timers.tick(10_000));
        assert.equal(signal?.aborted, true);
        assert.equal(button(dom, "Send test").disabled, false);
        assert.equal(button(dom, "Unsubscribe this browser").disabled, false);
        assert.match(dom.window.document.body.textContent!, /timed out/i);
        assert.match(dom.window.document.body.textContent!, /receipt is not confirmed/);
        await act(async () => button(dom, "Send test").click());
        assert.equal(writes, 2);
        assert.match(dom.window.document.body.textContent!, /accepted a test/);
      } finally { mock.timers.reset(); }
    });
  }
});

test("R6I-06: unmount aborts the held Send test and clears its deadline", { timeout: 15000 }, async () => {
  let signal: AbortSignal | undefined;
  await mounted(OwnerWebPushSettings, async (path: any, init?: any) => {
    if (!path.endsWith("/test")) return path.endsWith("/status") ? Response.json({ subscribed: true }) : statusReply();
    signal = init?.signal;
    return new Promise<Response>(() => {});
  }, { ready: Promise.resolve({ pushManager: { async getSubscription() { return browserSub(); } } }) }, async (dom, root) => {
    await act(async () => button(dom, "Send test").click());
    await act(async () => root.render(null));
    assert.equal(signal?.aborted, true);
  });
});

test("R6I-06: refused or malformed test replies recover without claiming provider acceptance", { timeout: 15000 }, async () => {
  for (const reply of [() => Response.json({ accepted: true }, { status: 503 }), () => new Response(null, { status: 503 }), () => Response.json({ accepted: false }), () => Response.json({}), () => new Response("bad json")]) {
    await mounted(OwnerWebPushSettings, async (path: any) => path.endsWith("/test") ? reply()
      : path.endsWith("/status") ? Response.json({ subscribed: true }) : statusReply(),
    { ready: Promise.resolve({ pushManager: { async getSubscription() { return browserSub(); } } }) }, async dom => {
      await act(async () => button(dom, "Send test").click());
      assert.equal(button(dom, "Send test").disabled, false);
      assert.match(dom.window.document.body.textContent!, /could not be sent/);
      assert.doesNotMatch(dom.window.document.body.textContent!, /accepted a test/);
    });
  }
});

test("R6I-06: deadline also bounds subscription lookup, and late setup never sends a timed-out test", { timeout: 15000 }, async () => {
  let lookup = 0, writes = 0, release: (value: any) => void = () => {};
  await mounted(OwnerWebPushSettings, async (path: any) => {
    if (path.endsWith("/test")) { writes++; return Response.json({ accepted: true }); }
    return path.endsWith("/status") ? Response.json({ subscribed: true }) : statusReply();
  }, { ready: Promise.resolve({ pushManager: { async getSubscription() {
    lookup++; return lookup === 1 ? browserSub() : new Promise(resolve => { release = resolve; });
  } } }) }, async dom => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await act(async () => button(dom, "Send test").click());
      await act(async () => mock.timers.tick(10_000));
      assert.equal(button(dom, "Send test").disabled, false);
      assert.match(dom.window.document.body.textContent!, /timed out/);
      await act(async () => release(browserSub()));
      assert.equal(writes, 0);
    } finally { mock.timers.reset(); }
  });
});

test("R6I-06: a missing browser subscription refuses Send test and completed tests clear their deadline", { timeout: 15000 }, async () => {
  let lookup = 0, writes = 0, signal: AbortSignal | undefined;
  await mounted(OwnerWebPushSettings, async (path: any, init?: any) => {
    if (path.endsWith("/test")) { writes++; signal = init.signal; return Response.json({ accepted: true }); }
    return path.endsWith("/status") ? Response.json({ subscribed: true }) : statusReply();
  }, { ready: Promise.resolve({ pushManager: { async getSubscription() { lookup++; return lookup === 2 ? null : browserSub(); } } }) }, async dom => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await act(async () => button(dom, "Send test").click());
      assert.equal(writes, 0); assert.match(dom.window.document.body.textContent!, /could not be sent/);
      await act(async () => button(dom, "Send test").click());
      assert.equal(writes, 1); assert.equal(signal?.aborted, false);
      await act(async () => mock.timers.tick(10_000));
      assert.equal(signal?.aborted, false, "the completed request's deadline was cleared");
      assert.match(dom.window.document.body.textContent!, /accepted a test/);
    } finally { mock.timers.reset(); }
  });
});
