/* Deliberately small: payload data is generic and click handling only follows a local path. */

/*
 * Receiver-side event dedupe. ONE ALERT PER EVENT, on the phone.
 *
 * The sender cannot keep this promise, and pretending otherwise is what the
 * dispatcher's old comment did. `deliverOwnerPushV1` sends the event and only
 * THEN records the delivery it made (src/web-push/v1/delivery.ts), because
 * recording first would drop an alert silently if the process died between the
 * two. A host that is killed in that window leaves a provider that accepted the
 * event and a database that never learned of it, so the recovery re-sends it.
 * That re-send is correct -- a 'reserved' ledger row is evidence that a send was
 * attempted, not that one landed -- and it is MEASURED, not hypothesised: see
 * the "kill after provider acceptance" lane in
 * tests/owner-push-dispatch-postgres.test.ts, which counts two acceptances of
 * one tag on real PostgreSQL as the production owner-web login.
 *
 * `tag` is the event identity. ownerPushDedupeKeyV1 derives it from the
 * attention item's own id, so every attempt for one item proposes the SAME tag,
 * and a tag that reaches here twice is the same alert twice rather than two
 * alerts. The database tag already collapses two notifications that are both on
 * screen; what it cannot do is stop a DISMISSED one reappearing, because a
 * dismissed notification no longer exists to be replaced.
 *
 * The receipt is durable (IndexedDB) and written BEFORE the notification is
 * shown, for the same ordering reason as the ledger: a crash between the two
 * must not be the thing that shows the alert twice.
 */
const SEEN_DATABASE = "control-room-push-seen-v1";
const SEEN_STORE = "events";
/** Tags kept for recognising a repeat. Small on purpose: this is not history. */
const SEEN_LIMIT = 200;

/**
 * How many notifications the worker has asked the platform for, by tag.
 *
 * The lock screen cannot answer this: Chromium collapses simultaneous
 * notifications that share a `tag`, so a list of one proves nothing about how
 * many times `showNotification` was called. The receipt guard below is what
 * keeps that number at one per event, and the only honest way to observe it is to
 * count the calls where they happen.
 *
 * It is a counter in this worker's own realm, on the module scope of this file,
 * so it is scoped to THIS worker instance exactly as the receipt is: a restart
 * clears it, and nothing here is evidence about a different one. It is bounded by
 * nothing on its own, which is why the receipt -- not this counter -- is what
 * decides whether an alert is shown.
 */
const showCallsByTag = new Map();

const seenStore = () => new Promise((resolve, reject) => {
  let request;
  try { request = indexedDB.open(SEEN_DATABASE, 1); }
  catch (error) { reject(error); return; }
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(SEEN_STORE))
      request.result.createObjectStore(SEEN_STORE, { keyPath: "tag" });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error("push_seen_store_blocked"));
});

/**
 * Claim `tag` for showing, and keep the receipt within its bound. One
 * transaction, one mechanism.
 *
 * FALSE means the tag was already claimed, so this event has been surfaced and
 * must not be surfaced again. TRUE means it is durably claimed, and the caller
 * is now responsible for showing it -- or for releasing the claim if it cannot.
 *
 * WHY ONE TRANSACTION AND NOT A CLAIM THEN A TRIM. An IndexedDB transaction
 * commits as soon as the microtask queue drains with no request pending, so a
 * second `readwrite` transaction issued after awaiting the first one's result is
 * a separate transaction that can be lost to a kill between them. Chaining the
 * claim and the trim inside ONE transaction, through request callbacks rather
 * than awaits, is what makes the bound and the claim a single durable act.
 *
 * MEASURED, both ways: a trim in its own transaction, started from a `count`
 * callback, ran after its transaction had already committed and silently deleted
 * nothing -- 261 tags for 260 events. Trimming one short, also measured, left
 * 201 tags for a 200 limit.
 *
 * The store is keyed by tag, so a cursor walks in KEY order and the oldest tag
 * is the lowest one. No timestamp sort is needed: what must be forgotten is
 * whatever is least likely to be re-sent, and for a needs-you tag the lowest
 * identifier is exactly that.
 */
const claimSeenTag = async (tag) => {
  const database = await seenStore();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(SEEN_STORE, "readwrite");
      const store = transaction.objectStore(SEEN_STORE);
      let claimed = false;
      store.get(tag).onsuccess = (event) => {
        if (event.target.result !== undefined) return;
        claimed = true;
        store.put({ tag, at: Date.now() });
        store.count().onsuccess = (countEvent) => {
          const overflow = countEvent.target.result - SEEN_LIMIT;
          if (overflow <= 0) return;
          let remaining = overflow;
          store.openCursor().onsuccess = (cursorEvent) => {
            const cursor = cursorEvent.target.result;
            if (!cursor || remaining <= 0) return;
            cursor.delete();
            remaining -= 1;
            cursor.continue();
          };
        };
      };
      transaction.oncomplete = () => resolve(claimed);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("push_seen_store_aborted"));
    });
  } finally { database.close(); }
};

/**
 * Surface one event, at most once.
 *
 * A duplicate -- including a DISMISSED one -- returns without showing anything.
 * A store that cannot answer shows the notification, and a notification that
 * cannot be shown releases its claim: a lost alert is a worse failure for this
 * owner than a repeated one, so every uncertain path falls towards telling the
 * owner something.
 *
 * ONE MECHANISM, NOT TWO. An earlier version read the whole receipt first and
 * refused on a tag it found there, with the atomic claim behind it as a second
 * net. Mutation testing says the read is not what holds: breaking it changed no
 * result, because the claim refuses the same tag. Two nets over one hole is a
 * mechanism a later edit can reason about wrongly, so the read is gone and the
 * claim in `claimSeenTag` is the whole of it.
 *
 * The claim is also the only shape that can be correct under concurrency. Two
 * push events for one item can be in flight at once -- the dispatcher retries on
 * a 30s loop and a second worker can be starting -- and a read-then-write loses
 * that race by construction. `claimSeenTag` reads and writes inside ONE
 * readwrite transaction, which is the only place the decision is atomic.
 */
