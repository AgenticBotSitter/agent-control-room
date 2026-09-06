import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repositoryRoot = resolve(scriptDirectory, "..", "..");
const runtimePlatform = process.platform === "win32"
  ? "windows"
  : process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : undefined;

function parseArguments(values) {
  if (values.length !== 2 || values[0] !== "--platform" || !["windows", "macos", "linux"].includes(values[1])) {
    throw new Error("invalid_arguments");
  }
  return values[1];
}

function supportedNodeVersion(actual) {
  const [major, minor, patch, ...extra] = actual.split(".").map((part) => Number.parseInt(part, 10));
  return extra.length === 0 && [major, minor, patch].every(Number.isFinite)
    && (major > 22 || major === 22 && (minor > 13 || minor === 13 && patch >= 0));
}

async function requireRegularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid_repository_configuration");
  await access(path, constants.R_OK);
}

function hasPinnedBuildPolicy(value) {
  const normalized = value.replaceAll("\r\n", "\n").trim();
  return normalized === [
    "packages:",
    '  - "."',
    "enableGlobalVirtualStore: false",
    "allowBuilds:",
    "  esbuild: false",
    "  sharp: false",
    "  workerd: false",
  ].join("\n");
}

async function resolvesPackage(name) {
  try {
    import.meta.resolve(name);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const platform = parseArguments(process.argv.slice(2));
  if (platform !== runtimePlatform) throw new Error("wrong_platform");
  if (await realpath(process.cwd()) !== await realpath(repositoryRoot)) throw new Error("wrong_working_directory");
  if (!supportedNodeVersion(process.versions.node)) throw new Error("node_version_unsupported");

  const packagePath = join(repositoryRoot, "package.json");
  const lockPath = join(repositoryRoot, "pnpm-lock.yaml");
  const workspacePath = join(repositoryRoot, "pnpm-workspace.yaml");
  await Promise.all([requireRegularFile(packagePath), requireRegularFile(lockPath), requireRegularFile(workspacePath)]);
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  if (packageJson.name !== "control-room" || packageJson.packageManager !== "pnpm@11.19.0") {
    throw new Error("invalid_repository_configuration");
  }
  if (!hasPinnedBuildPolicy(await readFile(workspacePath, "utf8"))) throw new Error("invalid_build_policy");

  const packages = ["tsx", "zod"];
  const availability = await Promise.all(packages.map(async (name) => [name, await resolvesPackage(name)]));
  const missing = availability.filter(([, present]) => !present).map(([name]) => name);
  const common = {
    schema: "control-room.platform-key-store-stage-zero/v1",
    platform,
    node: "node>=22.13.0",
    packageManager: "pnpm@11.19.0",
    lockfileSha256: createHash("sha256").update(await readFile(lockPath)).digest("hex"),
    buildPolicy: { esbuild: false, sharp: false, workerd: false },
  };
  if (missing.length > 0) {
    process.stdout.write(`${JSON.stringify({
      ...common,
      status: "setup_required",
      missing,
      preparation: {
        offline: {
          executable: "pnpm",
          args: ["install", "--frozen-lockfile", "--offline"],
          environment: { CI: "true" },
          network: "forbidden",
        },
        onlineRequiresSeparateAuthorization: {
          executable: "pnpm",
          args: ["install", "--frozen-lockfile"],
          environment: { CI: "true" },
          network: "required",
        },
      },
    })}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ...common,
    status: "ready_for_runtime_check",
    resolved: packages,
    nextCommand: `node --import tsx scripts/qualification/platform-key-store-readiness.ts --platform ${platform}`,
  })}\n`);
}

main().catch((error) => {
  const category = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "stage_zero_failed";
  process.stdout.write(`${JSON.stringify({ schema: "control-room.platform-key-store-stage-zero-error/v1", category })}\n`);
  process.exitCode = 1;
});
