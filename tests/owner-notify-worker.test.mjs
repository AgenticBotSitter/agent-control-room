import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

async function worker() {
  const handlers = {}, state = { skipped: 0, opened: [], shown: [], fetches: 0 };
  const self = { addEventListener(name, callback) { handlers[name] = callback; },
    async skipWaiting() { state.skipped++; },
    registration: { async showNotification(title, options) { state.shown.push({ title, options }); } } };
  vm.runInNewContext(await readFile("private-app/app/service-worker.js", "utf8"), { self, Response,
    clients: { async openWindow(link) { state.opened.push(link); } },
    fetch: async () => { state.fetches++; throw new Error("fixture_offline"); } });
  return { handlers, state };
}

test("N10: worker provides a private-data-free offline page only for navigation", async () => {
  const { handlers, state } = await worker();
  assert.equal(typeof handlers.fetch, "function");
  let response;
  handlers.fetch({ request: { mode: "navigate" }, respondWith(value) { response = value; } });
  const page = await response;
  assert.equal(page.status, 503); assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(await page.text(), /Control Room is offline/);
  handlers.fetch({ request: { mode: "same-origin", url: "/api/v1/private" }, respondWith() { assert.fail("private API must never be intercepted or cached"); } });
  assert.equal(state.fetches, 1);
});

test("N10: worker activation requires the explicit owner update message", async () => {
  const { handlers, state } = await worker();
  assert.equal(typeof handlers.message, "function");
  handlers.message({ data: { type: "untrusted" }, waitUntil() { assert.fail("unrecognized message activated an update"); } });
  assert.equal(state.skipped, 0);
  const pending = [];
  handlers.message({ data: { type: "control-room.activate-update" }, waitUntil(value) { pending.push(value); } });
  await Promise.all(pending); assert.equal(state.skipped, 1);
});
