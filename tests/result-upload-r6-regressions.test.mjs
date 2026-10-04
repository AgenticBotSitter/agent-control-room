import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
const { ResultUploadStagingV1, stagedChunkNameV1 } = await import('../src/artifacts/v1/result-upload-staging.ts');
import { FleetUploadStoreV1 } from '../src/fleet/v1/upload-store.ts';
const { createFleetGatewayHandlerV1 } = await import('../src/fleet/v1/gateway-http.ts');
import { createFleetReleaseTrustForTestV1 } from './support/fleet-release.ts';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const hex = n => n.toString(16).padStart(32, '0');
const tenantId = 'tenant:qa-r6';
const projectId = 'project:qa-r6';
const claimId = `fleet-claim:${hex(1)}`;
const uploadId = `result-upload:${hex(2)}`;
const fileId = `result-file:${hex(3)}`;
const setId = `result-set:${hex(4)}`;
const workerId = `fleet-worker:${hex(5)}`;
const identity = { tenantId, projectId, uploadId, ordinal: 1 };
const principal = { tenantId, workerId, identityId: 'identity:qa-r6', projectIds: [projectId] };
const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const configuration = rootPath => ({ rootPath, maximumChunkBytes: 1024, operationTimeoutMs: 5000 });
async function fixture(run) {
  const base = await fs.realpath(await fs.mkdtemp(join(await fs.realpath((await import('node:os')).tmpdir()), 'cr-r6fl-')));
  try { return await run(base); }
  finally { await fs.rm(base, { recursive: true, force: true }); }
}
async function privateRoot(base, name) {
  const root = join(base, name); await fs.mkdir(root, { mode: 0o700 }); return root;
}
function replaceOpen(wrapper) {
  const original = fs.open;
  fs.open = (...args) => wrapper(original, ...args);
  syncBuiltinESMExports();
  return () => { fs.open = original; syncBuiltinESMExports(); };
}
function requestFor(body, upload = uploadId, claimedDigest = digest(body), ordinal = 1) {
  const request = Readable.from([body]);
  Object.assign(request, { method: 'POST',
    url: `/fleet/v1/claims/${claimId}/uploads/${upload}/chunks`,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(body.length),
      'x-control-room-chunk-ordinal': String(ordinal), 'x-control-room-chunk-digest': claimedDigest },
    socket: { remoteAddress: '192.0.2.10' } });
  return request;
}
function responseFor() {
  const response = new EventEmitter();
  Object.assign(response, { headersSent: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(body) { this.body = String(body); }, destroy() { this.destroyed = true; } });
  return response;
}
async function exchange(handler, request) {
  const response = responseFor();
  try { await handler.handle(request, response); return response; }
  finally { request.destroy(); response.removeAllListeners(); }
}
function gateway(uploads) {
  return createFleetGatewayHandlerV1({ releaseTrust: createFleetReleaseTrustForTestV1().trust,
    store: { authenticate: async () => principal }, uploads,
    admission: { enter: () => ({ completeAuthentication() {}, release() {} }) } });
}

// A strict stand-in returning only the rows the actual store queries. It does
// not execute SQL, enforce grants, or pretend to prove production transactions.
function uploadDatabase(expectedBytes) {
  const row = { upload_id: uploadId, project_id: projectId, job_id: 'job:qa-r6', attempt_id: 'attempt:qa-r6',
    set_id: setId, ordinal: 1, worker_id: workerId, claim_id: claimId,
    expected_size_bytes: String(expectedBytes.length), expected_content_digest: digest(expectedBytes),
    chunk_size_bytes: 8 * 1024 * 1024, expected_chunks: 1, state: 'reserved',
    created_at: new Date(NOW).toISOString(), expires_at: new Date(NOW + 60000).toISOString(), received_at: null,
    file_id: fileId, display_name: 'report.txt', declared_media_type: 'text/plain', detected_media_type: 'text/plain' };
  const chunks = new Map();
  const client = { async transaction(run) { return run(client); }, async query(sql, params) {
    if (sql.includes('FROM fleet_claims')) return { rows: [{ claim_id: claimId,
      project_id: projectId, job_id: row.job_id, attempt_id: row.attempt_id }] };
    if (sql.includes('FROM control_result_upload_sessions')) return { rows: [row] };
    if (sql.includes('INSERT INTO control_result_upload_chunks')) {
      if (chunks.has(params[2])) { const error = new Error('synthetic_duplicate'); error.code = '23505'; throw error; }
      chunks.set(params[2], { ordinal: params[2], size_bytes: String(params[3]), chunk_digest: params[4] });
      return { rows: [] };
    }
    if (sql.includes('FROM control_result_upload_chunks')) return { rows: sql.includes('ordinal=$3')
      ? [chunks.get(params[2])].filter(Boolean) : [...chunks.values()] };
    throw new Error('unexpected_fake_statement');
  } };
  return { client, chunks, row };
}

