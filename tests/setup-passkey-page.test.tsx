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

// Real HTTP session issuance and real body refusal; passkey options below are
// synthetic WebAuthn-boundary data. No database or passkey record is created.
for (const mode of ["large-ascii", "large-link", "large-unicode", "dropped", "slow", "lost-success", "503", "unmount", "unmount-success"])
  test(`V101 F2 real HTTP sign-in recovery ${mode} retains same-page retry`, { timeout: 25_000 }, async () => {
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
          if (mode === "lost-success" && calls === 1 && new URL(request.url).pathname === "/api/v1/local-owner-session") {
            lostIssued = response.status === 201 && response.headers.has("set-cookie");
            lostSocket!.destroy();
          }
          return response;
        } });
      server.on("request", (request, response) => {
        if (request.url === "/api/v1/local-owner-session" && ++calls === 1) {
          entered();
          if (mode === "dropped") { request.socket.destroy(); return; }
          if (mode === "slow" || mode === "unmount") return;
          if (mode === "503") { response.writeHead(503); response.end(); return; }
          if (mode === "lost-success") {
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
      dom = new JSDOM('<div id="root"></div>', { url: localOrigin + "/setup#reg=" + secret + "&mode=initial",
        pretendToBeVisual: true });
      for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document,
        history: dom.window.history, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true,
        fetch: async (url: string, init: RequestInit) => {
          if (url.endsWith("local-owner-session")) { codes.push(JSON.parse(String(init.body)).ownerCode); pendingSignal = init.signal ?? undefined; }
          if (url.endsWith("registration/options")) clientOptions++;
          const response = await realFetch(localOrigin + url, { ...init,
            headers: { ...init.headers, origin: localOrigin, ...(cookie ? { cookie } : {}) } });
          const issued = response.headers.get("set-cookie"); if (issued) cookie = issued.split(";")[0]!;
          if (mode === "unmount-success" && url.endsWith("local-owner-session")) {
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
      await waitFor(() => !!dom!.window.document.querySelector("input"));
      const field = dom.window.document.querySelector("input")!;
      field.value = mode === "large-ascii" ? "A".repeat(500) : mode === "large-link"
        ? "https://example.test/setup#code=" + "A".repeat(480) : mode === "large-unicode" ? "é".repeat(260) : correctCode;
      const form = field.form!;
      const started = performance.now();
      await act(async () => { for (let index = 0; index < 50; index++) form.dispatchEvent(new dom!.window.Event("submit", { bubbles: true, cancelable: true })); });
      await firstSession;
      const waitingStatus = dom.window.document.querySelector('[role="status"]')?.textContent;
      if (mode === "unmount-success") {
        await waitFor(() => !mounted);
        await act(async () => { await new Promise<void>(done => setImmediate(done)); });
        assert.equal(clientOptions, 1, "unmount after session success never starts a new options fetch");
        assert.deepEqual(optionSecrets, [], "unmount after success never begins registration"); return;
      }
      if (mode === "unmount") {
        await act(async () => root!.unmount()); mounted = false;
        assert.equal(pendingSignal?.aborted, true, "unmount aborts the pending sign-in request");
        assert.deepEqual(optionSecrets, [], "unmount never resumes registration"); return;
      }
      await waitFor(() => !!dom!.window.document.querySelector('form [role="alert"]'), mode === "slow" ? 11_000 : 2_000);
      assert.equal(calls, 1, "50 parallel submits issue exactly one request");
      assert.deepEqual(optionSecrets, [], "a failed sign-in never begins registration");
      assert.ok(dom.window.document.querySelector("input"), "transient sign-in failure preserves retry form");
      if (mode.startsWith("large")) assert.equal(dom.window.document.querySelector('[role="alert"]')!.textContent,
        "Owner codes are 43 characters. You may have copied extra text. Copy only the owner code, without the link.",
        "oversized copied input shows guidance rather than service outage");
      else if (mode !== "503") assert.equal(dom.window.document.querySelector('[role="alert"]')!.textContent,
        "Could not reach Control Room to sign in. Check your connection and try again on this page.",
        "transport failures are recoverable sign-in errors, not terminal registration errors");
      if (mode === "lost-success") assert.equal(lostIssued, true, "the lost reply follows real session issuance");
      if (mode === "slow") {
        assert.equal(waitingStatus, "Signing in…", "slow sign-in never claims Face ID is already waiting");
        assert.equal(pendingSignal?.aborted, true, "application deadline aborts held sign-in response");
        assert.ok(performance.now() - started < 11_000, "sign-in deadline is bounded independently at eleven seconds");
      }
      const retry = dom.window.document.querySelector("input")!; retry.value = correctCode;
      await act(async () => retry.form!.dispatchEvent(new dom!.window.Event("submit", { bubbles: true, cancelable: true })));
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
