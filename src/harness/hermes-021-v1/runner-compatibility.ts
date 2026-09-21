import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HERMES_021_SOURCE_REVISION_V1, HERMES_021_VERSION_V1 } from "./connector-profile";

const unavailable = (): never => { throw new Error("hermes_021_macos_runner_compatibility_unavailable"); };

type VersionCommand = (file: string, args: readonly string[]) => Promise<unknown>;
const executeFile = promisify(execFile);

/**
 * Checks only the public first line of Hermes' own `--version` response. The
 * result deliberately contains no program location, profile, model, provider,
 * workspace, account, or other installation setting.
 */
export function verifyHermes021MacosLocalRunnerVersionV1(output: unknown) {
  if (typeof output !== "string" || output.length > 4_096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(output)) unavailable();
  const [first, ...rest] = output.replace(/\r\n/g, "\n").split("\n");
  if (rest.some(line => line.length > 4_096)) unavailable();
  const match = /^Hermes Agent v([0-9]+\.[0-9]+\.[0-9]+)(?: \([^\r\n)]{1,120}\))? · upstream ([a-f0-9]{8,64})$/.exec(first ?? "");
  if (!match || match[1] !== HERMES_021_VERSION_V1 || !HERMES_021_SOURCE_REVISION_V1.startsWith(match[2])) unavailable();
  return Object.freeze({ version: HERMES_021_VERSION_V1, sourceRevision: HERMES_021_SOURCE_REVISION_V1 });
}

async function defaultVersionCommand(file: string, args: readonly string[]) {
  const result = await executeFile(file, [...args], {
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 4_096,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" },
  });
  return result.stdout;
}

/**
 * An effect-free compatibility probe for the already-selected executable. It
 * sends only `--version`, never opens a Hermes profile or contacts a model.
 * Callers receive a fixed public identity only; private command output is not
 * retained or returned.
 */
export async function inspectHermes021MacosLocalRunnerCompatibilityV1(executablePath: unknown,
  command: VersionCommand = defaultVersionCommand) {
  if (typeof executablePath !== "string" || !executablePath.startsWith("/") || typeof command !== "function") unavailable();
  try {
    return verifyHermes021MacosLocalRunnerVersionV1(await command(executablePath, Object.freeze(["--version"])));
  } catch { unavailable(); }
}
