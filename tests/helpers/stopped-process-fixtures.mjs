import { execFile, spawn } from 'node:child_process';
import { appendFile, chmod, copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { once } from 'node:events';

const run = promisify(execFile);
const children = new Set();
process.once('exit', () => { for (const child of children) { child.stdin?.destroy(); try { process.kill(-child.pid, 'SIGKILL'); } catch {} } });
const nodeBody = "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); console.log('ready');\n";
const pythonBody = "import sys\nprint('ready', flush=True)\nsys.stdin.buffer.read()\n";

export async function stoppedProcessFixtures() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stopped-process-fixture-')));
  const launcher = join(root, 'group-exec'), source = join(root, 'group-exec.c');
  const clobber = join(root, 'erased-worker'), clobberSource = join(root, 'erased-worker.c');
  await writeFile(source, '#include <unistd.h>\n#include <stdlib.h>\nint main(int argc,char **argv){if(argc<2||setpgid(0,0))return 70;execvp(argv[1],argv+1);return 71;}\n');
  await writeFile(clobberSource, '#include <unistd.h>\n#include <string.h>\n#include <stdlib.h>\nint main(int argc,char **argv){char *title=strdup(argc>1?argv[1]:"My Agent Worker");size_t capacity=strlen(argv[0]);for(int i=0;i<argc;i++)memset(argv[i],0,strlen(argv[i]));strncpy(argv[0],title,capacity);free(title);write(1,"ready\\n",6);char b[256];while(read(0,b,sizeof(b))>0){}return 0;}\n');
  // Prepare everything before spawning a stand-in. Compiler failure leaves no helper.
  try {
    await run('/usr/bin/cc', ['-O0', '-o', launcher, source], { timeout: 20_000 });
    await run('/usr/bin/cc', ['-O0', '-o', clobber, clobberSource], { timeout: 20_000 });
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  const started = [];
  const file = async (relative, body) => { const path = join(root, relative); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, body); return path; };
  const start = async (label, program, args, options = {}) => {
    const child = spawn(launcher, [program, ...args], { cwd: root, ...options, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    started.push({ label, program, args, child, cwd: options.cwd ?? root });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    if (process.env.CONTROL_ROOM_TEST_PID_RECORD) await appendFile(process.env.CONTROL_ROOM_TEST_PID_RECORD, JSON.stringify({ pid: child.pid, label }) + '\n');
    const deadline = Date.now() + 5_000;
    while (!output.includes('ready\n') && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    if (!output.includes('ready\n')) throw new Error(`stand_in_not_ready:${label}:${errors}`);
    return child;
  };
  const stop = async () => {
    for (const { child } of started) {
      const closed = child.exitCode === null && child.signalCode === null ? once(child, 'close') : Promise.resolve();
      child.stdin.end();
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await closed; children.delete(child);
      try { process.kill(-child.pid, 0); throw new Error('stand_in_group_remains'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    await rm(root, { recursive: true, force: true });
  };
  const populate = async () => {
    const copy = join(root, 'runtime-copy'), hard = join(root, 'runtime-hardlink'), sym = join(root, 'runtime-symlink');
    await copyFile(process.execPath, copy); await chmod(copy, 0o755); await link(copy, hard); await symlink(copy, sym);
    const signed = join(root, 'runtime-resigned'); await copyFile(copy, signed);
    await run('/usr/bin/codesign', ['--force', '--sign', '-', signed], { timeout: 10_000 });
    const scripts = [
      ['claude-worker/cli.js', 'claude'], ['codex-tool/bin/codex.js', 'codex'], ['hermes-elsewhere/run.js', 'hermes'],
      ['node_modules/@anthropic-ai/claude-code/index.js', 'claude'], ['node_modules/@openai/codex/bin/codex.js', 'codex'],
      ['lib/opencode-ai/index.js', 'opencode'], ['home/.hermes/agent/run.js', 'hermes'], ['plain/run.js', 'unidentified'],
    ];
    for (const [relative] of scripts) await start(relative, process.execPath, [await file(relative, nodeBody)]);
    const family = await file('claude-worker/wrapped.js', nodeBody);
    for (const [name, program] of [['copy', copy], ['hardlink', hard], ['symlink', sym], ['re-signed', signed]]) await start(name, program, [family]);
    for (const name of ['bun', 'deno', 'tsx']) { const path = join(root, name); await symlink(process.execPath, path); await start(name, path, [family]); }
    await start('env wrapper', '/usr/bin/env', [process.execPath, family]);
    await start('shell exec wrapper', '/bin/bash', ['-c', 'exec "$1" "$2"', 'fixture', process.execPath, family]);
    await start('exec-a wrapper', '/bin/bash', ['-c', 'exec -a myworker "$1" "$2"', 'fixture', process.execPath, family]);
    for (const title of ['My Agent Worker', 'runtime-resigned idle', '/fixture/plain', '']) {
      await start(`node title ${title || 'empty'}`, signed, [await file(`plain/title-${started.length}.js`, `process.title=${JSON.stringify(title)};\n${nodeBody}`)]);
    }
    for (const title of ['My Agent Worker', 'erased-worker idle', '/fixture/plain']) await start(`native title ${title}`, clobber, [title, family]);
    const folder = join(root, 'hermes-data'); await mkdir(folder); await file('hermes-data/marker.txt', 'folders stay intact\n');
    await start('family folder', clobber, ['erased-worker idle'], { cwd: folder });
    await start('generic shell script', '/bin/sh', [await file('plain/loop.sh', "printf 'ready\\n'\nwhile IFS= read -r line; do :; done\n")]);
    for (const name of ['opencode', 'opencode-ai', 'myclaude', 'claude2.1.13', 'codex_2.1.13', 'hermes_worker', 'codex-agent',
      'home/.claude/versions/2.1.13', 'home/claude/versions/2.1.13', 'Applications/Claude.app/Contents/MacOS/Claude', 'Volumes/Fixture Disk/cli/codex']) {
      const path = join(root, name); await mkdir(join(path, '..'), { recursive: true }); await copyFile(clobber, path);
      await start(`binary ${name}`, path, ['My Agent Worker']);
    }
    const python = '/opt/homebrew/bin/python3';
    if (existsSync(python)) {
      const module = await file('claude-worker/pkg/__main__.py', pythonBody);
      await start('generic Python module', python, ['-m', 'pkg'], { env: { ...process.env, PYTHONPATH: join(module, '../..') } });
      await start('Python file', python, [await file('hermes-worker/run.py', pythonBody)]);
      await start('generic Python file', python, [await file('plain/run.py', pythonBody)]);
    }
  };
  return { root, launcher, clobber, start, started, stop, populate, marker: () => readFile(join(root, 'hermes-data/marker.txt'), 'utf8') };
}
