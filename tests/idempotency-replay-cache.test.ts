// Unit tests for the in-process idempotency-replay cache.
//
// These tests pin the cache contract:
//   * lookup returns null on miss and the prior outcome on hit
//   * TTL eviction happens lazily on the next lookup
//   * the LRU cap evicts the oldest entry when full
//   * the composite key prevents cross-project / cross-action replay

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIdempotencyCacheKey,
  IdempotencyReplayCache,
} from "../src/web/v1/idempotency-replay-cache";

const FIXTURE_NOW = Date.parse("2026-09-14T00:00:00.000Z");

function key(parts: Partial<{
  idempotencyKey: string;
  projectId: string;
  subaction: string;
  identitySubject: string;
}> = {}) {
  return {
    idempotencyKey: parts.idempotencyKey ?? "idem-default01",
    projectId: parts.projectId ?? "project:example",
    subaction: parts.subaction ?? "appoint-coordinator",
    identitySubject: parts.identitySubject ?? "subject:test",
  };
}

test("lookup on a fresh cache returns null", () => {
  const cache = new IdempotencyReplayCache({ clock: () => FIXTURE_NOW });
  assert.equal(cache.lookup(key()), null);
});

test("record + lookup returns the recorded outcome", () => {
  const cache = new IdempotencyReplayCache({ clock: () => FIXTURE_NOW });
  cache.record(key(), 200, { status: "accepted", revision: { expectedCoordinatorVersion: 1 } });
  const entry = cache.lookup(key());
  assert.ok(entry);
  assert.equal(entry?.status, 200);
  assert.deepEqual(entry?.body, { status: "accepted", revision: { expectedCoordinatorVersion: 1 } });
});

test("TTL eviction returns null after expiry", () => {
  let now = FIXTURE_NOW;
  const cache = new IdempotencyReplayCache({ clock: () => now, ttlMs: 1000 });
  cache.record(key(), 200, { ok: true });
  // Advance the clock past the TTL.
  now += 5000;
  assert.equal(cache.lookup(key()), null);
});

test("different projectId yields a fresh lookup slot", () => {
  const cache = new IdempotencyReplayCache({ clock: () => FIXTURE_NOW });
  cache.record(key({ projectId: "project:alpha" }), 200, { project: "alpha" });
  assert.equal(cache.lookup(key({ projectId: "project:beta" })), null);
  assert.deepEqual(cache.lookup(key({ projectId: "project:alpha" }))?.body, { project: "alpha" });
});

test("different subaction yields a fresh lookup slot", () => {
  const cache = new IdempotencyReplayCache({ clock: () => FIXTURE_NOW });
  cache.record(key({ subaction: "appoint-coordinator" }), 200, { sub: "appoint" });
  assert.equal(cache.lookup(key({ subaction: "revoke-coordinator" })), null);
  assert.deepEqual(cache.lookup(key({ subaction: "appoint-coordinator" }))?.body, { sub: "appoint" });
});

test("different identitySubject yields a fresh lookup slot", () => {
  const cache = new IdempotencyReplayCache({ clock: () => FIXTURE_NOW });
  cache.record(key({ identitySubject: "subject:alice" }), 200, { who: "alice" });
  assert.equal(cache.lookup(key({ identitySubject: "subject:bob" })), null);
});

test("LRU cap evicts the oldest entry when full", () => {
  const cache = new IdempotencyReplayCache({ clock: () => FIXTURE_NOW, maxEntries: 2 });
  cache.record(key({ idempotencyKey: "idem-older01" }), 200, { who: "older" });
  cache.record(key({ idempotencyKey: "idem-newer01" }), 200, { who: "newer" });
  assert.equal(cache.size(), 2);
  // Adding a third entry forces eviction of the oldest.
  cache.record(key({ idempotencyKey: "idem-newer02" }), 200, { who: "newest" });
  assert.equal(cache.size(), 2);
  assert.equal(cache.lookup(key({ idempotencyKey: "idem-older01" })), null);
  assert.deepEqual(cache.lookup(key({ idempotencyKey: "idem-newer01" }))?.body, { who: "newer" });
  assert.deepEqual(cache.lookup(key({ idempotencyKey: "idem-newer02" }))?.body, { who: "newest" });
});

test("buildIdempotencyCacheKey produces a stable composite string", () => {
  const composite = buildIdempotencyCacheKey(key());
  assert.equal(typeof composite, "string");
  assert.ok(composite.includes("idem-default01"));
  assert.ok(composite.includes("project:example"));
  assert.ok(composite.includes("appoint-coordinator"));
  assert.ok(composite.includes("subject:test"));
});

test("clear empties the cache", () => {
  const cache = new IdempotencyReplayCache({ clock: () => FIXTURE_NOW });
  cache.record(key(), 200, { ok: true });
  assert.equal(cache.size(), 1);
  cache.clear();
  assert.equal(cache.size(), 0);
  assert.equal(cache.lookup(key()), null);
});
