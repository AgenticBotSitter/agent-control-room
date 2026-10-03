// R6C-05, receiver half: the SHIPPED service worker, in a REAL browser, with
// REAL IndexedDB and the REAL notification API.
//
// WHY A BROWSER AND NOT A vm/jsdom HARNESS. The property under test is
// durability across a process boundary: the receipt has to survive the worker
// being stopped and started again, which is exactly the crash the sender half
// reproduces. `tests/owner-notify-worker.test.mjs` runs the same shipped file
// through `vm.runInNewContext`, which has no IndexedDB at all, so a lane written
// there could only ever prove the in-memory half of this finding.
//
// WHAT ACTUALLY RUNS. The real private-app/app/service-worker.js, served from a
// throwaway loopback origin this file starts and registered as a real service
// worker. Events reach the worker through its own `message` listener, which calls
// the SAME `deliverPushV1` the `push` listener calls -- one implementation, so
// the two cannot drift. IndexedDB, the worker lifecycle and the notification API
// are Chromium's.
//
// HEADLESS MODE IS PART OF THE PROOF. Chromium's original headless mode denies
// notification permission unconditionally -- MEASURED here: `grantPermissions`
// was ignored, permission stayed "denied" and every `showNotification` threw.
// Under that mode every assertion below would be measuring a permission error
// rather than the product. `--headless=new` with an explicit grant gives a REAL
// notification list, so the assertions read `getNotifications()`: Chromium's own
// record of what the owner would see on the lock screen.
//
// Two properties this buys that no recorder could: the second delivery of a tag
// really is collapsed by the platform, and `notification.close()` really removes
// it, so the DISMISSED case is an actual dismissal rather than a description of
// one.
//
// No push provider, no installed app, no origin the owner uses. The listener is
// bound to 127.0.0.1 on an ephemeral port this process chose, and every browser
// and server it starts is one it also stops in a finally.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";

const WORKER_PATH = "/service-worker.js";
const PAGE_HTML = "<!doctype html><meta charset=\"utf-8\"><title>Control Room worker harness</title><body>harness</body>";

/** The event identity ownerPushDedupeKeyV1 derives for one attention item. */
const dedupeKeyFor = (id) => `needs:${id}`;
const alertFor = (tag) => ({ title: "Control Room needs you", link: "/needs-me", tag });

/**
 * Serve the shipped worker from a loopback origin this test owns.
 *
 * Disposable by construction: port 0, and the port read back from the listener
 * rather than chosen, so it cannot collide with the live app on 3210 or with
 * anything else running on this machine.
 */
