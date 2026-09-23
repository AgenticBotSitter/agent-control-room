import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { sha256Digest } from "../src/security/canonical-digest.ts";

const run = promisify(execFile);
const report = { planDigest: sha256Digest("supervisor-plan"), proofs: [
  { proof: "private_configuration_custody", state: "passed", evidenceDigest: sha256Digest("custody") },
  { proof: "restricted_launch_definition", state: "passed", evidenceDigest: sha256Digest("launch") },
  { proof: "restart_and_drain_procedure", state: "passed", evidenceDigest: sha256Digest("restart") },
  { proof: "upgrade_and_rollback_procedure", state: "passed", evidenceDigest: sha256Digest("rollback") },
] };

test("local supervisor recorder emits only opaque plan-bound readiness", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "acr-supervisor-readiness-"));
  const reportPath = path.join(directory, "report.json");
  try {
    await writeFile(reportPath, JSON.stringify(report));
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", "scripts/record-local-supervisor-readiness.ts",
      "--report", reportPath], { cwd: process.cwd() });
    assert.equal(stderr, "");
    const readiness = JSON.parse(stdout);
    assert.equal(readiness.planDigest, report.planDigest);
    assert.equal(readiness.proofs.length, 4);
    assert.doesNotMatch(stdout, /acr-supervisor-readiness|report\.json|launchd|systemd/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("local supervisor recorder fails closed without echoing an input path", async () => {
  const privatePath = "/private/owner/service-review.json";
  const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", "scripts/record-local-supervisor-readiness.ts",
    "--report", privatePath], { cwd: process.cwd() })
    .catch(error => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
  assert.match(stdout, /local_service_readiness_record_invalid/);
  assert.doesNotMatch(`${stdout}\n${stderr}`, /private\/owner/);
});
