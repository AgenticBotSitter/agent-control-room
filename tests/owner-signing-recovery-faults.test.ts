import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { createOwnedOwnerSignature } from "../src/harness/v1/owned-owner-signature";
import { createNativeOwnerApprovalIssuer } from "../src/harness/v1/native-owner-approval-issuer";
import type { OwnerSigningProtocol } from "../src/harness/v1/bounded-owner-signature";
import { nativeStartAuthorityFixture } from "./helpers/native-start-authority";

test("owned signer refuses unavailable, wrong-identity, cancellation, and late responses exactly once", async () => {
  const trusted = generateKeyPairSync("ed25519"), wrong = generateKeyPairSync("ed25519");
  const publicKeySpki = trusted.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  for (const mode of ["unavailable", "wrong_identity", "cancelled", "late"] as const) {
    let opens = 0, closes = 0, signs = 0;
    let callback: ((error: unknown, signature?: Buffer) => void) | undefined;
    let entered!: () => void;
    const signing = new Promise<void>(resolve => { entered = resolve; });
    const protocol: OwnerSigningProtocol = Object.assign(new EventEmitter(), {
      sign(_key: Buffer, bytes: Buffer, done: (error: unknown, signature?: Buffer) => void) {
        signs++; callback = done; entered();
        if (mode === "unavailable") done(new Error("synthetic unavailable"));
        else if (mode === "wrong_identity") done(null, sign(null, bytes, wrong.privateKey));
      },
    });
    const abort = new AbortController();
    const signer = createOwnedOwnerSignature({ publicKeySpki, timeoutMs: 20, open() {
      opens++; return { ready: Promise.resolve(protocol), close() { closes++; } };
    } });
    const pending = signer.sign(Buffer.from("bounded synthetic approval"), abort.signal);
    if (mode === "cancelled") { await signing; abort.abort(); }
    await assert.rejects(pending, /owner_signature_unavailable/);
    callback?.(null, sign(null, Buffer.from("bounded synthetic approval"), trusted.privateKey));
    await new Promise<void>(resolve => setImmediate(resolve));
    await assert.rejects(signer.sign(Buffer.from("again"), new AbortController().signal), /owner_signature_unavailable/);
    assert.deepEqual({ opens, closes, signs }, { opens: 1, closes: 1, signs: 1 });
  }
});

test("current owner-consent revocation between paired signatures refuses the actual issuer without retry", async t => {
  const f = await nativeStartAuthorityFixture(); t.after(f.close);
  const keys = generateKeyPairSync("ed25519");
  const publicKeySpki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  let current = true, checks = 0, signatures = 0;
  const material = { enrollment: f.config.enrollment,
    request: f.prepared.request, start: f.prepared.start, approvalKeyId: "approval-key:fault-matrix",
    issuedAt: Date.parse(f.prepared.request.occurredAt), recoveryExpiresAt: f.prepared.start.deadline + 60_000,
    approvalNonce: "c2VjdXJpdHktZmF1bHQtbWF0cml4LWFwcHJvdmFs",
    recoveryNonce: "c2VjdXJpdHktZmF1bHQtbWF0cml4LXJlY292ZXJ5" };
  let deniedSignatures = 0;
  const denied = createNativeOwnerApprovalIssuer(material, {
    publicKeySpki, timeoutMs: 100, clock: () => Date.parse(f.prepared.request.occurredAt),
    assertOwnerConsentCurrent() { throw new Error("synthetic denied"); },
    async sign() { deniedSignatures++; throw new Error("must not sign"); },
  });
  await assert.rejects(denied.issue(new AbortController().signal), /owner_approval_issuance_uncertain/);
  assert.equal(deniedSignatures, 0);

  const issuer = createNativeOwnerApprovalIssuer(material, {
    publicKeySpki, timeoutMs: 100, clock: () => Date.parse(f.prepared.request.occurredAt),
    assertOwnerConsentCurrent() { checks++; if (!current) throw new Error("synthetic revoked"); },
    async sign(bytes) { signatures++; const signature = sign(null, Buffer.from(bytes), keys.privateKey);
      if (signatures === 1) current = false; return signature; },
  });
  await assert.rejects(issuer.issue(new AbortController().signal), /owner_approval_issuance_uncertain/);
  assert.equal(signatures, 1);
  assert.ok(checks >= 2);
  await assert.rejects(issuer.issue(new AbortController().signal), /owner_approval_issuance_uncertain/);
  assert.equal(signatures, 1);
});
