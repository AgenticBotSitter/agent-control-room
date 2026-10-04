import { isMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function runtimeAssemblyMemoryGuardArgs(root = repositoryRoot) {
  return [
    join(root, "scripts/run-tests-with-quarantine.mjs"),
    "--max-old-space-size=2048",
    "--import",
    "tsx",
    "--test",
    "tests/private-local-installation-runtime-assembly.test.ts",
  ];
}

function main() {
  const result = spawnSync(process.execPath, runtimeAssemblyMemoryGuardArgs(), {
    cwd: repositoryRoot,
    env: { ...process.env, ACR_RUNTIME_ASSEMBLY_MAX_RSS_KIB: "1048576" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.signal) console.error(`runtime assembly memory guard terminated by ${result.signal}`);
  process.exitCode = result.status ?? 1;
}

if (isMainModuleV1(process.argv[1], import.meta.url)) main();
