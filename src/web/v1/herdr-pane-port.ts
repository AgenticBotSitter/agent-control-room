import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { isAbsolute, normalize } from 'node:path';

type Launch = (file: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
/** This is an unwired process adapter, NOT executable/endpoint qualification.
 * The operator must pin and verify the binary and isolated configuration before
 * supplying these paths. The collector separately checks endpoint identity.
 * No shell, arbitrary arguments, inherited credentials or server autostart API.
 */
export function createHerdrPaneListPort(input: {
  executable: string; socket: string; configPath: string; configRoot: string; stateRoot: string;
}, launch: Launch = (file, args, options) => spawn(file, args, options)) {
  const config = { ...input };
  for (const value of Object.values(config)) {
    if (typeof value !== 'string' || !isAbsolute(value) || normalize(value) !== value
        || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('observation_configuration_invalid');
  }
  if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error('observation_platform_unqualified');
  return async (signal: AbortSignal): Promise<string> => {
    if (signal.aborted) throw new Error('observation_unavailable');
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = launch(config.executable, ['pane', 'list'], { shell: false, windowsHide: true,
          cwd: config.configRoot, env: { PATH: '/usr/bin:/bin', HERDR_SOCKET_PATH: config.socket,
            HERDR_CONFIG_PATH: config.configPath, XDG_CONFIG_HOME: config.configRoot, XDG_STATE_HOME: config.stateRoot } });
      } catch { reject(new Error('observation_unavailable')); return; }
      let failed = false, closed = false, bytes = 0;
      const output: Buffer[] = [];
      const erase = () => { for (const chunk of output) chunk.fill(0); output.length = 0; };
      const stop = () => {
        if (closed || failed) return;
        failed = true; erase();
        try { child.kill('SIGKILL'); } catch { /* Close remains required; no cleanup success inferred. */ }
      };
      const timer = setTimeout(stop, 2000);
      signal.addEventListener('abort', stop, { once: true });
      // Error observers remain through close. Neither kill() nor an error is an
      // exit acknowledgement; an unclosed child keeps this promise unsettled.
      child.on('error', stop); child.stdin.on('error', stop);
      child.stdout.on('error', stop); child.stderr.on('error', stop);
      child.stdout.on('data', (chunk: Buffer) => {
        if (closed || failed) return;
        bytes += chunk.byteLength;
        if (bytes > 256 * 1024) { stop(); return; }
        output.push(Buffer.from(chunk));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (closed || failed) return;
        bytes += chunk.byteLength;
        if (bytes > 256 * 1024) stop();
      });
      child.once('close', (code, terminationSignal) => {
        closed = true; clearTimeout(timer); signal.removeEventListener('abort', stop);
        if (failed || signal.aborted || code !== 0 || terminationSignal !== null) {
          erase(); reject(new Error('observation_unavailable')); return;
        }
        const combined = Buffer.concat(output);
        try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(combined)); }
        catch { reject(new Error('observation_unavailable')); }
        finally { combined.fill(0); erase(); }
      });
      if (signal.aborted) stop();
      try { child.stdin.end(); } catch { stop(); }
    });
  };
}