// The database below is a statement stand-in, not PostgreSQL evidence.
test('R6FL-02: digest mismatch refuses before staging; 50 mismatches and correct resend', { timeout: 8000 }, async () => fixture(async base => {
  const root = await privateRoot(base, 'staging');
  const staging = await ResultUploadStagingV1.create(configuration(root));
  const approved = Buffer.from('GOOD'), swapped = Buffer.from('EVIL');
  const fake = uploadDatabase(approved);
  let stored = 0, calls = 0;
  const uploads = new FleetUploadStoreV1(fake.client, { tenantId, clock: () => NOW, staging,
    store: { read: async () => undefined, put: async () => { stored++; } } });
  const originalChunk = uploads.chunk.bind(uploads);
  uploads.chunk = (...args) => { calls++; return originalChunk(...args); };
  const handler = gateway(uploads);
  const responses = await Promise.all(Array.from({ length: 50 }, () =>
    exchange(handler, requestFor(swapped, uploadId, digest(approved)))));
  for (const response of responses) {
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(response.body).error, 'invalid');
  }
  assert.equal(calls, 0, 'no mismatch reaches uploads.chunk');
  assert.equal(fake.chunks.size, 0);
  assert.deepEqual(await fs.readdir(root), []);
  const retry = await exchange(handler, requestFor(approved));
  assert.equal(retry.status, 201);
  assert.equal(fake.chunks.get(1).chunk_digest, digest(approved));
  assert.deepEqual(Buffer.from(await staging.read(identity)), approved);
  assert.equal((await exchange(handler, requestFor(approved))).status, 201);
  // Keep the independent final whole-file guard: syntactically correct chunk
  // ingress does not substitute for the owner's approved file digest.
  fake.row.expected_content_digest = digest(swapped);
  await assert.rejects(uploads.finalise(principal, { claimId, uploadId }), error => error.code === 'invalid');
  assert.equal(stored, 0);
}));

async function bounded(promise, ms = 8000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('regression deadline exceeded')), ms);
  })]); } finally { clearTimeout(timer); }
}

