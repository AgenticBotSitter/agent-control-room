import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security";
import { LocalOwnerSessionServiceV1, LOCAL_OWNER_SESSION_PROFILE_V1, readLocalOwnerCodeV1 } from "../src/web/v1/local-owner-session";
import { WebAccessError } from "../src/web/v1/access-verifier";

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

test("local owner sign-in request accepts only a small exact JSON object", async () => {
  const valid = request(undefined, { "content-type": "application/json" }, JSON.stringify({ ownerCode }));
  assert.equal(await readLocalOwnerCodeV1(valid), ownerCode);
  for (const value of ["{}", JSON.stringify({ ownerCode, extra: true }), JSON.stringify({ ownerCode: 4 })]) {
    await assert.rejects(readLocalOwnerCodeV1(request(undefined, { "content-type": "application/json" }, value)),
      (error: unknown) => error instanceof WebAccessError && error.code === "invalid_request");
  }
});
