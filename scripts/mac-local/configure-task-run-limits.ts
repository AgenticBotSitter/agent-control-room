// Writes owner-controlled limits without printing their values.
// Usage: node --import tsx scripts/mac-local/configure-task-run-limits.ts
//   --protected-root ABS_PATH --wall-time-ms INTEGER --output-bytes INTEGER
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { captureMacLocalTaskRunLimitsV1, MAC_LOCAL_TASK_RUN_LIMITS_V1 } from "../../src/harness/v1/owner-trusted-local-run-limits";
import { writeMacLocalTaskRunLimitsToRootV1 } from "../../src/web/v1/mac-local-task-run-limits";

const flags = ["--protected-root", "--wall-time-ms", "--output-bytes"] as const;
const decimalInteger = /^(?:0|[1-9][0-9]*)$/u;

export function parseConfigureTaskRunLimitsArgumentsV1(args: readonly string[]) {
  const values = args[0] === "--" ? args.slice(1) : args;
  const found = new Map<string, string>();
  if (values.length !== flags.length * 2) throw new Error("mac_local_task_run_limits_arguments_refused");
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index]!, value = values[index + 1];
    if (!(flags as readonly string[]).includes(flag) || found.has(flag) || value === undefined || value.startsWith("--"))
      throw new Error("mac_local_task_run_limits_arguments_refused");
    found.set(flag, value);
  }
  const wall = found.get("--wall-time-ms")!, output = found.get("--output-bytes")!;
  if (!decimalInteger.test(wall) || !decimalInteger.test(output)) throw new Error("mac_local_task_run_limits_arguments_refused");
  return { protectedRoot: found.get("--protected-root")!, limits: captureMacLocalTaskRunLimitsV1({
    schema: MAC_LOCAL_TASK_RUN_LIMITS_V1,
    wallTimeMs: Number(wall),
    outputBytes: Number(output),
  }) };
}

function invokedDirectly() {
  try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (invokedDirectly()) {
  try {
    const { protectedRoot, limits } = parseConfigureTaskRunLimitsArgumentsV1(process.argv.slice(2));
    await writeMacLocalTaskRunLimitsToRootV1(protectedRoot, limits);
    process.stdout.write("mac:configure-task-run-limits updated\n");
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("mac_local_task_run_limits_")
      ? error.message : "mac_local_task_run_limits_failed";
    process.stderr.write(`mac:configure-task-run-limits FAILED ${message}\n`);
    process.exitCode = 1;
  }
}
