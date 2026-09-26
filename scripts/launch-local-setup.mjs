#!/usr/bin/env node
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { runLocalCleanInstallRehearsalV1 } from "../src/installer/v1/local-clean-install-acceptance.mjs";

const args = process.argv.slice(2).filter(value => value !== "--");
const one = flag => {
  const positions = args.reduce((all, value, index) => value === flag ? [...all, index] : all, []);
  return positions.length === 1 && positions[0] < args.length - 1 ? args[positions[0] + 1] : undefined;
};
const mode = one("--mode"), installRoot = one("--install-root"), journalRoot = one("--journal-root");
const installationId = one("--installation-id"), topologyPlanDigest = one("--topology-plan-digest");
const releaseDirectory = one("--release-directory");
const expectedReleaseVersion = one("--expected-release-version");
const expectedReleaseManifestDigest = one("--expected-release-manifest-digest");
const known = new Set(["--owner-attended", "--mode", "--install-root", "--journal-root", "--installation-id",
  "--topology-plan-digest", "--release-directory", "--expected-release-version", "--expected-release-manifest-digest",
  mode, installRoot, journalRoot, installationId, topologyPlanDigest, releaseDirectory, expectedReleaseVersion,
  expectedReleaseManifestDigest].filter(Boolean));

function runBounded(spec) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.environment, shell: false,
      stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", oversized = false;
    const append = target => chunk => {
      if (target === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
      if (stdout.length > 1024 * 1024 || stderr.length > 1024 * 1024) { oversized = true; child.kill("SIGKILL"); }
    };
    child.stdout.on("data", append("stdout")); child.stderr.on("data", append("stderr")); child.once("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), spec.timeoutMs);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (oversized) return reject(new Error("dependency_tool_output_too_large"));
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

const common = args.filter(value => value === "--owner-attended").length === 1
  && [installRoot, journalRoot].every(value => value && isAbsolute(value)) && installationId && topologyPlanDigest
  && (mode === "begin" || mode === "resume") && args.every(value => known.has(value));
const valid = common && (mode === "begin"
  ? Boolean(releaseDirectory && isAbsolute(releaseDirectory)
    && expectedReleaseVersion === undefined && expectedReleaseManifestDigest === undefined)
  : releaseDirectory === undefined && Boolean(expectedReleaseVersion && expectedReleaseManifestDigest))
  && args.length === (mode === "begin" ? 13 : 15);
if (!valid) {
  console.error("Usage: node scripts/launch-local-setup.mjs --owner-attended --mode begin --release-directory ABSOLUTE_RELEASE_DIRECTORY --install-root ABSOLUTE_PRIVATE_INSTALL_ROOT --journal-root ABSOLUTE_PRIVATE_JOURNAL_ROOT --installation-id SAFE_ID --topology-plan-digest sha256:...\n       node scripts/launch-local-setup.mjs --owner-attended --mode resume --expected-release-version VERSION --expected-release-manifest-digest sha256:... --install-root ABSOLUTE_PRIVATE_INSTALL_ROOT --journal-root ABSOLUTE_PRIVATE_JOURNAL_ROOT --installation-id SAFE_ID --topology-plan-digest sha256:...");
  process.exitCode = 2;
} else {
  try {
    const report = await runLocalCleanInstallRehearsalV1({ ownerAttended: true, mode, installRoot, journalRoot,
      installationId, topologyPlanDigest, ...(mode === "begin" ? { releaseDirectory }
        : { expectedReleaseVersion, expectedReleaseManifestDigest }) }, { runner: runBounded });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const code = error?.code;
    const state = code === "local_production_dependency_preparation_uncertain" || code === "local_production_dependency_preparation_in_progress"
      ? "uncertain_or_in_progress" : "refused";
    console.error(`Control Room local setup rehearsal ${state}.`);
    process.exitCode = 1;
  }
}
