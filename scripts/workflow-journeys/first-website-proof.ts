// B5 first website proof: the foreground real-proof command the lead runs once on
// the owner's Mac in the existing session. It validates every pin and prerequisite
// before importing the private assembly or creating any resource, and it never
// provisions accounts, reads credentials, installs, delivers, pushes or chooses a
// role. Exit 0 only with complete verified proof; otherwise a safe refusal line.
import { fileURLToPath } from "node:url";
import { B5_BLOCKED_PREREQUISITES, B5RefusalV1, preflightFirstWebsiteV1 } from "../../tests/helpers/improve-control-room-first-website";

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
  await preflightFirstWebsiteV1({ ...args, cliFile: fileURLToPath(import.meta.url) });
  // Preflight refuses while any landed prerequisite is missing. The journey controller
  // binds the role-scoped inputs between intake and confirmation through that landed
  // contract, so it is added with that contract's reviewed integration, then imports
  // the assembly through loadFirstWebsiteAssemblyV1 under a maxDurationMs signal.
  throw new B5RefusalV1("B5_JOURNEY_CONTROLLER_UNBOUND");
}

try {
  await main();
  console.log("OK: disposable website proof complete");
} catch (error) {
  const code = error instanceof B5RefusalV1 ? error.code : "B5_INTERNAL";
  console.log(`FAILED: ${code}; proof retained`);
  const blocked = B5_BLOCKED_PREREQUISITES.find(item => item.code === code);
  if (blocked) console.log(`BLOCKED: ${blocked.contract}`);
  process.exitCode = 1;
}
