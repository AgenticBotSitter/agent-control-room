import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);

// Populate a disposable bare origin by fetching from its disposable seed.
// This exercises real Git refs without executing a push command.
export async function publishLocalFixtureV1(seed, source = 'main') {
  const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], { cwd: seed });
  const url = stdout.trim(), origin = url.startsWith('file:') ? fileURLToPath(url) : url;
  if (!isAbsolute(origin)) throw new Error('fixture_origin_must_be_local');
  await exec('git', ['fetch', '--no-tags', seed, `+${source}:refs/heads/main`], { cwd: origin });
}
