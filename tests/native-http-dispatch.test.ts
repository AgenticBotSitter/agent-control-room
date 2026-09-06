import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { TLSSocket } from "node:tls";
import test from "node:test";
import { createNativeHttpHost } from "../src/web/v1/native-http-host";
import type { ManagedNativeSessions } from "../src/web/v1/managed-native-sessions";

test("dispatch captures input and cannot transmit on a replacement after its stage settles", async t => {
  const raw = Buffer.from("synthetic dispatch TLS certificate"), digest = `sha256:${"a".repeat(64)}`;
  let release!: () => void, entered!: () => void;
  const staging = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const calls: { id: number; operation: string; subject?: string; jobId?: string }[] = [];
  let count = 0;
  const host = createNativeHttpHost({ origin: "https://machine.example.test", peers: [{ nodeId: "node:dispatch",
    certificateDigest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    task: { projectId: "project:test", jobId: "job:test", attemptId: "attempt:test", inputDigest: digest } }],
    isPeerCurrent: () => true, isReady: () => true,
    connections: { attachWire: (async () => {
      const id = ++count;
      return { nodeId: "node:dispatch", grantsExecutionAuthority: false, receive: async () => {},
        stage: async (actor: { subject: string }, task: { jobId: string }) => {
          if (id === 1) { entered(); await held; }
          calls.push({ id, operation: "stage", subject: actor.subject, jobId: task.jobId });
        }, transmit: async () => { calls.push({ id, operation: "transmit" }); return { sent: true }; },
        close: async () => { calls.push({ id, operation: "close" }); } };
    }) as unknown as ManagedNativeSessions["attachWire"] },
  });
  t.after(host.close);
  const socket = { encrypted: true, authorized: true, destroyed: false, getPeerCertificate: () => ({ raw }) } as unknown as TLSSocket;
  const open = async () => {
    const body = JSON.stringify({ schema: "control-room.native-http/v1", operation: "open", mode: "initial" });
    const response = await host.handle(new Request("https://machine.example.test/v1/control-room/native", {
      method: "POST", body, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } }), socket);
    assert.equal(response.status, 200);
  };
  await open();
  const identity = { provider: "test", subject: "owner:test", tokenDigest: digest,
    issuedAt: "2026-09-06T12:00:00.000Z", expiresAt: "2026-09-06T13:00:00.000Z", verificationExpiresAt: "2026-09-06T13:00:00.000Z" };
  const task = { projectId: "project:test", jobId: "job:test", inputDigest: digest, packetDigest: digest };
  const pending = host.dispatch("node:dispatch", identity, task, new AbortController().signal);
  const denied = assert.rejects(pending, { message: "native_http_unavailable" });
  await staging;
  assert.throws(() => host.dispatch("node:dispatch", identity, task, new AbortController().signal), /native_http_unavailable/);
  identity.subject = "owner:mutated"; task.jobId = "job:mutated";
  await open(); release(); await denied;
  assert.deepEqual(calls.filter(call => call.operation === "stage"), [{ id: 1, operation: "stage", subject: "owner:test", jobId: "job:test" }]);
  assert.equal(calls.some(call => call.operation === "transmit"), false);
  await host.dispatch("node:dispatch", { ...identity, subject: "owner:test" }, { ...task, jobId: "job:test" }, new AbortController().signal);
  assert.deepEqual(calls.slice(-2).map(call => [call.id, call.operation]), [[2, "stage"], [2, "transmit"]]);
});
