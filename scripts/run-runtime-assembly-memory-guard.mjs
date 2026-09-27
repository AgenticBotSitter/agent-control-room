import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const result = spawnSync(process.execPath, [
  "--max-old-space-size=2048",
  "--import",
  "tsx",
  "--test",
  join(repositoryRoot, "tests/private-local-installation-runtime-assembly.test.ts"),
], {
  cwd: repositoryRoot,
  env: { ...process.env, ACR_RUNTIME_ASSEMBLY_MAX_RSS_KIB: "1048576" },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.signal) console.error(`runtime assembly memory guard terminated by ${result.signal}`);
process.exitCode = result.status ?? 1;
