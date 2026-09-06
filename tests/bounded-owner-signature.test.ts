import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import { createBoundedOwnerSignature, type OwnerSigningProtocol } from "../src/harness/v1/bounded-owner-signature";

test("bounded signer copies bytes, rejects mutation and never retries a closed attempt", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeySpki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  for (const mode of ["valid", "mutation", "late", "pre-abort", "oversize", "close-failed"] as const) {
    const emitter = new EventEmitter(); let calls = 0, closes = 0;
    let callback: ((error: unknown, signature?: Buffer) => void) | undefined;
    const input = Buffer.from("original"), abort = new AbortController();
    const protocol: OwnerSigningProtocol = Object.assign(emitter, {
      sign(_key: Buffer, data: Buffer, done: (error: unknown, signature?: Buffer) => void) {
        calls++; callback = done;
        if (mode === "late") return;
        if (mode === "mutation") data.fill(1);
        done(null, sign(null, data, keys.privateKey));
      },
    });
    const wrapper = createBoundedOwnerSignature({ protocol, publicKeySpki, timeoutMs: 20, close() {
      closes++; if (mode === "close-failed") throw new Error("synthetic cleanup detail");
    } });
    if (mode === "pre-abort") abort.abort();
    const result = wrapper.sign(mode === "oversize" ? Buffer.alloc(24_577) : input, abort.signal);
    if (mode === "valid") assert.equal((await result).length, 64);
    else await assert.rejects(result, /owner_signature_unavailable/);
    callback?.(null, sign(null, input, keys.privateKey));
    await assert.rejects(wrapper.sign(input, new AbortController().signal), /owner_signature_unavailable/);
    assert.equal(calls, ["pre-abort", "oversize"].includes(mode) ? 0 : 1);
    assert.equal(closes, 1); assert.equal(input.toString(), "original");
    assert.equal(emitter.listenerCount("close"), 0);
  }
});
