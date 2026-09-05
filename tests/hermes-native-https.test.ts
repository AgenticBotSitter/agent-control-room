import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { ConnectionOptions, TLSSocket } from "node:tls";
import test from "node:test";
import { createNativeHttpsTransport, type NativeHttpsPorts } from "../src/harness/hermes-native-v1/https-transport.ts";
import { bindNativeStart, nativeLimits, type NativeWireRequest } from "../src/harness/hermes-native-v1/contracts.ts";
import { binding, enrollment, input, instant, nativeRunId } from "./hermes-native-fixture.ts";

type Mode = "normal" | "private_dns" | "wrong_peer" | "wrong_certificate" | "unauthorized_tls" | "redirect" | "oversize" | "incomplete" | "compressed" | "hang" | "sse" | "wrong_sse";
function fixture(mode: Mode = "normal") {
  const order: string[] = []; let requests = 0, credentials = 0, connections = 0;
  let observedOptions: RequestOptions | undefined, observedTls: ConnectionOptions | undefined, sentBody: unknown;
  class FakeSocket extends EventEmitter {
    authorized = mode !== "unauthorized_tls"; destroyed = false;
    remoteAddress = mode === "wrong_peer" ? "8.8.4.4" : "8.8.8.8"; remotePort = 443;
    getPeerCertificate() { return { subjectaltname: mode === "wrong_certificate" ? "DNS:other.example.test" : "DNS:agent.example.test" }; }
    destroy() { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit("close")); } return this; }
  }
  const socket = new FakeSocket();
  class FakeResponse extends EventEmitter {
    statusCode = mode === "redirect" ? 302 : 200; complete = false; destroyed = false;
    headers = { "content-type": mode === "sse" ? "text/event-stream; charset=utf-8" : "application/json",
      ...(mode === "compressed" ? { "content-encoding": "gzip" } : {}) };
    destroy() { this.destroyed = true; return this; }
  }
  const incoming = new FakeResponse();
  class FakeRequest extends EventEmitter {
    destroyed = false;
    end(body: unknown) { sentBody = body; if (mode !== "hang") queueMicrotask(() => {
      receive(incoming as unknown as IncomingMessage);
      if (incoming.destroyed) return;
      const content = mode === "oversize" ? Buffer.alloc(nativeLimits.jsonBytes + 1) : mode === "sse" ? Buffer.from(": fixture\n\n") : Buffer.from("{}");
      incoming.emit("data", content); incoming.complete = mode !== "incomplete"; incoming.emit("end");
    }); return this; }
    destroy() { this.destroyed = true; return this; }
  }
  const request = new FakeRequest(); let receive: (value: IncomingMessage) => void = () => undefined;
  const ports: NativeHttpsPorts = {
    resolver: { async resolve(host) { order.push("resolve"); assert.equal(host, "agent.example.test"); return [mode === "private_dns" ? "10.0.0.1" : "8.8.8.8"]; } },
    connect(options) { observedTls = options; connections++; order.push("connect"); queueMicrotask(() => { order.push("secure"); socket.emit("secureConnect"); }); return socket as unknown as TLSSocket; },
    request(options, handler) { requests++; order.push("http"); observedOptions = options; receive = handler;
      assert.equal(options.createConnection?.({}, () => undefined), socket); assert.equal(options.agent, undefined);
      return request as unknown as ClientRequest;
    },
  };
  const transport = createNativeHttpsTransport(enrollment, async ref => {
    assert.equal(ref, enrollment.credentialRef); order.push("credential"); credentials++; return "synthetic-bearer-not-a-real-secret";
  }, ports, () => instant);
  const wire = (operation: NativeWireRequest["operation"] = "capabilities", patch: Partial<NativeWireRequest> = {}): NativeWireRequest => ({ operation,
    ...(operation === "status" || operation === "stop" || operation === "events" ? { nativeRunId } : {}),
    deadline: instant + 1000, authorize: async () => { order.push("authorize"); }, ...patch });
  return { transport, wire, ports, socket, request, incoming, order,
    counts: () => ({ requests, credentials, connections }), observed: () => ({ options: observedOptions, tls: observedTls, body: sentBody }) };
}

