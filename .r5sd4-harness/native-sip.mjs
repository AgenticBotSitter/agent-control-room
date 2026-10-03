import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { checkOwnerBotsStoppedV1 } from '../scripts/install/rehearsal/check-bots-stopped.mjs';
const nativeRun = promisify(execFile);
const paths = [
  '/Library/Apple/System/Library/CoreServices/XProtect.app/Contents/MacOS/XProtect',
  '/Library/Apple/System/Library/CoreServices/XProtect.app/Contents/XPCServices/XProtectPluginService.xpc/Contents/MacOS/XProtectPluginService',
  '/System/Volumes/Preboot/Cryptexes/OS/System/Library/PrivateFrameworks/SafariPlatformSupport.framework/Versions/A/XPCServices/com.apple.SafariPlatformSupport.Helper.xpc/Contents/MacOS/com.apple.SafariPlatformSupport.Helper',
  '/bin/sleep',
];
assert.ok(paths.every(existsSync), 'native controls must exist on this Mac');
for (const [index, path] of paths.entries()) {
  const details = await nativeRun('/usr/bin/codesign', ['-d', '--verbose=4', path], { timeout: 5000, killSignal: 'SIGKILL' });
  const platform = /^Platform identifier=\d+$/mu.test(details.stdout + '\n' + details.stderr);
  assert.equal(platform, index >= 2, 'native Platform identifier control');
  console.log('NATIVE METADATA', basename(path), 'Platform identifier', platform ? 'present' : 'absent');
}
const kernel = paths.map((path, index) => `p${701 + index}\nu501\nR1\nfcwd\ntDIR\nn/fixture/plain\nftxt\ntREG\ni${statSync(path, { bigint: true }).ino}\nn${path}\n`).join('');
for (const enabled of [true, false]) {
  let sipReads = 0;
  const run = (file, args, options) => {
    if (file === '/usr/bin/csrutil') {
      sipReads++;
      assert.deepEqual(args, ['status']);
      return enabled ? nativeRun(file, args, options) : Promise.resolve({ stdout: 'System Integrity Protection status: disabled.\n', stderr: '' });
    }
    if (file === '/bin/ps') return Promise.resolve({ stdout: '', stderr: '' });
    if (file === '/usr/sbin/lsof') return Promise.resolve({ stdout: kernel, stderr: '' });
    assert.equal(file, '/usr/bin/codesign');
    return nativeRun(file, args, options);
  };
  const rows = await checkOwnerBotsStoppedV1({ run, ownerUid: 501, selfPid: 999999, alive: () => true });
  assert.equal(sipReads, 1);
  assert.deepEqual(rows.map(row => row.pid), enabled ? [] : [701, 702]);
  assert.ok(rows.every(row => row.family === 'unidentified'));
  console.log('NATIVE SIGNING / INJECTED MEMBERSHIP: SIP', enabled ? 'native enabled' : 'injected disabled', 'listed', rows.map(row => basename(row.executable)).join(', ') || 'none');
}
