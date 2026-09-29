import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security";
import { captureLocalOwnerSessionProfileV1, LocalOwnerSessionServiceV1, LOCAL_OWNER_SESSION_PROFILE_V1,
  readLocalOwnerCodeV1 } from "../src/web/v1/local-owner-session";
import { WebAccessError } from "../src/web/v1/access-verifier";
import type { LocalOwnerSessionStoreV1 } from "../src/web/v1/local-owner-session-store";
import type { PersistedLocalOwnerSessionV1 } from "../src/web/v1/local-owner-session";

const origin = "http://127.0.0.1:3210";
const ownerCode = "local-owner-code-that-is-long-enough";
const profile = Object.freeze({ schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: "tenant:local",
  provider: "local-owner", subject: "owner:local", ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 });

function request(path = "/api/v1/local-owner-session", headers: Record<string, string> = {}, body?: string) {
  return new Request(`${origin}${path}`, { method: body === undefined ? "GET" : "POST", headers, body });
}

test("local owner session accepts only the correct code from the configured loopback origin", async () => {
  const service = new LocalOwnerSessionServiceV1(profile);
  const issued = await service.issue(request(undefined, { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    JSON.stringify({ ownerCode })), ownerCode, 1_000);
  assert.match(issued.cookie, /^control_room_local_owner=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=900$/);
  const cookie = issued.cookie.split(";", 1)[0]!;
  const identity = service.verify(request("/api/v1/projects", { cookie }), 1_001);
  assert.deepEqual(identity, { provider: "local-owner", subject: "owner:local", tokenDigest: identity.tokenDigest,
    issuedAt: "1970-01-01T00:00:01.000Z", expiresAt: "1970-01-01T00:15:01.000Z", verificationExpiresAt: "1970-01-01T00:15:01.000Z" });
});

test("an optional exact HTTPS origin gets a Secure cookie and keeps exact-origin write checks", async () => {
  const trustedOrigin = "https://control-room-mac.example.ts.net";
  const service = new LocalOwnerSessionServiceV1(captureLocalOwnerSessionProfileV1({ ...profile, trustedOrigin }));
  const remote = (path: string, headers: Record<string, string> = {}, body?: string) => new Request(`${trustedOrigin}${path}`,
    { method: body === undefined ? "GET" : "POST", headers, body });
  const issued = await service.issue(remote("/api/v1/local-owner-session", { origin: trustedOrigin,
    "sec-fetch-site": "same-origin", "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 1_000);
  assert.match(issued.cookie, /; Secure$/);
  const cookie = issued.cookie.split(";", 1)[0]!;
  assert.equal(service.verify(remote("/api/v1/projects", { cookie }), 1_001).subject, "owner:local");
  await assert.rejects(service.issue(remote("/api/v1/local-owner-session", { origin,
    "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 1_002),
  (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
});

test("an HTTPS origin is off by default and protected configuration refuses unsafe alternatives", async () => {
  const service = new LocalOwnerSessionServiceV1(profile);
  const remote = new Request("https://control-room-mac.example.ts.net/api/v1/projects");
  assert.throws(() => service.verify(remote, 1_000),
    (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
  for (const trustedOrigin of ["http://control-room-mac.example.ts.net", "https://*.example.ts.net", "https://user@example.ts.net", "https://example.ts.net/path"])
    assert.throws(() => captureLocalOwnerSessionProfileV1({ ...profile, trustedOrigin }));
});

test("local owner session rejects wrong code, forwarded requests, foreign origins, and expired cookies", async () => {
  const service = new LocalOwnerSessionServiceV1(profile);
  for (const bad of ["wrong-code-that-is-still-long-enough", "wrong-code-that-is-still-long-enough"]) {
    await assert.rejects(service.issue(request(undefined, { origin, "content-type": "application/json" }, JSON.stringify({ ownerCode: bad })), bad, 1_000),
      (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");
  }
  await assert.rejects(service.issue(request(undefined, { origin: "http://127.0.0.1:9999", "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 1_000),
    (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
  await assert.rejects(service.issue(request(undefined, { origin, forwarded: "for=192.0.2.1", "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 1_000),
    (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
  const issued = await service.issue(request(undefined, { origin, "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 1_000);
  await assert.throws(() => service.verify(request("/api/v1/projects", { cookie: issued.cookie.split(";", 1)[0]! }), 901_001),
    (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");
});

test("local owner session rate-limits repeated wrong-code attempts without locking a valid session forever", async () => {
  const service = new LocalOwnerSessionServiceV1(profile);
  const bad = "wrong-code-that-is-still-long-enough";
  for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(service.issue(
    request(undefined, { origin, "content-type": "application/json" }, JSON.stringify({ ownerCode: bad })), bad, 1_000 + attempt),
    (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");
  await assert.rejects(service.issue(request(undefined, { origin, "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 1_006),
    (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
  await assert.doesNotReject(service.issue(request(undefined, { origin, "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode,
    1_000 + 60_001));
});

test("local owner sign-in request accepts only a small exact JSON object", async () => {
  const valid = request(undefined, { "content-type": "application/json" }, JSON.stringify({ ownerCode }));
  assert.equal(await readLocalOwnerCodeV1(valid), ownerCode);
  for (const value of ["{}", JSON.stringify({ ownerCode, extra: true }), JSON.stringify({ ownerCode: 4 })]) {
    await assert.rejects(readLocalOwnerCodeV1(request(undefined, { "content-type": "application/json" }, value)),
      (error: unknown) => error instanceof WebAccessError && error.code === "invalid_request");
  }
});

test("a persisted hashed session survives restart, remains installation-bound, and contains no cookie secret", async () => {
  const rows = new Map<string, PersistedLocalOwnerSessionV1 & { revokedAt?: string }>();
  const store: LocalOwnerSessionStoreV1 = {
    async load(nowMs) { return [...rows.values()].filter(row => !row.revokedAt && Date.parse(row.expiresAt) > nowMs); },
    async save(session) { rows.set(session.tokenDigest, { ...session }); },
    async revoke(tokenDigest, revokedAt) { const row = rows.get(tokenDigest); if (!row) throw new Error("missing"); rows.set(tokenDigest, { ...row, revokedAt }); },
  };
  const first = new LocalOwnerSessionServiceV1(profile, store);
  const issued = await first.issue(request(undefined, { origin, "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 1_000);
  const cookie = issued.cookie.split(";", 1)[0]!, token = cookie.split("=", 2)[1]!;
  assert.equal(rows.size, 1);
  assert.doesNotMatch(JSON.stringify([...rows.values()]), new RegExp(token, "u"));
  const restarted = new LocalOwnerSessionServiceV1(profile, store, await store.load(2_000));
  assert.equal(restarted.verify(request("/api/v1/projects", { cookie }), 2_000).subject, profile.subject);

  const anotherInstallation = { ...profile, ownerCodeDigest: sha256Digest({ ownerCode: `${ownerCode}-different-installation` }) };
  const copied = new LocalOwnerSessionServiceV1(anotherInstallation, store, await store.load(2_000));
  assert.throws(() => copied.verify(request("/api/v1/projects", { cookie }), 2_000),
    (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");
});

test("expired and revoked persisted sessions are refused", async () => {
  const rows = new Map<string, PersistedLocalOwnerSessionV1 & { revokedAt?: string }>();
  const store: LocalOwnerSessionStoreV1 = {
    async load(nowMs) { return [...rows.values()].filter(row => !row.revokedAt && Date.parse(row.expiresAt) > nowMs); },
    async save(session) { rows.set(session.tokenDigest, { ...session }); },
    async revoke(tokenDigest, revokedAt) { const row = rows.get(tokenDigest); if (!row) throw new Error("missing"); rows.set(tokenDigest, { ...row, revokedAt }); },
  };
  const active = new LocalOwnerSessionServiceV1(profile, store);
  const issued = await active.issue(request(undefined, { origin, "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 1_000);
  const cookie = issued.cookie.split(";", 1)[0]!;
  await active.revoke(request(undefined, { origin, cookie }), 2_000);
  assert.throws(() => active.verify(request("/api/v1/projects", { cookie }), 2_001),
    (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");
  const afterRevocation = new LocalOwnerSessionServiceV1(profile, store, await store.load(2_001));
  assert.throws(() => afterRevocation.verify(request("/api/v1/projects", { cookie }), 2_001),
    (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");

  const expiring = new LocalOwnerSessionServiceV1(profile, store);
  const expired = await expiring.issue(request(undefined, { origin, "content-type": "application/json" }, JSON.stringify({ ownerCode })), ownerCode, 3_000);
  assert.throws(() => expiring.verify(request("/api/v1/projects", { cookie: expired.cookie.split(";", 1)[0]! }), 903_001),
    (error: unknown) => error instanceof WebAccessError && error.code === "authentication_required");
});

test("a failed persistent revoke is surfaced and leaves the in-memory session active", async () => {
  const rows = new Map<string, PersistedLocalOwnerSessionV1>();
  const store: LocalOwnerSessionStoreV1 = {
    async load() { return [...rows.values()]; },
    async save(session) { rows.set(session.tokenDigest, { ...session }); },
    async revoke() { throw new Error("persistent_revoke_failed"); },
  };
  const service = new LocalOwnerSessionServiceV1(profile, store);
  const issued = await service.issue(request(undefined, { origin, "content-type": "application/json" },
    JSON.stringify({ ownerCode })), ownerCode, 1_000);
  const cookie = issued.cookie.split(";", 1)[0]!;
  await assert.rejects(service.revoke(request(undefined, { origin, cookie }), 2_000), /persistent_revoke_failed/u);
  assert.equal(service.verify(request("/api/v1/projects", { cookie }), 2_001).subject, profile.subject);
  const restarted = new LocalOwnerSessionServiceV1(profile, store, await store.load(2_001));
  assert.equal(restarted.verify(request("/api/v1/projects", { cookie }), 2_001).subject, profile.subject);
});