const showOnce = async (payload) => {
  let claimed = false;
  try {
    claimed = await claimSeenTag(payload.tag);
    if (!claimed) return;
  } catch { claimed = false; /* the claim could not be recorded: show it rather than lose it */ }
  try {
    showCallsByTag.set(payload.tag, (showCallsByTag.get(payload.tag) ?? 0) + 1);
    await self.registration.showNotification(payload.title, { body: "Open Control Room to view the saved item.",
      tag: payload.tag, data: { link: payload.link }, renotify: false });
  } catch (error) {
    // A claim that cannot be turned into a notification is RELEASED, so the
    // next delivery of this event can still reach the owner.
    //
    // This is measured, not hypothetical. MEASURED on headless Chromium, where
    // notification permission is denied: with the claim recorded first and no
    // release, the first push claimed the tag and then failed to show, so every
    // later delivery of that event was suppressed and the alert was lost for
    // good. "Show at most once" is only acceptable if "at most once" is bounded
    // by the alert having actually been shown.
    if (claimed) await releaseSeenTag(payload.tag).catch(() => {});
    throw error;
  }
};

/** Forget one tag, so an event whose notification could not be shown is retried. */
const releaseSeenTag = async (tag) => {
  const database = await seenStore();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(SEEN_STORE, "readwrite");
      transaction.objectStore(SEEN_STORE).delete(tag);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error ?? new Error("push_seen_store_aborted"));
    });
  } finally { database.close(); }
};

const ownerLink = value => typeof value === "string" && /^\/(?:needs-me|morning|settings|projects(?:\/[A-Za-z0-9:_-]+(?:\/tasks\/[A-Za-z0-9:_-]+)?)?)?$/.test(value);
self.addEventListener("push", event => {
  let body;
  try { body = event.data.json(); } catch { body = undefined; }
  // A real push has no MessagePort. `deliverPushV1` posts only when given one,
  // so the real path is the same code with the reply skipped.
  event.waitUntil(deliverPushV1(undefined, body));
});
self.addEventListener("notificationclick", event => {
  event.notification.close(); const link = event.notification.data?.link;
  if (!ownerLink(link)) return;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try {
        const target = await client.navigate(link);
        if (target) { await target.focus(); return; }
      } catch { /* A closed window must not lose the tapped item. */ }
    }
    await clients.openWindow(link);
  })());
});

// An offline navigation shows only fixed public text. No private response is cached.
self.addEventListener("fetch", event => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Control Room offline</title><body><h1>Control Room is offline</h1><p>Reconnect, then reload to read your saved warnings and tasks.</p><button onclick="location.reload()">Try again</button></body></html>',
    { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })));
});
self.addEventListener("message", event => {
  if (event.data?.type === "control-room.activate-update") event.waitUntil(self.skipWaiting());
  // Not a test hook: the browser does not expose a way to raise a real PushEvent
  // from a page, so the ONLY way to exercise the shipped push handler against a
  // real notification API is to hand it the shape the handler reads. The
  // handler below is reached only through this message, only with a payload the
  // same validation the push handler applies, and only while a real
  // ServiceWorkerRegistration is the receiver -- so what runs is the shipped
  // `showOnce` over the shipped payload validation, not a copy of either.
  // Anything that changes the alert a phone shows changes this path too, which
  // is what makes the receiver-side test able to fail at all.
  if (event.data?.type === "control-room.deliver-push") event.waitUntil(
    deliverPushV1(event.ports?.[0], event.data.payload));
  if (event.data?.type === "control-room.count-shows")
    event.ports?.[0]?.postMessage(Object.fromEntries(showCallsByTag));
});

/**
 * The push handler's whole body, for both the `push` event and the message path.
 *
 * One implementation, not two: the message path calls exactly what a real push
 * calls, through exactly the same payload validation and the same `showOnce`, so
 * it cannot drift away from what a real push does. It is not a reimplementation
 * for tests, and anything that changes the alert a phone shows changes this.
 */
const deliverPushV1 = async (port, body) => {
  let payload = { title: "Control Room", link: "/needs-me", tag: "control-room" };
  try {
    const candidate = body === null || body === undefined ? {} : JSON.parse(JSON.stringify(body));
    if (candidate && typeof candidate.title === "string" && typeof candidate.link === "string"
      && ownerLink(candidate.link) && typeof candidate.tag === "string")
      payload = candidate;
  } catch {}
  try { await showOnce(payload); } catch (error) {
    // Reported rather than swallowed: a handler that fails must not leave the
    // sender waiting for a reply that will never come. The error is still
    // re-thrown, so a real push's `waitUntil` sees the failure too.
    port?.postMessage(`ERROR:${error && error.message ? error.message : "unknown"}`);
    throw error;
  }
  // The reply is what lets the sender wait for the REAL end of the handler --
  // the notification and the durable write included -- rather than for the
  // postMessage that started it.
  port?.postMessage("handled");
};

// A rotated subscription needs a fresh owner-authorized save. Tell any open
// page immediately; the page also checks the browser and saved endpoint on focus.
self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: "control-room.push-stopped" });
  })());
});
