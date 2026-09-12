import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { trust, token, now } from "./helpers/web-foundation";

test("maintained JWT verifier preserves owner claims and rejects invalid policy", () => {
  const verify = createAccessVerifier(trust);
  const request = (jwt: string) => new Request("https://fixture.invalid", { headers: { "cf-access-jwt-assertion": jwt } });
  assert.equal(verify(request(token()), now).subject, "test-owner");
  for (const changes of [{ aud: ["wrong"] }, { iss: "https://wrong.invalid" },
    { exp: now / 1000 }, { nbf: now / 1000 + 1 }, { iat: now / 1000 + 1 }, { type: "wrong" }])
    assert.throws(() => verify(request(token(changes)), now), { message: "authentication_required" });
  const valid = token();
  assert.throws(() => verify(request(valid.slice(0, -5) + "AAAAA"), now), { message: "authentication_required" });
  assert.throws(() => verify(request(valid), trust.validUntilMs), { message: "authentication_required" });
});

test("session ceiling, trust snapshot and canonical token encoding remain enforced", () => {
  const input = { ...trust, maxSessionSeconds: 90 };
  const verify = createAccessVerifier(input);
  input.maxSessionSeconds = 604800;
  const request = (value: string) => new Request("https://fixture.invalid", { headers: { "cf-access-jwt-assertion": value } });
  const valid = token({ iat: now / 1000 - 60, exp: now / 1000 + 300 });
  assert.equal(verify(request(valid), now).expiresAt, new Date(now + 30000).toISOString());
  assert.throws(() => verify(request(valid), now + 30000), { message: "authentication_required" });
  assert.throws(() => verify(request(valid + "="), now), { message: "authentication_required" });
  const parts = valid.split(".");
  parts[0] = Buffer.from(JSON.stringify({ alg: "none", kid: "test-public-key" })).toString("base64url");
  assert.throws(() => verify(request(parts.join(".")), now), { message: "authentication_required" });
});

test("epoch zero uses the supplied clock rather than the machine clock", () => {
  const verify = createAccessVerifier({ ...trust, validUntilMs: 120000 });
  const signed = token({ iat: 0, exp: 60 });
  const request = new Request("https://fixture.invalid", { headers: { "cf-access-jwt-assertion": signed } });
  assert.equal(verify(request, 0).issuedAt, "1970-01-01T00:00:00.000Z");
  assert.throws(() => verify(request, 60000), { message: "authentication_required" });
});
