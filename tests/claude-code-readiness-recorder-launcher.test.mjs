import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1 } from
  "../src/harness/claude-code-v1/text-review-invocation-policy.ts";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology.ts";
import { sha256Digest } from "../src/security/canonical-digest.ts";

const run = promisify(execFile);
const hermes = { kind: "local", workerId: "worker:marvin",
  adapterId: "connector:hermes-021-macos-local-v1", adapterRevision: "00570550" };
const claude = { kind: "local", workerId: "worker:claude",
  adapterId: "connector:claude-code-local-v1", adapterRevision: "0000001" };
const plan = planInstallationTopologyV1({ databaseAuthorityDigest: sha256Digest("database"),
  schedulerAuthorityDigest: sha256Digest("scheduler"), currentRoutes: [hermes], requestedRoutes: [hermes, claude] });
const report = { schema: "control-room.claude-code-text-review-qualification-report/v1", qualified: true,
  fixedInvocationPolicyDigest: CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1,
  executableSha256: sha256Digest("private-executable"), workingDirectoryBindingDigest: sha256Digest("private-workspace"),
  supervisedRouteDigest: sha256Digest("private-supervised-route"),
  terminalResultObserved: true, terminalResultDigest: sha256Digest("private-answer"), inputTokens: 10,
  outputTokens: 4, totalTokens: 14, durationMs: 250, failureReason: "none",
  retryRequiresFreshOwnerAuthorization: false, startsWork: false, grantsExecutionAuthority: false };

test("Claude readiness recorder emits only the redacted partial setup record", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "acr-claude-readiness-"));
  try {
    const planPath = path.join(directory, "plan.json"), reportPath = path.join(directory, "report.json");
    await Promise.all([writeFile(planPath, JSON.stringify(plan)), writeFile(reportPath, JSON.stringify(report))]);
    const { stdout, stderr } = await run(process.execPath,
      ["--import", "tsx", "scripts/record-local-claude-readiness.ts", "--plan", planPath, "--report", reportPath],
      { cwd: process.cwd() });
    assert.equal(stderr, "");
    const readiness = JSON.parse(stdout);
    assert.equal(readiness.proofs.find(item => item.proof === "installed_process_identity")?.state, "passed");
    assert.equal(readiness.proofs.find(item => item.proof === "permission_boundary")?.state, "passed");
    assert.equal(readiness.proofs.find(item => item.proof === "cancellation_and_restart_recovery")?.state, "not_started");
    assert.doesNotMatch(stdout, /private-executable|private-workspace|private-answer|inputTokens|outputTokens/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Claude readiness recorder fails closed without echoing an input path", async () => {
  const privatePath = "/private/owner/claude-qualification.json";
  const result = await run(process.execPath,
    ["--import", "tsx", "scripts/record-local-claude-readiness.ts", "--plan", privatePath, "--report", privatePath],
    { cwd: process.cwd() }).catch(error => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
  assert.match(result.stdout, /qualification_record_invalid/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /private\/owner/);
});
