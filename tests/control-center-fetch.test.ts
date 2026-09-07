import test from "node:test";
import assert from "node:assert/strict";
import { isNonPublicIpAddress } from "../src/vendor/control-center/public-address";
import { fetchPinned } from "../src/vendor/control-center/pinned-fetch";
import { safeFetchText } from "../src/vendor/control-center/safe-fetch";
import { createControlCenterCollectionReader } from "../src/project-adapters/abs-news/v1/control-center-reader";

const publicLookup = async () => [{ address: "8.8.8.8", family: 4 as const }];
test("redirect scope refusal happens before the redirected DNS lookup", async () => {
  const lookups: string[] = [];
  await assert.rejects(safeFetchText("https://example.org", { beforeRequest(url) {
    if (new URL(url).hostname !== "example.org") throw new Error("source_not_allowed");
  } }, { lookup: async host => { lookups.push(host); return publicLookup(); },
    fetch: async () => new Response(null, { status: 302, headers: { location: "https://other.example/" } }),
  }), /source_not_allowed/);
  assert.deepEqual(lookups, ["example.org"]);
});
test("outer cancellation follows a redirect and prevents the next lookup", async () => {
  const abort = new AbortController(); let lookups = 0;
  await assert.rejects(safeFetchText("https://example.org", { signal: abort.signal }, {
    lookup: async () => { lookups++; return publicLookup(); },
    fetch: async () => { abort.abort(); return new Response(null, { status: 302, headers: { location: "/next" } }); },
  }));
  assert.equal(lookups, 1);
});
test("bounded borrowed discovery caps physical attempts and body reservations without default transport", async () => {
  const limits = { timeoutMs: 1000, maxAttempts: 1, maxDocumentBytes: 1024, maxReservedBodyBytes: 2048 };
  let calls = 0;
  const reader = createControlCenterCollectionReader(limits, { assertCurrent() {} }, new AbortController().signal,
    { lookup: publicLookup, fetch: async () => { calls++; return new Response("not a feed"); } });
  await assert.rejects(reader.readSource({ id: "source:test", name: "Test", url: "https://example.org/" }));
  assert.equal(calls, 1);
  let deniedLookups = 0, authorityChecks = 0;
  const denied = createControlCenterCollectionReader(limits, { assertCurrent() { authorityChecks++; throw new Error("revoked"); } }, new AbortController().signal,
    { lookup: async () => { deniedLookups++; return publicLookup(); }, fetch: async () => { throw new Error("unexpected"); } });
  await assert.rejects(denied.readSource({ id: "source:test", name: "Test", url: "https://example.org/" }), /revoked/);
  assert.equal(authorityChecks, 1);
  assert.equal(deniedLookups, 0);
});
test("bounded reader shares cancellation and refuses a late result even if an injected transport ignores abort", async () => {
  const abort = new AbortController();
  const reader = createControlCenterCollectionReader({ timeoutMs: 1000, maxAttempts: 3, maxDocumentBytes: 1024, maxReservedBodyBytes: 4096 },
    { assertCurrent() {} }, abort.signal, { lookup: publicLookup, fetch: async () => {
      abort.abort(); return new Response("<rss><channel></channel></rss>");
    } });
  await assert.rejects(reader.readSource({ id: "source:test", name: "Test", url: "https://example.org/" }));
  assert.equal(reader.signal.aborted, true);
});
test("one shared deadline stops a stalled injected request", async () => {
  const reader = createControlCenterCollectionReader({ timeoutMs: 10, maxAttempts: 3, maxDocumentBytes: 1024, maxReservedBodyBytes: 4096 },
    { assertCurrent() {} }, new AbortController().signal, { lookup: publicLookup,
      fetch: async (_url, _address, init) => new Promise((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      }) });
  // AbortSignal.timeout is unref'ed; keep this synthetic test alive until it fires.
  const keepAlive = setTimeout(() => undefined, 100);
  try { await assert.rejects(reader.readSource({ id: "source:test", name: "Test", url: "https://example.org/" })); }
  finally { clearTimeout(keepAlive); }
  assert.equal(reader.signal.aborted, true);
});
test("already-aborted borrowed fetch never launches DNS or transport", async () => {
  let lookups = 0, requests = 0;
  await assert.rejects(fetchPinned("https://example.org", { signal: AbortSignal.abort() }, {
    lookup: async () => { lookups++; throw new Error("lookup_must_not_run"); },
    fetch: async () => { requests++; throw new Error("request_must_not_run"); },
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lookups, 0); assert.equal(requests, 0);
});
test("borrowed address checks reject local and embedded private addresses", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2001:db8::1"])
    assert.equal(isNonPublicIpAddress(address), true, address);
  for (const address of ["8.8.8.8", "2606:4700:4700::1111"]) assert.equal(isNonPublicIpAddress(address), false);
});
test("borrowed pinning refuses mixed DNS answers without requesting and passes the checked address", async () => {
  let calls = 0;
  await assert.rejects(fetchPinned("https://example.org", {}, {
    lookup: async () => [...await publicLookup(), { address: "10.0.0.1", family: 4 }],
    fetch: async () => { calls++; return new Response("unexpected"); },
  }));
  assert.equal(calls, 0);
  const result = await fetchPinned("https://example.org", {}, { lookup: publicLookup,
    async fetch(url, address) { calls++; assert.equal(url.hostname, "example.org"); assert.equal(address.address, "8.8.8.8"); return new Response("fixture"); } });
  assert.equal(await result.text(), "fixture"); assert.equal(calls, 1);
});
test("borrowed redirect reader rechecks every destination and bounds decoded response", async () => {
  const hosts: string[] = [];
  const result = await safeFetchText("https://example.org/start", { maxBytes: 10 }, {
    lookup: async hostname => { hosts.push(hostname); return publicLookup(); },
    async fetch(url) { return url.pathname === "/start"
      ? new Response(null, { status: 302, headers: { location: "https://other.example/feed" } }) : new Response("<rss/>"); },
  });
  assert.deepEqual(hosts, ["example.org", "other.example"]); assert.equal(result.text, "<rss/>");
  assert.equal(result.finalUrl, "https://other.example/feed");
  await assert.rejects(safeFetchText("https://example.org", { maxBytes: 2 }, {
    lookup: publicLookup, fetch: async () => new Response("too large"),
  }));
  let calls = 0;
  await assert.rejects(safeFetchText("https://example.org", {}, { lookup: publicLookup,
    async fetch() { calls++; return new Response(null, { status: 302, headers: { location: "http://localhost/private" } }); } }));
  assert.equal(calls, 1);
});
