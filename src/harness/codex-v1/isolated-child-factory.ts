import { isAbsolute } from "node:path";
import { sha256Digest } from "../../security";
import type { CodexAppServerChildPortV1 } from "./isolated-process-transport";
import type { CodexMacIsolatedLauncherPlanV1 } from "./isolated-launcher";
import { CODEX_PINNED_EXECUTABLE_V1 } from "./manifest";

export const CODEX_APP_SERVER_EXACT_ARGS_V1 = ["app-server", "--stdio", "--strict-config"] as const;

export interface CodexPinnedAppServerSpawnSpecV1 {
  executable: typeof CODEX_PINNED_EXECUTABLE_V1;
  args: readonly ["app-server", "--stdio", "--strict-config"];
  cwd: string;
  env: Readonly<{ CODEX_HOME: string }>;
  shell: false;
  detached: false;
  stdio: readonly ["pipe", "pipe", "ignore"];
}

export interface CodexPinnedAppServerSpawnedPortV1 extends CodexAppServerChildPortV1 {
  readonly pid: number;
  readonly spawnSpecDigest: string;
  readonly state: "running" | "exited";
}

/** Deliberately narrow effect port: callers cannot supply an arbitrary command. */
export interface CodexPinnedAppServerSpawnerV1 {
  spawnPinnedAppServer(spec: CodexPinnedAppServerSpawnSpecV1): CodexPinnedAppServerSpawnedPortV1;
}

export interface CodexPinnedAppServerChildV1 {
  port: CodexPinnedAppServerSpawnedPortV1;
  identity: { pid: number; spawnSpecDigest: string };
}

export function digestCodexPinnedAppServerSpawnSpecV1(spec: CodexPinnedAppServerSpawnSpecV1): string {
  return sha256Digest(spec);
}

function exactKeys(value: Record<string, string>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

/**
 * Creates only the launcher's exact pinned app-server child. No ambient process
 * environment, shell, generic argv, stderr pipe, or job-controlled field exists.
 */
export function createCodexPinnedAppServerChildV1(
  launcher: CodexMacIsolatedLauncherPlanV1,
  spawner: CodexPinnedAppServerSpawnerV1,
): CodexPinnedAppServerChildV1 {
  const plan = launcher.appServerChild;
  if (launcher.schema !== "control-room.codex-macos-isolated-launcher-plan/v1"
    || plan.executable !== CODEX_PINNED_EXECUTABLE_V1
    || plan.args.length !== CODEX_APP_SERVER_EXACT_ARGS_V1.length
    || !plan.args.every((value, index) => value === CODEX_APP_SERVER_EXACT_ARGS_V1[index])
    || !isAbsolute(plan.cwd) || plan.cwd.includes("\0")
    || !exactKeys(plan.env, ["CODEX_HOME"])
    || !isAbsolute(plan.env.CODEX_HOME) || plan.env.CODEX_HOME.includes("\0")) {
    throw new Error("Codex pinned app-server plan invalid");
  }
  const spec: CodexPinnedAppServerSpawnSpecV1 = {
    executable: CODEX_PINNED_EXECUTABLE_V1,
    args: [...CODEX_APP_SERVER_EXACT_ARGS_V1],
    cwd: plan.cwd,
    env: { CODEX_HOME: plan.env.CODEX_HOME },
    shell: false,
    detached: false,
    stdio: ["pipe", "pipe", "ignore"],
  };
  const expectedDigest = digestCodexPinnedAppServerSpawnSpecV1(spec);
  const port = spawner.spawnPinnedAppServer(spec);
  if (!Number.isSafeInteger(port.pid) || port.pid < 2 || port.state !== "running"
    || port.spawnSpecDigest !== expectedDigest) {
    try { port.closeStdin(); } catch { /* safe best effort */ }
    try { port.terminate(); } catch { /* safe best effort */ }
    throw new Error("Codex pinned app-server child identity invalid");
  }
  return { port, identity: { pid: port.pid, spawnSpecDigest: expectedDigest } };
}
