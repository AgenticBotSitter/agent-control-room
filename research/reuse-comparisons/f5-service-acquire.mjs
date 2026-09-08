// Disposable official-release acquisition only. Does not launch either server.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const assets = [
  { candidate: 'etcd', name: 'etcd-v3.7.1-darwin-arm64.zip', size: 22821078,
    sha256: 'a3e839d9128e170c299b1592bed92d8327f258eb94923aea24a0ccf923cf27e9',
    url: 'https://github.com/etcd-io/etcd/releases/download/v3.7.1/etcd-v3.7.1-darwin-arm64.zip' },
  { candidate: 'openbao', name: 'openbao_2.6.2_darwin_arm64.tar.gz', size: 76833570,
    sha256: '4e495376174accc0e014d31e9901f518a974f966850c839f626347eaac05fd52',
    url: 'https://github.com/openbao/openbao/releases/download/v2.6.2/openbao_2.6.2_darwin_arm64.tar.gz' },
];
const disk = await fs.statfs('/private/tmp');
assert.ok(disk.bavail * disk.bsize >= 20 * 1024 ** 3, 'disk_floor');
const root = await fs.mkdtemp('/private/tmp/cr-f5-services.');
const receiptPath = 'docs/research/reuse-comparisons/f5-service-acquisitions.json';
const receipt = { root, scope: 'Official pinned release archives; no server execution',
  initialFreeBytes: disk.bavail * disk.bsize, assets: [], status: 'acquiring' };
const save = () => fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
await save();
const env = { PATH: '/usr/bin:/bin', TMPDIR: root };
const command = (bin, args) => {
  const result = spawnSync(bin, args, { encoding: 'utf8', env, timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, `${bin}: ${result.error?.code ?? result.stderr}`);
  return result.stdout;
};
try {
  for (const asset of assets) {
    const current = await fs.statfs(root);
    assert.ok(current.bavail * current.bsize >= 20 * 1024 ** 3, 'disk_floor');
    const entry = { ...asset, state: 'downloading', received: 0 };
    receipt.assets.push(entry); await save();
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(120000) });
    assert.ok(response.ok, `download_status_${response.status}`);
    const declared = response.headers.get('content-length');
    if (declared !== null) assert.equal(Number(declared), asset.size);
    const output = await fs.open(`${root}/${asset.name}`, 'wx', 0o600);
    const digest = createHash('sha256');
    try {
      for await (const chunk of response.body) {
        entry.received += chunk.byteLength;
        assert.ok(entry.received <= asset.size, 'archive_size_limit');
        digest.update(chunk);
        let offset = 0;
        while (offset < chunk.length) offset += (await output.write(chunk, offset)).bytesWritten;
      }
    } finally { await output.close(); }
    assert.equal(entry.received, asset.size);
    entry.actualSha256 = digest.digest('hex');
    assert.equal(entry.actualSha256, asset.sha256, 'archive_digest');
    entry.state = 'verified'; await save();
    const archive = `${root}/${asset.name}`;
    const entries = command(asset.candidate === 'etcd' ? '/usr/bin/unzip' : '/usr/bin/tar',
      asset.candidate === 'etcd' ? ['-Z1', archive] : ['-tzf', archive]).trim().split('\n');
    assert.ok(entries.length > 0 && entries.length < 2000);
    for (const name of entries) assert.ok(name && !name.startsWith('/') && !name.split('/').includes('..'), 'archive_path');
    entry.archiveEntries = entries;
    const directory = `${root}/${asset.candidate}`;
    await fs.mkdir(directory, { mode: 0o700 });
    command(asset.candidate === 'etcd' ? '/usr/bin/unzip' : '/usr/bin/tar',
      asset.candidate === 'etcd' ? ['-q', archive, '-d', directory] : ['-xzf', archive, '-C', directory]);
    // Only ordinary files/directories are accepted for the retained distribution.
    async function inventory(dir) {
      const records = [];
      for (const name of await fs.readdir(dir)) {
        const path = `${dir}/${name}`, info = await fs.lstat(path);
        assert.ok(info.isFile() || info.isDirectory(), 'nonordinary_archive_entry');
        if (info.isDirectory()) records.push(...await inventory(path));
        else records.push({ path: path.slice(root.length + 1), bytes: info.size,
          sha256: createHash('sha256').update(await fs.readFile(path)).digest('hex') });
      }
      return records;
    }
    entry.extracted = await inventory(directory);
    assert.ok(entry.extracted.reduce((n, x) => n + x.bytes, 0) < 512 * 1024 ** 2, 'extracted_limit');
    entry.state = 'extracted_not_executed'; await save();
  }
  receipt.allocatedKiB = Number(command('/usr/bin/du', ['-sk', root]).split(/\s/)[0]);
  assert.ok(receipt.allocatedKiB < 1024 * 1024, 'cohort_disk_limit');
  receipt.status = 'ready_not_executed'; await save();
  console.log(JSON.stringify({ root, status: receipt.status, allocatedKiB: receipt.allocatedKiB }));
} catch (error) {
  receipt.status = 'failed_retained_for_inspection'; receipt.error = String(error.message);
  await save(); throw error;
}
