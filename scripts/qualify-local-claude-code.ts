/**
 * Owner-attended Claude qualification entry. Production qualification accepts
 * only one process-local capability produced by the protected native
 * supervisor composer. Command-line paths and a generic child-process spawn
 * are deliberately not supported.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { types } from "node:util";
import { consumePrivateMacosClaudeCodeQualificationRouteV1 } from
  "../src/node-bridge/private-macos-claude-code-qualification-port-composer";

let registeredCapability: unknown;
let registrationState: "unregistered" | "registered" | "spent" = "unregistered";

export function registerPrivateLocalClaudeQualificationRouteV1(capability: unknown) {
  if (registrationState !== "unregistered" || !capability || typeof capability !== "object"
    || types.isProxy(capability) || !Object.isFrozen(capability))
    throw new Error("private_local_claude_qualification_route_refused");
  registeredCapability = capability;
  registrationState = "registered";
  return Object.freeze({ status: "registered" as const, processLocal: true as const, oneUse: true as const });
}

async function takeRegisteredCapability() {
  if (registrationState !== "registered") throw new Error("private_local_claude_qualification_route_missing");
  registrationState = "spent";
  const capability = registeredCapability;
  registeredCapability = undefined;
  return capability;
}

type Runtime = Readonly<{
  loadProtectedQualificationRoute(): Promise<unknown>;
  report(value: string): void;
  reportError(value: string): void;
  signals: Pick<NodeJS.Process, "once" | "removeListener">;
}>;

const installedRuntime: Runtime = Object.freeze({
  loadProtectedQualificationRoute: takeRegisteredCapability,
  report(value) { process.stdout.write(value); },
  reportError(value) { process.stderr.write(`${value}\n`); },
  signals: process,
});

export async function runPrivateLocalClaudeQualificationV1(args: readonly string[], runtime: Runtime = installedRuntime) {
  const argv = args.filter(value => value !== "--");
  const ownerAttended = argv.filter(value => value === "--owner-attended").length === 1;
  const reuseOwnerLogin = argv.filter(value => value === "--reuse-owner-login").length === 1;
  const dryRun = argv.filter(value => value === "--dry-run").length === 1;
  const valid = ownerAttended && reuseOwnerLogin && argv.length === (dryRun ? 3 : 2)
    && argv.every(value => ["--owner-attended", "--reuse-owner-login", "--dry-run"].includes(value));
  if (!valid) {
    runtime.reportError("Usage: node --import tsx scripts/qualify-local-claude-code.ts --owner-attended --reuse-owner-login [--dry-run]");
    return 2;
  }
  if (dryRun) {
    runtime.report(`${JSON.stringify({ qualificationReady: false, ownerAttended: true,
      invocation: "protected supervised local Claude text-review route", startsWork: false,
      blocker: "protected_route_provider_required" }, null, 2)}\n`);
    return 0;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  runtime.signals.once("SIGINT", interrupt); runtime.signals.once("SIGTERM", interrupt);
  try {
    const capability = await runtime.loadProtectedQualificationRoute();
    const route = consumePrivateMacosClaudeCodeQualificationRouteV1(capability);
    const nonce = `CONTROL_ROOM_CLAUDE_${randomUUID().replaceAll("-", "").toUpperCase()}`;
    const report = await route.qualify(nonce, controller.signal);
    runtime.report(`${JSON.stringify(report, null, 2)}\n`);
    return report.qualified ? 0 : 1;
  } catch {
    runtime.reportError("Control Room Claude qualification requires its protected supervised installed route; no process was started.");
    return 1;
  } finally {
    runtime.signals.removeListener("SIGINT", interrupt); runtime.signals.removeListener("SIGTERM", interrupt);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await runPrivateLocalClaudeQualificationV1(process.argv.slice(2));
