import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePrivateVpsArguments, validatePrivateVpsConfigurationPath } from './run-private-vps.mjs';

export function parsePrivateNodeArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  if (args.length !== 4 || args[2] !== '--mode' || !['initial', 'recover'].includes(args[3]))
    throw new Error('private_node_arguments_invalid');
  return { ...parsePrivateVpsArguments(args.slice(0, 2)), mode: args[3] };
}

const installed = Object.freeze({
  signals: process,
  report: message => console.log(message),
  reportError: message => console.error(message),
  loadOperator: path => import(pathToFileURL(path).href),
  loadRelease: () => import('../dist-vps/server/nodeConnector.js'),
});

async function observeCleanup(work) {
  let timer;
  try { await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('private_node_cleanup_uncertain')), 15_000);
  })]); } finally { clearTimeout(timer); }
}

/** Trusted executable operator module, not an upload/plugin or a sandbox. The
 * factory owns partial-open cleanup until it returns; the launcher then owns its
 * close callback. Only approved persistent resources may be supplied. No defaults
 * for identities, credentials, enrollment, journals, recovery or trust pins. */
export async function runPrivateNode(args, runtime = installed) {
  const parsed = parsePrivateNodeArguments(args);
  if (parsed.help) {
    runtime.report('Usage: node scripts/run-private-node.mjs --configuration /absolute/node-config.mjs --mode initial|recover');
    runtime.report('One explicit Hermes task only. Requires approved operator setup. Never auto-restart after uncertainty.');
    return 0;
  }
  await validatePrivateVpsConfigurationPath(parsed.configurationPath);
  const lifetime = new AbortController();
  const stop = () => lifetime.abort();
  runtime.signals.on('SIGINT', stop); runtime.signals.on('SIGTERM', stop);
  // Requests cancellation during acquisition as well as the connector. Uncooperative operator code is
  // not contained by AbortSignal; the supervising operator owns final termination.
  const timer = setTimeout(stop, 300_000);
  const current = () => { if (lifetime.signal.aborted) throw new Error('private_node_stopped'); };
  let resources, node, connector, result, failed = false, cleanupUncertain = false;
  let releaseResources;
  try {
    current(); const release = await runtime.loadRelease(); current();
    const operator = await runtime.loadOperator(parsed.configurationPath); current();
    if (operator.schema !== 'control-room.private-node-configuration/v1'
      || typeof operator.createConfiguration !== 'function') throw new Error('private_node_configuration_invalid');
    resources = await operator.createConfiguration({ signal: lifetime.signal, mode: parsed.mode });
    if (typeof resources?.close !== 'function') throw new Error('private_node_resource_owner_missing');
    releaseResources = resources.close.bind(resources);
    current();
    if (resources.harness !== 'hermes-native-v1') throw new Error('private_node_harness_unsupported');
    node = release.createNativeNodeRuntime(resources.node, resources.dependencies);
    current();
    connector = release.createNativeHttpsConnector(node, resources.https, resources.settings, resources.sources);
    current();
    result = await connector.run(parsed.mode, lifetime.signal);
    current();
    // Do not log states/identities from an operator-supplied object. Only a fixed
    // completion category is emitted; terminal failure is not successful work.
    if (result?.disposition !== 'terminal' || result.state !== 'completed') failed = true;
  } catch { failed = true; }
  finally {
    lifetime.abort();
    try {
      // The connector owns the node once constructed. Do not close persistent
      // journals underneath an unresolved runtime; retain them on uncertain drain.
      if (connector) await observeCleanup(() => connector.close());
      else if (node) await observeCleanup(() => node.close());
    } catch { cleanupUncertain = true; }
    if (!cleanupUncertain && releaseResources) {
      try { await observeCleanup(releaseResources); } catch { cleanupUncertain = true; }
    } else if (resources && !releaseResources) cleanupUncertain = true;
    clearTimeout(timer);
    runtime.signals.removeListener('SIGINT', stop); runtime.signals.removeListener('SIGTERM', stop);
  }
  if (cleanupUncertain) {
    runtime.reportError('Control Room node cleanup uncertain. Preserve journals; operator attention required. No automatic retry.');
    return 1;
  }
  if (failed) {
    runtime.reportError('Control Room node attempt did not confirm completed work. Preserve journals and review before explicit recovery.');
    return 1;
  }
  runtime.report('Control Room node reported completed work and closed. Server receipt and owner review remain authoritative.');
  return 0;
}

// Import/help is inert. This command opens real resources only with explicit args.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await runPrivateNode(process.argv.slice(2)); }
  catch { console.error('Control Room node launcher refused setup.'); process.exitCode = 1; }
}
