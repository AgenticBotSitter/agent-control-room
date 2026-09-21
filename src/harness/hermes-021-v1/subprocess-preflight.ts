import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { captureHermes021MacosSubprocessHostConfigurationV1 } from "./subprocess-stream-json-host";

export const HERMES_021_MACOS_LOCAL_RUNNER_PREFLIGHT_V1 =
  "control-room.hermes-021-macos-local-runner-preflight/v1" as const;

const unavailable = (): never => { throw new Error("hermes_021_macos_runner_preflight_unavailable"); };

type Access = (path: string, mode?: number) => Promise<void>;
type Stat = (path: string) => Promise<Readonly<{ isFile(): boolean; isDirectory(): boolean }>>;

/**
 * Effect-free local configuration check. It reads file metadata only: no
 * Hermes process, profile, model call, task file, database, queue, or browser
 * request is involved. Its result intentionally contains no path or selected
 * harness setting, so it can be shown to an installer without disclosing the
 * private runner configuration.
 */
export async function preflightHermes021MacosLocalRunnerV1(configurationValue: unknown,
  fileAccess: Access = access, fileStat: Stat = stat) {
  const configuration = captureHermes021MacosSubprocessHostConfigurationV1(configurationValue);
  if (typeof fileAccess !== "function" || typeof fileStat !== "function") unavailable();
  try {
    await fileAccess(configuration.executablePath, constants.X_OK);
    const [executable, workingDirectory] = await Promise.all([
      fileStat(configuration.executablePath), fileStat(configuration.workingDirectory),
    ]);
    if (!executable.isFile() || !workingDirectory.isDirectory()) unavailable();
  } catch { unavailable(); }
  return Object.freeze({ schema: HERMES_021_MACOS_LOCAL_RUNNER_PREFLIGHT_V1,
    ready: true as const, startsWork: false as const });
}
