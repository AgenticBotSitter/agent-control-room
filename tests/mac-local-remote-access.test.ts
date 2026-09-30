import assert from "node:assert/strict";
import test, { after } from "node:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { sha256Digest } from "../src/security";
import { createAccessKeyLoader } from "../src/web/v1/access-key-cache";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { captureLocalOwnerSessionProfileV1, LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";
import { captureMacLocalProtectedConfigurationV1, MAC_LOCAL_PROTECTED_CONFIGURATION_V1 } from "../src/web/v1/mac-local-protected-configuration";
import { admitTailscaleRequestV1, captureMacLocalRemoteAccessV1, createCloudflareAccessGateV1,
  createMacLocalRemoteOriginGatesV1, MAC_LOCAL_REMOTE_ACCESS_V1, RemoteAccessRefusedError,
  type MacLocalCloudflareAccessV1 } from "../src/web/v1/mac-local-remote-access";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { createMacLocalControlRoomServiceV1 } from "../src/web/v1/mac-local-serving";
import { createMacLocalNodeHandler, createPrivateNodeHandler } from "../src/web/v1/private-node-handler";
import { createPrivateOwnerBootstrapCommand } from "../src/web/v1/private-owner-bootstrap";
import { closePrivateOwnerBootstrapConformanceDatabase, conformanceNow, conformanceSubject,
  privateOwnerBootstrapFixture } from "./helpers/private-owner-bootstrap-conformance";
import { nodeExchange } from "./helpers/web-node";

after(closePrivateOwnerBootstrapConformanceDatabase);

// Synthetic, non-routable names only. Real hostnames are private configuration.
const loopback = "http://127.0.0.1:3210";
const tailnetOrigin = "https://control-room-mac.example-tailnet.ts.net";
const cloudflareOrigin = "https://private-app.example.invalid";
const teamDomain = "https://example-team.cloudflareaccess.com";
const audience = "a".repeat(64);
const owner = "owner@example.invalid";
const nowMs = Date.parse("2026-09-29T12:00:00.000Z");
const cloudflare: MacLocalCloudflareAccessV1 = Object.freeze({ origin: cloudflareOrigin, teamDomain, audience,
  ownerEmail: owner, maxSessionSeconds: 86_400 });

function signingKey(kid: string) {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: "jwk" }) as { kty: "RSA"; n: string; e: string };
  return Object.freeze({ kid, privateKey: pair.privateKey, published: Object.freeze({ kid, jwk: { ...jwk, alg: "RS256", use: "sig" } }) });
}
type Key = ReturnType<typeof signingKey>;

function token(key: { kid: string; privateKey: KeyObject }, claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {}, at = nowMs) {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...header })).toString("base64url");
  const c = Buffer.from(JSON.stringify({ aud: [audience], email: owner, exp: Math.floor(at / 1000) + 3600,
    iat: Math.floor(at / 1000) - 5, nbf: Math.floor(at / 1000) - 5, iss: teamDomain, type: "app",
    identity_nonce: "synthetic-nonce", sub: "00000000-0000-4000-8000-000000000001", country: "XX", ...claims })).toString("base64url");
  return `${h}.${c}.${sign("RSA-SHA256", Buffer.from(`${h}.${c}`), key.privateKey).toString("base64url")}`;
}

const keyA = signingKey("synthetic-key-a"), keyB = signingKey("synthetic-key-b"), stranger = signingKey("synthetic-key-a");

function gateWith(keySets: Key[][], clock: { now: number }, options: { unknownKeyRefreshMs?: number } = {}) {
  let loads = 0;
  const gate = createCloudflareAccessGateV1({ access: cloudflare, clock: () => clock.now, ...options,
    loadKeys: async () => { const set = keySets[Math.min(loads, keySets.length - 1)]!; loads += 1; return set.map(key => key.published); } });
  return { gate, loads: () => loads };
}

const headers = (value?: string, extra: Record<string, string> = {}) =>
  new Headers({ ...(value === undefined ? {} : { "cf-access-jwt-assertion": value }), ...extra });

async function refused(promise: Promise<unknown>, message: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof RemoteAccessRefusedError, message);
}

