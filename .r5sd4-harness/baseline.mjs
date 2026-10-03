import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
const files = ['docs/install/E2E2_REHEARSAL.md', 'mutation-checks/cook-r5sdeny.json', 'scripts/install/rehearsal/check-bots-stopped.mjs', 'tests/e2e2-rehearsal.mjs'];
const originals = new Map(files.map(file => [file, readFileSync(file)]));
const backup = '.r5sd4-harness/baseline-backup';
mkdirSync(backup, { recursive: true });
for (const [index, file] of files.entries()) writeFileSync(join(backup, String(index)), originals.get(file));
const restore = () => { for (const [file, bytes] of originals) writeFileSync(file, bytes); };
process.once('exit', restore);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { restore(); process.exit(128); });
try {
  for (const file of files) writeFileSync(file, execFileSync('git', ['show', `HEAD:${file}`]));
  const pattern = 'every release program composed|uid-wide cleanup kills|a build that exits after leaving|journal: dead writer lock|journal: a reclaimed PID stamp|journal: fifty stale-lock recoverers|R2F-02: a journal PID stamp|real vendoring feeds';
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-timeout=45000', '--test-name-pattern=' + pattern,
    'tests/updater-attended-release-programs.test.mjs', 'tests/updater-attended-source.test.mjs', 'tests/updater-file-hardening.test.mjs', 'tests/updater-round2-files.test.mjs', 'tests/updater-runtime-vendor.test.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; process.stdout.write(data); });
  child.stderr.on('data', data => { output += data; process.stderr.write(data); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 120000);
  let status;
  try { status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timer); try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  console.log('BASELINE EXIT', status, 'TIMED OUT', timedOut);
  const failed = output.split('\n').filter(line => /^not ok /u.test(line));
  console.log('BASELINE FAILED CASES', failed.length);
  if (status === 0 || timedOut || failed.length !== 8) process.exitCode = 1;
} finally {
  restore();
  for (const [file, bytes] of originals) if (!readFileSync(file).equals(bytes)) throw new Error('baseline_restore_refused');
  console.log('ALL FOUR MODIFIED FILES RESTORED BYTE FOR BYTE');
}
