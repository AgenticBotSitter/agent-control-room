import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { nativeNodeRuntimeFixture } from "./helpers/native-node-runtime";
import { currentSignal } from "./helpers/managed-native-session";
import { signNodeFrame } from "../src/node-protocol/v1";
import { response, statusBody } from "./hermes-native-fixture";
import type { NativeWireResponse } from "../src/harness/hermes-native-v1/contracts";

test("a saved same-server delivery under another trusted key cannot start under the runtime's exact pins", async t => {
  const f = await nativeNodeRuntimeFixture(); t.after(f.close); await f.runtime.close();
  const other = generateKeyPairSync("ed25519"), load = f.journal.acceptedNativeDelivery.bind(f.journal);
  const resolve = f.dependencies.security.resolveServerKey.bind(f.dependencies.security);
  f.dependencies.security.resolveServerKey = async key => key === "key:other-server"
    ? new Uint8Array(other.publicKey.export({ format: "der", type: "spki" })) : resolve(key);
  f.journal.acceptedNativeDelivery = queue => {
    const saved = load(queue); if (!saved) return saved;
    const { signature, bodyDigest, ...frame } = saved.frame; void signature; void bodyDigest;
    // The owner-approved packet/body and node receipt remain genuine; only the server
    // signing key differs. The alternate key is available to the trusted resolver.
    return { ...saved, frame: signNodeFrame({ ...frame, keyId: "key:other-server" }, other.privateKey) };
  };
  const node = f.create(), c = await f.connect("initial", node); await f.dispatch(c);
  assert.equal(f.x.local.journal.load(f.x.f.prepared.binding.runId), undefined);
  await assert.rejects(f.x.admin(() => node.start(currentSignal())));
  assert.deepEqual(f.x.local.calls, []);
  assert.equal(f.x.local.journal.load(f.x.f.prepared.binding.runId), undefined);
});

test("two abort-ignoring raw status calls consume retained slots and prevent a third call", async t => {
  const f = await nativeNodeRuntimeFixture(); await f.runtime.close();
  const original = f.dependencies.transport.json.bind(f.dependencies.transport);
  const completions: ((value: NativeWireResponse) => void)[] = [];
  let entered: (() => void) | undefined;
  f.dependencies.transport.json = async request => {
    if (request.operation !== "status") return original(request);
    await request.authorize(); f.x.local.calls.push("status");
    const pending = new Promise<NativeWireResponse>(resolve => completions.push(resolve));
    entered?.(); return pending; // Deliberately ignores the supplied abort signal.
  };
  const node = f.create(), c = await f.connect("initial", node); await f.dispatch(c);
  await f.x.admin(() => node.start(currentSignal())); await f.pump(c);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let closing: Promise<void> | undefined;
  try {
    for (let i = 0; i < 2; i++) {
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const poll = f.x.admin(() => node.poll(currentSignal())); await ready;
      t.mock.timers.tick(10_000);
      const snapshot = await poll; assert.equal(snapshot.availability, "offline");
    }
    assert.equal(completions.length, 2);
    await assert.rejects(f.x.admin(() => node.poll(currentSignal())));
    assert.equal(completions.length, 2, "no third raw status transport is entered");
    closing = node.close(); const rejected = assert.rejects(closing, /native_node_runtime_close_uncertain/);
    t.mock.timers.tick(10_000); await rejected;
  } finally {
    for (const resolve of completions) resolve(response(statusBody("running", { session_id: f.x.f.prepared.binding.sessionId })));
    await new Promise<void>(resolve => setImmediate(resolve));
    if (closing) await assert.rejects(f.close(), /synthetic_node_runtime_cleanup_uncertain/);
    else await f.close();
  }
});
