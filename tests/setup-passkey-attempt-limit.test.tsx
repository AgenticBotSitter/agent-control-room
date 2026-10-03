import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { PasskeyRegistration } from "../private-app/app/setup/passkey-registration";

const secret = "A".repeat(43), ownerCode = "owner-code-long-enough-for-session";
const buffer = (size: number, byte: number) => new Uint8Array(size).fill(byte).buffer;
const b64 = (value: ArrayBuffer) => Buffer.from(value).toString("base64url");

const scenarios = ["options", "insert"].flatMap(stage =>
  ["37", null, "invalid", "0", "-1", "9007199254740992", "1e1", "1.0"].map(retryAfter => ({ stage, retryAfter, status: 429 }))).concat(
  ["options", "insert"].map(stage => ({ stage, retryAfter: "37", status: 503 })));
for (const scenario of scenarios) test(`R7W setup passkey browser ${scenario.stage} ${scenario.status} with ${scenario.retryAfter} strips fragment authority`, { timeout: 10000 }, async t => {
  const limited = scenario;
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
    create: async () => { return ({ id: b64(buffer(32, 7)), rawId: buffer(32, 7), type: "public-key",
      authenticatorAttachment: "platform", getClientExtensionResults: () => ({}), response: new FakeAttestation() }); },
  } });
  const requests: Array<{ path: string; hash: string; body: unknown }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, hash: dom.window.location.hash, body });
    if (path.endsWith("local-owner-session")) return Response.json({ authenticated: true }, { status: 201 });
    if ((limited.stage === "options" ? path.endsWith("/options") : path.endsWith("/registration")))
      return new Response(null, { status: limited.status, headers: limited.retryAfter === null ? {} : { "retry-after": limited.retryAfter } });
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
  for (let tries = 0; !dom.window.document.querySelector('[role="alert"]') && tries < 100; tries += 1)
    await act(async () => new Promise(resolve => setTimeout(resolve, 5)));
  assert.equal(dom.window.location.hash, "");
  assert.equal(requests.length, limited.stage === "options" ? 2 : 3);
  const message = dom.window.document.querySelector('[role="alert"]')?.textContent ?? "";
  if (limited.status === 429 && limited.retryAfter === "37") assert.equal(message, "Too many tries — wait 37 seconds");
  else assert.match(message, /Registration stopped/);
  assert.equal(dom.window.document.querySelector('[aria-label="Passkey comparison code"]'), null);
  assert.ok(requests.every(request => request.hash === ""));
});

