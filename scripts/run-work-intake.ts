import { isMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createWorkIntakeLoopbackClientV1, runWorkIntakeCliV1 } from "../src/work-intake/v1";
import { captureWorkIntakeClientConfigurationV1 } from "../src/work-intake/v1/installed-configuration";

export const WORK_INTAKE_CLIENT_CONFIG_PATH_V1 = join(homedir(), "Library", "Application Support",
  "Agent Control Room", "config", "work-intake-client.json");
const MAX_CONFIG_BYTES = 4096, MAX_STDIN_BYTES = 256 * 1024;

export async function readProtectedWorkIntakeClientV1(path = WORK_INTAKE_CLIENT_CONFIG_PATH_V1,
  options: { trustedOwnerUid?: number; openFile?: typeof open } = {}) {
  let handle;
  try {
    if (path !== WORK_INTAKE_CLIENT_CONFIG_PATH_V1 || !Number.isInteger(constants.O_NOFOLLOW)) throw new Error();
    handle = await (options.openFile ?? open)(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    const uid = BigInt(options.trustedOwnerUid ?? process.getuid?.() ?? -1);
    if (!before.isFile() || before.uid !== uid || (before.mode & BigInt(0o077)) !== BigInt(0)
      || before.size < BigInt(1) || before.size > BigInt(MAX_CONFIG_BYTES)) throw new Error();
    const source = await handle.readFile("utf8"), after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || Buffer.byteLength(source) !== Number(after.size)) throw new Error();
    const value = captureWorkIntakeClientConfigurationV1(JSON.parse(source));
    return createWorkIntakeLoopbackClientV1(value);
  } catch { throw new Error("work_intake_protected_configuration_refused"); }
  finally { try { await handle?.close(); } catch {} }
}

async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); length += bytes.length;
    if (length > MAX_STDIN_BYTES) throw new Error("work_intake_stdin_refused"); chunks.push(bytes);
  }
  const { parseStrictJsonObjectV1 } = await import("../src/project-coordination/v1/strict-json");
  return parseStrictJsonObjectV1(Buffer.concat(chunks, length).toString("utf8"));
}

export async function runInstalledWorkIntakeV1(args = process.argv.slice(2)) {
  return runWorkIntakeCliV1(args, { loadProtectedClient: readProtectedWorkIntakeClientV1,
    readInput: readStdin, report: (message: string) => process.stdout.write(message),
    reportError: (message: string) => process.stderr.write(`${message}\n`) });
}

if (isMainModuleV1(process.argv[1], import.meta.url))
  process.exitCode = await runInstalledWorkIntakeV1();
