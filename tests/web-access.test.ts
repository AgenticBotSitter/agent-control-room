import assert from "node:assert/strict";
import test from "node:test";
import { createAccessVerifier, requireSameOrigin, safeWebReturnPath } from "../src/web/v1/access-verifier.ts";
import { now, origin, trust, token, request } from "./helpers/web-foundation.ts";

test("Access signature yields only normalized human identity, without a strong effect approval", () => {
  const proof = createAccessVerifier(trust)(request(), now);
  assert.equal(proof.subject, "test-owner");
  assert.deepEqual(Object.keys(proof).sort(), ["expiresAt", "issuedAt", "provider", "subject", "tokenDigest", "verificationExpiresAt"]);
  assert.match(proof.tokenDigest, /^sha256:[a-f0-9]{64}$/);
});
test("only a current app assertion under configured signature and trust is accepted", () => {
  const verify = createAccessVerifier(trust);
  for (const changes of [{ iss: "https://other.invalid" }, { aud: ["other-app"] }, { exp: now / 1000 },
    { iat: now / 1000 + 1 }, { nbf: now / 1000 + 1 }, { sub: "" }, { type: "service" }])
    assert.throws(() => verify(request(undefined, undefined, undefined, undefined, token(changes)), now), /authentication_required/);
  assert.throws(() => verify(new Request(origin, { headers: { "oai-authenticated-user-id": "test-owner" } }), now), /authentication_required/);
  assert.throws(() => verify(request(), trust.validUntilMs), /authentication_required/);
});
test("remembered sessions are capped by token, trust freshness and seven-day policy", () => {
  const verify = createAccessVerifier({ ...trust, maxSessionSeconds: 120 });
  assert.equal(verify(request(), now).expiresAt, new Date(now + 60_000).toISOString());
  assert.throws(() => createAccessVerifier({ ...trust, maxSessionSeconds: 604801 }), /invalid_access_trust/);
  assert.throws(() => createAccessVerifier({ ...trust, keys: [...trust.keys, ...trust.keys] }), /invalid_access_trust/);
  const shortTrust = createAccessVerifier({ ...trust, validUntilMs: now + 1000 })(request(), now);
  assert.equal(shortTrust.verificationExpiresAt, new Date(now + 1000).toISOString());
  assert.equal(shortTrust.expiresAt, new Date(now + 300_000).toISOString());
});
test("mutations need the exact configured origin and return paths remain within the app", () => {
  requireSameOrigin(request(), origin);
  requireSameOrigin(request(undefined, "POST", {}), origin);
  assert.throws(() => requireSameOrigin(new Request(origin, { method: "POST" }), origin), /access_denied/);
  assert.throws(() => requireSameOrigin(new Request("https://other.invalid"), origin), /access_denied/);
  assert.equal(safeWebReturnPath("/projects?tab=work"), "/projects?tab=work");
  for (const path of ["https://elsewhere.invalid", "//elsewhere.invalid", "/\\elsewhere.invalid", "/cdn-cgi/access/logout", "/%2felsewhere.invalid"])
    assert.equal(safeWebReturnPath(path), "/projects");
});
