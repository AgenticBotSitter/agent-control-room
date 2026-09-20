/**
 * Owner-attended, effect-free check before the one-shot Hermes runner
 * qualification. It reads only executable/directory metadata and deliberately
 * emits no path, profile, model, or provider value.
 */
import { isAbsolute } from "node:path";
import { preflightHermes021MacosLocalRunnerV1 } from "../src/harness/hermes-021-v1/subprocess-preflight";

const args = process.argv.slice(2).filter(value => value !== "--");
const ownerAttended = args.includes("--owner-attended");
const names = ["--executable", "--profile", "--model", "--provider", "--workdir"] as const;
type Name = typeof names[number];

const valueFor = (name: Name): string | undefined => {
  const indexes = args.reduce<number[]>((all, value, index) => value === name ? [...all, index] : all, []);
  if (indexes.length !== 1 || indexes[0] === args.length - 1) return undefined;
  const value = args[indexes[0] + 1];
  return value && !value.startsWith("--") ? value : undefined;
};
const supplied = Object.fromEntries(names.map(name => [name, valueFor(name)])) as Record<Name, string | undefined>;
const accepted = new Set<string>(["--owner-attended", ...names,
  ...Object.values(supplied).filter((value): value is string => Boolean(value))]);
const valid = ownerAttended && args.every(value => accepted.has(value)) && names.every(name => supplied[name] !== undefined);

if (!valid) {
  console.error("Usage: node --import tsx scripts/preflight-local-hermes-021-runner.ts --owner-attended --executable ABSOLUTE_PATH --profile PROFILE --model MODEL --provider PROVIDER --workdir ABSOLUTE_WORKDIR");
  process.exitCode = 2;
} else if (!isAbsolute(supplied["--executable"]!) || !isAbsolute(supplied["--workdir"]!)) {
  console.log(JSON.stringify({ ready: false, failureReason: "owner_configuration_invalid", startsWork: false }, null, 2));
  process.exitCode = 1;
} else {
  try {
    console.log(JSON.stringify(await preflightHermes021MacosLocalRunnerV1({ executablePath: supplied["--executable"]!,
      profile: supplied["--profile"]!, model: supplied["--model"]!, provider: supplied["--provider"]!,
      workingDirectory: supplied["--workdir"]! }), null, 2));
  } catch {
    console.log(JSON.stringify({ ready: false, failureReason: "owner_configuration_invalid", startsWork: false }, null, 2));
    process.exitCode = 1;
  }
}
