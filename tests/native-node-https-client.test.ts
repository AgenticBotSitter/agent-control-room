import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { ConnectionOptions, TLSSocket } from "node:tls";
import test from "node:test";
import { createNativeNodeHttpsClient, type NativeNodeHttpsConfiguration, type NativeNodeHttpsPorts } from "../src/node-bridge/native-https-client";
import { nativeHttpLimits, type NativeHttpRequest, type NativeHttpResponse } from "../src/harness/v1/native-http-exchange";

const now = Date.parse("2026-09-06T18:00:00.000Z");
const certificateRaw = Buffer.from("synthetic server certificate bytes");
const certificateDigest = `sha256:${createHash("sha256").update(certificateRaw).digest("hex")}`;
const connection = "connection:http:00000000-0000-4000-8000-000000000001";
const validResponse: NativeHttpResponse = { schema: "control-room.native-http/v1", connection, packets: [], more: false };
type Mode = "normal" | "private_address" | "wrong_address" | "wrong_hostname" | "wrong_digest" | "unauthorized"
  | "redirect" | "compressed" | "cookie" | "wrong_type" | "oversize" | "incomplete" | "invalid_json" | "invalid_shape" | "hang";

function fixture(mode: Mode = "normal", privateOptions: { pinnedPrivateAddress?: string; answers?: string[]; peerAddress?: string } = {}) {
  const order: string[] = [], config: NativeNodeHttpsConfiguration = { canonicalDestination: "https://native.example.test:443",
    ...(privateOptions.pinnedPrivateAddress ? { pinnedPrivateAddress: privateOptions.pinnedPrivateAddress } : {}),
    connectorCredentialRef: "credential:native-mtls", serverCertificateDigest: certificateDigest,
    serverCa: "synthetic server CA material" };
  const counts = { resolves: 0, credentials: 0, connects: 0, requests: 0 };
  let requestOptions: RequestOptions | undefined, tlsOptions: ConnectionOptions | undefined, sentBody: string | undefined;
  let answers = privateOptions.answers;
  class FakeSocket extends EventEmitter {
    authorized = mode !== "unauthorized"; destroyed = false;
    remoteAddress = privateOptions.peerAddress ?? privateOptions.pinnedPrivateAddress ?? (mode === "wrong_address" ? "8.8.4.4" : "8.8.8.8"); remotePort = 443;
    getPeerCertificate() { return { subjectaltname: mode === "wrong_hostname" ? "DNS:other.example.test" : "DNS:native.example.test",
      raw: mode === "wrong_digest" ? Buffer.from("other certificate") : certificateRaw }; }
    destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit("close")); } return this; }
  }
  class FakeResponse extends EventEmitter {
    statusCode = mode === "redirect" ? 302 : 200; complete = false; destroyed = false; rawTrailers: string[] = [];
    headers: IncomingMessage["headers"] = {
      "content-type": mode === "wrong_type" ? "text/plain" : "application/json",
      ...(mode === "compressed" ? { "content-encoding": "gzip" } : {}),
      ...(mode === "cookie" ? { "set-cookie": ["not-accepted=1"] } : {}),
      ...(mode === "redirect" ? { location: "https://other.example.test/" } : {}),
    };
    destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit("close")); } return this; }
  }
  const socket = new FakeSocket(), response = new FakeResponse();
  let receive: (value: IncomingMessage) => void = () => undefined;
  class FakeRequest extends EventEmitter {
    destroyed = false;
    end(body?: string) {
      sentBody = body;
      if (mode !== "hang") queueMicrotask(() => {
        receive(response as unknown as IncomingMessage);
        if (response.destroyed) return;
        const value = mode === "oversize" ? Buffer.alloc(nativeHttpLimits.bodyBytes + 1)
          : Buffer.from(mode === "invalid_json" ? "{" : mode === "invalid_shape" ? "{}" : JSON.stringify(validResponse));
        response.emit("data", value); response.complete = mode !== "incomplete"; response.emit("end");
      });
      return this;
    }
    destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit("close")); } return this; }
  }
  const request = new FakeRequest();
  const ports: NativeNodeHttpsPorts = {
    resolver: { async resolve(host) { counts.resolves++; order.push("resolve"); assert.equal(host, "native.example.test");
      return answers ?? [mode === "private_address" ? "10.0.0.1" : "8.8.8.8"]; } },
    connect(options) { counts.connects++; order.push("connect"); tlsOptions = options;
      queueMicrotask(() => socket.emit("secureConnect")); return socket as unknown as TLSSocket; },
    request(options, handler) { counts.requests++; order.push("request"); requestOptions = options; receive = handler;
      assert.equal(options.createConnection?.({}, () => undefined), socket); return request as unknown as ClientRequest; },
  };
  const source = { async credential(reference: string) { counts.credentials++; order.push("credential");
    assert.equal(reference, "credential:native-mtls");
    return { certificate: "synthetic client certificate", privateKey: "synthetic client private key" }; },
    assertCurrent() { order.push("current"); }, clock: () => now };
  const client = createNativeNodeHttpsClient(config, source, ports);
  const exchange = (patch: Partial<NativeHttpRequest> = {}) => client.exchange({
    schema: "control-room.native-http/v1", operation: "open", mode: "initial", ...patch,
  } as NativeHttpRequest, new AbortController().signal);
  return { client, config, source, ports, socket, response, request, counts, order, exchange,
    setAnswers: (value: string[]) => { answers = value; },
    observed: () => ({ requestOptions, tlsOptions, sentBody }) };
}

