// Creates <protected>/config/task-runtime.json once, with fresh role keys and the owner's chosen Hermes
// run settings. An existing valid file is kept unchanged; an invalid one is refused. Prints no key.
// Usage: pnpm mac:prepare-task-runtime -- --protected-root ABS_PATH --hermes-profile P --hermes-provider P --hermes-model M
import { createMacLocalTaskRuntimeFileV1 } from "../../src/web/v1/mac-local-task-runtime";

const flags = ["--protected-root", "--hermes-profile", "--hermes-provider", "--hermes-model"] as const;

export function parsePrepareTaskRuntimeArgumentsV1(args: readonly string[]) {
  const values = args[0] === "--" ? args.slice(1) : args;
  const found = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index]!, value = values[index + 1];
    if (!(flags as readonly string[]).includes(flag) || found.has(flag) || value === undefined || value.startsWith("--"))
      throw new Error("mac_local_task_runtime_arguments_refused");
    found.set(flag, value);
  }
  if (found.size !== flags.length) throw new Error("mac_local_task_runtime_arguments_refused");
  return { protectedRoot: found.get("--protected-root")!, hermes: { profile: found.get("--hermes-profile")!,
    provider: found.get("--hermes-provider")!, model: found.get("--hermes-model")! } };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const { protectedRoot, hermes } = parsePrepareTaskRuntimeArgumentsV1(process.argv.slice(2));
    process.stdout.write(`mac:prepare-task-runtime ${await createMacLocalTaskRuntimeFileV1(protectedRoot, hermes)}\n`);
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("mac_local_task_runtime_") ? error.message : "mac_local_task_runtime_failed";
    process.stderr.write(`mac:prepare-task-runtime FAILED ${message}\n`);
    process.exitCode = 1;
  }
}
