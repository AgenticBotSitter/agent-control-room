import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePrivateVpsArguments, validatePrivateVpsConfigurationPath } from './run-private-vps.mjs';

const installed = Object.freeze({
  loadOperator: path => import(pathToFileURL(path).href),
  loadRelease: () => import('../dist-vps/server/ownerBootstrap.js'),
  report: value => console.log(value), reportError: value => console.error(value),
});

/** Explicit production write command. No automatic invocation or retry. */
export async function bootstrapPrivateVpsOwner(args, runtime = installed) {
  try {
    const parsed = parsePrivateVpsArguments(args);
    if (parsed.help) {
      runtime.report('Usage: node scripts/bootstrap-private-vps-owner.mjs --configuration /absolute/owner-bootstrap-config.mjs');
      runtime.report('Creates the first owner in the explicitly approved prepared database. Requires verified owner confirmation and production-write authorization.');
      return 0;
    }
    await validatePrivateVpsConfigurationPath(parsed.configurationPath);
    const operator = await runtime.loadOperator(parsed.configurationPath);
    if (operator.schema !== 'control-room.private-owner-bootstrap-configuration/v1' || typeof operator.createConfiguration !== 'function') throw new Error();
    const input = await operator.createConfiguration();
    const release = await runtime.loadRelease();
    const receipt = await release.runPrivateOwnerBootstrap(input);
    runtime.report(JSON.stringify(receipt)); return 0;
  } catch {
    runtime.reportError('Owner bootstrap failed or its outcome is uncertain. Do not automatically retry. Review the approved target and connection cleanup privately.');
    return 1;
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await bootstrapPrivateVpsOwner(process.argv.slice(2));
