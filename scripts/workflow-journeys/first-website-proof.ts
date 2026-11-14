// B5 first website proof: the foreground real-proof command the lead runs once on
// the owner's Mac in the existing session. It validates every pin and prerequisite
// before importing the private assembly or creating any resource, and it never
// provisions accounts, reads credentials, installs, delivers, pushes or chooses a
// role. Exit 0 only with complete verified proof; otherwise a safe refusal line.
import { dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { resolveJourneyProfileV1 } from "../../tests/helpers/improve-control-room-model-eval";
import { fileURLToPath } from "node:url";
import { createFirstWebsiteControllerOwnerV1, runFirstWebsiteJourneyV1 } from "./first-website-controller";
import { B5DeviceRefusalV1 } from "./first-website-device";
import { B5RefusalV1, preflightFirstWebsiteV1 } from "../../tests/helpers/improve-control-room-first-website";

function parseArguments(argv: readonly string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i], value = argv[i + 1];
    if (!["--config", "--evidence-dir", "--profile"].includes(name ?? "") || value === undefined || value.startsWith("--") || values.has(name!))
      throw new B5RefusalV1("B5_USAGE");
    values.set(name!, value);
  }
  if (!values.has("--config") || !values.has("--evidence-dir") || values.has("--profile") && !["first-website", "model-eval"].includes(values.get("--profile")!)) throw new B5RefusalV1("B5_USAGE");
  return { configFile: values.get("--config")!, evidenceDir: values.get("--evidence-dir")!, selection: values.get("--profile") };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const owner = createFirstWebsiteControllerOwnerV1();
  try {
    let config: { scratchRoot?: string } | null;
    try { config = JSON.parse(await readFile(args.configFile, "utf8")); }
    catch (error) { throw new B5RefusalV1(error instanceof SyntaxError ? "B5_CONFIG_INVALID" : "B5_CONFIG_PATH"); }
    const profile = await resolveJourneyProfileV1(config?.scratchRoot ?? dirname(dirname(args.configFile)), args.selection);
    const preflight = await preflightFirstWebsiteV1({ ...args, profile, cliFile: fileURLToPath(import.meta.url), signalOwner: owner });
    const verdict = await runFirstWebsiteJourneyV1({ ...preflight, controllerOwner: owner }, owner.signal);
    if (verdict.state !== "complete") throw new B5RefusalV1(verdict.reasons[0] ?? "B5_PROOF_INCOMPLETE");
  } finally { await owner.cleanup(); owner.dispose(); }
}

try {
  await main();
  console.log(process.argv.includes("model-eval") ? "OK: disposable model-eval proof complete" : "OK: disposable website proof complete");
} catch (error) {
  const code = error instanceof B5RefusalV1 || error instanceof B5DeviceRefusalV1 ? error.code : "B5_INTERNAL";
  console.log(`FAILED: ${code}; proof retained`);
  process.exitCode = 1;
}