async function afterCleanup(action) {
  const deadline = Date.now() + 8000;
  for (;;) {
    try { return await action(); }
    catch (error) {
      if (error.code !== 'staging_ambiguous' || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

for (const phase of ['open', 'writeFile', 'sync', 'close', 'read', 'readdir', 'link', 'link-replaced', 'directory-sync']) {
  test(`R6FL-01: stalled ${phase} expires, holds only its root, cleans late I/O and retries`, { timeout: 30000 }, async () => fixture(async base => {
    const root = await privateRoot(base, 'blocked'), otherRoot = await privateRoot(base, 'other');
    const staging = await ResultUploadStagingV1.create({ ...configuration(root), operationTimeoutMs: 150 });
    const peer = await ResultUploadStagingV1.create({ ...configuration(root), operationTimeoutMs: 150 });
    const other = await ResultUploadStagingV1.create({ ...configuration(otherRoot), operationTimeoutMs: 15000 });
    if (phase === 'read') await staging.stage(identity, Buffer.from('first'));
    let release, reached;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { reached = resolve; });
    let intercept = true, closed = 0;
    const originalReaddir = fs.readdir, originalLink = fs.link;
    const restore = replaceOpen(async (original, path, ...args) => {
      const handle = await original(path, ...args);
      // The root is also opened (with O_EXLOCK, 0x20) for the integrated disk-budget
      // lock; the directory-sync phase hooks only the plain open used for the sync.
      if (intercept && (phase === 'directory-sync' ? path === root && !(Number(args[0]) & 0x20) : String(path).startsWith(root + '/') &&
        (phase === 'read' ? String(path).endsWith('.chunk') : ['open', 'writeFile', 'sync', 'close'].includes(phase) && String(path).endsWith('.part')))) {
        intercept = false;
        const originalClose = handle.close.bind(handle);
        handle.close = async () => { closed++; return originalClose(); };
        if (phase === 'open') { reached(); await gate; }
        else {
          const methodName = phase === 'directory-sync' ? 'sync' : phase;
          const method = handle[methodName].bind(handle);
          handle[methodName] = async (...values) => { reached(); await gate; return method(...values); };
        }
      }
      return handle;
    });
    if (phase === 'readdir') {
      fs.readdir = async (...args) => {
        if (intercept && args[0] === root) { intercept = false; reached(); await gate; }
        return originalReaddir(...args);
      };
      syncBuiltinESMExports();
    }
    if (phase === 'link' || phase === 'link-replaced') {
      fs.link = async (...args) => {
        if (intercept && String(args[0]).startsWith(root + '/')) {
          intercept = false;
          if (phase === 'link-replaced') {
            await originalLink(...args);
            await fs.unlink(args[1]);
            await fs.writeFile(args[1], 'competitor', { mode: 0o600 });
            reached(); await gate; return;
          }
          reached(); await gate;
        }
        return originalLink(...args);
      };
      syncBuiltinESMExports();
    }
    const jobs = [];
    try {
      const start = Date.now();
      jobs.push((phase === 'read' || phase === 'readdir' ? staging.read(identity) : staging.stage(identity, Buffer.from('first')))
        .then(value => ({ value, ms: Date.now() - start }), error => ({ code: error.code, ms: Date.now() - start })));
      await bounded(entered);
      const queued = peer.stage({ ...identity, uploadId: `result-upload:${hex(9)}` }, Buffer.from('queued'))
        .then(value => ({ value }), error => ({ code: error.code }));
      jobs.push(queued);
      if (phase === 'sync') {
        const refused = [peer.read(identity), peer.stagedNames(), peer.assemble(identity, 1),
          peer.discardChunk(identity), peer.discardSession(identity),
          ResultUploadStagingV1.create({ ...configuration(root), operationTimeoutMs: 150 })]
          .map(promise => promise.then(value => ({ value }), error => ({ code: error.code })));
        jobs.push(...refused);
        const blocked = Array.from({ length: 50 }, (_, i) =>
          peer.stage({ ...identity, uploadId: `result-upload:${hex(500 + i)}` }, Buffer.from('blocked'))
            .then(value => ({ value }), error => ({ code: error.code })));
        jobs.push(...blocked);
        for (const outcome of await bounded(Promise.all([...refused, ...blocked]))) assert.equal(outcome.code, 'staging_ambiguous');
        const refusedAt = Date.now();
        const afterTimeout = peer.stage({ ...identity, uploadId: `result-upload:${hex(10)}` }, Buffer.from('still blocked'))
          .then(value => ({ value }), error => ({ code: error.code }));
        jobs.push(afterTimeout);
        assert.equal((await bounded(afterTimeout)).code, 'staging_ambiguous', 'root remains closed after caller timeout');
        assert.ok(Date.now() - refusedAt < 100, 'uncertain root rejects new work immediately');
        const fake = uploadDatabase(Buffer.from('GOOD'));
        const uploads = new FleetUploadStoreV1(fake.client, { tenantId, clock: () => NOW, staging,
          store: { read: async () => undefined, put: async () => { throw new Error('unexpected publication'); } } });
        const response = await exchange(gateway(uploads), requestFor(Buffer.from('GOOD')));
        assert.equal(response.status, 503);
        assert.equal(JSON.parse(response.body).error, 'unavailable');
        assert.equal(fake.chunks.size, 0);
      }
      // Different root: all 50 writes finish while the first disk operation is still stalled.
      const burstJobs = Array.from({ length: 50 }, (_, i) =>
        other.stage({ ...identity, uploadId: `result-upload:${hex(100 + i)}` }, Buffer.from('other')));
      jobs.push(...burstJobs);
      const burst = await bounded(Promise.all(burstJobs));
      assert.equal(burst.length, 50);
      const expired = await bounded(jobs[0]);
      assert.equal(expired.code, 'staging_ambiguous');
      assert.ok(expired.ms < 1000, `150 ms deadline returned in ${expired.ms} ms`);
      assert.equal((await bounded(queued)).code, 'staging_ambiguous', 'queue wait consumes the caller deadline');
      assert.ok(!(await fs.readdir(root)).some(name => name === stagedChunkNameV1(tenantId, projectId, `result-upload:${hex(9)}`, 1)),
        'queued expired caller did not touch disk');
      release();
      // Observe cleanup before any fresh retry can itself publish. A retry
      // that links within its deadline but times out on sync may safely replay.
      const remaining = await afterCleanup(() => staging.stagedNames());
      const present = ['read', 'directory-sync', 'link-replaced'].includes(phase);
      assert.deepEqual(remaining, present ? [stagedChunkNameV1(tenantId, projectId, uploadId, 1)] : [],
        'late I/O left only a previously published chunk or the competitor');
      if (phase === 'link-replaced') {
        await assert.rejects(afterCleanup(() => staging.stage(identity, Buffer.from('first'))), error => error.code === 'staging_conflict');
      } else {
        const recovered = await afterCleanup(() => staging.stage(identity, Buffer.from('first')));
        assert.equal(recovered.digest, digest(Buffer.from('first')));
        if (present) assert.equal(recovered.replayed, true);
      }
      if (!['readdir', 'link', 'link-replaced'].includes(phase)) assert.ok(closed > 0, 'late-opened handle was closed');
      assert.deepEqual(Buffer.from(await staging.read(identity)), Buffer.from(phase === 'link-replaced' ? 'competitor' : 'first'));
      assert.ok((await fs.readdir(root)).every(name => name.endsWith('.chunk')), 'no partial scratch survives');
      assert.equal(await staging.read({ ...identity, uploadId: `result-upload:${hex(9)}` }), undefined);
      if (phase === 'sync') {
        for (const id of [10, ...Array.from({ length: 50 }, (_, i) => 500 + i)])
          assert.equal(await staging.read({ ...identity, uploadId: `result-upload:${hex(id)}` }), undefined);
      }
    } finally {
      release();
      await Promise.allSettled(jobs);
      // Drain the shared root queue before restoring hooks and removing the fixture.
      await afterCleanup(() => staging.stagedNames()).catch(() => {});
      await afterCleanup(() => other.stagedNames()).catch(() => {});
      restore(); fs.readdir = originalReaddir; fs.link = originalLink; syncBuiltinESMExports();
    }
  }));
}

test('R6FL-01: assembly shares one deadline across chunks and retries after late read', { timeout: 10000 }, async () => fixture(async base => {
  const root = await privateRoot(base, 'aggregate');
  const staging = await ResultUploadStagingV1.create({ ...configuration(root), operationTimeoutMs: 150 });
  for (let ordinal = 1; ordinal <= 4; ordinal++) await staging.stage({ ...identity, ordinal }, Buffer.from('piece'));
  const restore = replaceOpen(async (original, path, ...args) => {
    const handle = await original(path, ...args);
    if (String(path).endsWith('.chunk')) {
      const read = handle.read.bind(handle);
      handle.read = async (...values) => {
        await new Promise(resolve => setTimeout(resolve, 80));
        return read(...values);
      };
    }
    return handle;
  });
  try {
    const start = Date.now();
    await assert.rejects(staging.assemble(identity, 4), error => error.code === 'staging_ambiguous');
    assert.ok(Date.now() - start < 1000);
  } finally {
    // Waiting for this root also drains the late read before fixture teardown.
    await afterCleanup(() => staging.stagedNames()).catch(() => {});
    restore();
  }
  assert.deepEqual(Buffer.from(await staging.assemble(identity, 4)), Buffer.from('piece'.repeat(4)));
}));

test('R6FL-01: discard refuses an unaccounted or replaced root without deleting bytes', { timeout: 8000 }, async () => fixture(async base => {
  const root = await privateRoot(base, 'discard');
  const staging = await ResultUploadStagingV1.create(configuration(root));
  await staging.stage(identity, Buffer.from('original'));
  await fs.writeFile(join(root, 'stray'), 'unaccounted', { mode: 0o600 });
  await assert.rejects(staging.discardChunk(identity), error => error.code === 'staging_ambiguous');
  await fs.unlink(join(root, 'stray'));
  await fs.rename(root, join(base, 'moved'));
  await fs.mkdir(root, { mode: 0o700 });
  const name = stagedChunkNameV1(tenantId, projectId, uploadId, 1);
  await fs.writeFile(join(root, name), 'replacement', { mode: 0o600 });
  await assert.rejects(staging.discardSession(identity), error => error.code === 'staging_ambiguous');
  assert.equal(await fs.readFile(join(root, name), 'utf8'), 'replacement');
  assert.equal(await fs.readFile(join(base, 'moved', name), 'utf8'), 'original');
}));
