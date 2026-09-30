import { mutableNightOperationsModeV1, runNightKitV1, type NightKitModeV1 } from "../src/night-kit/v1";
import { loadMacLocalProtectedConfigurationFromRootV1 } from "../src/web/v1/mac-local-protected-loader";
import { createMacLocalWorkBatchQueueCatalogV1 } from "../src/web/v1/mac-local-host";
import { verifyOwnerTrustedLocalEnablementV1 } from "../src/harness/v1/owner-trusted-local-enablements";
import { readPinnedMacExecutableVersion, verifyPinnedMacModelPolicy } from "./mac-local/start-web-host.mjs";

async function main(): Promise<void> {
  const requested = process.argv[2];
  if (requested !== "practice" && requested !== "shadow") {
    process.stderr.write("Usage: night-kit.ts <practice|shadow>\n");
    process.exitCode = 2;
    return;
  }
  const operations = mutableNightOperationsModeV1();
  const pause = () => operations.set("paused"), drain = () => operations.set("draining"), stop = () => operations.set("stopped");
  process.once("SIGUSR1", pause); process.once("SIGUSR2", drain); process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    let dependencies: Parameters<typeof runNightKitV1>[1] = { operations };
    if (requested === "shadow") {
      const index = process.argv.indexOf("--protected-root");
      const protectedRoot = index < 0 ? process.env.CONTROL_ROOM_PROTECTED_ROOT : process.argv[index + 1];
      if (!protectedRoot) throw new Error("night:shadow requires --protected-root ABSOLUTE_PATH or CONTROL_ROOM_PROTECTED_ROOT");
      const configuration = await loadMacLocalProtectedConfigurationFromRootV1(protectedRoot);
      const readiness = await verifyOwnerTrustedLocalEnablementV1(configuration.enablement,
        readPinnedMacExecutableVersion, verifyPinnedMacModelPolicy);
      dependencies = { operations, workerCatalog: createMacLocalWorkBatchQueueCatalogV1(configuration),
        readyWorkerIds: readiness.enabledWorkerIds };
    }
    const summary = await runNightKitV1(requested as NightKitModeV1, dependencies);
    process.stdout.write(`${summary.message}\n`);
    process.stdout.write(`Stages completed: ${summary.completedStages.join(" -> ") || "none"}.\n`);
    process.stdout.write(`Recorded dry-run effects: ${summary.effects.map(effect => effect.kind).join(", ") || "none"}.\n`);
    process.stdout.write(`Safety caps: ${summary.caps.maxTotalTasks} tasks, ${summary.caps.maxConcurrentTasks} at once, ${summary.loopLimit} attempts.\n`);
    if (summary.status !== "completed") process.exitCode = 1;
  } finally {
    process.off("SIGUSR1", pause); process.off("SIGUSR2", drain); process.off("SIGINT", stop); process.off("SIGTERM", stop);
  }
}

await main().catch(error => {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`Night kit did not start: ${message}\n`);
  process.exitCode = 1;
});