test("explicit private connector pins flow into one TLS dial while DNS hostname, SNI, CA and leaf checks remain intact", async t => {
  for (const pin of ["10.12.34.56", "fd12:3456::7", "100.100.10.20"]) await t.test(pin, async () => {
    const f = fixture("normal", { pinnedPrivateAddress: pin, answers: [pin, pin] });
    assert.deepEqual(f.counts, { resolves: 0, credentials: 0, connects: 0, requests: 0 });
    // The connector captures its configuration before any asynchronous resolver or credential call.
    f.config.pinnedPrivateAddress = "10.9.9.9";
    assert.deepEqual(await f.exchange(), validResponse);
    assert.deepEqual(f.counts, { resolves: 1, credentials: 1, connects: 1, requests: 1 });
    assert.deepEqual(f.order.filter(value => value !== "current"), ["resolve", "credential", "connect", "request"]);
    const { tlsOptions, requestOptions } = f.observed();
    assert.equal(tlsOptions?.host, pin); assert.equal(tlsOptions?.port, 443);
    assert.equal(tlsOptions?.servername, "native.example.test"); assert.equal(tlsOptions?.rejectUnauthorized, true);
    assert.equal(tlsOptions?.ca, "synthetic server CA material"); assert.equal(tlsOptions?.minVersion, "TLSv1.2");
    assert.equal(requestOptions?.hostname, "native.example.test");
    assert.equal((requestOptions?.headers as Record<string, string>).Host, "native.example.test:443");
    assert.equal(f.socket.destroyed, true); assert.equal(f.request.destroyed, true); assert.equal(f.response.destroyed, true);
    await f.client.close();
  });
});

test("mismatched private DNS is rejected before credentials or TLS with no fallback", async t => {
  for (const answers of [["10.1.2.4"], ["10.1.2.3", "8.8.8.8"], [], Array(17).fill("10.1.2.3"), ["not-an-address"]])
    await t.test(JSON.stringify(answers), async () => {
      const f = fixture("normal", { pinnedPrivateAddress: "10.1.2.3", answers });
      await assert.rejects(f.exchange(), { message: "native_node_https_unavailable" });
      assert.deepEqual(f.counts, { resolves: 1, credentials: 0, connects: 0, requests: 0 });
      await assert.rejects(f.exchange(), { message: "native_node_https_unavailable" });
      assert.equal(f.counts.resolves, 1); await f.client.close();
    });
});

test("a later changed DNS answer cannot reuse the prior private connection or reread credentials", async () => {
  const f = fixture("normal", { pinnedPrivateAddress: "192.168.2.3", answers: ["192.168.2.3"] });
  await f.exchange(); f.setAnswers(["192.168.2.4"]);
  await assert.rejects(f.exchange(), { message: "native_node_https_unavailable" });
  assert.deepEqual(f.counts, { resolves: 2, credentials: 1, connects: 1, requests: 1 });
  await f.client.close();
});

test("private pins do not waive actual peer, hostname, certificate fingerprint or authorization checks", async t => {
  for (const failure of ["peer", "wrong_hostname", "wrong_digest", "unauthorized"] as const) await t.test(failure, async () => {
    const pin = "172.20.1.2";
    const f = fixture(failure === "peer" ? "normal" : failure, { pinnedPrivateAddress: pin, answers: [pin],
      ...(failure === "peer" ? { peerAddress: "172.20.1.3" } : {}) });
    await assert.rejects(f.exchange(), { message: "native_node_https_unavailable" });
    assert.deepEqual(f.counts, { resolves: 1, credentials: 1, connects: 1, requests: 0 });
    assert.equal(f.socket.destroyed, true); await f.client.close();
  });
});

