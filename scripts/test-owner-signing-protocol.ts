import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { createOwnedOwnerSignature } from "../src/harness/v1/owned-owner-signature";
import { ownOwnerSigningStream } from "../src/harness/v1/owner-signing-stream";
import { createNativeOwnerApprovalIssuer } from "../src/harness/v1/native-owner-approval-issuer";
import { canonicalApprovalStorageFixture } from "../tests/helpers/canonical-approval-storage";

// Explicit disposable package path; never load ambient SSH_AUTH_SOCK or keys.
const root = process.argv[2];
if (!root || !isAbsolute(root)) throw new Error("supply absolute evaluated ssh2 package directory");
const metadata = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
assert.equal(metadata.name, "ssh2"); assert.equal(metadata.version, "1.17.0");
assert.equal(createHash("sha256").update(await readFile(resolve(root, "lib/agent.js"))).digest("hex"),
  "cc6987488bf45f73e0ac5d8bbe59912b70a144cd73b53c83919f188f4cc3f2be");
const { AgentProtocol } = createRequire(import.meta.url)(root);
const keys = generateKeyPairSync("ed25519"), wrong = generateKeyPairSync("ed25519");
const publicKeySpki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
for (const mode of ["valid", "denied", "missing", "abort", "wrong-key", "short-signature", "acquisition-abort", "acquisition-timeout"] as const) {
  const client = new AgentProtocol(true), server = new AgentProtocol(false);
  const errors: unknown[] = [];
  client.on("error", (e: unknown) => errors.push(e)); server.on("error", (e: unknown) => errors.push(e));
  let requests = 0, closes = 0;
  const abort = new AbortController();
  server.on("sign", (request: unknown, _key: unknown, bytes: Buffer) => {
    requests++;
    assert.equal(bytes.toString(), "synthetic exact approval material");
    if (mode === "missing") return;
    if (mode === "abort") { abort.abort(); return; }
    if (mode === "denied") { server.failureReply(request); return; }
    server.signReply(request, mode === "short-signature" ? Buffer.alloc(32)
      : sign(null, bytes, mode === "wrong-key" ? wrong.privateKey : keys.privateKey));
  });
  let ready!: () => void;
  const delayed = mode === "acquisition-abort" || mode === "acquisition-timeout";
  const signer = createOwnedOwnerSignature({ publicKeySpki, timeoutMs: 100,
    open(signal) {
      const owned = ownOwnerSigningStream({ stream: server, signal, createProtocol: () => client,
        connected: delayed ? new Promise<void>(resolve => { ready = resolve; }) : Promise.resolve() });
      return { ready: owned.ready, close() { closes++; owned.close(); } };
    } });
  const bytes = Buffer.from("synthetic exact approval material");
  try {
    const result = signer.sign(bytes, abort.signal);
    if (mode === "valid") assert.equal((await result).length, 64);
    else {
      const rejected = assert.rejects(result, /owner_signature_unavailable/);
      if (mode === "acquisition-abort") abort.abort();
      await rejected;
    }
    if (delayed) ready();
    await assert.rejects(signer.sign(bytes, new AbortController().signal), /owner_signature_unavailable/);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(requests, delayed ? 0 : 1); assert.equal(closes, 1);
    assert.equal(client.destroyed, !delayed); assert.equal(server.destroyed, true);
    assert.deepEqual(errors, []);
  } finally { client.destroy(); server.destroy(); }
  process.stdout.write(`${mode}: passed; owned in-memory protocols destroyed; no retry\n`);
}

// One disposable canonical fixture, reused serially. Synthetic consent and keys
// prove composition, not real owner presence or custody.
const f = await canonicalApprovalStorageFixture();
try {
  const keyId = f.packet.approval.body.approvalKeyId;
  const publicKeySpki = Buffer.from((await f.approvals.resolveApprovalKey(keyId))!).toString("base64url");
  for (const mode of ["complete", "second-lost", "consent-withdrawn"] as const) {
    let channels = 0, closes = 0, consent = true;
    const streams: Array<InstanceType<typeof AgentProtocol>> = [];
    const issuer = createNativeOwnerApprovalIssuer({ ...f.prepared, approvalKeyId: keyId, issuedAt: f.clock(),
      recoveryExpiresAt: f.prepared.start.deadline + 120000,
      approvalNonce: `synthetic-${mode}-approval`, recoveryNonce: `synthetic-${mode}-recovery` }, {
      publicKeySpki, timeoutMs: 1000, clock: f.clock,
      assertOwnerConsentCurrent(digest) {
        assert.equal(digest, issuer.reviewDigest);
        if (!consent) throw new Error("synthetic consent withdrawn");
      },
      sign(bytes, signal) {
        return createOwnedOwnerSignature({ publicKeySpki, timeoutMs: 100,
          open(signal) {
            channels++; const ordinal = channels;
            const server = new AgentProtocol(false), protocol = new AgentProtocol(true);
            streams.push(server, protocol);
            server.on("error", () => {}); protocol.on("error", () => {});
            server.on("sign", (request: unknown, _key: unknown, data: Buffer) => {
              if (mode === "second-lost" && ordinal === 2) return;
              server.signReply(request, Buffer.from(f.sign(JSON.parse(data.toString())).signature, "base64url"));
              if (mode === "consent-withdrawn") consent = false;
            });
            const owned = ownOwnerSigningStream({ stream: server, signal, connected: Promise.resolve(), createProtocol: () => protocol });
            return { ready: owned.ready, close() { closes++; owned.close(); } };
          } }).sign(bytes, signal);
      },
    });
    try {
      if (mode === "complete") {
        const packet = await issuer.issue(new AbortController().signal);
        assert.equal((await f.save(packet)).startsWork, false);
        assert.equal((await f.save(packet)).replayed, true);
      } else await assert.rejects(issuer.issue(new AbortController().signal), /owner_approval_issuance_uncertain/);
      await assert.rejects(issuer.issue(new AbortController().signal));
      assert.equal(channels, mode === "consent-withdrawn" ? 1 : 2); assert.equal(closes, channels);
      assert.equal(await f.count(), 1);
      assert.ok(streams.every(stream => stream.destroyed));
    } finally { for (const stream of streams) stream.destroy(); }
    process.stdout.write(`paired issuer ${mode}: passed; no dispatch or retry\n`);
  }
} finally { await f.close(); }
