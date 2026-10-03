import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { PasskeyRegistration } from "../private-app/app/setup/passkey-registration";

const secret = "A".repeat(43), ownerCode = "owner-code-long-enough-for-session";
const buffer = (size: number, byte: number) => new Uint8Array(size).fill(byte).buffer;
const b64 = (value: ArrayBuffer) => Buffer.from(value).toString("base64url");

for (const cancel of [false, true]) test(`R5G setup passkey browser ${cancel ? "cancellation" : "success"} strips fragment authority`, async t => {
  const dom = new JSDOM('<div id="root"></div>', { url: `https://control-room.example.test/setup#code=${ownerCode}&reg=${secret}`,
    pretendToBeVisual: true });
  const prior = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
    history: globalThis.history, fetch: globalThis.fetch,
    act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT,
    attestation: (globalThis as { AuthenticatorAttestationResponse?: unknown }).AuthenticatorAttestationResponse };
  class FakeAttestation {
    clientDataJSON = buffer(32, 1); attestationObject = buffer(64, 2);
    getTransports() { return ["internal"]; }
  }
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, history: dom.window.history });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "AuthenticatorAttestationResponse", { configurable: true, value: FakeAttestation });
  Object.defineProperty(dom.window.navigator, "credentials", { configurable: true, value: {
    get: async () => null,
    create: async () => { if (cancel) throw new Error("cancelled"); return ({ id: b64(buffer(32, 7)), rawId: buffer(32, 7), type: "public-key",
      authenticatorAttachment: "platform", getClientExtensionResults: () => ({}), response: new FakeAttestation() }); },
  } });
  const requests: Array<{ path: string; hash: string; body: unknown }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, hash: dom.window.location.hash, body });
    if (path.endsWith("local-owner-session")) return Response.json({ authenticated: true }, { status: 201 });
    if (path.endsWith("/options")) return Response.json({ publicKey: { challenge: b64(buffer(32, 3)),
      rp: { id: "control-room.example.test", name: "Control Room" }, user: { id: b64(buffer(32, 4)),
        name: "owner", displayName: "owner" }, pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      attestation: "none", excludeCredentials: [] }, authorization: null });
    return Response.json({ accepted: true }, { status: 201 });
  }) as typeof fetch;
  const root = createRoot(dom.window.document.getElementById("root")!);
  t.after(async () => {
    await act(async () => { root.unmount(); await Promise.resolve(); }); dom.window.close();
    Object.assign(globalThis, { window: prior.window, document: prior.document, history: prior.history, fetch: prior.fetch });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: prior.navigator });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: prior.act });
    Object.defineProperty(globalThis, "AuthenticatorAttestationResponse", { configurable: true, value: prior.attestation });
  });
  await act(async () => { root.render(createElement(PasskeyRegistration)); });
  for (let tries = 0; !dom.window.document.querySelector(cancel ? '[role="alert"]' : '[aria-label="Passkey comparison code"]') && tries < 100; tries += 1)
    await act(async () => new Promise(resolve => setTimeout(resolve, 5)));
  assert.equal(dom.window.location.hash, "");
  if (cancel) {
    assert.equal(requests.length, 2);
    assert.match(dom.window.document.body.textContent ?? "", /Do not retry or reload this page.*Keep the Terminal message.*show the lead after reopening Claude/);
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /start again/);
    return;
  }
  assert.equal(requests.length, 3); assert.ok(requests.every(request => request.hash === ""));
  assert.deepEqual(requests.map(request => request.path), ["/api/v1/local-owner-session",
    "/api/v1/passkeys/registration/options", "/api/v1/passkeys/registration"]);
  assert.deepEqual(requests[0]!.body, { ownerCode });
  const submitted = requests[2]!.body as { comparisonCode: string; registrationSecret: string };
  assert.match(submitted.comparisonCode, /^[A-Z2-7]{6}$/); assert.equal(submitted.registrationSecret, secret);
  assert.match(dom.window.document.body.textContent ?? "", new RegExp(submitted.comparisonCode));
});

test("the setup source keeps fragments out of history and fixes RP data to server options", async () => {
  const source = await readFile("private-app/app/setup/passkey-registration.tsx", "utf8");
  const authority = await readFile("src/updater/v1/passkey.mjs", "utf8");
  const cli = await readFile("src/updater/v1/cli.mjs", "utf8");
  assert.ok(source.indexOf("history.replaceState") < source.indexOf("fetch(\"/api/v1/local-owner-session\""));
  assert.match(source, /window\.location\.hash\.length > 1024/);
  assert.match(source, /credentials: "same-origin"/);
  assert.match(authority, /residentKey: "required"/);
  assert.match(authority, /userVerification: "required"/);
  assert.doesNotMatch(source, /window\.location\.origin|document\.location\.origin/);
  assert.match(source, /Type the code above into the installer/u);
  assert.doesNotMatch(source, /installer must show the same code/iu);
  assert.match(cli, /Phone warning delivery is not available yet/u);
  assert.doesNotMatch(cli, /Cooling-off warnings were queued/iu);
});

test("the passkey POST adapter requires Origin before reading or forwarding the body", async () => {
  const source = (await readFile("src/web/v1/mac-local-web-process.ts", "utf8"))
    .replace(/\/\*[\s\S]*?\*\//gu, " ").replace(/\s+/gu, " ");
  const route = source.indexOf('url.pathname === "/api/v1/passkeys/registration/options"');
  const originGuard = source.indexOf("sessions.assertLocalRequest(request, true);", route);
  const bodyRead = source.indexOf("readBoundedJson(request.body, 20_000)", route);
  const typedPort = source.indexOf("options.passkeyRegistration.options", route);
  assert.ok(route >= 0 && originGuard > route && bodyRead > originGuard && typedPort > bodyRead);
});

test("R5G Mac signs in separately with the long code from the original installer link", async () => {
  const { LocalOwnerSessionServiceV1, LOCAL_OWNER_SESSION_PROFILE_V1, renderLocalOwnerSignInPageV1 } = await import("../src/web/v1/local-owner-session");
  const { sha256Digest } = await import("../src/security");
  const { initialPasskeyUrlV1 } = await import("../src/updater/v1/terminal/qr.mjs");
  const origin = "https://control-room.example.test", loopback = "http://127.0.0.1:3210";
  const link = initialPasskeyUrlV1({ rpId: "control-room.example.test", ownerCode, registrationSecret: secret });
  // Follow the exact owner wording: copy the text between #code= and &reg=.
  const copiedCode = link.split("#code=")[1]!.split("&reg=")[0]!;
  assert.equal(copiedCode, ownerCode);
  const service = new LocalOwnerSessionServiceV1({ schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: loopback,
    trustedOrigin: origin, tenantId: "tenant:fixture", provider: "fixture", subject: "owner:fixture",
    ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 });
  const signIn = (code: string) => service.issue(new Request(`${origin}/api/v1/local-owner-session`, {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ ownerCode: code }),
  }), code, 1000);
  const phone = await signIn(ownerCode);
  assert.throws(() => service.verify(new Request(`${origin}/workers/connect`), 1001), /authentication_required/);
  await assert.rejects(signIn("ABC234"), /authentication_required/);
  const mac = await signIn(copiedCode);
  assert.notEqual(phone.cookie, mac.cookie);
  assert.equal(service.verify(new Request(`${origin}/workers/connect`, { headers: { cookie: mac.cookie.split(";")[0]! } }), 1001).subject, "owner:fixture");
  const html = await renderLocalOwnerSignInPageV1().text();
  assert.match(html, /Owner code/); assert.match(html, /Sign in/);
});
