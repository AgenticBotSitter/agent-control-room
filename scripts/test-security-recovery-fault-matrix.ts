import { spawnSync } from "node:child_process";

const files = ["tests/security-recovery-fault-matrix.test.ts", "tests/owner-signing-recovery-faults.test.ts"];
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...files], {
  cwd: process.cwd(), stdio: "inherit", env: { ...process.env, NODE_ENV: "test" },
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`synthetic_fault_matrix_interrupted:${result.signal}`);
process.exitCode = result.status ?? 1;
