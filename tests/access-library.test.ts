import assert from "node:assert/strict";
import { test } from "node:test";
import { captureGatewayAssertionProviderProfileV1, createAccessVerifier,
  GATEWAY_ASSERTION_PROVIDER_PROFILE_SCHEMA_V1 } from "../src/web/v1/access-verifier";
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

const genericProfile = () => ({ schema: GATEWAY_ASSERTION_PROVIDER_PROFILE_SCHEMA_V1,
  profileId: "rs256_gateway_assertion" as const, algorithm: "RS256" as const,
  assertionHeader: "x-test-gateway-assertion", claimContract: "standard_gateway_subject" as const,
  subjectClaim: "sub" as const, audienceClaim: "aud" as const, issuerClaim: "iss" as const,
  mfaPolicy: "gateway_policy_external" as const });

test("a configured RS256 gateway profile maps only its exact assertion header and fixed claims", () => {
  const profile = genericProfile(), verify = createAccessVerifier(trust, profile);
  const signed = token({ type: undefined, amr: ["pwd", "mfa"], acr: "untrusted-by-control-room" });
  const configured = new Request("https://fixture.invalid", { headers: { [profile.assertionHeader]: signed } });
  const identity = verify(configured, now);
  assert.equal(identity.subject, "test-owner");
  assert.equal("mfa" in identity, false);
  assert.deepEqual(Object.keys(identity).sort(),
    ["expiresAt", "issuedAt", "provider", "subject", "tokenDigest", "verificationExpiresAt"]);
  for (const headers of [
    [["cf-access-jwt-assertion", signed]], [["authorization", `Bearer ${signed}`]],
    [[profile.assertionHeader, signed], ["cf-access-jwt-assertion", signed]],
  ] as Array<Array<[string, string]>>) assert.throws(() => verify(new Request("https://fixture.invalid", { headers }), now),
    { message: "authentication_required" });
  for (const changes of [{ aud: ["wrong"] }, { iss: "https://wrong.invalid" },
    { exp: now / 1000 }, { nbf: now / 1000 + 1 }, { iat: now / 1000 + 1 }])
    assert.throws(() => verify(new Request("https://fixture.invalid",
      { headers: { [profile.assertionHeader]: token({ type: undefined, ...changes }) } }), now), { message: "authentication_required" });
});

test("gateway assertion profiles are exact, isolated and cannot configure OIDC or MFA inference", () => {
  const input = genericProfile(), captured = captureGatewayAssertionProviderProfileV1(input);
  input.assertionHeader = "x-mutated-gateway-assertion";
  assert.equal(captured.assertionHeader, "x-test-gateway-assertion"); assert.equal(Object.isFrozen(captured), true);
  for (const invalid of [
    { ...genericProfile(), profileId: "oidc" },
    { ...genericProfile(), assertionHeader: "authorization" },
    { ...genericProfile(), assertionHeader: "cf-access-jwt-assertion" },
    { ...genericProfile(), assertionHeader: "x-forwarded-assertion" },
    { ...genericProfile(), mfaClaim: "amr" },
    { ...genericProfile(), discoveryUrl: "https://issuer.invalid/.well-known/openid-configuration" },
  ]) assert.throws(() => captureGatewayAssertionProviderProfileV1(invalid));
});