test("client construction is inert and one exchange uses only the exact pinned destination and mTLS credential", async () => {
  const f = fixture(); assert.deepEqual(f.counts, { resolves: 0, credentials: 0, connects: 0, requests: 0 });
  const original = { resolve: f.ports.resolver.resolve, connect: f.ports.connect, request: f.ports.request,
    credential: f.source.credential, current: f.source.assertCurrent, clock: f.source.clock };
  f.config.canonicalDestination = "https://mutated.example.test:443";
  f.ports.resolver.resolve = async () => { throw new Error("mutated resolver"); };
  f.ports.connect = () => { throw new Error("mutated connector"); };
  f.ports.request = () => { throw new Error("mutated requester"); };
  f.source.credential = async () => { throw new Error("mutated credential source"); };
  f.source.assertCurrent = () => { throw new Error("mutated current check"); }; f.source.clock = () => -1;
  try {
    assert.deepEqual(await f.exchange(), validResponse);
  } finally {
    f.ports.resolver.resolve = original.resolve; f.ports.connect = original.connect; f.ports.request = original.request;
    f.source.credential = original.credential; f.source.assertCurrent = original.current; f.source.clock = original.clock;
  }
  assert.deepEqual(f.counts, { resolves: 1, credentials: 1, connects: 1, requests: 1 });
  const { requestOptions, tlsOptions, sentBody } = f.observed();
  assert.equal(tlsOptions?.host, "8.8.8.8"); assert.equal(tlsOptions?.port, 443);
  assert.equal(tlsOptions?.servername, "native.example.test"); assert.equal(tlsOptions?.rejectUnauthorized, true);
  assert.equal(tlsOptions?.minVersion, "TLSv1.2"); assert.deepEqual(tlsOptions?.ALPNProtocols, ["http/1.1"]);
  assert.equal(tlsOptions?.ca, "synthetic server CA material");
  assert.equal(tlsOptions?.cert, "synthetic client certificate"); assert.equal(tlsOptions?.key, "synthetic client private key");
  assert.equal(requestOptions?.protocol, "https:"); assert.equal(requestOptions?.hostname, "native.example.test");
  assert.equal(requestOptions?.port, 443); assert.equal(requestOptions?.path, nativeHttpLimits.path);
  assert.equal(requestOptions?.method, "POST"); assert.equal(requestOptions?.agent, undefined);
  const headers = requestOptions?.headers as Record<string, string>;
  assert.deepEqual(headers, { Host: "native.example.test:443", "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(sentBody!)), Accept: "application/json", "Accept-Encoding": "identity", Connection: "close" });
  assert.deepEqual(JSON.parse(sentBody!), { schema: "control-room.native-http/v1", operation: "open", mode: "initial" });
  assert.equal(f.socket.destroyed, true); assert.equal(f.request.destroyed, true); assert.equal(f.response.destroyed, true);
});

test("destination, TLS peer and certificate failures have no fallback or HTTP retry", async t => {
  for (const mode of ["private_address", "wrong_address", "wrong_hostname", "wrong_digest", "unauthorized"] as const) {
    await t.test(mode, async () => {
      const f = fixture(mode); await assert.rejects(f.exchange(), { message: "native_node_https_unavailable" });
      assert.equal(f.counts.requests, 0); assert.ok(f.counts.connects <= 1); assert.ok(f.counts.credentials <= 1);
      assert.equal(f.counts.connects, mode === "private_address" ? 0 : 1);
      assert.equal(f.counts.credentials, mode === "private_address" ? 0 : 1);
    });
  }
});

test("redirects, response metadata, body bounds and response schemas fail once without fallback", async t => {
  for (const mode of ["redirect", "compressed", "cookie", "wrong_type", "oversize", "incomplete", "invalid_json", "invalid_shape"] as const) {
    await t.test(mode, async () => {
      const f = fixture(mode); await assert.rejects(f.exchange(), { message: "native_node_https_unavailable" });
      assert.deepEqual(f.counts, { resolves: 1, credentials: 1, connects: 1, requests: 1 });
      assert.equal(f.socket.destroyed, true); assert.equal(f.request.destroyed, true);
    });
  }
});

test("caller cancellation closes the active request and socket and never retries", async () => {
  const f = fixture("hang"), controller = new AbortController();
  const pending = f.client.exchange({ schema: "control-room.native-http/v1", operation: "open", mode: "recover" }, controller.signal);
  while (!f.counts.requests) await new Promise<void>(resolve => setImmediate(resolve));
  controller.abort(); await assert.rejects(pending, { message: "native_node_https_unavailable" });
  assert.deepEqual(f.counts, { resolves: 1, credentials: 1, connects: 1, requests: 1 });
  assert.equal(f.socket.destroyed, true); assert.equal(f.request.destroyed, true);
  await assert.rejects(f.exchange(), { message: "native_node_https_unavailable" });
  assert.equal(f.counts.requests, 1);
});

test("close reports uncertainty when the accepted raw HTTP exchange never settles", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture("hang"), exchanging = f.exchange();
  while (!f.counts.requests) await new Promise<void>(resolve => setImmediate(resolve));
  const closing = f.client.close();
  await assert.rejects(exchanging, { message: "native_node_https_unavailable" });
  t.mock.timers.tick(nativeHttpLimits.closeMs);
  await assert.rejects(closing, { message: "native_node_https_close_uncertain" });
  assert.deepEqual(f.counts, { resolves: 1, credentials: 1, connects: 1, requests: 1 });
  assert.equal(f.socket.destroyed, true); assert.equal(f.request.destroyed, true);
});
