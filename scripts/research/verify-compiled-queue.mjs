import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Portable invocation (including Windows shells). Build first; never falls back to
// source if a compiled entry is missing. Uses disposable in-process PGlite only.
const result = spawnSync(process.execPath, ["--import", "tsx", "--test",
  "--test-name-pattern=upstream schema inspection|fresh HTTP task",
  "scripts/research/pg-boss-worker-integration.test.mjs"], {
  cwd: fileURLToPath(new URL("../../", import.meta.url)),
  env: { ...process.env, CR_REUSE_COMPILED_STARTUP: "1", CR_REUSE_EVAL_ROOT: fileURLToPath(new URL("../../", import.meta.url)) },
  stdio: "inherit", timeout: 120_000,
});
if (result.error || result.signal || result.status !== 0) process.exitCode = 1;