test("Cloudflare Access gate admits only a fully valid owner token", async () => {
  const clock = { now: nowMs };
  const { gate } = gateWith([[keyA]], clock);
  const admitted = await gate.admit(headers(token(keyA)));
  assert.equal(admitted.email, owner);
  assert.equal(admitted.expiresAt, new Date((Math.floor(nowMs / 1000) + 3600) * 1000).toISOString());
  // Email domains are case-insensitive; the signed claim may differ only in ASCII case.
  await gate.admit(headers(token(keyA, { email: "Owner@Example.INVALID" })));

  await refused(gate.admit(headers()), "missing header");
  await refused(gate.admit(headers("")), "empty header");
  await refused(gate.admit(headers(undefined, { "cf-access-authenticated-user-email": owner })),
    "the plain email header alone is never trusted");
  await refused(gate.admit(headers(token(keyA, { aud: ["b".repeat(64)] }))), "wrong aud");
  await refused(gate.admit(headers(token(keyA, { aud: [] }))), "empty aud");
  await refused(gate.admit(headers(token(keyA, { iss: "https://other-team.cloudflareaccess.com" }))), "wrong iss");
  await refused(gate.admit(headers(token(keyA, { email: "someone@example.invalid" }))), "wrong email");
  await refused(gate.admit(headers(token(keyA, { email: "owner@example.invalid.attacker.test" }))), "suffix email");
  await refused(gate.admit(headers(token(keyA, { email: undefined }))), "missing email (service token)");
  await refused(gate.admit(headers(token(keyA, { type: "org" }))), "not an application token");
  await refused(gate.admit(headers(token(keyA, { exp: Math.floor(nowMs / 1000) - 1 }))), "expired");
  await refused(gate.admit(headers(token(keyA, { exp: Math.floor(nowMs / 1000) }))), "expires now");
  // Up to 60 s of Mac clock lag behind Cloudflare is tolerated for iat and nbf, never for exp.
  await gate.admit(headers(token(keyA, { iat: Math.floor(nowMs / 1000) + 30, nbf: Math.floor(nowMs / 1000) + 30 })));
  await gate.admit(headers(token(keyA, { iat: Math.floor(nowMs / 1000) + 60, nbf: Math.floor(nowMs / 1000) + 60 })));
  await refused(gate.admit(headers(token(keyA, { nbf: Math.floor(nowMs / 1000) + 61 }))), "not yet valid");
  await refused(gate.admit(headers(token(keyA, { iat: Math.floor(nowMs / 1000) + 61 }))), "issued in the future");
  await refused(gate.admit(headers(token(keyA, { iat: Math.floor(nowMs / 1000) - 86_401, exp: Math.floor(nowMs / 1000) + 60 }))),
    "older than the session ceiling");
  await refused(gate.admit(headers(token(stranger))), "bad signature under a known key id");
  const valid = token(keyA), [h, c, s] = valid.split(".");
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(c!, "base64url").toString()), email: "x@example.invalid" }))
    .toString("base64url");
  await refused(gate.admit(headers(`${h}.${forged}.${s}`)), "payload swapped under a valid signature");
  await refused(gate.admit(headers(`${h}.${c}.`)), "empty signature");
  await refused(gate.admit(headers(token(keyA, {}, { alg: "none" }))), "alg none");
  await refused(gate.admit(headers(token(keyA, {}, { alg: "HS256" }))), "alg HS256");
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "none", kid: keyA.kid })).toString("base64url")}.${c}.`;
  await refused(gate.admit(headers(unsigned)), "unsigned token");
  await refused(gate.admit(headers("not-a-token")), "garbage");
  gate.close();
  await refused(gate.admit(headers(token(keyA))), "closed gate");
});

test("the clock tolerance is opt-in and bounded to 60 seconds", () => {
  const trust = { issuer: teamDomain, audience, validUntilMs: nowMs + 3_600_000, maxSessionSeconds: 3600, keys: [keyA.published] };
  const early = new Request(cloudflareOrigin, { headers: { "cf-access-jwt-assertion": token(keyA, { iat: Math.floor(nowMs / 1000) + 30 }) } });
  assert.throws(() => createAccessVerifier(trust)(early, nowMs), "no tolerance by default (the hosted verifier is unchanged)");
  assert.equal(createAccessVerifier(trust, undefined, { clockToleranceSeconds: 60 })(early, nowMs).subject.length > 0, true);
  for (const clockToleranceSeconds of [-1, 61, 1.5]) assert.throws(() => createAccessVerifier(trust, undefined, { clockToleranceSeconds }),
    /invalid_access_trust/, String(clockToleranceSeconds));
});

test("Cloudflare Access gate refuses a non-ASCII email that case-folds onto the owner", async () => {
  const kim = createCloudflareAccessGateV1({ access: { ...cloudflare, ownerEmail: "kim@example.invalid" },
    clock: () => nowMs, loadKeys: async () => [keyA.published] });
  await kim.admit(headers(token(keyA, { email: "KIM@example.invalid" })));
  // U+212A KELVIN SIGN lower-cases to ASCII "k".
  assert.equal("\u212Aim@example.invalid".toLowerCase(), "kim@example.invalid");
  await refused(kim.admit(headers(token(keyA, { email: "\u212Aim@example.invalid" }))), "Kelvin sign");
});

test("Cloudflare Access gate follows key rotation and bounds unknown-key refreshes", async () => {
  const clock = { now: nowMs };
  // Load 1: only A. Load 2 (rotation): A and B. Load 3: B only (A retired).
  const { gate, loads } = gateWith([[keyA], [keyA, keyB], [keyB]], clock);
  await gate.admit(headers(token(keyA)));
  assert.equal(loads(), 1);
  await gate.admit(headers(token(keyA)));
  assert.equal(loads(), 1, "the key set is cached");
  await gate.admit(headers(token(keyB)));
  assert.equal(loads(), 2, "a token from the newly rotated key forces one refresh");
  const unknown = signingKey("synthetic-key-c");
  clock.now += 1_000;
  await refused(gate.admit(headers(token(unknown, {}, {}, clock.now))), "unknown key");
  assert.equal(loads(), 2, "a second unknown key id inside the refresh window never fetches");
  clock.now += 301_000;
  await gate.admit(headers(token(keyB, {}, {}, clock.now)));
  assert.equal(loads(), 3, "the cache refreshes on its own after the freshness window");
  await refused(gate.admit(headers(token(keyA, {}, {}, clock.now))), "a retired key is refused");
});

test("Cloudflare Access gate refuses when the team keys cannot be loaded", async () => {
  const clock = { now: nowMs };
  const gate = createCloudflareAccessGateV1({ access: cloudflare, clock: () => clock.now,
    loadKeys: async () => { throw new Error("offline"); } });
  await refused(gate.admit(headers(token(keyA))), "no keys, no admission");
  const wrongShape = createCloudflareAccessGateV1({ access: cloudflare, clock: () => clock.now,
    loadKeys: async () => [{ kid: "short", jwk: { ...generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "jwk" }) } }] });
  await refused(wrongShape.admit(headers(token(keyA))), "a weak published key is refused");
});

test("the production key loader contacts only the configured team certs URL", async () => {
  const requested: string[] = [];
  const loader = createAccessKeyLoader(teamDomain, (async (url: string, init: RequestInit) => {
    requested.push(url); assert.equal(init.redirect, "error"); assert.equal(init.credentials, "omit");
    return new Response(JSON.stringify({ keys: [keyA.published.jwk && { kid: keyA.kid, ...keyA.published.jwk }],
      public_cert: { kid: keyA.kid, cert: "synthetic" } }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch);
  const keys = await loader(new AbortController().signal);
  assert.deepEqual(requested, [`${teamDomain}/cdn-cgi/access/certs`]);
  assert.equal(keys[0]?.kid, keyA.kid);
});

test("remote access configuration is exact, private-name free and refuses unsafe values", () => {
  const good = { schema: MAC_LOCAL_REMOTE_ACCESS_V1, tailscale: { origin: tailnetOrigin, ownerLogin: owner },
    cloudflare: { origin: cloudflareOrigin, teamDomain, audience, ownerEmail: owner } };
  const captured = captureMacLocalRemoteAccessV1(good, loopback);
  assert.deepEqual(captured, { tailscale: { origin: tailnetOrigin, ownerLogin: owner },
    cloudflare: { origin: cloudflareOrigin, teamDomain, audience, ownerEmail: owner, maxSessionSeconds: 86_400 } });
  assert.deepEqual(captureMacLocalRemoteAccessV1(undefined, loopback, tailnetOrigin), { tailscale: { origin: tailnetOrigin } },
    "the legacy trusted origin is the Tailscale path");
  const bad: [string, unknown][] = [
    ["http origin", { ...good, cloudflare: { ...good.cloudflare, origin: "http://private-app.example.invalid" } }],
    ["path", { ...good, cloudflare: { ...good.cloudflare, origin: `${cloudflareOrigin}/app` } }],
    ["port", { ...good, cloudflare: { ...good.cloudflare, origin: "https://private-app.example.invalid:8443" } }],
    ["wildcard", { ...good, cloudflare: { ...good.cloudflare, origin: "https://*.example.invalid" } }],
    ["ip", { ...good, cloudflare: { ...good.cloudflare, origin: "https://203.0.113.9" } }],
    ["credentials", { ...good, cloudflare: { ...good.cloudflare, origin: "https://u:p@private-app.example.invalid" } }],
    ["tailnet name on the Cloudflare path", { ...good, cloudflare: { ...good.cloudflare, origin: tailnetOrigin } }],
    ["non-tailnet Tailscale origin", { ...good, tailscale: { origin: "https://public-proxy.example.invalid" } }],
    ["uppercase Tailscale login", { ...good, tailscale: { origin: tailnetOrigin, ownerLogin: "Name@github" } }],
    ["Tailscale login without a domain", { ...good, tailscale: { origin: tailnetOrigin, ownerLogin: "name@" } }],
    ["Tailscale login with spaces", { ...good, tailscale: { origin: tailnetOrigin, ownerLogin: "na me@github" } }],
    ["team domain elsewhere", { ...good, cloudflare: { ...good.cloudflare, teamDomain: "https://keys.example.invalid" } }],
    ["team domain with path", { ...good, cloudflare: { ...good.cloudflare, teamDomain: `${teamDomain}/x` } }],
    ["short aud", { ...good, cloudflare: { ...good.cloudflare, audience: "abc" } }],
    ["uppercase aud", { ...good, cloudflare: { ...good.cloudflare, audience: "A".repeat(64) } }],
    ["uppercase owner", { ...good, cloudflare: { ...good.cloudflare, ownerEmail: "Owner@example.invalid" } }],
    ["no owner", { ...good, cloudflare: { ...good.cloudflare, ownerEmail: undefined } }],
    ["long ceiling", { ...good, cloudflare: { ...good.cloudflare, maxSessionSeconds: 8 * 86_400 } }],
    ["extra field", { ...good, cloudflare: { ...good.cloudflare, trustEmailHeader: true } }],
    ["wrong schema", { ...good, schema: "other" }],
    ["empty", { schema: MAC_LOCAL_REMOTE_ACCESS_V1 }],
  ];
  for (const [name, value] of bad) assert.throws(() => captureMacLocalRemoteAccessV1(value, loopback), /mac_local_remote_access_invalid/, name);
  assert.throws(() => captureMacLocalRemoteAccessV1(good, loopback, tailnetOrigin), /mac_local_remote_access_invalid/,
    "legacy and new Tailscale origins together are ambiguous");
  // The legacy origin becomes the Tailscale gate, so it must pass the same tailnet rule.
  for (const legacy of ["https://public-proxy.example.invalid", "https://example.ts.net.attacker.invalid"])
    assert.throws(() => captureMacLocalRemoteAccessV1(undefined, loopback, legacy), /mac_local_remote_access_invalid/, legacy);
  assert.throws(() => captureMacLocalRemoteAccessV1({ schema: MAC_LOCAL_REMOTE_ACCESS_V1, cloudflare: good.cloudflare }, loopback,
    "https://public-proxy.example.invalid"), /mac_local_remote_access_invalid/, "legacy non-tailnet beside Cloudflare");
  // Tailscale logins for GitHub and passkey identities have no dot in the domain.
  for (const ownerLogin of ["name@github", "name@passkey", "first.last+tag@example.invalid"])
    assert.equal(captureMacLocalRemoteAccessV1({ ...good, tailscale: { origin: tailnetOrigin, ownerLogin } }, loopback).tailscale?.ownerLogin,
      ownerLogin);
  assert.throws(() => captureMacLocalRemoteAccessV1({ ...good, tailscale: undefined,
    cloudflare: { ...good.cloudflare, origin: "https://same.example.ts.net" } }, loopback), /mac_local_remote_access_invalid/);
});

const protectedBase = () => ({ schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: 3210, workspaceId: "workspace:local",
  localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: loopback, tenantId: "tenant:local", provider: "local-owner",
    subject: "owner:local", ownerCodeDigest: sha256Digest({ ownerCode: "x".repeat(24) }), sessionSeconds: 900 },
  database: { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_web",
    password: "synthetic-password-never-output", majorVersion: 17 },
  enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1", workers: [{ workerId: "worker:codex",
    kind: "codex", executablePath: "/Applications/Codex.app/Contents/MacOS/codex", recordedVersion: "codex test" }] } });

test("protected configuration derives the session origins from remoteAccess and nothing else", () => {
  const base = protectedBase();
  const plain = captureMacLocalProtectedConfigurationV1(base);
  assert.equal(plain.remoteAccess, undefined, "loopback only by default");
  assert.equal(plain.localOwnerSession.remoteOrigins, undefined);
  const withRemote = captureMacLocalProtectedConfigurationV1({ ...base, remoteAccess: { schema: MAC_LOCAL_REMOTE_ACCESS_V1,
    tailscale: { origin: tailnetOrigin }, cloudflare: { origin: cloudflareOrigin, teamDomain, audience, ownerEmail: owner } } });
  assert.deepEqual(withRemote.localOwnerSession.remoteOrigins, [tailnetOrigin, cloudflareOrigin]);
  assert.throws(() => captureMacLocalProtectedConfigurationV1({ ...base, localOwnerSession: { ...base.localOwnerSession,
    trustedOrigin: "https://public-proxy.example.invalid" } }), /mac_local_protected_configuration_invalid/,
  "a legacy origin that is not a tailnet address is refused, not treated as Tailscale");
  const legacy = captureMacLocalProtectedConfigurationV1({ ...base, localOwnerSession: { ...base.localOwnerSession, trustedOrigin: tailnetOrigin } });
  assert.deepEqual(legacy.remoteAccess, { tailscale: { origin: tailnetOrigin } });
  assert.equal(legacy.localOwnerSession.trustedOrigin, undefined);
  assert.deepEqual(legacy.localOwnerSession.remoteOrigins, [tailnetOrigin]);
  assert.throws(() => captureMacLocalProtectedConfigurationV1({ ...base,
    localOwnerSession: { ...base.localOwnerSession, remoteOrigins: [cloudflareOrigin] } }), /mac_local_protected_configuration_invalid/,
  "a session origin cannot be added without its gate");
});

test("Tailscale owner login check, when configured, needs the exact Serve identity header", () => {
  admitTailscaleRequestV1({ origin: tailnetOrigin }, new Headers());
  admitTailscaleRequestV1({ origin: tailnetOrigin, ownerLogin: owner }, new Headers({ "tailscale-user-login": owner }));
  for (const value of [undefined, "", "other@example.invalid", `${owner}.attacker.test`])
    assert.throws(() => admitTailscaleRequestV1({ origin: tailnetOrigin, ownerLogin: owner },
      new Headers(value === undefined ? {} : { "tailscale-user-login": value })), RemoteAccessRefusedError);
  admitTailscaleRequestV1({ origin: tailnetOrigin, ownerLogin: "name@github" }, new Headers({ "tailscale-user-login": "Name@GitHub" }));
  // Defence in depth below the HTTP layer: a non-ASCII login must not case-fold onto the owner.
  assert.equal("\u212Aim@example.invalid".toLowerCase(), "kim@example.invalid");
  assert.throws(() => admitTailscaleRequestV1({ origin: tailnetOrigin, ownerLogin: "kim@example.invalid" },
    { get: (name: string) => name === "tailscale-user-login" ? "\u212Aim@example.invalid" : null, has: () => false } as unknown as Headers),
  RemoteAccessRefusedError, "Kelvin sign");
});

test("Tailscale Funnel traffic is always refused on the Tailscale origin", () => {
  for (const access of [{ origin: tailnetOrigin }, { origin: tailnetOrigin, ownerLogin: owner }])
    assert.throws(() => admitTailscaleRequestV1(access, new Headers({ "tailscale-funnel-request": "?1", "tailscale-user-login": owner })),
      RemoteAccessRefusedError, JSON.stringify(access));
});

async function exchange(handler: ReturnType<typeof createMacLocalNodeHandler>, host: string,
  options: { path?: string; method?: string; headers?: string[]; body?: string } = {}) {
  const ex = nodeExchange(options); ex.input.rawHeaders[1] = host;
  const done = new Promise<void>((resolve, reject) => { ex.output.once("finish", resolve); ex.output.once("error", reject); });
  void handler.handle(ex.input, ex.output); await done;
  return { status: ex.output.statusCode, headers: ex.headers, body: ex.body() };
}

const assets = (served: string[]) => ({ count: 1, digest: "synthetic", respond: (path: string) => {
  served.push(path); return new Response("asset"); } });

test("with no remote path configured the transport is exactly loopback-only", async () => {
  const seen: Request[] = [], served: string[] = [];
  const handler = createMacLocalNodeHandler({ origin: loopback, application: { isReady: () => true, close: async () => {} },
    handler: async request => { seen.push(request); return new Response("ok"); }, assets: assets(served) });
  assert.equal((await exchange(handler, "127.0.0.1:3210")).status, 200);
  for (const host of [new URL(tailnetOrigin).host, new URL(cloudflareOrigin).host, "localhost:3210"])
    assert.equal((await exchange(handler, host, { headers: ["Cf-Access-Jwt-Assertion", token(keyA)] })).status, 403, host);
  for (const header of ["X-Forwarded-For", "X-Forwarded-Proto", "X-Forwarded-Host", "Forwarded"])
    assert.equal((await exchange(handler, "127.0.0.1:3210", { headers: [header, "x"] })).status, 403, header);
  assert.equal((await exchange(handler, "127.0.0.1:3210", { headers: ["Origin", cloudflareOrigin] })).status, 403);
  assert.equal(seen.length, 1);
  assert.throws(() => createMacLocalNodeHandler({ origin: loopback, application: { isReady: () => true, close: async () => {} },
    handler: async () => new Response("ok"), assets: assets([]),
    remoteOrigins: [{ origin: "http://private-app.example.invalid", admit: () => {} }] }), /mac_local_serving_config_invalid/);
  assert.throws(() => createMacLocalNodeHandler({ origin: loopback, application: { isReady: () => true, close: async () => {} },
    handler: async () => new Response("ok"), assets: assets([]), secondaryOrigin: tailnetOrigin,
    remoteOrigins: [{ origin: tailnetOrigin, admit: () => {} }] }), /mac_local_serving_config_invalid/);
  assert.throws(() => createMacLocalNodeHandler({ origin: loopback, application: { isReady: () => true, close: async () => {} },
    handler: async () => new Response("ok"), assets: assets([]), remoteOrigins: [tailnetOrigin, cloudflareOrigin,
      "https://third.example.invalid"].map(origin => ({ origin, admit: () => {} })) }), /mac_local_serving_config_invalid/,
  "at most two remote paths");
  assert.throws(() => createPrivateNodeHandler({ origin: "https://hosted.example.invalid",
    application: { isReady: () => true, close: async () => {} }, handler: async () => new Response("ok"), assets: assets([]),
    remoteOrigins: [{ origin: cloudflareOrigin, admit: () => {} }] }), /private_serving_config_invalid/,
  "only the Mac-local transport accepts remote-origin gates");
});

test("remote origins pass only their gate, and proxy headers are checked but never relayed", async () => {
  const clock = { now: nowMs };
  const remote = createMacLocalRemoteOriginGatesV1(captureMacLocalRemoteAccessV1({ schema: MAC_LOCAL_REMOTE_ACCESS_V1,
    tailscale: { origin: tailnetOrigin, ownerLogin: owner }, cloudflare: { origin: cloudflareOrigin, teamDomain, audience, ownerEmail: owner } },
  loopback), { clock: () => clock.now, loadKeys: async () => [keyA.published] });
  const seen: Request[] = [], served: string[] = [];
  const handler = createMacLocalNodeHandler({ origin: loopback, application: { isReady: () => true, close: async () => {} },
    handler: async request => { seen.push(request); return new Response("ok"); }, assets: assets(served), remoteOrigins: remote.gates });
  const cfHost = new URL(cloudflareOrigin).host, tsHost = new URL(tailnetOrigin).host;
  const cloudflared = ["X-Forwarded-For", "198.51.100.7", "X-Forwarded-Proto", "https", "Cf-Connecting-Ip", "198.51.100.7",
    "Cf-Access-Authenticated-User-Email", owner];

  // Direct-origin or misrouted requests without a valid token are denied, static files included.
  for (const path of ["/projects", "/session", "/_next/static/app.js", "/api/v1/local-owner-session"])
    assert.equal((await exchange(handler, cfHost, { path, headers: cloudflared })).status, 403, path);
  assert.equal((await exchange(handler, cfHost, { headers: [...cloudflared, "Cf-Access-Jwt-Assertion", token(keyA, { email: "x@example.invalid" })] })).status, 403);
  assert.equal((await exchange(handler, cfHost, { headers: [...cloudflared, "Cf-Access-Jwt-Assertion", token(keyA, { aud: ["b".repeat(64)] })] })).status, 403);
  assert.equal(seen.length, 0); assert.deepEqual(served, []);

  const good = await exchange(handler, cfHost, { headers: [...cloudflared, "Cf-Access-Jwt-Assertion", token(keyA)] });
  assert.equal(good.status, 200);
  assert.equal(new URL(seen[0]!.url).origin, cloudflareOrigin);
  for (const name of ["x-forwarded-for", "x-forwarded-proto", "cf-connecting-ip", "cf-access-authenticated-user-email", "tailscale-user-login"])
    assert.equal(seen[0]!.headers.has(name), false, `${name} is not relayed`);
  assert.equal((await exchange(handler, cfHost, { path: "/_next/static/app.js",
    headers: ["Cf-Access-Jwt-Assertion", token(keyA)] })).status, 200);
  assert.deepEqual(served, ["/_next/static/app.js"]);

  const serve = ["X-Forwarded-For", "100.64.0.9", "X-Forwarded-Proto", "https", "X-Forwarded-Host", tsHost, "Tailscale-User-Login", owner];
  assert.equal((await exchange(handler, tsHost, { headers: serve })).status, 200);
  assert.equal((await exchange(handler, tsHost, { headers: serve.map(v => v === owner ? "someone@example.invalid" : v) })).status, 403);
  assert.equal((await exchange(handler, tsHost, { headers: serve.slice(0, 6) })).status, 403, "no Serve identity header");
  assert.equal((await exchange(handler, tsHost, { headers: [...serve.slice(0, 2), "X-Forwarded-Proto", "http", ...serve.slice(4)] })).status, 403);
  assert.equal((await exchange(handler, tsHost, { headers: [...serve.slice(0, 4), "X-Forwarded-Host", "evil.example.invalid", ...serve.slice(6)] })).status, 403);
  assert.equal((await exchange(handler, tsHost, { headers: [...serve, "X-Forwarded-Prefix", "/x"] })).status, 403);
  assert.equal((await exchange(handler, tsHost, { headers: [...serve, "Forwarded", "for=1.2.3.4"] })).status, 403);
  assert.equal((await exchange(handler, tsHost, { headers: [...serve, "Origin", cloudflareOrigin] })).status, 403, "cross-origin write source");
  assert.equal((await exchange(handler, "127.0.0.1:3210", { headers: ["X-Forwarded-For", "127.0.0.1"] })).status, 403,
    "loopback still refuses proxy headers");
  assert.equal((await exchange(handler, "127.0.0.1:3210", { headers: ["Cf-Access-Jwt-Assertion", "garbage"] })).status, 200,
    "loopback ignores the Access header; the owner session still applies");
  remote.close();
});

const navigation = (site = "cross-site", dest = "document", mode = "navigate") =>
  ["Sec-Fetch-Site", site, "Sec-Fetch-Mode", mode, "Sec-Fetch-Dest", dest];
const continuePage = (next: string) => new RegExp(`<meta http-equiv="refresh" content="0;url='${next.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}'">`
  + `[\\s\\S]*<a href="${next.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}">Continue to Control Room</a>`);

test("after a Cloudflare login the cross-site page navigation continues on the same origin; nothing else crosses sites", async () => {
  const clock = { now: nowMs };
  const remote = createMacLocalRemoteOriginGatesV1(captureMacLocalRemoteAccessV1({ schema: MAC_LOCAL_REMOTE_ACCESS_V1,
    cloudflare: { origin: cloudflareOrigin, teamDomain, audience, ownerEmail: owner } }, loopback),
  { clock: () => clock.now, loadKeys: async () => [keyA.published] });
  const seen: Request[] = [], served: string[] = [];
  const handler = createMacLocalNodeHandler({ origin: loopback, application: { isReady: () => true, close: async () => {} },
    handler: async request => { seen.push(request); return new Response("ok"); }, assets: assets(served), remoteOrigins: remote.gates });
  const cfHost = new URL(cloudflareOrigin).host;
  const jwt = () => ["Cf-Access-Jwt-Assertion", token(keyA, {}, {}, clock.now)];

  // Cloudflare's redirect back from the team domain: valid token, cross-site top-level page navigation.
  for (const path of ["/", "/projects", "/session", "/sign-out"]) {
    const landed = await exchange(handler, cfHost, { path, headers: [...jwt(), ...navigation(), "Sec-Fetch-User", "?1"] });
    assert.equal(landed.status, 200, path);
    assert.match(landed.body, continuePage(path), path);
    assert.equal(landed.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(landed.headers.get("cache-control"), "no-store");
    assert.match(landed.headers.get("content-security-policy") ?? "", /default-src 'none'.*frame-ancestors 'none'/u);
    assert.equal(landed.headers.has("set-cookie"), false);
  }
  const quoted = await exchange(handler, cfHost, { path: "/projects/it's&more?x=1&y=2", headers: [...jwt(), ...navigation()] });
  assert.match(quoted.body, continuePage("/projects/it%27s&amp;more?x=1&amp;y=2"), "the path cannot break out of the refresh URL");
  const head = await exchange(handler, cfHost, { method: "HEAD", headers: [...jwt(), ...navigation()] });
  assert.equal(head.status, 200); assert.equal(head.body, "");
  assert.equal(seen.length, 0, "the application never runs for the continue page");
  assert.deepEqual(served, []);

  // The follow-up navigation starts on this origin and reaches the application normally.
  const followed = await exchange(handler, cfHost, { path: "/projects", headers: [...jwt(), ...navigation("same-origin")] });
  assert.equal(followed.status, 200); assert.equal(followed.body, "ok");
  assert.equal(seen.length, 1);

  // Still refused cross-site: no or bad token, writes, subresources, frames, API calls and static files.
  const stillRefused: [string, { path?: string; method?: string; headers: string[]; body?: string }][] = [
    ["no Access token", { headers: navigation() }],
    ["another person's token", { headers: [...navigation(), "Cf-Access-Jwt-Assertion", token(keyA, { email: "x@example.invalid" })] }],
    ["cross-site form post", { method: "POST", body: "a=1", headers: [...jwt(), ...navigation(),
      "Content-Type", "application/x-www-form-urlencoded", "Content-Length", "3"] }],
    ["cross-site delete", { method: "DELETE", path: "/api/v1/local-owner-session", headers: [...jwt(), ...navigation()] }],
    ["subresource", { headers: [...jwt(), ...navigation("cross-site", "script", "no-cors")] }],
    ["document fetched without navigating", { headers: [...jwt(), ...navigation("cross-site", "document", "no-cors")] }],
    ["frame", { headers: [...jwt(), ...navigation("cross-site", "iframe")] }],
    ["API fetch", { path: "/api/v1/projects", headers: [...jwt(), ...navigation("cross-site", "empty", "cors")] }],
    ["API navigation", { path: "/api/v1/projects", headers: [...jwt(), ...navigation()] }],
    ["static file navigation", { path: "/_next/static/app.js", headers: [...jwt(), ...navigation()] }],
    ["no fetch mode or destination", { headers: [...jwt(), "Sec-Fetch-Site", "cross-site"] }],
  ];
  for (const [name, options] of stillRefused) {
    const refusedResponse = await exchange(handler, cfHost, options);
    assert.equal(refusedResponse.status, 403, name);
    assert.doesNotMatch(refusedResponse.body, /Continue to Control Room/u, name);
  }
  // The loopback origin has no gate, so it keeps refusing every cross-site request.
  assert.equal((await exchange(handler, "127.0.0.1:3210", { headers: navigation() })).status, 403, "loopback");
  assert.equal(seen.length, 1); assert.deepEqual(served, []);
  remote.close();
});

test("each remote path keeps the owner session, CSRF, sign-out, expiry and revocation", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "mac-local-remote" }); t.after(fixture.close);
  await createPrivateOwnerBootstrapCommand({ openDatabase: fixture.openDatabase(), clock: () => conformanceNow })({
    configuration: fixture.configuration, database: fixture.database, trust: fixture.trust, assertion: fixture.assertion,
  });
  const clock = { now: conformanceNow };
  const ownerCode = "mac-local-remote-owner-code-long-enough";
  const remoteAccess = captureMacLocalRemoteAccessV1({ schema: MAC_LOCAL_REMOTE_ACCESS_V1, tailscale: { origin: tailnetOrigin },
    cloudflare: { origin: cloudflareOrigin, teamDomain, audience, ownerEmail: owner } }, loopback);
  const localOwnerSession = { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: loopback, tenantId: fixture.configuration.tenantId,
    provider: fixture.trust.issuer, subject: conformanceSubject, ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900,
    remoteOrigins: [tailnetOrigin, cloudflareOrigin] } as const;
  const app = createMacLocalWebProcessV1({ origin: loopback, workspaceId: fixture.configuration.workspaceId, localOwnerSession,
    cloudflareAccessOrigin: cloudflareOrigin,
    database: { client: fixture.client, close: async () => {}, isAvailable: () => true }, clock: () => clock.now });
  const gates = createMacLocalRemoteOriginGatesV1(remoteAccess, { clock: () => clock.now, loadKeys: async () => [keyA.published] });
  const handler = createMacLocalNodeHandler({ origin: loopback, application: { isReady: () => true, close: async () => {} },
    handler: request => app.handle(request, () => new Response("page")), assets: assets([]), remoteOrigins: gates.gates });
  const jwt = () => ["Cf-Access-Jwt-Assertion", token(keyA, {}, {}, clock.now)];
  const paths = [
    { name: "Cloudflare", origin: cloudflareOrigin, extra: jwt },
    { name: "Tailscale", origin: tailnetOrigin, extra: () => ["X-Forwarded-Proto", "https"] },
  ];
  for (const path of paths) {
    const host = new URL(path.origin).host;
    const go = (options: { path?: string; method?: string; headers?: string[]; body?: string }) =>
      exchange(handler, host, { ...options, headers: [...(options.headers ?? []), ...path.extra()] });
    const signedOut = await go({ path: "/projects" });
    assert.equal(signedOut.status, 303, path.name); assert.equal(signedOut.headers.get("location"), `${path.origin}/session`);
    // Arriving from another site (the Cloudflare login page) continues to the sign-in page on this origin.
    assert.match((await go({ path: "/session", headers: navigation() })).body, continuePage("/session"), path.name);
    const signInPage = await go({ path: "/session", headers: navigation("same-origin") });
    assert.equal(signInPage.status, 200, path.name); assert.match(signInPage.body, /Enter the local owner code/u);
    const body = JSON.stringify({ ownerCode });
    const crossSite = await go({ path: "/api/v1/local-owner-session", method: "POST", body,
      headers: ["Origin", loopback, "Content-Type", "application/json", "Content-Length", String(body.length)] });
    assert.equal(crossSite.status, 403, `${path.name}: sign-in from another origin is refused`);
    const signedIn = await go({ path: "/api/v1/local-owner-session", method: "POST", body,
      headers: ["Origin", path.origin, "Sec-Fetch-Site", "same-origin", "Content-Type", "application/json", "Content-Length", String(body.length)] });
    assert.equal(signedIn.status, 201, `${path.name}: ${signedIn.body}`);
    const setCookie = signedIn.headers.get("set-cookie")!;
    assert.match(setCookie, /HttpOnly; SameSite=Strict; Path=\/; Max-Age=900; Secure$/);
    const cookie = setCookie.split(";", 1)[0]!;
    assert.equal((await go({ path: "/api/v1/projects", headers: ["Cookie", cookie] })).status, 200, path.name);
    // A later Access re-login: the cross-site navigation carries no Strict cookie and gets the
    // continue page; the same-origin follow-up carries the cookie and opens the page.
    const relogin = await go({ path: "/projects", headers: navigation() });
    assert.equal(relogin.status, 200, path.name); assert.match(relogin.body, continuePage("/projects"));
    const opened = await go({ path: "/projects", headers: ["Cookie", cookie, ...navigation("same-origin")] });
    assert.equal(opened.status, 200, path.name); assert.equal(opened.body, "page", path.name);
    const write = JSON.stringify({ title: `${path.name} project`, summary: "Remote write proof" });
    assert.equal((await go({ path: "/api/v1/projects", method: "POST", body: write, headers: ["Cookie", cookie,
      "Origin", path.origin, "Content-Type", "application/json", "Idempotency-Key", `remote-write-${path.name.toLowerCase()}-0001`,
      "Content-Length", String(write.length)] })).status, 201, `${path.name}: same-origin write`);
    assert.equal((await go({ path: "/api/v1/projects", method: "POST", body: write, headers: ["Cookie", cookie,
      "Content-Type", "application/json", "Idempotency-Key", `remote-write-${path.name.toLowerCase()}-0002`,
      "Content-Length", String(write.length), "Sec-Fetch-Site", "cross-site"] })).status, 403, `${path.name}: cross-site write`);
    const signOutPage = await go({ path: "/sign-out" });
    assert.equal(signOutPage.status, 200);
    for (const [name, value] of [["sec-fetch-site", "cross-site"], ["x-forwarded-for", "198.51.100.7"]])
      assert.equal((await app.handle(new Request(`${path.origin}/sign-out`, { headers: { [name]: value } }), () => new Response("page"))).status,
        403, `${path.name}: the sign-out page is refused for ${name}`);
    assert.match(signOutPage.body, path.name === "Cloudflare" ? /"\/cdn-cgi\/access\/logout"/ : /location\.assign\("\/session"\)/);
    assert.equal((await go({ path: "/api/v1/local-owner-session", method: "DELETE", headers: ["Cookie", cookie, "Origin", path.origin] })).status, 204);
    assert.equal((await go({ path: "/api/v1/projects", headers: ["Cookie", cookie] })).status, 401, `${path.name}: revoked session`);
    // Expiry: a fresh session stops working at its expiry time.
    const again = await go({ path: "/api/v1/local-owner-session", method: "POST", body,
      headers: ["Origin", path.origin, "Content-Type", "application/json", "Content-Length", String(body.length)] });
    const second = again.headers.get("set-cookie")!.split(";", 1)[0]!;
    const start = clock.now;
    clock.now = start + 899_000;
    assert.equal((await go({ path: "/api/v1/projects", headers: ["Cookie", second] })).status, 200);
    clock.now = start + 900_000;
    assert.equal((await go({ path: "/api/v1/projects", headers: ["Cookie", second] })).status, 401, `${path.name}: expired session`);
    clock.now = start + 901_000;
  }
  // A valid Control Room session is not enough on the Cloudflare path: an expired Access token is refused first.
  const body = JSON.stringify({ ownerCode });
  const host = new URL(cloudflareOrigin).host;
  const signedIn = await exchange(handler, host, { path: "/api/v1/local-owner-session", method: "POST", body,
    headers: [...jwt(), "Origin", cloudflareOrigin, "Content-Type", "application/json", "Content-Length", String(body.length)] });
  assert.equal(signedIn.status, 201, signedIn.body);
  const cookie = signedIn.headers.get("set-cookie")!.split(";", 1)[0]!;
  const oldToken = token(keyA, {}, {}, clock.now);
  clock.now += 3_600_000;
  assert.equal((await exchange(handler, host, { path: "/api/v1/projects", headers: ["Cookie", cookie, "Cf-Access-Jwt-Assertion", oldToken] })).status, 403);
  assert.equal((await exchange(handler, host, { path: "/api/v1/projects", headers: ["Cookie", cookie] })).status, 403,
    "a session cookie without an Access token is refused");
  gates.close();
  await app.close();
});

test("the service composition refuses session origins without matching gates", () => {
  const base = { origin: loopback, port: 3210, workspaceId: "workspace:x",
    database: { client: {} as never, close: async () => {}, isAvailable: () => true },
    assets: assets([]), render: () => new Response("x") };
  const session = { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: loopback, tenantId: "tenant:x", provider: "p", subject: "s",
    ownerCodeDigest: sha256Digest({ ownerCode: "x".repeat(24) }), sessionSeconds: 900 } as const;
  assert.throws(() => createMacLocalWebProcessV1({ origin: loopback, workspaceId: "workspace:x",
    database: { client: {} as never, close: async () => {} } as never, localOwnerSession: session }),
  /mac_local_web_process_config_invalid/, "database availability is mandatory");
  assert.throws(() => createMacLocalControlRoomServiceV1({ ...base, localOwnerSession: { ...session, remoteOrigins: [cloudflareOrigin] } }),
    /mac_local_remote_access_invalid/, "an origin without its gate");
  assert.throws(() => createMacLocalControlRoomServiceV1({ ...base, localOwnerSession: { ...session, remoteOrigins: [tailnetOrigin] },
    remoteAccess: { cloudflare } }), /mac_local_remote_access_invalid/, "mismatched origins");
  assert.throws(() => createMacLocalControlRoomServiceV1({ ...base, localOwnerSession: { ...session, trustedOrigin: tailnetOrigin,
    remoteOrigins: [cloudflareOrigin] }, remoteAccess: { tailscale: { origin: tailnetOrigin }, cloudflare } }),
  /mac_local_remote_access_invalid/, "the legacy origin beside remoteAccess");
  for (const remoteOrigins of [["http://private-app.example.invalid"], ["https://u:p@private-app.example.invalid"],
    [`${cloudflareOrigin}/path`], [tailnetOrigin, cloudflareOrigin, "https://third.example.invalid"]])
    assert.throws(() => captureLocalOwnerSessionProfileV1({ ...session, remoteOrigins }), /invalid_local_owner_session_profile/,
      remoteOrigins.join(" "));
  assert.throws(() => createMacLocalWebProcessV1({ origin: loopback, workspaceId: "workspace:x", database: base.database,
    localOwnerSession: { ...session, remoteOrigins: [tailnetOrigin] }, cloudflareAccessOrigin: cloudflareOrigin }),
  /mac_local_web_process_config_invalid/, "the Cloudflare origin must be one of the session origins");
  const service = createMacLocalControlRoomServiceV1({ ...base, localOwnerSession: { ...session, remoteOrigins: [cloudflareOrigin] },
    remoteAccess: { cloudflare }, remoteAccessRuntime: { loadKeys: async () => [keyA.published] } });
  assert.equal(typeof service.start, "function");
  void service.close();
});
