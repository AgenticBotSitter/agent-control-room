import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface CodexMacIsolatedPackageConformanceV1 { file: string; checks: string[]; }

const root = "packages/control-room-codex-isolated-macos";
const forbidden = ["/users/", "auth.json", "api_key", "bearer ", "sudo ", "curl ", "wget ", "rm -rf", "0.0.0.0", "process/spawn"];

function check(text: string, value: string, label: string, checks: string[]): void {
  if (!text.includes(value)) throw new Error(`${label} is missing`);
  checks.push(label);
}

function safe(text: string): void {
  const lower = text.toLowerCase();
  const matched = forbidden.find((value) => lower.includes(value));
  if (matched) throw new Error(`forbidden isolated package content: ${matched}`);
}

export async function verifyCodexMacIsolatedPackagesV1(): Promise<CodexMacIsolatedPackageConformanceV1[]> {
  const brokerFile = "broker/com.control-room.codex-broker.plist.template";
  const executorFile = "executor/com.control-room.codex-executor.plist.template";
  const broker = await readFile(resolve(root, brokerFile), "utf8");
  const executor = await readFile(resolve(root, executorFile), "utf8");
  safe(broker); safe(executor);
  const results = [{ file: brokerFile, checks: [] as string[] }, { file: executorFile, checks: [] as string[] }];
  for (const placeholder of ["{{CONTROL_ROOM_CODEX_NODE_RUNTIME}}", "{{CONTROL_ROOM_CODEX_BROKER_RELEASE_DIR}}", "{{CONTROL_ROOM_CODEX_BROKER_CONFIG_PATH}}", "{{CONTROL_ROOM_CODEX_BROKER_LOG_ROOT}}"])
    check(broker, placeholder, `broker placeholder ${placeholder}`, results[0].checks);
  check(broker, "Platform: macos-launchagent-broker", "broker platform marker", results[0].checks);
  check(broker, "LimitLoadToSessionType", "broker Aqua guard", results[0].checks);
  check(broker, "<string>Aqua</string>", "broker owner login context", results[0].checks);
  check(broker, "ThrottleInterval", "broker bounded restart", results[0].checks);
  for (const placeholder of ["{{CONTROL_ROOM_CODEX_EXECUTOR_USER}}", "{{CONTROL_ROOM_CODEX_PINNED_EXECUTABLE}}", "{{CONTROL_ROOM_CODEX_EXECUTOR_ENDPOINT}}", "{{CONTROL_ROOM_CODEX_EXECUTOR_HOME}}", "{{CONTROL_ROOM_CODEX_EXECUTOR_WORK_ROOT}}", "{{CONTROL_ROOM_CODEX_EXECUTOR_LOG_ROOT}}"])
    check(executor, placeholder, `executor placeholder ${placeholder}`, results[1].checks);
  check(executor, "Platform: macos-launchdaemon-executor", "executor platform marker", results[1].checks);
  check(executor, "<key>UserName</key>", "executor separate user", results[1].checks);
  check(executor, "<string>exec-server</string>", "executor exact role", results[1].checks);
  check(executor, "<string>--strict-config</string>", "executor strict config", results[1].checks);
  check(executor, "<string>1</string>", "executor single request", results[1].checks);
  check(executor, "ThrottleInterval", "executor bounded restart", results[1].checks);
  return results;
}
