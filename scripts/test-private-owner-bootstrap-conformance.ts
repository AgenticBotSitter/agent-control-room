import { spawnSync } from "node:child_process";

const files = ["tests/private-owner-bootstrap-conformance.test.ts", "tests/private-ingress-conformance.test.ts"];
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...files], {
  cwd: process.cwd(), stdio: "inherit", env: { ...process.env, NODE_ENV: "test" },
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`offline_auth_conformance_interrupted:${result.signal}`);
process.exitCode = result.status ?? 1;
