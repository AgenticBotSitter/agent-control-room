import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NODE_POLICY_CONTRACT_V1 } from "../../src/node-policy/v1/index.ts";

type ReadinessPlatform = "windows" | "macos" | "linux";
type Check = { id: string; status: "pass"; detail: string };

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repositoryRoot = resolve(scriptDirectory, "..", "..");
const harnessPath = join(scriptDirectory, "platform-key-store-harness.ts");
const macosHelperPath = join(scriptDirectory, "macos-keychain-fixture.swift");
const windowsPowerShell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const runtimePlatform: ReadinessPlatform | undefined = process.platform === "win32"
  ? "windows"
  : process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : undefined;

function parseArguments(values: string[]): { platform: ReadinessPlatform; operatorReady?: string } {
  if (values.length % 2 !== 0) throw new Error("invalid_arguments");
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name || !value || !["--platform", "--operator-ready"].includes(name) || parsed.has(name) || value.startsWith("--")) {
      throw new Error("invalid_arguments");
    }
    parsed.set(name, value);
  }
  const platform = parsed.get("--platform");
  if (platform !== "windows" && platform !== "macos" && platform !== "linux") throw new Error("invalid_arguments");
  const operatorReady = parsed.get("--operator-ready");
  if (platform === "macos" && operatorReady !== "live-stderr-and-desktop") throw new Error("operator_not_ready");
  if (platform !== "macos" && operatorReady !== undefined) throw new Error("invalid_arguments");
  return { platform, operatorReady };
}

function supportedNodeVersion(actual: string): boolean {
  const [major, minor, patch, ...extra] = actual.split(".").map((part) => Number.parseInt(part, 10));
  return extra.length === 0 && [major, minor, patch].every(Number.isFinite)
    && (major! > 22 || major === 22 && (minor! > 13 || minor === 13 && patch! >= 0));
}

async function requireRegularFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("prerequisite_unavailable");
  await access(path, constants.R_OK);
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function main(): Promise<void> {
  const { platform, operatorReady } = parseArguments(process.argv.slice(2));
  if (runtimePlatform !== platform) throw new Error("wrong_platform");
  const checks: Check[] = [];

  if (await realpath(process.cwd()) !== await realpath(repositoryRoot)) throw new Error("wrong_working_directory");
  checks.push({ id: "working_directory", status: "pass", detail: "repository_root" });
  const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as { name?: string };
  if (packageJson.name !== "control-room") throw new Error("wrong_repository");
  checks.push({ id: "repository_identity", status: "pass", detail: "control-room" });

  if (!supportedNodeVersion(process.versions.node)) throw new Error("node_version_unsupported");
  await requireRegularFile(process.execPath);
  checks.push({ id: "node_runtime", status: "pass", detail: "node>=22.13.0" });
  if (NODE_POLICY_CONTRACT_V1 !== "control-room-node-policy/v1") throw new Error("module_resolution_failed");
  checks.push({ id: "tsx_module_resolution", status: "pass", detail: "node-policy-v1" });
  await requireRegularFile(harnessPath);
  checks.push({ id: "qualification_harness", status: "pass", detail: "repository_owned" });

  const tempRoot = await realpath(tmpdir());
  const tempStat = await lstat(tempRoot);
  if (!tempStat.isDirectory() || tempStat.isSymbolicLink()) throw new Error("scratch_parent_unsuitable");
  await access(tempRoot, constants.R_OK | constants.W_OK);
  checks.push({ id: "scratch_parent", status: "pass", detail: "existing_directory_read_write" });

  let helperSha256: string | undefined;
  if (platform === "windows") {
    await requireRegularFile(windowsPowerShell);
    checks.push({ id: "native_tool", status: "pass", detail: "windows_powershell_present" });
  } else if (platform === "macos") {
    await requireRegularFile("/usr/bin/swiftc");
    await requireRegularFile("/usr/bin/security");
    await requireRegularFile(macosHelperPath);
    checks.push({ id: "native_tools", status: "pass", detail: "swiftc_security_present" });
    checks.push({ id: "attended_operator", status: "pass", detail: operatorReady! });
    helperSha256 = await sha256File(macosHelperPath);
  } else {
    checks.push({ id: "native_tool", status: "pass", detail: "no_external_tool_required" });
  }

  checks.push({ id: "output_contract", status: "pass", detail: "single_json_stdout" });
  process.stdout.write(`${JSON.stringify({
    schema: "control-room.platform-key-store-readiness/v1",
    platform,
    ready: true,
    checks,
    artifacts: {
      harnessSha256: await sha256File(harnessPath),
      ...(helperSha256 ? { helperSha256 } : {}),
    },
  })}\n`);
}

main().catch((error: unknown) => {
  const category = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "readiness_failed";
  process.stdout.write(`${JSON.stringify({ schema: "control-room.platform-key-store-readiness-error/v1", category })}\n`);
  process.exitCode = 1;
});
