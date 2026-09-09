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

const installedRuntime = Object.freeze({
  signals: process,
  report: message => console.log(message),
  reportError: message => console.error(message),
  loadOperator: path => import(pathToFileURL(path).href),
  loadRelease: () => Promise.all([
    import('../dist-vps/server/taskHost.js'), import('../dist-vps/server/serving.js'),
    import('../dist-vps/server/index.js'),
    import('../dist-vps/server/bootstrap.js'),
    import('../dist-vps/server/ideaAuthoring.js'),
  ]),
});

/** Operator intent/completeness check only. Existing bootstrap validates each
 * actual resource, role, trust pin and authority; this cannot certify them. */
export function requirePrivateVpsMode(prepared) {
  const coordinator = prepared?.configuration?.coordinator;
  if (!prepared?.configuration || !['website-only', 'agent-tasks'].includes(prepared.mode)) {
    throw new Error('private_vps_mode_invalid');
  }
  if ('ideaAuthoring' in prepared.configuration && (prepared.mode !== 'website-only' || coordinator))
    throw new Error('private_vps_mode_invalid');
  if (prepared.mode === 'website-only') {
    if (coordinator?.nativeQueue || coordinator?.queueWorker || coordinator?.nativeHttp || prepared.nativeHttps
      || coordinator && 'ideaRuntime' in coordinator || 'news' in prepared.configuration) {
      throw new Error('private_vps_mode_invalid');
    }
  } else if (!coordinator || coordinator.nativeQueue !== true || coordinator.nativeQueueRecovery !== true
    || coordinator.revisionPlanning !== true || !coordinator.queueWorker || !coordinator.nativeHttp
    || !coordinator.approvals || !coordinator.quality || !coordinator.resultDatabase
    || !coordinator.evidence || !coordinator.sessions || !prepared.nativeHttps) {
    throw new Error('private_vps_mode_invalid');
  }
  return prepared.mode;
}

// Explicit in-process dependency injection supports offline tests. The CLI never
// accepts runtime factories, import overrides or a test-mode flag from arguments.
export async function runPrivateVps(args, runtime = installedRuntime) {
  const parsed = parsePrivateVpsArguments(args);
  if (parsed.help) {
    runtime.report('Usage: node scripts/run-private-vps.mjs --configuration /absolute/operator-config.mjs');
    runtime.report('Starts real resources. Requires approved operator setup; never use test credentials.');
    return 0;
  }
  await validatePrivateVpsConfigurationPath(parsed.configurationPath);
  // Fixed paths in this release, not cwd or a request-supplied module search path.
  const [{ createInstalledPrivateTaskHost, startPrivateHostLifecycle }, serving, renderer, bootstrap, ideaAuthoring] = await runtime.loadRelease();
  let mode;
  const lifecycle = startPrivateHostLifecycle({ signals: runtime.signals, async start(signal) {
    const active = () => { if (signal.aborted) throw new Error('private_vps_start_canceled'); };
    active();
    const operator = await runtime.loadOperator(parsed.configurationPath);
    active();
    if (operator.schema !== 'control-room.private-vps-configuration/v1'
      || typeof operator.createConfiguration !== 'function') throw new Error('private_vps_configuration_invalid');
    const prepared = await operator.createConfiguration({ signal });
    active();
    mode = requirePrivateVpsMode(prepared);
    const assets = await serving.loadPrivateClientAssets(fileURLToPath(new URL('../dist-vps/client', import.meta.url)));
    active();
    if (mode === 'website-only' && !prepared.configuration.coordinator) {
      return startWebsiteOnly(prepared, { bootstrap, ideaAuthoring, serving, handler: renderer.default, assets, signal });
    }
    return createInstalledPrivateTaskHost().start({
      configuration: prepared.configuration, port: prepared.port, nativeHttps: prepared.nativeHttps,
      handler: renderer.default, assets, signal,
    });
  } });
  try {
    await lifecycle.ready;
    runtime.report(mode === 'website-only'
      ? 'Control Room website-only host ready. Agent execution is disabled.'
      : 'Control Room agent-task host ready. Live-agent connectivity still requires verification.');
  } catch {
    await lifecycle.stop();
    runtime.reportError('Control Room startup failed; cleanup may require operator attention.');
    return 1;
  }
  const result = await lifecycle.completed;
  if (result.status !== 'closed') {
    runtime.reportError('Control Room cleanup uncertain; operator attention required.');
    return 1;
  }
  runtime.report('Control Room private host closed.');
  return 0;
}

/** Reuses the restricted production web bootstrap, with no task planner or worker.
 * Cleanup ownership transfers to the existing loopback service after construction.
 */
export async function startWebsiteOnly(prepared, { bootstrap, ideaAuthoring, serving, handler, assets, signal }) {
  requirePrivateVpsMode(prepared);
  const port = prepared.port;
  if (prepared.mode !== 'website-only' || prepared.configuration.coordinator
    || Object.keys(prepared.configuration).some(key => !['web', 'ideaAuthoring'].includes(key))
    || !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error('private_vps_mode_invalid');
  const config = bootstrap.validatePrivateStartupConfiguration(prepared.configuration.web);
  const authoring = 'ideaAuthoring' in prepared.configuration
    ? ideaAuthoring.validatePrivateIdeaAuthoringConfiguration(prepared.configuration) : undefined;
  if (signal.aborted) throw new Error('private_vps_start_canceled');
  const application = authoring ? await ideaAuthoring.startPrivateIdeaAuthoringApplication(authoring, signal)
    : await bootstrap.startPrivateWebApplication(config);
  let service;
  const close = () => service ? service.close() : application.close();
  const cancel = () => { void close().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw new Error('private_vps_start_canceled');
    service = serving.createPrivateNodeService({ origin: config.origin,
      secondaryOrigin: config.secondaryAccess?.origin, port,
      application, handler, assets });
    await service.start();
    if (signal.aborted) throw new Error('private_vps_start_canceled');
    return service;
  } catch (error) {
    await close();
    throw error;
  } finally { signal.removeEventListener('abort', cancel); }
}

// Import is inert. A service manager owns final termination if cleanup cannot finish.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await runPrivateVps(process.argv.slice(2)); }
  catch { console.error('Control Room launcher refused setup.'); process.exitCode = 1; }
}
