import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import { createOwnedOwnerSignature } from "../src/harness/v1/owned-owner-signature";
import type { OwnerSigningProtocol } from "../src/harness/v1/bounded-owner-signature";

test("one owned deadline covers acquisition and signing, closes once and refuses late readiness", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeySpki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  for (const mode of ["valid", "pre-abort", "acquisition-abort", "acquisition-timeout", "readiness-rejected", "signing-abort", "signing-timeout", "close-failure"] as const) {
    let opens = 0, closes = 0, calls = 0;
    let ready!: (value: OwnerSigningProtocol) => void;
    let rejectReady!: (error: Error) => void;
    let callback: ((error: unknown, signature?: Buffer) => void) | undefined;
    let acquisitionSignal: AbortSignal | undefined;
    const protocol = Object.assign(new EventEmitter(), {
      sign(_key: Buffer, bytes: Buffer, done: (error: unknown, signature?: Buffer) => void) {
        calls++; callback = done; assert.equal(bytes.toString(), "original material");
        if (mode === "signing-abort" || mode === "signing-timeout") return;
        done(null, sign(null, bytes, keys.privateKey));
      },
    });
    const abort = new AbortController(), body = Buffer.from("original material");
    const signer = createOwnedOwnerSignature({ publicKeySpki, timeoutMs: 40,
      open(signal) {
        opens++; acquisitionSignal = signal;
        return { ready: new Promise<OwnerSigningProtocol>((resolve, reject) => { ready = resolve; rejectReady = reject; }),
          close() { closes++; if (mode === "close-failure") throw new Error("synthetic private detail"); } };
      } });
    if (mode === "pre-abort") abort.abort();
    const result = signer.sign(body, abort.signal);
    // Attach a rejection observer before triggering synchronous cancellation.
    const outcome = mode === "valid" ? result.then(value => assert.equal(value.length, 64))
      : assert.rejects(result, { message: "owner_signature_unavailable" });
    body.fill(0);
    if (mode === "acquisition-abort") abort.abort();
    else if (mode === "readiness-rejected") rejectReady(new Error("synthetic endpoint unavailable"));
    else if (mode !== "pre-abort" && mode !== "acquisition-timeout") {
      ready(protocol);
      await new Promise<void>(resolve => setImmediate(resolve));
      if (mode === "signing-abort") abort.abort();
    }
    await outcome;
    if (opens) {
      assert.equal(acquisitionSignal!.aborted, true); ready(protocol);
      callback?.(null, sign(null, Buffer.from("original material"), keys.privateKey));
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(opens, mode === "pre-abort" ? 0 : 1);
    assert.equal(closes, opens);
    assert.equal(calls, ["valid", "signing-abort", "signing-timeout", "close-failure"].includes(mode) ? 1 : 0);
    await assert.rejects(signer.sign(Buffer.from("again"), new AbortController().signal));
    assert.equal(closes, opens);
  }
});

test("invalid signing input never starts acquisition", async () => {
  const keys = generateKeyPairSync("ed25519");
  const publicKeySpki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(24577)]) {
    let opens = 0;
    const signer = createOwnedOwnerSignature({ publicKeySpki, timeoutMs: 100,
      open() { opens++; throw new Error("must not open"); } });
    await assert.rejects(signer.sign(bytes, new AbortController().signal)); assert.equal(opens, 0);
  }
});
