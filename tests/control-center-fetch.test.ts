import test from "node:test";
import assert from "node:assert/strict";
import { isNonPublicIpAddress } from "../src/vendor/control-center/public-address";
import { fetchPinned } from "../src/vendor/control-center/pinned-fetch";
import { safeFetchText } from "../src/vendor/control-center/safe-fetch";

const publicLookup = async () => [{ address: "8.8.8.8", family: 4 as const }];
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
