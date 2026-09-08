// Explicit public metadata acquisition for the pinned evaluation; no packages installed.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const root = process.argv[2];
assert.match(root ?? '', /^\/private\/tmp\/control-room-herdr-eval\.[A-Za-z0-9]+$/);
const pin = 'b99002ac99b09e00b4ca692436cb15a6b0d676f1';
const lock = await readFile(join(root, `herdr-${pin}`, 'Cargo.lock'), 'utf8');
const packages = lock.split('[[package]]').slice(1).map(block => {
  const field = name => block.match(new RegExp(`^${name} = "([^"]+)"`, 'm'))?.[1];
  return { name: field('name'), version: field('version'), source: field('source') ?? 'local', checksum: field('checksum') ?? null };
});
assert.ok(packages.length < 512);
const registry = packages.filter(pkg => pkg.source.startsWith('registry+'));
const deadline = performance.now() + 180000;
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < registry.length) {
    const pkg = registry[next++];
    assert.match(pkg.name, /^[a-zA-Z0-9_-]+$/); assert.match(pkg.version, /^[a-zA-Z0-9.+-]+$/);
    pkg.metadataUrl = `https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}`;
    if (performance.now() >= deadline) { pkg.status = 'not_fetched_deadline'; continue; }
    try {
      const response = await fetch(pkg.metadataUrl, { signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'Agent-Control-Room-license-evaluation (read-only)' } });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const text = await response.text(); assert.ok(Buffer.byteLength(text) < 1000000);
      const metadata = JSON.parse(text).version;
      assert.equal(metadata.crate, pkg.name); assert.equal(metadata.num, pkg.version);
      pkg.license = metadata.license ?? null;
      pkg.metadataSha256 = createHash('sha256').update(text).digest('hex');
      pkg.status = pkg.license ? 'metadata_inspected' : 'license_unknown';
    } catch (e) { pkg.status = 'metadata_unavailable'; pkg.error = e.name === 'AssertionError' ? 'metadata_mismatch' : 'request_failed'; }
  }
}));
const counts = {};
for (const pkg of registry) counts[pkg.license ?? pkg.status] = (counts[pkg.license ?? pkg.status] ?? 0) + 1;
const result = { source: pin, lockSha256: createHash('sha256').update(lock).digest('hex'),
  totalPackages: packages.length, registryPackages: registry.length, counts,
  scope: 'all Cargo.lock targets; metadata is not full license-text or binary redistribution clearance; Zig packages excluded', packages };
await writeFile(join(root, 'cargo-license-inventory.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ totalPackages: packages.length, registryPackages: registry.length, counts }, null, 2));
