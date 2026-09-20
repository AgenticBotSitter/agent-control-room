/**
 * Owner-attended, effect-free check before the one-shot Hermes runner
 * qualification. It reads only executable/directory metadata and deliberately
 * emits no path, profile, model, or provider value.
 */
import { preflightHermes021MacosLocalRunnerV1 } from "../src/harness/hermes-021-v1/subprocess-preflight";
import { resolveOwnerSelectedHermesExecutableV1 } from "../src/harness/hermes-021-v1/owner-executable-resolution";

const args = process.argv.slice(2).filter(value => value !== "--");
const ownerAttended = args.includes("--owner-attended");
const names = ["--executable", "--executable-command", "--profile", "--model", "--provider", "--workdir"] as const;
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
const hasOneExecutable = Number(Boolean(supplied["--executable"])) + Number(Boolean(supplied["--executable-command"])) === 1;
const valid = ownerAttended && args.every(value => accepted.has(value)) && hasOneExecutable
  && ["--profile", "--model", "--provider", "--workdir"].every(name => supplied[name as Name] !== undefined);

if (!valid) {
  console.error("Usage: node --import tsx scripts/preflight-local-hermes-021-runner.ts --owner-attended (--executable ABSOLUTE_PATH | --executable-command hermes) --profile PROFILE --model MODEL --provider PROVIDER --workdir ABSOLUTE_WORKDIR");
  process.exitCode = 2;
} else if (!supplied["--workdir"]!.startsWith("/")) {
  console.log(JSON.stringify({ ready: false, failureReason: "owner_configuration_invalid", startsWork: false }, null, 2));
  process.exitCode = 1;
} else {
  try {
    const executablePath = await resolveOwnerSelectedHermesExecutableV1({ executable: supplied["--executable"],
      executableCommand: supplied["--executable-command"], path: process.env.PATH ?? "" });
    console.log(JSON.stringify(await preflightHermes021MacosLocalRunnerV1({ executablePath,
      profile: supplied["--profile"]!, model: supplied["--model"]!, provider: supplied["--provider"]!,
      workingDirectory: supplied["--workdir"]! }), null, 2));
  } catch {
    console.log(JSON.stringify({ ready: false, failureReason: "owner_configuration_invalid", startsWork: false }, null, 2));
    process.exitCode = 1;
  }
}
