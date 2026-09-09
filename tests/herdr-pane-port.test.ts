import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHerdrPaneListPort } from '../src/web/v1/herdr-pane-port';
const config = { executable: '/fixture/bin/herdr', socket: '/fixture/run/api.sock', configPath: '/fixture/config/herdr.toml',
  configRoot: '/fixture/config', stateRoot: '/fixture/state' };
function child() {
  const events = new EventEmitter(); let kills = 0;
  const result = Object.assign(events, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill(signal: string) { assert.equal(signal, 'SIGKILL'); kills++; return true; } });
  return { process: result as unknown as ChildProcessWithoutNullStreams, kills: () => kills,
    cleanup() { result.stdin.destroy(); result.stdout.destroy(); result.stderr.destroy(); } };
}
test('pane port captures only explicit paths and fixed read command, and waits for child close', async t => {
  const f = child(); t.after(f.cleanup); const input = { ...config };
  const port = createHerdrPaneListPort(input, (file, args, options) => {
    assert.equal(file, config.executable); assert.deepEqual(args, ['pane', 'list']);
    assert.equal(options.shell, false); assert.equal(options.cwd, config.configRoot);
    assert.deepEqual(options.env, { NODE_ENV: 'production', PATH: '/usr/bin:/bin', HERDR_SOCKET_PATH: config.socket,
      HERDR_CONFIG_PATH: config.configPath, XDG_CONFIG_HOME: config.configRoot, XDG_STATE_HOME: config.stateRoot });
    return f.process;
  });
  input.executable = '/different';
  const pending = port(new AbortController().signal); let settled = false; void pending.then(() => { settled = true; });
  f.process.stdout.emit('data', Buffer.from('{"result":true}'));
  f.process.emit('exit', 0, null); await Promise.resolve(); assert.equal(settled, false);
  f.process.emit('close', 0, null); assert.equal(await pending, '{"result":true}'); assert.equal(f.kills(), 0);
});
test('cancel and oversized output kill only the owned client and require terminal close before rejection', async t => {
  for (const mode of ['abort', 'stdout', 'stderr', 'error']) {
    const f = child(); t.after(f.cleanup); const stop = new AbortController();
    const pending = createHerdrPaneListPort(config, () => f.process)(stop.signal);
    let settled = false; void pending.catch(() => { settled = true; });
    if (mode === 'abort') stop.abort();
    else if (mode === 'error') f.process.emit('error', new Error('private diagnostic'));
    else f.process[mode as 'stdout' | 'stderr'].emit('data', Buffer.alloc(256 * 1024 + 1));
    await Promise.resolve(); assert.equal(settled, false); assert.equal(f.kills(), 1);
    f.process.emit('close', null, 'SIGKILL'); await assert.rejects(pending, /^Error: observation_unavailable$/);
  }
});
test('pre-abort launches nothing and invalid UTF8 is refused after close', async t => {
  const stop = new AbortController(); stop.abort();
  await assert.rejects(createHerdrPaneListPort(config, () => { throw new Error('must not launch'); })(stop.signal));
  const f = child(); t.after(f.cleanup);
  const pending = createHerdrPaneListPort(config, () => f.process)(new AbortController().signal);
  f.process.stdout.emit('data', Buffer.from([0xff])); f.process.emit('close', 0, null);
  await assert.rejects(pending, /^Error: observation_unavailable$/);
});
