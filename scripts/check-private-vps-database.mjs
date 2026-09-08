import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePrivateVpsArguments, validatePrivateVpsConfigurationPath, requirePrivateVpsMode } from './run-private-vps.mjs';

const installedRuntime = Object.freeze({
  loadOperator: path => import(pathToFileURL(path).href),
  loadRelease: () => import('../dist-vps/server/bootstrap.js'),
  report: message => console.log(message),
  reportError: message => console.error(message),
});

/** Explicit operator command. Import is inert; no command-line injection seams,
 * production overrides, app installation, listener or automatic retry. */
export async function checkPrivateVpsDatabase(args, runtime = installedRuntime) {
  try {
    const parsed = parsePrivateVpsArguments(args);
    if (parsed.help) {
      runtime.report('Usage: node scripts/check-private-vps-database.mjs --configuration /absolute/operator-config.mjs');
      runtime.report('Connects to the explicitly configured database for read-only production preflight, then closes. Requires target authorization.');
      return 0;
    }
    await validatePrivateVpsConfigurationPath(parsed.configurationPath);
    const operator = await runtime.loadOperator(parsed.configurationPath);
    if (operator.schema !== 'control-room.private-vps-configuration/v1' || typeof operator.createConfiguration !== 'function')
      throw new Error('private_database_check_configuration_invalid');
    const prepared = await operator.createConfiguration({ signal: new AbortController().signal });
    if (requirePrivateVpsMode(prepared) !== 'website-only' || prepared.configuration.coordinator
      || Object.keys(prepared.configuration).some(key => key !== 'web')) throw new Error('private_database_check_configuration_invalid');
    const release = await runtime.loadRelease();
    const result = await release.checkPrivateWebDatabase(prepared.configuration.web);
    runtime.report(JSON.stringify(result));
    return 0;
  } catch {
    runtime.reportError('Control Room database check failed; inspect the approved target and connection cleanup before retrying. No readiness claim.');
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await checkPrivateVpsDatabase(process.argv.slice(2));
