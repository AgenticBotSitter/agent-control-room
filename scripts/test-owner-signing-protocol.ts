import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { createOwnedOwnerSignature } from "../src/harness/v1/owned-owner-signature";
import { ownOwnerSigningStream } from "../src/harness/v1/owner-signing-stream";

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
