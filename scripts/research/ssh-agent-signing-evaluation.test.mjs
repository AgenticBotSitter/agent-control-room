// Opt-in downloaded package evaluation. In-memory protocol only: no socket,
// OpenSSHAgent/createAgent, existing identities, SSH_AUTH_SOCK or credential store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { Transform } from 'node:stream';
import { once } from 'node:events';
import { canonicalJson } from '../../src/security/index.ts';
import { prepareNativeOwnerApprovalMaterial } from '../../src/harness/v1/native-owner-approval-material.ts';
import { verifyArtifactSignature } from '../../src/node-policy/v1/crypto.ts';
import { canonicalApprovalStorageFixture } from '../../tests/helpers/canonical-approval-storage.ts';
import { createBoundedOwnerSignature } from '../../src/harness/v1/bounded-owner-signature.ts';
import { createNativeOwnerApprovalIssuer } from '../../src/harness/v1/native-owner-approval-issuer.ts';

test('paired issuer through bounded actual-package channels reaches canonical intake', { timeout: 15000 }, async t => {
  const f = await canonicalApprovalStorageFixture(); t.after(f.close);
  const keyId = f.packet.approval.body.approvalKeyId;
  const publicKeySpki = Buffer.from(await f.approvals.resolveApprovalKey(keyId)).toString('base64url');
  let channels = 0, closes = 0;
  const issuer = createNativeOwnerApprovalIssuer({ ...f.prepared, approvalKeyId: keyId, issuedAt: f.clock(),
    recoveryExpiresAt: f.prepared.start.deadline + 120000, approvalNonce: 'synthetic-issuer-approval', recoveryNonce: 'synthetic-issuer-recovery' }, {
    publicKeySpki, timeoutMs: 1000, clock: f.clock,
    assertOwnerConsentCurrent(digest) { assert.equal(digest, issuer.reviewDigest); }, // synthetic gate, not real owner attendance
    sign(bytes, signal) {
      channels++; const protocol = new AgentProtocol(true), server = new AgentProtocol(false);
      t.after(() => { protocol.destroy(); server.destroy(); }); server.on('error', () => {});
      protocol.pipe(server).pipe(protocol);
      server.on('sign', (request, _key, data) => server.signReply(request,
        Buffer.from(f.sign(JSON.parse(data.toString())).signature, 'base64url')));
      return createBoundedOwnerSignature({ protocol, publicKeySpki, timeoutMs: 500,
        close() { closes++; protocol.destroy(); server.destroy(); } }).sign(bytes, signal);
    },
  });
  const packet = await issuer.issue(new AbortController().signal);
  assert.equal((await f.save(packet)).startsWork, false); assert.equal(await f.count(), 1);
  assert.equal(channels, 2); assert.equal(closes, 2);
  await assert.rejects(issuer.issue(new AbortController().signal), /issuance_uncertain/);
  assert.equal(channels, 2);
});

const root = process.env.CR_SIGNER_EVAL_ROOT;
assert.ok(root && isAbsolute(root), 'Explicit isolated evaluation root required');
const packageRoot = join(root, 'node_modules/ssh2');
assert.equal(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version, '1.17.0');
assert.equal(createHash('sha256').update(await readFile(join(packageRoot, 'lib/agent.js'))).digest('hex'),
  'cc6987488bf45f73e0ac5d8bbe59912b70a144cd73b53c83919f188f4cc3f2be');
const require = createRequire(import.meta.url);
const { AgentProtocol } = require(join(packageRoot, 'lib/agent.js'));
function sshPublicKey(der) {
  const string = bytes => { const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); return Buffer.concat([size, bytes]); };
  assert.equal(der.length, 44); // exact synthetic Ed25519 SPKI fixture
  return Buffer.concat([string(Buffer.from('ssh-ed25519')), string(der.subarray(-32))]);
}