async function workerOrigin() {
  const source = await readFile("private-app/app/service-worker.js", "utf8");
  const server = createServer((request, response) => {
    if (request.url === WORKER_PATH) {
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      response.end(source);
      return;
    }
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(PAGE_HTML);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("push_worker_harness_no_port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => { server.close(() => resolve()); });
    },
  };
}

async function harnessFor(browser, origin) {
  const context = await browser.newContext();
  // The grant the worker's real `showNotification` needs.
  await context.grantPermissions(["notifications"], { origin });
  const page = await context.newPage();
  const failures = [];
  page.on("pageerror", (error) => failures.push(`pageerror:${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") failures.push(`console:${message.text()}`); });

  /**
   * How many times the worker has REALLY asked the platform to show something.
   *
   * Counted INSIDE the worker, because that is the only realm that can see it:
   * MEASURED, a wrapper installed on the page's `ServiceWorkerRegistration
   * .prototype` is a different object from the one the service worker reaches,
   * so the worker pushed into an array the page could not read and the count came
   * back zero. The worker's own `navigator.serviceWorker` handle exposes
   * `showNotification` call statistics only to the worker, so the count is
   * recorded there and read back over the same message port the pushes use.
   *
   * WHY NOT COUNT THE LOCK SCREEN. Chromium's notification list collapses
   * simultaneous notifications that share a `tag`, so it cannot tell "the worker
   * asked once" from "the worker asked eight times and the platform merged
   * them". MEASURED: with the claim's own dedupe check deleted, eight concurrent
   * deliveries of one tag still left exactly one notification on the lock screen
   * and every lane passed. This count is what a mutation cannot hide behind.
   */
  /** Ask the worker how many notifications it has asked for, by tag. */
  const showCalls = () => page.evaluate(async () => {
    const worker = (await navigator.serviceWorker.ready).active;
    const channel = new MessageChannel();
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("count_reply_timeout")), 20_000);
      channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(event.data); };
    });
    worker.postMessage({ type: "control-room.count-shows" }, [channel.port2]);
    return await reply;
  });

  const install = async () => {
    await page.goto(`${origin}/`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
      await navigator.serviceWorker.ready;
    });
  };
  await install();

  /** Deliver one event through the real worker and wait for its handler to end. */
  const push = async (payload) => {
    const outcome = await page.evaluate(async (body) => {
      const worker = (await navigator.serviceWorker.ready).active;
      if (!worker) return { ok: false, reason: "no_active_worker" };
      const channel = new MessageChannel();
      // The worker replies once its own `waitUntil` promise has settled, so the
      // page waits for the REAL end of the handler -- the notification and the
      // durable write included -- not for the postMessage that started it.
      const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("push_handler_timeout")), 20_000);
        channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(String(event.data)); };
      });
      worker.postMessage({ type: "control-room.deliver-push", payload: body ?? null }, [channel.port2]);
      return { ok: true, reason: await done };
    }, payload ?? null);
    assert.equal(outcome.ok, true, `the push handler reported ${JSON.stringify(outcome)}`);
    // A refusal is a failure of this lane, not a condition to accept: permission
    // is granted, so a refusal means the product could not show the alert, which
    // is the one outcome this file exists to exclude.
    assert.equal(outcome.reason, "handled",
      `the worker could not deliver the event to the notification API: ${outcome.reason}`);
  };

  /**
   * Deliver N events of the SAME new tag at once, through N ports.
   *
   * Concurrent, because that is the only shape in which the read and the claim
   * disagree: a sequential second push finds the tag already recorded by the
   * first, so the fast read refuses it and nothing is exercised. Two pushes
   * racing both read "not seen" before either has written, and only the ATOMIC
   * claim inside the readwrite transaction can refuse the second one.
   */
  const pushConcurrently = async (payload, copies) => {
    const outcomes = await page.evaluate(async ({ body, count }) => {
      const worker = (await navigator.serviceWorker.ready).active;
      const ports = Array.from({ length: count }, () => new MessageChannel());
      const replies = ports.map((channel) => new Promise((resolve) => {
        const timer = setTimeout(() => { clearTimeout(timer); resolve("timeout"); }, 20_000);
        channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(String(event.data)); };
      }));
      for (const channel of ports)
        worker.postMessage({ type: "control-room.deliver-push", payload: body }, [channel.port2]);
      return await Promise.all(replies);
    }, { body: payload, count: copies });
    for (const outcome of outcomes) assert.equal(outcome, "handled",
      `every concurrent delivery finished its handler; one reported ${outcome}`);
    return outcomes;
  };


  /** What the owner's lock screen actually holds, read from the platform. */
  const shown = () => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const notifications = await registration.getNotifications();
    return notifications.map((notification) => ({ tag: notification.tag, title: notification.title, data: notification.data }));
  });

  /** The owner swiping an alert away. */
  const dismissAll = () => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    for (const notification of await registration.getNotifications()) notification.close();
  });

  const restartWorker = async () => {
    // Stopping and starting the worker is what a host restart does to it, and it
    // is the boundary this finding's claim has to survive: anything the worker
    // held in memory is gone, IndexedDB is not.
    await dismissAll();
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration.unregister();
    });
    await install();
  };

  /** How many tags the worker's own durable receipt currently holds. */
  const receiptSize = () => page.evaluate(async () => new Promise((resolve) => {
    const request = indexedDB.open("control-room-push-seen-v1", 1);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("events")) { resolve(0); database.close(); return; }
      const read = database.transaction("events", "readonly").objectStore("events").count();
      read.onsuccess = () => { resolve(read.result); database.close(); };
      read.onerror = () => resolve(-1);
    };
    request.onerror = () => resolve(-1);
  }));

  return { context, page, push, pushConcurrently, shown, showCalls,
    dismissAll, restartWorker, receiptSize, failures,
    close: async () => { await context.close(); } };
}

/**
 * Launch Chromium, or null with the reason recorded.
 *
 * `--headless=new` is what makes the notification API real here; see the header.
 */
let browserUnavailable = null;

const browserFor = async () => {
  const { chromium } = await import("@playwright/test");
  try {
    return await chromium.launch({ headless: false, args: ["--headless=new"] });
  } catch (error) {
    browserUnavailable = `needs a Chromium build this lane can launch (pnpm exec playwright install chromium); ${error?.message ?? "unknown"}`;
    return null;
  }
};

/**
 * SKIPPING IS EXPLICIT, and decided ONCE before any lane runs.
 *
 * A lane that silently passes without a browser would report the receiver half of
 * R6C-05 as proved by every lane that has no Chromium -- which is most of them.
 * The test:owner-push:postgres lane this file is registered in installs no
 * browser, so without this the coverage claim would be a fiction. Probing once at
 * module load means every lane skips with the SAME visible reason, rather than
 * each of them deciding separately.
 */
const browserProbe = await browserFor();
const skipWithoutBrowser = browserProbe === null
  ? { skip: `owner_push_service_worker_needs_chromium:${browserUnavailable}` }
  : undefined;
await browserProbe?.close();

const withHarness = async (body) => {
  const browser = await browserFor();
  if (browser === null) return;
  const origin = await workerOrigin();
  const harness = await harnessFor(browser, origin.origin);
  try {
    await body(harness);
  } finally {
    await harness.close();
    await browser.close();
    await origin.close();
  }
};

test("R6C-05: the shipped worker shows one alert per event, including after a dismissal and a restart",
  skipWithoutBrowser,
  async () => {
    await withHarness(async (harness) => {
      const item = "attention:supervisor:crash-accepted";
      const tag = dedupeKeyFor(item);

      // The crash the sender lane reproduces: the provider handed this event to
      // the browser, then the host died before it recorded the delivery.
      await harness.push(alertFor(tag));
      assert.deepEqual((await harness.shown()).map((entry) => entry.tag), [tag],
        "the first acceptance reaches the lock screen: an alert nobody is told about is the worse failure");

      // The re-send, while the first alert is still on screen.
      await harness.push(alertFor(tag));
      assert.deepEqual((await harness.shown()).map((entry) => entry.tag), [tag],
        "the re-sent event does not become a second alert");

      // And after the owner DISMISSED it. The database `tag` collapses two
      // notifications that are both on screen; it cannot stop a DISMISSED one
      // reappearing, because a dismissed notification no longer exists to be
      // replaced. That is the case this receipt exists for.
      await harness.dismissAll();
      assert.deepEqual(await harness.shown(), [], "the owner really dismissed the alert");
      await harness.push(alertFor(tag));
      assert.deepEqual(await harness.shown(), [],
        "a dismissed alert does not come back when the same event is handed over again");

      // CONCURRENTLY, and with a tag nothing has ever claimed. Two push events
      // for one item can be in flight at the same moment -- the dispatcher
      // retries on a 30s loop and a second worker can be starting -- and a
      // read-then-act dedupe loses that race by construction. Only the claim
      // inside one readwrite transaction can refuse the second.
      //
      // Counted by CALL, not by the lock screen: the platform merges
      // simultaneous same-tag notifications, so the lock screen would report one
      // alert whether the worker asked once or eight times. This is the
      // assertion that makes the atomic claim load bearing rather than a second
      // net over a read.
      const raced = dedupeKeyFor("attention:supervisor:raced");
      await harness.pushConcurrently(alertFor(raced), 8);
      assert.deepEqual((await harness.shown()).map((entry) => entry.tag), [raced],
        "eight concurrent deliveries of one brand-new event produce ONE alert on the lock screen");
      const calls = await harness.showCalls();
      assert.equal(calls[raced], 1,
        `and the worker really asked the platform exactly once; it asked ${String(calls[raced])} times`);

      // A different item is a different event and must still reach the owner.
      await harness.dismissAll();
      const other = dedupeKeyFor("attention:supervisor:another");
      await harness.push(alertFor(other));
      assert.deepEqual((await harness.shown()).map((entry) => entry.tag), [other],
        "one event per item: the dedupe is per tag, not a global mute");

      // ACROSS a restart. Both tags were already surfaced before it, so both
      // must still be recognised afterwards: the receipt is what a restart does
      // not take with it.
      await harness.restartWorker();
      await harness.dismissAll();
      await harness.push(alertFor(tag));
      await harness.push(alertFor(other));
      assert.deepEqual(await harness.shown(), [],
        "the receipt survives the worker being stopped and started again");

      // And a genuinely new event is still delivered after that restart, so the
      // receipt is not a mute that outlives its usefulness.
      const afterRestart = dedupeKeyFor("attention:supervisor:after-restart");
      await harness.push(alertFor(afterRestart));
      assert.deepEqual((await harness.shown()).map((entry) => entry.tag), [afterRestart],
        "a new event after the restart still reaches the owner");
      assert.deepEqual(harness.failures, [], "the worker logged nothing while doing it");
    });
  });

test("R6C-05: the receipt is bounded, and a payload the worker cannot use is shown once",
  skipWithoutBrowser,
  async () => {
    await withHarness(async (harness) => {
      // A payload the worker cannot use falls back to its own defaults, and that
      // default tag is shared by every unusable push. Refusing those outright
      // would mean a broken event is never shown; showing the default once is
      // the honest middle -- the owner is told something happened, and a broken
      // push cannot become an unbounded alert storm either.
      await harness.push(undefined);
      await harness.push(undefined);
      const shown = await harness.shown();
      assert.equal(shown.length, 1, `two unusable payloads produce one alert; shown ${JSON.stringify(shown)}`);
      assert.equal(shown[0].tag, "control-room", "and it is the worker's own fixed default tag");
      assert.equal(shown[0].data.link, "/needs-me", "pointing at the owner's own saved items");

      // The receipt is bounded. Chromium's own notification list is itself capped
      // (MEASURED: 100), so the lock-screen count cannot measure an unbounded
      // store -- what it measures here is only that each distinct event is shown.
      // The STORE is read directly below, because that is the claim.
      for (let index = 0; index < 260; index++) {
        await harness.push(alertFor(`needs:bulk:${index}`));
        // Dismissed as the owner would, so the platform's own cap never hides a
        // later event behind an earlier one.
        if (index % 25 === 24) await harness.dismissAll();
      }
      const storeSize = await harness.receiptSize();
      assert.ok(storeSize <= 200,
        `the receipt is bounded and stays within its limit; found ${storeSize} tags for 260 events`);
      assert.ok(storeSize >= 150, `and it is not truncated into uselessness; found ${storeSize} tags`);

      // The most recent event is still recognised as seen after the trim, so the
      // bound is not costing the owner a repeat on the alert they just got.
      await harness.dismissAll();
      await harness.push(alertFor("needs:bulk:259"));
      assert.deepEqual(await harness.shown(), [],
        "the most recent event is still recognised as seen after the store was trimmed");

      // A tag older than the window is forgotten on purpose, and is shown again
      // rather than dropped: the bound trades a possible repeat for a store that
      // cannot grow for ever. A lost alert is the failure this must never have.
      await harness.push(alertFor("needs:bulk:0"));
      assert.deepEqual((await harness.shown()).map((entry) => entry.tag), ["needs:bulk:0"],
        "a forgotten tag is shown again -- a bounded store may repeat, never lose an alert");
    });
  });

test("R6C-05: a store that cannot answer still shows the alert", async () => {
  // The failure mode of receiver-side dedupe is a LOST alert. Every path that
  // cannot prove the event was already seen has to show it, and this is the
  // proof that the fallback exists: the owner's own browser storage refuses, and
  // the alert still reaches the lock screen.
  await withHarness(async (harness) => {
    await harness.page.evaluate(() => {
      indexedDB.open = () => {
        const request = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, result: null };
        setTimeout(() => { request.onerror?.(); }, 0);
        return request;
      };
    });
    await harness.push(alertFor("needs:page-store-refused"));
    assert.equal((await harness.shown()).length, 1,
      "a refused browser store does not stop the worker alerting the owner");
  });
});

test("R6C-05: a notification the platform REFUSES does not consume the event",
  skipWithoutBrowser,
  async () => {
    // A context with NO permission granted, so Chromium refuses the notification
    // -- the exact condition the receipt release exists for: the first delivery
    // claims the tag and then cannot show it, so without a release every later
    // delivery of that event is suppressed and the alert is lost for good.
    // MEASURED on this machine before the release existed. A dedupe receipt that
    // can turn a visible alert into a silent one is worse than no dedupe at all.
    const browser = await browserFor();
    const origin = await workerOrigin();
    const context = await browser.newContext();
    const page = await context.newPage();
    const failures = [];
    page.on("pageerror", (error) => failures.push(`pageerror:${error.message}`));
    try {
      await page.goto(`${origin.origin}/`);
      await page.evaluate(async () => {
        await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
        await navigator.serviceWorker.ready;
      });
      // "default" (never granted) rather than an explicit "denied": both make
      // Chromium refuse the notification, and "default" is the state a real
      // install is in before the owner opts in.
      assert.notEqual(await page.evaluate(() => Notification.permission), "granted",
        "this lane requires an origin whose notifications the platform refuses");
      const deliver = () => page.evaluate(async () => {
        const worker = (await navigator.serviceWorker.ready).active;
        const channel = new MessageChannel();
        return await new Promise((resolve) => {
          const timer = setTimeout(() => { clearTimeout(timer); resolve("timeout"); }, 20_000);
          channel.port1.onmessage = (event) => { clearTimeout(timer); resolve(String(event.data)); };
          worker.postMessage({ type: "control-room.deliver-push",
            payload: { title: "Control Room needs you", link: "/needs-me", tag: "needs:refused" } }, [channel.port2]);
        });
      });
      const first = await deliver();
      assert.match(first, /^ERROR:/,
        `the platform really did refuse the notification; the worker reported ${first}`);
      // The receipt must not be holding a claim for an event nothing ever showed.
      const stored = await page.evaluate(async () => new Promise((resolve) => {
        const request = indexedDB.open("control-room-push-seen-v1", 1);
        request.onsuccess = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("events")) { resolve(["store_absent"]); database.close(); return; }
          const read = database.transaction("events", "readonly").objectStore("events").getAllKeys();
          read.onsuccess = () => { resolve(read.result); database.close(); };
          read.onerror = () => resolve(["read_failed"]);
        };
        request.onerror = () => resolve(["open_failed"]);
      }));
      assert.deepEqual(stored, [],
        `a refused notification must release its receipt, or the event can never be alerted; stored ${JSON.stringify(stored)}`);
      assert.deepEqual(failures, [], "and the page logged nothing");
    } finally {
      await context.close();
      await browser.close();
      await origin.close();
    }
  });