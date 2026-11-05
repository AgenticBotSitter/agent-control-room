// B5 first website proof: the foreground real-proof command the lead runs once on
// the owner's Mac in the existing session. It validates every pin and prerequisite
// before importing the private assembly or creating any resource, and it never
// provisions accounts, reads credentials, installs, delivers, pushes or chooses a
// role. Exit 0 only with complete verified proof; otherwise a safe refusal line.
import { fileURLToPath } from "node:url";
import { createFirstWebsiteControllerOwnerV1, runFirstWebsiteJourneyV1 } from "./first-website-controller";
import { B5DeviceRefusalV1 } from "./first-website-device";
import { B5RefusalV1, preflightFirstWebsiteV1 } from "../../tests/helpers/improve-control-room-first-website";

function parseArguments(argv: readonly string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i], value = argv[i + 1];
    if (!["--config", "--evidence-dir"].includes(name ?? "") || value === undefined || value.startsWith("--") || values.has(name!))
      throw new B5RefusalV1("B5_USAGE");
    values.set(name!, value);
  }
  if (values.size !== 2) throw new B5RefusalV1("B5_USAGE");
  return { configFile: values.get("--config")!, evidenceDir: values.get("--evidence-dir")! };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const owner = createFirstWebsiteControllerOwnerV1();
  try {
    const preflight = await preflightFirstWebsiteV1({ ...args, cliFile: fileURLToPath(import.meta.url), signalOwner: owner });
    const verdict = await runFirstWebsiteJourneyV1({ ...preflight, controllerOwner: owner }, owner.signal);
    if (verdict.state !== "complete") throw new B5RefusalV1(verdict.reasons[0] ?? "B5_PROOF_INCOMPLETE");
  } finally { await owner.cleanup(); owner.dispose(); }
}

try {
  await main();
  console.log("OK: disposable website proof complete");
} catch (error) {
  const code = error instanceof B5RefusalV1 || error instanceof B5DeviceRefusalV1 ? error.code : "B5_INTERNAL";
  console.log(`FAILED: ${code}; proof retained`);
  process.exitCode = 1;
}
