import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { lstat, realpath } from 'node:fs/promises';

export function parsePrivateVpsArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length !== 2 || args[0] !== '--configuration' || !isAbsolute(args[1])
    || !args[1].endsWith('.mjs') || [...args[1]].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error('private_vps_arguments_invalid');
  }
  return { configurationPath: args[1] };
}

/** This module is trusted executable operator configuration, NOT uploaded data or
 * a plugin. Permission checks do not contain its code or defeat same-UID/admin edits.
 */
export async function validatePrivateVpsConfigurationPath(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || await realpath(path) !== path
    || typeof process.getuid !== 'function' || stat.uid !== process.getuid()
    || (stat.mode & 0o077) !== 0 || stat.size > 256 * 1024) {
    throw new Error('private_vps_configuration_invalid');
  }
}

export async function runPrivateVps(args) {
  const parsed = parsePrivateVpsArguments(args);
  if (parsed.help) {
    console.log('Usage: node scripts/run-private-vps.mjs --configuration /absolute/operator-config.mjs');
    console.log('Starts real resources. Requires approved operator setup; never use test credentials.');
    return 0;
  }
  await validatePrivateVpsConfigurationPath(parsed.configurationPath);
  // Fixed paths in this release, not cwd or a request-supplied module search path.
  const [{ createInstalledPrivateTaskHost, startPrivateHostLifecycle }, serving, renderer] = await Promise.all([
    import('../dist-vps/server/taskHost.js'), import('../dist-vps/server/serving.js'),
    import('../dist-vps/server/index.js'),
  ]);
  const lifecycle = startPrivateHostLifecycle({ signals: process, async start(signal) {
    const active = () => { if (signal.aborted) throw new Error('private_vps_start_canceled'); };
    active();
    const operator = await import(pathToFileURL(parsed.configurationPath).href);
    active();
    if (operator.schema !== 'control-room.private-vps-configuration/v1'
      || typeof operator.createConfiguration !== 'function') throw new Error('private_vps_configuration_invalid');
    const prepared = await operator.createConfiguration({ signal });
    active();
    const assets = await serving.loadPrivateClientAssets(fileURLToPath(new URL('../dist-vps/client', import.meta.url)));
    active();
    return createInstalledPrivateTaskHost().start({
      configuration: prepared.configuration, port: prepared.port, nativeHttps: prepared.nativeHttps,
      handler: renderer.default, assets, signal,
    });
  } });
  try {
    await lifecycle.ready;
    console.log('Control Room private host ready.');
  } catch {
    await lifecycle.stop();
    console.error('Control Room startup failed; cleanup may require operator attention.');
    return 1;
  }
  const result = await lifecycle.completed;
  if (result.status !== 'closed') {
    console.error('Control Room cleanup uncertain; operator attention required.');
    return 1;
  }
  console.log('Control Room private host closed.');
  return 0;
}

// Import is inert. A service manager owns final termination if cleanup cannot finish.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await runPrivateVps(process.argv.slice(2)); }
  catch { console.error('Control Room launcher refused setup.'); process.exitCode = 1; }
}