test("native transport construction is inert and sends authentication only through verified pinned TLS", async () => {
  const f = fixture(); assert.deepEqual(f.counts(), { requests: 0, credentials: 0, connections: 0 });
  const result = await f.transport.json(f.wire()); assert.equal(result.status, 200);
  assert.deepEqual(f.order, ["authorize", "resolve", "authorize", "connect", "secure", "credential", "authorize", "http"]);
  assert.deepEqual(f.counts(), { requests: 1, credentials: 1, connections: 1 });
  assert.equal(f.observed().tls?.host, "8.8.8.8"); assert.equal(f.observed().tls?.servername, "agent.example.test");
  assert.equal(f.observed().tls?.rejectUnauthorized, true); assert.deepEqual(f.observed().tls?.ALPNProtocols, ["http/1.1"]);
  assert.equal(f.observed().options?.path, "/p/control_room/v1/capabilities");
  assert.equal(f.observed().options?.maxHeaderSize, 8192);
  assert.equal(f.socket.destroyed, true); assert.equal(f.request.destroyed, true);
});
test("the submission route carries only exact body, isolated session and idempotency key", async () => {
  const f = fixture(), bound = bindNativeStart(enrollment, input);
  await f.transport.json(f.wire("start", { body: bound.body, idempotencyKey: binding.effectClaimKey, sessionKey: binding.sessionId }));
  const actual = f.observed(); assert.equal(actual.options?.method, "POST"); assert.equal(actual.options?.path, "/p/control_room/v1/runs");
  assert.deepEqual(JSON.parse(String(actual.body)), bound.body);
  const headers = actual.options?.headers as Record<string, string>;
  assert.equal(headers["X-Hermes-Session-Key"], binding.sessionId); assert.equal(headers["Idempotency-Key"], binding.effectClaimKey);
  assert.equal(headers["Content-Length"], String(Buffer.byteLength(String(actual.body))));
});
test("status and stop use exact allowlisted native-ID routes without arbitrary RPC payloads", async () => {
  for (const operation of ["status", "stop"] as const) {
    const f = fixture(); await f.transport.json(f.wire(operation));
    assert.equal(f.observed().options?.path, `/p/control_room/v1/runs/${nativeRunId}${operation === "stop" ? "/stop" : ""}`);
    assert.equal(f.observed().body, undefined);
  }
});
test("unapproved destination resolution or peer identity cannot release credentials or HTTP", async () => {
  for (const mode of ["private_dns", "wrong_peer", "wrong_certificate", "unauthorized_tls"] as const) {
    const f = fixture(mode); await assert.rejects(f.transport.json(f.wire()), { message: "native_transport_unavailable" });
    assert.equal(f.counts().credentials, 0); assert.equal(f.counts().requests, 0);
    assert.equal(f.counts().connections, mode === "private_dns" ? 0 : 1);
  }
});
test("wire input cannot select a different URL, session, profile, model or unsupported operation", async () => {
  const bound = bindNativeStart(enrollment, input);
  for (const patch of [{ url: "https://other.example.test" }, { operation: "approve" }, { nativeRunId: "arbitrary" }, { body: {} }]) {
    const f = fixture(); await assert.rejects(f.transport.json({ ...f.wire(), ...patch } as NativeWireRequest), /native_wire_invalid/);
    assert.equal(f.counts().connections, 0);
  }
  const f = fixture(); await assert.rejects(f.transport.json(f.wire("start", { body: { ...bound.body, model: "different" },
    idempotencyKey: binding.effectClaimKey, sessionKey: binding.sessionId })), /native_wire_invalid/);
  assert.equal(f.counts().connections, 0);
});
test("response limits, redirects, compression and incomplete messages fail without a retry", async () => {
  for (const mode of ["redirect", "oversize", "compressed", "incomplete"] as const) {
    const f = fixture(mode); await assert.rejects(f.transport.json(f.wire()), { message: "native_transport_unavailable" });
    assert.deepEqual(f.counts(), { requests: 1, credentials: 1, connections: 1 }); assert.equal(f.socket.destroyed, true);
  }
});
test("a deadline closes only the owned request/socket and does not claim the remote run stopped", async () => {
  const f = fixture("hang"); await assert.rejects(f.transport.json(f.wire("status", { deadline: instant + 15 })), /unavailable/);
  assert.equal(f.socket.destroyed, true); assert.equal(f.request.destroyed, true); assert.equal(f.counts().requests, 1);
});
test("aborted input prevents resolution, connection and credential operations", async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.transport.json(f.wire("status", { signal: controller.signal })), /unavailable/);
  assert.equal(f.order.length, 0); assert.deepEqual(f.counts(), { requests: 0, credentials: 0, connections: 0 });
});
test("authority revoked after TLS is checked again before HTTP bytes leave", async () => {
  const f = fixture(); let checks = 0;
  await assert.rejects(f.transport.json(f.wire("status", { authorize: async () => { if (++checks === 3) throw new Error("private denial"); } })),
    { message: "native_transport_unavailable" });
  assert.equal(f.counts().requests, 0); assert.equal(f.socket.destroyed, true);
});
test("only bounded correctly typed event streams reach the decoder callback", async () => {
  const f = fixture("sse"), chunks: Uint8Array[] = [];
  await f.transport.events(f.wire("events"), chunk => chunks.push(chunk));
  assert.equal(Buffer.concat(chunks).toString(), ": fixture\n\n");
  const wrong = fixture("wrong_sse"); await assert.rejects(wrong.transport.events(wrong.wire("events"), () => assert.fail("not an event stream")), /unavailable/);
});
