import { isAbsolute, relative, sep } from "node:path";
import { sha256Digest } from "../../security";
import { CODEX_ISOLATED_CLIENT_METHODS_V1 } from "./isolated-topology";
import { CODEX_PINNED_EXECUTABLE_V1 } from "./manifest";

export interface CodexMacIsolatedLauncherConfigV1 {
  nodeRuntime: string;
  brokerControllerScript: string;
  brokerConfigPath: string;
  brokerConfigRoot: string;
  brokerReleaseRoot: string;
  brokerCodexHome: string;
  brokerStateRoot: string;
  brokerLedgerPath: string;
  executorCodexHome: string;
  executorWorkingDirectory: string;
  workspacePath: string;
  executorEndpoint: string;
  environmentId: string;
  brokerIdentityDigest: string;
  executorIdentityDigest: string;
}

export interface CodexLocalProcessPlanV1 {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface CodexMacIsolatedLauncherPlanV1 {
  schema: "control-room.codex-macos-isolated-launcher-plan/v1";
  brokerController: CodexLocalProcessPlanV1;
  appServerChild: CodexLocalProcessPlanV1;
  remoteExecutor: CodexLocalProcessPlanV1;
  environmentAdd: { method: "environment/add"; params: { environmentId: string; execServerUrl: string; connectTimeoutMs: number } };
  environmentStatus: { method: "environment/status"; params: { environmentId: string } };
  threadEnvironment: { environmentId: string; cwd: string; runtimeWorkspaceRoots: string[] };
  allowedClientMethods: readonly string[];
  summary: {
    brokerIdentityDigest: string;
    executorIdentityDigest: string;
    environmentIdDigest: string;
    endpointIdentityDigest: string;
    brokerRootDigest: string;
    executorRootDigest: string;
  };
}

function validIdentifier(value: string): boolean { return /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/.test(value); }
function validDigest(value: string): boolean { return /^sha256:[a-f0-9]{64}$/.test(value); }
function requireAbsolute(value: string): void { if (!isAbsolute(value) || value.includes("\0")) throw new Error("Codex isolated launcher path invalid"); }
function contains(parent: string, child: string): boolean { const path = relative(parent, child); return path === "" || (!path.startsWith(`..${sep}`) && path !== ".."); }
function overlaps(left: string, right: string): boolean { return contains(left, right) || contains(right, left); }

export function planCodexMacIsolatedLauncherV1(config: CodexMacIsolatedLauncherConfigV1): CodexMacIsolatedLauncherPlanV1 {
  for (const path of [config.nodeRuntime, config.brokerControllerScript, config.brokerConfigPath, config.brokerConfigRoot, config.brokerReleaseRoot,
    config.brokerCodexHome, config.brokerStateRoot, config.brokerLedgerPath, config.executorCodexHome,
    config.executorWorkingDirectory, config.workspacePath]) requireAbsolute(path);
  if (!validIdentifier(config.environmentId) || !validDigest(config.brokerIdentityDigest) || !validDigest(config.executorIdentityDigest)
    || config.brokerIdentityDigest === config.executorIdentityDigest) throw new Error("Codex isolated launcher identity invalid");
  const endpoint = /^ws:\/\/127\.0\.0\.1:([0-9]{2,5})$/.exec(config.executorEndpoint);
  const port = endpoint ? Number(endpoint[1]) : 0;
  if (!endpoint || port < 1024 || port > 65_535) throw new Error("Codex isolated executor endpoint invalid");
  const brokerRoots = [config.brokerReleaseRoot, config.brokerConfigRoot, config.brokerCodexHome, config.brokerStateRoot];
  const brokerRootsOverlap = brokerRoots.some((root, index) => brokerRoots.slice(index + 1).some((other) => overlaps(root, other)));
  const executorCanReachBrokerOwnedPath = brokerRoots.some((root) =>
    overlaps(root, config.executorCodexHome) || overlaps(root, config.executorWorkingDirectory));
  if (!contains(config.brokerReleaseRoot, config.brokerControllerScript)
    || !contains(config.brokerConfigRoot, config.brokerConfigPath)
    || !contains(config.brokerStateRoot, config.brokerLedgerPath)
    || !contains(config.executorWorkingDirectory, config.workspacePath)
    || overlaps(config.executorCodexHome, config.executorWorkingDirectory)
    || brokerRootsOverlap || executorCanReachBrokerOwnedPath) {
    throw new Error("Codex isolated launcher roots overlap or escape ownership");
  }
  return {
    schema: "control-room.codex-macos-isolated-launcher-plan/v1",
    brokerController: { executable: config.nodeRuntime, args: [config.brokerControllerScript, "--config", config.brokerConfigPath], cwd: config.brokerReleaseRoot, env: {} },
    appServerChild: { executable: CODEX_PINNED_EXECUTABLE_V1, args: ["app-server", "--stdio", "--strict-config"], cwd: config.brokerReleaseRoot, env: { CODEX_HOME: config.brokerCodexHome } },
    remoteExecutor: { executable: CODEX_PINNED_EXECUTABLE_V1,
      args: ["exec-server", "--strict-config", "--concurrent-requests", "1", "--listen", config.executorEndpoint],
      cwd: config.executorWorkingDirectory, env: { CODEX_HOME: config.executorCodexHome } },
    environmentAdd: { method: "environment/add", params: { environmentId: config.environmentId, execServerUrl: config.executorEndpoint, connectTimeoutMs: 5_000 } },
    environmentStatus: { method: "environment/status", params: { environmentId: config.environmentId } },
    threadEnvironment: { environmentId: config.environmentId, cwd: config.workspacePath, runtimeWorkspaceRoots: [config.workspacePath] },
    allowedClientMethods: [...CODEX_ISOLATED_CLIENT_METHODS_V1],
    summary: { brokerIdentityDigest: config.brokerIdentityDigest, executorIdentityDigest: config.executorIdentityDigest,
      environmentIdDigest: sha256Digest(config.environmentId), endpointIdentityDigest: sha256Digest(config.executorEndpoint),
      brokerRootDigest: sha256Digest(JSON.stringify({ releaseRoot: config.brokerReleaseRoot, configRoot: config.brokerConfigRoot,
        credentialRoot: config.brokerCodexHome, stateRoot: config.brokerStateRoot })),
      executorRootDigest: sha256Digest(config.executorCodexHome) },
  };
}
