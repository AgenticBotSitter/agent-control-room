import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { ownOwnerSigningStream } from "../src/harness/v1/owner-signing-stream";

test("stream ownership destroys failed acquisitions and never creates a late protocol", async () => {
  for (const mode of ["abort", "error", "end", "close", "rejected", "already-destroyed"] as const) {
    const stream = new PassThrough(), abort = new AbortController();
    let resolve!: () => void, reject!: (e: Error) => void, created = 0;
    if (mode === "already-destroyed") stream.destroy();
    const owned = ownOwnerSigningStream({ stream, signal: abort.signal,
      connected: new Promise<void>((yes, no) => { resolve = yes; reject = no; }),
      createProtocol() { created++; return Object.assign(new PassThrough(), { sign() {} }); } });
    const refused = assert.rejects(owned.ready, { message: "owner_signature_unavailable" });
    if (mode === "abort") abort.abort();
    if (mode === "error") stream.emit("error", new Error("synthetic private endpoint detail"));
    if (mode === "end" || mode === "close") stream.emit(mode);
    if (mode === "rejected") reject(new Error("synthetic connection failure"));
    if (mode === "already-destroyed") resolve();
    await refused; resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(created, 0); assert.equal(stream.destroyed, true);
    owned.close(); owned.close();
  }
});

test("ready stream cleanup owns both directions and retains cleanup failure", async () => {
  const stream = new PassThrough(), protocol = Object.assign(new PassThrough(), { sign() {} });
  const owned = ownOwnerSigningStream({ stream, connected: Promise.resolve(), signal: new AbortController().signal,
    createProtocol: () => protocol });
  assert.equal(await owned.ready, protocol);
  owned.close(); assert.equal(stream.destroyed, true); assert.equal(protocol.destroyed, true);
  owned.close();
  const failingStream = new PassThrough();
  const originalDestroy = failingStream.destroy.bind(failingStream);
  failingStream.destroy = () => { originalDestroy(); throw new Error("synthetic cleanup failure"); };
  const failed = ownOwnerSigningStream({ stream: failingStream, connected: new Promise<void>(() => {}),
    signal: new AbortController().signal, createProtocol: () => Object.assign(new PassThrough(), { sign() {} }) });
  assert.throws(() => failed.close(), /owner_signature_unavailable/);
  assert.throws(() => failed.close(), /owner_signature_unavailable/);
  await assert.rejects(failed.ready);
});

test("cancellation inside protocol creation destroys the returned protocol too", async () => {
  const stream = new PassThrough(), abort = new AbortController();
  const protocol = Object.assign(new PassThrough(), { sign() {} });
  const owned = ownOwnerSigningStream({ stream, connected: Promise.resolve(), signal: abort.signal,
    createProtocol() { abort.abort(); return protocol; } });
  await assert.rejects(owned.ready);
  assert.equal(stream.destroyed, true); assert.equal(protocol.destroyed, true);
});