test('actual ssh2 protocol returns Ed25519 bytes accepted by existing owner intake', { timeout: 15000 }, async t => {
  const f = await canonicalApprovalStorageFixture(); t.after(f.close);
  const keyId = f.packet.approval.body.approvalKeyId;
  const der = Buffer.from(await f.approvals.resolveApprovalKey(keyId));
  const publicKey = sshPublicKey(der), spki = der.toString('base64url');
  const material = prepareNativeOwnerApprovalMaterial({ ...f.prepared, approvalKeyId: keyId,
    issuedAt: f.clock(), recoveryExpiresAt: f.prepared.start.deadline + 120000,
    approvalNonce: 'synthetic-agent-approval', recoveryNonce: 'synthetic-agent-recovery' });
  const client = new AgentProtocol(true), server = new AgentProtocol(false);
  const fragments = new Transform({ transform(chunk, _encoding, done) {
    for (let offset = 0; offset < chunk.length; offset += 3) this.push(chunk.subarray(offset, offset + 3));
    done();
  } });
  t.after(() => { client.destroy(); server.destroy(); fragments.destroy(); });
  client.pipe(server).pipe(fragments).pipe(client);
  const errors = []; client.on('error', error => errors.push(error)); server.on('error', error => errors.push(error));
  const wrongKey = generateKeyPairSync('ed25519').privateKey;
  let calls = 0, mode = 'valid';
  server.on('sign', (request, key, bytes) => {
    calls++;
    assert.deepEqual(key.getPublicSSH(), publicKey);
    if (mode === 'denied') return server.failureReply(request);
    const signed = f.sign(JSON.parse(bytes.toString('utf8')));
    const signature = mode === 'wrong-key' ? sign(null, bytes, wrongKey)
      : mode === 'corrupt' ? Buffer.alloc(64) : Buffer.from(signed.signature, 'base64url');
    server.signReply(request, signature);
  });
  const signBody = body => new Promise((resolve, reject) => client.sign(publicKey, Buffer.from(canonicalJson(body)),
    (error, signature) => error ? reject(error) : resolve({ body, signatureAlgorithm: 'Ed25519', signature: signature.toString('base64url') })));
  const approval = await signBody(material.approval), recovery = await signBody(material.recovery);
  assert.equal(verifyArtifactSignature(approval, spki), true); assert.equal(verifyArtifactSignature(recovery, spki), true);
  assert.equal((await f.save({ schema: 'control-room.native-task-approval-packet/v1', approval, recovery })).startsWork, false);
  assert.equal(await f.count(), 1); assert.equal(calls, 2);
  mode = 'corrupt';
  assert.equal(verifyArtifactSignature(await signBody(material.approval), spki), false, 'protocol success is not signature validity');
  mode = 'wrong-key'; assert.equal(verifyArtifactSignature(await signBody(material.approval), spki), false);
  mode = 'denied'; await assert.rejects(signBody(material.approval));
  assert.equal(calls, 5, 'denial is not automatically retried'); assert.deepEqual(errors, []);
});

test('destroying an unanswered in-memory request reports failure, not a signature', { timeout: 2000 }, async t => {
  const client = new AgentProtocol(true); client.on('error', () => {}); t.after(() => client.destroy());
  const keys = generateKeyPairSync('ed25519');
  const pending = new Promise(resolve => client.sign(sshPublicKey(keys.publicKey.export({ type: 'spki', format: 'der' })),
    Buffer.from('synthetic'), (error, signature) => resolve({ error, signature })));
  client.destroy();
  const result = await pending; assert.ok(result.error); assert.equal(result.signature, undefined);
});

test('malformed reply closes the protocol without settling its signing callback or emitting error', { timeout: 2000 }, async t => {
  const client = new AgentProtocol(true); const errors = [];
  client.on('error', error => errors.push(error)); t.after(() => client.destroy());
  const keys = generateKeyPairSync('ed25519');
  let callbacks = 0;
  client.sign(sshPublicKey(keys.publicKey.export({ type: 'spki', format: 'der' })), Buffer.from('synthetic'),
    () => { callbacks++; });
  const closed = once(client, 'close');
  const writeError = await new Promise(resolve => client.write(Buffer.from([0, 0, 0, 1, 14]), resolve));
  await closed;
  assert.ok(writeError); assert.equal(errors.length, 0);
  assert.equal(callbacks, 0, 'adapter must settle the outer request on protocol closure; callback/error alone can hang');
});

for (const mode of ['valid', 'malformed', 'silent', 'wrong-key', 'abort'])
  test(`bounded wrapper with actual protocol: ${mode}`, { timeout: 3000 }, async t => {
    const keys = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519');
    const protocol = new AgentProtocol(true), server = new AgentProtocol(false);
    const abort = new AbortController(); let requests = 0, closes = 0;
    t.after(() => { protocol.destroy(); server.destroy(); });
    server.on('error', () => {});
    protocol.pipe(server).pipe(protocol);
    server.on('sign', (request, _key, bytes) => {
      requests++;
      if (mode === 'silent') return;
      if (mode === 'abort') return abort.abort();
      if (mode === 'malformed') return protocol.write(Buffer.from([0, 0, 0, 1, 14]), () => {});
      server.signReply(request, sign(null, bytes, mode === 'wrong-key' ? other.privateKey : keys.privateKey));
    });
    const wrapper = createBoundedOwnerSignature({ protocol, timeoutMs: 100,
      publicKeySpki: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url'),
      close() { closes++; protocol.destroy(); server.destroy(); } });
    const bytes = Buffer.from('synthetic exact approval bytes');
    if (mode === 'valid') assert.equal((await wrapper.sign(bytes, abort.signal)).length, 64);
    else await assert.rejects(wrapper.sign(bytes, abort.signal), /owner_signature_unavailable/);
    await assert.rejects(wrapper.sign(bytes, new AbortController().signal), /owner_signature_unavailable/);
    assert.equal(requests, 1); assert.equal(closes, 1);
  });
