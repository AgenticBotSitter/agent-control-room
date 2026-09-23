import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkPrivateVpsDatabase } from "./check-private-vps-database.mjs";
import { bootstrapPrivateVpsOwner } from "./bootstrap-private-vps-owner.mjs";
import { parsePrivateVpsArguments, requirePrivateVpsMode, validatePrivateVpsConfigurationPath, runPrivateVps } from "./run-private-vps.mjs";

function parseActivationArguments(args) {
  if (args.length === 1 && args[0] === "--help") return Object.freeze({ help: true });
  if (args.length !== 5 || args[0] !== "--owner-bootstrap-configuration"
    || args[2] !== "--configuration" || args[4] !== "--start") throw new Error("private_activation_arguments_invalid");
  // Reuse the existing strict absolute-path parser rather than accepting a second
  // version of its path rules in this convenience command.
  const bootstrap = parsePrivateVpsArguments(["--configuration", args[1]]).configurationPath;
  const runtime = parsePrivateVpsArguments(["--configuration", args[3]]).configurationPath;
  return Object.freeze({ bootstrap, runtime });
}

function assertCompatibleActivationInput(ownerInput, prepared) {
  const bootstrap = ownerInput?.configuration, trust = ownerInput?.trust, database = ownerInput?.database;
  const web = prepared?.configuration?.web;
  try {
    if (!bootstrap || !trust || !database || !web || requirePrivateVpsMode(prepared) !== "website-only") throw new Error();
    if (bootstrap.databaseName !== database.database || bootstrap.databaseName !== web.database.database
      || bootstrap.tenantId !== web.tenantId || bootstrap.workspaceId !== web.workspaceId
      || bootstrap.identityId !== web.ownerIdentityId || trust.issuer !== web.issuer
      || trust.audience !== web.audience) throw new Error();
  } catch { throw new Error("private_activation_inputs_mismatch"); }
}

const installed = Object.freeze({
  loadOperator: path => import(pathToFileURL(path).href),
  bootstrap: args => bootstrapPrivateVpsOwner(args),
  check: args => checkPrivateVpsDatabase(args),
  start: args => runPrivateVps(args),
  report: value => console.log(value),
  reportError: value => console.error(value),
});

/**
 * Explicit first-activation convenience command. It is deliberately not a
 * supervisor, a retry loop, or a replacement for the individual commands.
 * It validates both protected operator inputs before the first possible write,
 * then performs the already-reviewed one-shot bootstrap, read-only database
 * check, and normal website launch in that order.
 */
export async function activatePrivateVps(args, runtime = installed) {
  try {
    const parsed = parseActivationArguments(args);
    if (parsed.help) {
      runtime.report("Usage: node scripts/activate-private-vps.mjs --owner-bootstrap-configuration /absolute/owner-bootstrap-config.mjs --configuration /absolute/operator-config.mjs --start");
      runtime.report("Validates protected inputs, creates the first owner once, checks the database, then starts the private website. Do not retry after a bootstrap failure without reconciliation.");
      return 0;
    }
    await validatePrivateVpsConfigurationPath(parsed.bootstrap);
    await validatePrivateVpsConfigurationPath(parsed.runtime);
    const [ownerOperator, runtimeOperator] = await Promise.all([runtime.loadOperator(parsed.bootstrap), runtime.loadOperator(parsed.runtime)]);
    if (ownerOperator.schema !== "control-room.private-owner-bootstrap-configuration/v1" || typeof ownerOperator.createConfiguration !== "function"
      || runtimeOperator.schema !== "control-room.private-vps-configuration/v1" || typeof runtimeOperator.createConfiguration !== "function") throw new Error();
    const [ownerInput, prepared] = await Promise.all([ownerOperator.createConfiguration(), runtimeOperator.createConfiguration({ signal: new AbortController().signal })]);
    assertCompatibleActivationInput(ownerInput, prepared);
    if (await runtime.bootstrap(["--configuration", parsed.bootstrap]) !== 0) throw new Error();
    if (await runtime.check(["--configuration", parsed.runtime]) !== 0) throw new Error();
    runtime.report("First-owner setup and database checks passed. Starting the private Control Room website.");
    if (await runtime.start(["--configuration", parsed.runtime]) !== 0) throw new Error();
    return 0;
  } catch {
    runtime.reportError("Control Room activation stopped before a usable website was confirmed. If owner creation may have been attempted, reconcile the private database before another activation attempt.");
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await activatePrivateVps(process.argv.slice(2));
