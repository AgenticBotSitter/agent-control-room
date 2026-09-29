import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkPreparedPrivateVpsDatabase } from "./check-private-vps-database.mjs";
import { bootstrapPreparedPrivateVpsOwner } from "./bootstrap-private-vps-owner.mjs";
import { parsePrivateVpsArguments, requirePrivateVpsMode, validatePrivateVpsConfigurationPath, runPreparedPrivateVps } from "./run-private-vps.mjs";

function parseActivationArguments(args) {
  if (args.length === 1 && args[0] === "--help") return Object.freeze({ help: true });
  if (args.length !== 5 || args[0] !== "--owner-bootstrap-configuration"
    || args[2] !== "--configuration" || args[4] !== "--start") throw new Error("private_activation_arguments_invalid");
  const bootstrap = parsePrivateVpsArguments(["--configuration", args[1]]).configurationPath;
  const runtime = parsePrivateVpsArguments(["--configuration", args[3]]).configurationPath;
  return Object.freeze({ bootstrap, runtime });
}

function assertCompatibleActivationInput(ownerInput, prepared) {
  const bootstrap = ownerInput?.configuration, trust = ownerInput?.trust, database = ownerInput?.database;
  const web = prepared?.configuration?.web;
  try {
    // First-owner bootstrap applies to both supported product modes.  The
    // selected runtime still validates its complete website-only or
    // agent-task graph before any listener or worker can start.  Keeping the
    // compatibility comparison here prevents an agent-task configuration
    // from silently bootstrapping a different database or owner.
    if (!bootstrap || !trust || !database || !web || !["website-only", "agent-tasks"].includes(requirePrivateVpsMode(prepared))) throw new Error();
    if (bootstrap.databaseName !== database.database || bootstrap.databaseName !== web.database.database
      || database.host !== web.database.host || database.port !== web.database.port
      || database.majorVersion !== web.database.majorVersion
      || bootstrap.tenantId !== web.tenantId || bootstrap.workspaceId !== web.workspaceId
      || bootstrap.identityId !== web.ownerIdentityId || trust.issuer !== web.issuer
      || trust.audience !== web.audience) throw new Error();
  } catch { throw new Error("private_activation_inputs_mismatch"); }
}

function freezeActivationSnapshot(value, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (Array.isArray(value)) {
    const copy = [];
    seen.set(value, copy);
    for (const entry of value) copy.push(freezeActivationSnapshot(entry, seen));
    return Object.freeze(copy);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw new Error("private_activation_snapshot_invalid");
  const copy = {};
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || "get" in descriptor || "set" in descriptor) throw new Error("private_activation_snapshot_invalid");
    copy[key] = freezeActivationSnapshot(value[key], seen);
  }
  return Object.freeze(copy);
}

const installed = Object.freeze({
  loadOperator: path => import(pathToFileURL(path).href),
  bootstrap: input => bootstrapPreparedPrivateVpsOwner(input),
  check: prepared => checkPreparedPrivateVpsDatabase(prepared),
  start: prepared => runPreparedPrivateVps(prepared),
  report: value => console.log(value),
  reportError: value => console.error(value),
});

/** One explicit first-activation path. It validates both private inputs before
 * the first possible write and never retries an uncertain owner bootstrap. */
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
    const [loadedOwnerInput, loadedPrepared] = await Promise.all([ownerOperator.createConfiguration(), runtimeOperator.createConfiguration({ signal: new AbortController().signal })]);
    const ownerInput = freezeActivationSnapshot(loadedOwnerInput);
    const prepared = freezeActivationSnapshot(loadedPrepared);
    assertCompatibleActivationInput(ownerInput, prepared);
    if (await runtime.bootstrap(ownerInput) !== 0) throw new Error();
    if (await runtime.check(prepared) !== 0) throw new Error();
    runtime.report("First-owner setup and database checks passed. Starting the reviewed private Control Room host.");
    if (await runtime.start(prepared) !== 0) throw new Error();
    return 0;
  } catch {
    runtime.reportError("Control Room activation stopped before a usable website was confirmed. If owner creation may have been attempted, reconcile the private database before another activation attempt.");
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await activatePrivateVps(process.argv.slice(2));
