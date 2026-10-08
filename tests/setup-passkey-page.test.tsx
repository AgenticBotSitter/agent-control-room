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
    assert.match(dom.window.document.body.textContent ?? "", /the 43-character owner code printed in the Terminal window where you installed Control Room.*If that window is unavailable, ask the lead/u, "N1: manual code source is actionable");
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

// Real HTTP session issuance and real body refusal; passkey options below are
// synthetic WebAuthn-boundary data. No database or passkey record is created.
for (const mode of ["large-ascii", "large-link", "large-unicode", "dropped", "slow", "lost-success", "503", "unmount", "unmount-success", "qr-dropped", "qr-503", "qr-slow", "qr-lost-success"])
  test(`V101 F2 real HTTP sign-in recovery ${mode} retains same-page retry`, { timeout: 25_000 }, async () => {
    const failureMode = mode.replace(/^qr-/, "");
    const { createServer } = await import("node:http");
    const { createMacLocalWebProcessV1 } = await import("../src/web/v1/mac-local-web-process");
    const { createMacLocalNodeHandler } = await import("../src/web/v1/private-node-handler");
    const { LOCAL_OWNER_SESSION_PROFILE_V1 } = await import("../src/web/v1/local-owner-session");
    const { sha256Digest } = await import("../src/security");
    const server = createServer(), realFetch = globalThis.fetch;
    let app: ReturnType<typeof createMacLocalWebProcessV1> | undefined, dom: JSDOM | undefined;
    let root: ReturnType<typeof createRoot> | undefined, mounted = false;
    const keys = ["window", "document", "history", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"];
    const prior = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    let calls = 0, cookie = "", pendingSignal: AbortSignal | undefined, clientOptions = 0;
    let lostSocket: import("node:net").Socket | undefined, lostIssued = false;
    let entered!: () => void;
    const firstSession = new Promise<void>(done => { entered = done; });
    const optionSecrets: string[] = [], codes: string[] = [];
    try {
      await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
      const address = server.address(); assert.ok(address && typeof address !== "string");
      const localOrigin = `http://127.0.0.1:${address.port}`, correctCode = "B".repeat(43);
      const unavailable = async (): Promise<never> => { throw new Error("sign-in must not query a database"); };
      app = createMacLocalWebProcessV1({ origin: localOrigin, workspaceId: "workspace:retry",
        localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: localOrigin,
          tenantId: "tenant:retry", provider: "local", subject: "owner:retry",
          ownerCodeDigest: sha256Digest({ ownerCode: correctCode }), sessionSeconds: 900 },
        passkeyRegistration: { options: async input => {
          optionSecrets.push(input.registrationSecret);
          return { publicKey: { challenge: b64(buffer(32, 3)), user: { id: b64(buffer(32, 4)) } } };
        }, insert: unavailable },
        database: { client: { query: unavailable, transaction: unavailable, transactionWithPreCommitCheck: unavailable },
          close: async () => {}, isAvailable: () => true } });
      const handler = createMacLocalNodeHandler({ origin: localOrigin, application: app,
        assets: { count: 0, digest: "synthetic:no-assets", respond: () => undefined },
        handler: async request => {
          const response = await app!.handle(request, () => new Response("shell"));
          if (failureMode === "lost-success" && calls === 1 && new URL(request.url).pathname === "/api/v1/local-owner-session") {
            lostIssued = response.status === 201 && response.headers.has("set-cookie");
            lostSocket!.destroy();
          }
          return response;
        } });
      server.on("request", (request, response) => {
        if (request.url === "/api/v1/local-owner-session" && ++calls === 1) {
          entered();
          if (failureMode === "dropped") { request.socket.destroy(); return; }
          if (failureMode === "slow" || failureMode === "unmount") return;
          if (failureMode === "503") { response.writeHead(503); response.end(); return; }
          if (failureMode === "lost-success") {
            // Retain the socket until the application has issued its session,
            // then drop it before the Node adapter sends headers or body.
            lostSocket = request.socket;
          }
        }
        void handler.handle(request, response);
      });
      const denied = await realFetch(localOrigin + "/api/v1/passkeys/registration/options", {
        method: "POST", headers: { origin: localOrigin, "content-type": "application/json" },
        body: JSON.stringify({ registrationSecret: secret }),
      });
      assert.equal(denied.status, 401, "registration options still require session authority"); await denied.text();
      dom = new JSDOM('<div id="root"></div>', { url: localOrigin + "/setup#reg=" + secret + "&mode=initial" + (mode.startsWith("qr-") ? "&code=" + correctCode : ""),
        pretendToBeVisual: true });
      for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
        history: dom.window.history, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
        fetch: async (url: string, init: RequestInit) => {
          if (url.endsWith("local-owner-session")) { codes.push(JSON.parse(String(init.body)).ownerCode); pendingSignal = init.signal ?? undefined; }
          if (url.endsWith("registration/options")) clientOptions++;
          const response = await realFetch(localOrigin + url, { ...init,
            headers: { ...init.headers, origin: localOrigin, ...(cookie ? { cookie } : {}) } });
          const issued = response.headers.get("set-cookie"); if (issued) cookie = issued.split(";")[0]!;
          if (failureMode === "unmount-success" && url.endsWith("local-owner-session")) {
            assert.equal(response.status, 201, "unmount follows real sign-in success");
            await act(async () => root!.unmount()); mounted = false;
          }
          return response;
        } })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
      Object.defineProperty(dom.window.navigator, "credentials", { configurable: true, value: { create: async () => null } });
      root = createRoot(dom.window.document.getElementById("root")!); mounted = true;
      const waitFor = async (predicate: () => boolean, milliseconds = 2_000) => {
        const deadline = performance.now() + milliseconds;
        while (!predicate() && performance.now() < deadline) await act(async () => new Promise(done => setTimeout(done, 10)));
        assert.ok(predicate(), "observable recovery state reached within its independent deadline");
      };
      await act(async () => root!.render(createElement(PasskeyRegistration)));
      const started = performance.now();
      if (!mode.startsWith("qr-")) {
      await waitFor(() => !!dom!.window.document.querySelector("input"));
      const field = dom.window.document.querySelector("input")!;
      field.value = failureMode === "large-ascii" ? "A".repeat(500) : failureMode === "large-link"
        ? "https://example.test/setup#code=" + "A".repeat(480) : failureMode === "large-unicode" ? "é".repeat(260) : correctCode;
      const form = field.form!;
      await act(async () => { for (let index = 0; index < 50; index++) form.dispatchEvent(new dom!.window.Event("submit", { bubbles: true, cancelable: true })); });
      }
      await firstSession;
      const waitingStatus = dom.window.document.querySelector('[role="status"]')?.textContent;
      if (failureMode === "unmount-success") {
        await waitFor(() => !mounted);
        await act(async () => { await new Promise<void>(done => setImmediate(done)); });
        assert.equal(clientOptions, 1, "unmount after session success never starts a new options fetch");
        assert.deepEqual(optionSecrets, [], "unmount after success never begins registration"); return;
      }
      if (failureMode === "unmount") {
        await act(async () => root!.unmount()); mounted = false;
        assert.equal(pendingSignal?.aborted, true, "unmount aborts the pending sign-in request");
        assert.deepEqual(optionSecrets, [], "unmount never resumes registration"); return;
      }
      await waitFor(() => !!dom!.window.document.querySelector('form [role="alert"]'), failureMode === "slow" ? 11_000 : 2_000);
      assert.equal(calls, 1, "50 parallel submits issue exactly one request");
      assert.deepEqual(optionSecrets, [], "a failed sign-in never begins registration");
      if (mode.startsWith("qr-")) {
        assert.equal(!!dom.window.document.querySelector("input"), false, "R3: QR retry never asks for or redisplays the retained code");
        assert.equal(dom.window.document.querySelector("button")?.textContent, "Try again", "R3: transient QR failure offers an in-memory retry");
        assert.ok(!dom.window.document.body.textContent?.includes(correctCode));
      } else assert.ok(dom.window.document.querySelector("input"), "transient sign-in failure preserves retry form");
      if (mode.startsWith("large")) assert.equal(dom.window.document.querySelector('[role="alert"]')!.textContent,
        "Owner codes are 43 characters. You may have copied extra text. Copy only the owner code, without the link.",
        "oversized copied input shows guidance rather than service outage");
      else if (failureMode !== "503") assert.equal(dom.window.document.querySelector('[role="alert"]')!.textContent,
        "Could not reach Control Room to sign in. Check your connection and try again on this page.",
        "transport failures are recoverable sign-in errors, not terminal registration errors");
      if (failureMode === "lost-success") assert.equal(lostIssued, true, "the lost reply follows real session issuance");
      if (failureMode === "slow") {
        assert.equal(waitingStatus, "Signing in…", "slow sign-in never claims Face ID is already waiting");
        assert.equal(pendingSignal?.aborted, true, "application deadline aborts held sign-in response");
        assert.ok(performance.now() - started < 11_000, "sign-in deadline is bounded independently at eleven seconds");
      }
      if (mode.startsWith("qr-")) {
        const retry = dom.window.document.querySelector("button")!;
        await act(async () => { for (let n = 0; n < 50; n++) retry.click(); });
      } else {
        const retry = dom.window.document.querySelector("input")!; retry.value = correctCode;
        await act(async () => retry.form!.dispatchEvent(new dom!.window.Event("submit", { bubbles: true, cancelable: true })));
      }
      await waitFor(() => optionSecrets.length === 1 && !!dom!.window.document.querySelector('[role="alert"]'));
      assert.equal(calls, 2, "one retry issues one new sign-in");
      assert.equal(codes.at(-1), correctCode);
      assert.deepEqual(optionSecrets, [secret], "retry preserves the original registration secret");
      assert.equal(dom.window.location.pathname, "/setup"); assert.equal(dom.window.location.hash, "");
      assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /Registration stopped.*Do not retry or reload/,
        "WebAuthn cancellation remains a separate terminal registration error");
    } finally {
      if (mounted) await act(async () => root!.unmount()); dom?.window.close();
      for (const key of keys) { const descriptor = prior.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
      server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await app?.close();
    }
  });

