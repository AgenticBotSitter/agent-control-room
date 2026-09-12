// Owner-authorized research download only. Does not mount/install/run the bundle.
import { mkdtemp, open, stat, statfs, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const url = 'https://github.com/PostgresApp/PostgresApp/releases/download/v2.9.6/Postgres-2.9.6-17.dmg';
const expectedBytes = 119621638;
const expectedSha256 = 'b38bb00b8c8702a568270aab85995c550f7f93d1503b818efdc5ff9a519b7168';
const fs = await statfs('/private/tmp');
const freeBefore = fs.bavail * fs.bsize;
assert.ok(freeBefore > 20 * 1024 ** 3, 'free disk below research floor');
const root = await mkdtemp('/private/tmp/cr-f8-pg17.');
const path = join(root, 'Postgres-2.9.6-17.dmg');
const ledgerPath = join(root, 'acquisition.json');
const receipt = {schema:'control-room.research-download/v1', root, path, url,
  revision:'0e7a7084f7467ceacbaf757019b6e9bb1fb5ab7d', expectedBytes, expectedSha256,
  freeBefore, bytes:0, status:'started', downloadedSha256:null, cleanup:'retained; exact owned root only',
  effects:'download only; no mount, app execution, install, service or database'};
await writeFile(ledgerPath, JSON.stringify(receipt,null,2), {flag:'wx',mode:0o600});
console.log(JSON.stringify({root,ledgerPath,freeBefore,status:'started'}));
const hash = createHash('sha256');
let file;
try {
  const response = await fetch(url, {signal:AbortSignal.timeout(180000), redirect:'follow'});
  assert.equal(response.status,200); assert.ok(response.url.startsWith('https://'));
  receipt.finalUrlHost = new URL(response.url).hostname;
  const length = response.headers.get('content-length');
  if (length !== null) assert.equal(Number(length),expectedBytes);
  file = await open(path,'wx',0o600);
  for await (const chunk of response.body) {
    receipt.bytes += chunk.byteLength;
    assert.ok(receipt.bytes <= expectedBytes, 'archive exceeded published size');
    hash.update(chunk);
    let offset = 0;
    while (offset < chunk.byteLength) offset += (await file.write(chunk, offset, chunk.byteLength-offset)).bytesWritten;
  }
  await file.close(); file=undefined;
  receipt.downloadedSha256=hash.digest('hex');
  assert.equal(receipt.bytes,expectedBytes); assert.equal((await stat(path)).size,expectedBytes);
  assert.equal(receipt.downloadedSha256,expectedSha256);
  receipt.status='downloaded-digest-verified-signature-unverified';
} catch(error) { receipt.status='failed-retained-for-exact-cleanup'; receipt.error=String(error.message); process.exitCode=1; }
finally {
  await file?.close();
  await writeFile(ledgerPath,JSON.stringify(receipt,null,2),{mode:0o600});
  console.log(JSON.stringify(receipt));
}
