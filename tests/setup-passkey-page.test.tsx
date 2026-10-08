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

// These responses are synthetic protocol fixtures. Real session/cookie issuance
// is covered separately by the in-test-server browser journey.
for (const scenario of ["fresh", "session", "forbidden", "expired", "limited", "dropped", "interrupted"])
  test(`V101 recovery ${scenario} preserves registration authority on the setup page`, async t => {
    const dom = new JSDOM('<div id="root"></div>', { url: `https://control-room.example.test/setup#reg=${secret}&mode=initial`,
      pretendToBeVisual: true });
    const prior = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator,
      history: globalThis.history, fetch: globalThis.fetch,
      act: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT };
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, history: dom.window.history });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(dom.window.navigator, "credentials", { configurable: true, value: { create: async () => null } });
    const root = createRoot(dom.window.document.getElementById("root")!);
    let mounted = true;
    t.after(async () => {
      if (mounted) await act(async () => root.unmount());
      dom.window.close();
      Object.assign(globalThis, { window: prior.window, document: prior.document, history: prior.history, fetch: prior.fetch });
      Object.defineProperty(globalThis, "navigator", { configurable: true, value: prior.navigator });
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: prior.act });
    });
    const requests: Array<{ path: string; body: any; hash: string }> = [];
    const sessionCode = "B".repeat(43);
    let signedIn = scenario === "session", release: (() => void) | undefined, pendingSignal: AbortSignal | undefined;
    globalThis.fetch = (async (input, init) => {
      const path = String(input), body = JSON.parse(String(init?.body));
      requests.push({ path, body, hash: dom.window.location.hash });
      if (path.endsWith("local-owner-session")) {
        if (body.ownerCode !== sessionCode) return Response.json({ error: "authentication_required" }, { status: 401 });
        await new Promise<void>(resolve => { release = resolve; });
        signedIn = true; return Response.json({ authenticated: true }, { status: 201 });
      }
      assert.equal(body.registrationSecret, secret, "registration fragment is retained across sign-in");
      if (scenario === "dropped") throw new TypeError("synthetic dropped connection");
      if (scenario === "interrupted") {
        pendingSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => pendingSignal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      if (scenario === "forbidden" || scenario === "expired") return Response.json({}, { status: scenario === "forbidden" ? 403 : 410 });
      if (scenario === "limited") return Response.json({}, { status: 429, headers: { "retry-after": "37" } });
      if (!signedIn) return Response.json({ error: "authentication_required" }, { status: 401 });
      return Response.json({ publicKey: { challenge: b64(buffer(32, 3)), user: { id: b64(buffer(32, 4)) } } });
    }) as typeof fetch;
    await act(async () => root.render(createElement(PasskeyRegistration)));
    assert.equal(dom.window.location.hash, "", "fragment is removed before requests");
    assert.ok(requests.every(request => request.hash === ""));
    if (scenario === "interrupted") {
      await act(async () => root.unmount()); mounted = false;
      assert.equal(pendingSignal?.aborted, true, "unmount aborts the pending options request"); return;
    }
    if (scenario !== "fresh") {
      assert.equal(dom.window.document.querySelector('input[name="ownerCode"]'), null, "only unauthenticated options asks for a code");
      assert.match(dom.window.document.body.textContent ?? "", scenario === "limited" ? /Too many tries — wait 37 seconds/ : /Registration stopped/);
      assert.equal(requests.length, 1); return;
    }
    assert.ok(dom.window.document.querySelector('input[name="ownerCode"]'), "unauthenticated setup offers an owner-code field on the same page");
    const submit = async (code: string, burst = 1) => {
      const field = dom.window.document.querySelector('input[name="ownerCode"]') as HTMLInputElement;
      assert.ok(field, "owner-code field remains available after a refused attempt");
      field.value = code;
      await act(async () => {
        for (let n = 0; n < burst; n += 1) field.form!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      });
    };
    const guidance = "Owner codes are 43 characters. You may have copied extra text. Copy only the owner code, without the link.";
    for (const code of ["ABC234", "&" + "C".repeat(42), "code" + "C".repeat(39), "C".repeat(21) + " " + "C".repeat(21)]) {
      await submit(code);
      assert.ok(dom.window.document.body.textContent?.includes(guidance), "wrong code format shows the sign-in page's extra-text guidance");
    }
    await submit("C".repeat(43));
    assert.ok(dom.window.document.body.textContent?.includes("Sign-in was not accepted. Check your owner code and try again."));
    const before = requests.length;
    await submit(` ${sessionCode} `, 50);
    assert.equal(requests.length, before + 1, "50 concurrent submits issue one owner-session request while the connection is slow");
    assert.deepEqual(requests.at(-1)!.body, { ownerCode: sessionCode }, "only one outside space is trimmed");
    await act(async () => { release!(); });
    assert.equal(requests.length, before + 2, "successful sign-in resumes registration options once");
    assert.equal(requests.at(-1)!.path, "/api/v1/passkeys/registration/options");
    assert.deepEqual(requests.at(-1)!.body, { registrationSecret: secret }, "registration fragment is retained across sign-in");
    assert.equal(dom.window.location.pathname, "/setup", "sign-in never redirects to Projects");
    assert.equal(dom.window.location.hash, "");
  });