// Synthetic WebAuthn replies isolate the hashchange lifecycle. Browser coverage
// below separately uses Chromium; this fixture makes no persistence claim.
for (const stage of ["ready", "pending", "insert", "credential"]) test(`V101 R4 new same-tab fragment replaces ${stage} registration`, async t => {
  const pending = stage !== "ready";
  const nextSecret = "Z".repeat(43);
  const dom = new JSDOM('<div id="root"></div>', { url: `https://control-room.example.test/setup#reg=${secret}` });
  const keys = ["window", "document", "history", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT", "AuthenticatorAttestationResponse"];
  const prior = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class Attestation { clientDataJSON = buffer(32, 1); attestationObject = buffer(64, 2); getTransports() { return ["internal"]; } }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    history: dom.window.history, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    AuthenticatorAttestationResponse: Attestation })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let release!: () => void, oldSignal: AbortSignal | undefined;
  let creates = 0;
  Object.defineProperty(dom.window.navigator, "credentials", { configurable: true, value: { create: async (input: { signal?: AbortSignal }) => {
    creates++;
    if (stage === "credential") { oldSignal = input.signal; await new Promise<void>(done => { release = done; }); }
    return ({
    id: b64(buffer(32, 7)), rawId: buffer(32, 7), type: "public-key", getClientExtensionResults: () => ({}), response: new Attestation(),
  }); } } });
  const secrets: string[] = [], inserts: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const requested = JSON.parse(String(init!.body)).registrationSecret;
    assert.equal(dom.window.location.hash, "", "new fragment is removed before requests");
    if (String(_url).endsWith("/options")) {
      secrets.push(requested);
      if (requested === secret && stage === "pending") { oldSignal = init!.signal!; await new Promise<void>(done => { release = done; }); }
      if (requested === nextSecret) return Response.json({}, { status: 410 });
      return Response.json({ publicKey: { challenge: b64(buffer(32, 3)), user: { id: b64(buffer(32, 4)) } } });
    }
    inserts.push(requested);
    if (requested === secret && stage === "insert") { oldSignal = init!.signal!; await new Promise<void>(done => { release = done; }); }
    return Response.json({}, { status: 201 });
  }) as typeof fetch;
  const root = createRoot(dom.window.document.getElementById("root")!);
  t.after(async () => { await act(async () => root.unmount()); dom.window.close();
    for (const key of keys) { const descriptor = prior.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
  const settle = async () => { for (let n = 0; n < 20; n++) await act(async () => new Promise<void>(done => setImmediate(done))); };
  await act(async () => root.render(createElement(PasskeyRegistration))); await settle();
  if (!pending) assert.ok(dom.window.document.querySelector('[aria-label="Passkey comparison code"]'), "first registration completed");
  await act(async () => {
    const changed = new Promise<void>(done => dom.window.addEventListener("hashchange", () => done(), { once: true }));
    dom.window.location.hash = `reg=${nextSecret}&mode=add`; await changed;
  }); await settle();
  assert.deepEqual(secrets, [secret, nextSecret], "R4: same-tab link starts registration with new authority");
  assert.equal(dom.window.location.hash, "");
  assert.equal(!!dom.window.document.querySelector('[aria-label="Passkey comparison code"]'), false, "R4: old comparison code is cleared");
  assert.match(dom.window.document.querySelector('[role="alert"]')!.textContent!, /Registration stopped/);
  if (pending) {
    assert.equal(oldSignal!.aborted, true, "R4: replacement aborts the old request");
    await act(async () => release()); await settle();
    assert.deepEqual(inserts, stage === "insert" ? [secret] : [], "R4: a late reply cannot insert the old registration");
    assert.equal(creates, stage === "pending" ? 0 : 1, "R4: a late reply cannot start an old WebAuthn prompt");
    assert.equal(!!dom.window.document.querySelector('[aria-label="Passkey comparison code"]'), false);
  }
  await act(async () => {
    const changed = new Promise<void>(done => dom.window.addEventListener("hashchange", () => done(), { once: true }));
    dom.window.location.hash = "reg=bad"; await changed;
  }); await settle();
  assert.equal(dom.window.location.hash, "", "malformed replacement is removed and refused");
  assert.deepEqual(secrets, [secret, nextSecret], "malformed replacement never reaches the API");
});

test("V101 R1 browser fixture uses a WebAuthn hostname and a new document for replay", async () => {
  const typescript = (await import("typescript")).default;
  const fixture = await readFile("tests/browser/mac-local-owner-journey.spec.ts", "utf8");
  const source = typescript.createPrinter({ removeComments: true }).printFile(
    typescript.createSourceFile("journey.ts", fixture, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TS),
  ).replace(/\s+/gu, " ");
  assert.match(source, /const localOrigin = `https:\/\/localhost:\$\{address\.port\}`/u,
    "R1: browser origin is a hostname accepted by WebAuthn, rather than an IP literal");
  assert.match(source, /origin: loopbackOrigin, trustedOrigin: localOrigin/u, "R1: HTTPS browser origin is trusted without changing the required HTTP loopback profile");
  assert.match(source, /origin: loopbackOrigin, secondaryOrigin: localOrigin/u, "R1: production Node adapter admits the HTTPS browser origin");
  assert.match(source, /rp: \{ name: "Disposable setup", id: "localhost" \}/u,
    "R1: RP id is the independently specified matching hostname");
  assert.match(source, /await page\.goto\("about:blank"\);\s*await page\.goto\(link\)/u,
    "R1: replay loads a new document rather than assuming a fragment reload");
});

// Reviewer S6/S6b/S6c: the actual layout's skip link changes the fragment.
// Synthetic credential/options replies isolate that lifecycle; no DB proof.
for (const scenario of ["ready", "credential", "absent", "reopen-ready", "reopen-credential", "anchor-load"]) test(
  scenario.startsWith("reopen-") ? `V101 R6 identical reopen clears URL in ${scenario.slice(7)} registration`
    : scenario === "anchor-load" ? "V101 N9 plain anchor reload stays without registration"
      : `V101 R5 skip link preserves ${scenario} registration`, async t => {
  const stage = scenario === "anchor-load" ? "absent" : scenario.replace("reopen-", "");
  const initialHash = `#code=${ownerCode}&reg=${secret}`;
  const dom = new JSDOM('<a href="#private-main">Skip to content</a><main id="private-main"><div id="root"></div></main>',
    { url: `https://control-room.example.test/setup${scenario === "anchor-load" ? "#private-main" : stage === "absent" ? "" : initialHash}` });
  const keys = ["window", "document", "history", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT", "AuthenticatorAttestationResponse"];
  const prior = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class Attestation { clientDataJSON = buffer(32, 1); attestationObject = buffer(64, 2); getTransports() { return ["internal"]; } }
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
    history: dom.window.history, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
    AuthenticatorAttestationResponse: Attestation })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let signal: AbortSignal | undefined, release: (() => void) | undefined, creates = 0;
  const requests: string[] = [];
  Object.defineProperty(dom.window.navigator, "credentials", { configurable: true, value: { create: async (input: { signal?: AbortSignal }) => {
    creates++; signal = input.signal;
    if (stage === "credential") await new Promise<void>(done => { release = done; });
    return { id: b64(buffer(32, 7)), rawId: buffer(32, 7), type: "public-key", getClientExtensionResults: () => ({}), response: new Attestation() };
  } } });
  globalThis.fetch = (async input => {
    requests.push(String(input));
    return String(input).endsWith("/options")
      ? Response.json({ publicKey: { challenge: b64(buffer(32, 3)), user: { id: b64(buffer(32, 4)) } } })
      : Response.json({}, { status: 201 });
  }) as typeof fetch;
  const root = createRoot(dom.window.document.getElementById("root")!);
  t.after(async () => {
    await act(async () => { root.unmount(); release?.(); }); dom.window.close();
    for (const key of keys) { const descriptor = prior.get(key); if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  const settle = async () => { for (let n = 0; n < 20; n++) await act(async () => new Promise<void>(done => setImmediate(done))); };
  await act(async () => root.render(createElement(PasskeyRegistration)));
  if (scenario === "anchor-load") {
    assert.equal(dom.window.location.hash, "#private-main", "N9: ordinary anchor survives mount");
    assert.equal(dom.window.document.querySelector("section"), null, "N9: plain anchor reload must not show Registration stopped");
    assert.deepEqual(requests, [], "N9: ordinary anchor never starts requests");
    return;
  }
  const deadline = performance.now() + 5_000;
  while (stage !== "absent" && !(stage === "credential" ? creates === 1 : dom.window.document.querySelector('[aria-label="Passkey comparison code"]'))) {
    assert.ok(performance.now() < deadline, "initial registration reaches its observable stage");
    await act(async () => new Promise<void>(done => setImmediate(done)));
  }
  const code = dom.window.document.querySelector('[aria-label="Passkey comparison code"]')?.textContent;
  if (stage === "ready") assert.match(code!, /^[A-Z2-7]{6}$/);
  if (stage === "credential") assert.equal(creates, 1, "pending Face ID reached before skip");
  const beforeRequests = [...requests];
  const changeHash = async (hash: string) => {
    await act(async () => {
      const changed = new Promise<void>(done => dom.window.addEventListener("hashchange", () => done(), { once: true }));
      dom.window.location.hash = hash; await changed;
    }); await settle();
  };
  await act(async () => {
    const changed = new Promise<void>(done => dom.window.addEventListener("hashchange", () => done(), { once: true }));
    dom.window.document.querySelector("a")!.click(); await changed;
  }); await settle();
  const unchanged = () => {
    assert.equal(!!dom.window.document.querySelector('[role="alert"]'), false, "R5: skip link must not show a false stop");
    assert.equal(dom.window.document.querySelector('[aria-label="Passkey comparison code"]')?.textContent, code, "R5: comparison code survives skip link");
    assert.equal(signal?.aborted ?? false, false, "R5: skip link must not cancel Face ID");
    assert.deepEqual(requests, beforeRequests, "R5: unrelated fragments never restart registration");
    if (stage === "absent") assert.equal(!!dom.window.document.querySelector("section"), false, "R5: plain setup remains without a registration panel");
  };
  unchanged();
  for (const hash of ["#other-anchor", "#code=extra", "#REG=other", ""]) { await changeHash(hash); unchanged(); }
  for (let n = 0; n < 50; n++) { await changeHash(`#anchor-${n}`); unchanged(); }
  if (stage !== "absent") {
    await changeHash(initialHash); unchanged();
    if (scenario.startsWith("reopen-")) {
      assert.equal(dom.window.location.hash, "", "R6: identical reopen removes fragment secrets from URL");
      for (let n = 0; n < 50; n++) {
        await changeHash(initialHash); unchanged();
        assert.equal(dom.window.location.hash, "", "R6: repeated reopen removes fragment secrets from URL");
      }
    }
    assert.equal(creates, 1, "R5: identical registration fragment never restarts Face ID");
  }
  if (stage === "credential") {
    await act(async () => release!()); await settle();
    assert.ok(dom.window.document.querySelector('[aria-label="Passkey comparison code"]'), "R5: pending registration completes after skip");
  }
});
