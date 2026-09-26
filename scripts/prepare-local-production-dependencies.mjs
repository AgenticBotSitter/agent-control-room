#!/usr/bin/env node
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { prepareLocalProductionDependenciesV1 } from "../src/installer/v1/local-production-dependencies.mjs";

const args = process.argv.slice(2).filter(value => value !== "--");
const one = flag => {
  const indexes = args.reduce((all, item, index) => item === flag ? [...all, index] : all, []);
  return indexes.length === 1 && indexes[0] < args.length - 1 ? args[indexes[0] + 1] : undefined;
};
const installRoot = one("--install-root");
const version = one("--version");
const expectedManifestDigest = one("--expected-manifest-digest");
const known = new Set(["--owner-attended", "--install-root", "--version", "--expected-manifest-digest",
  installRoot, version, expectedManifestDigest].filter(Boolean));

function runBounded(spec) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, spec.args, { cwd: spec.cwd, env: spec.environment,
      shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", oversized = false;
    const collect = target => chunk => {
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      if (stdout.length > 1024 * 1024 || stderr.length > 1024 * 1024) {
        oversized = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.once("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), spec.timeoutMs);
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (oversized) return reject(new Error("dependency_tool_output_too_large"));
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}
if (args.filter(value => value === "--owner-attended").length !== 1 || args.length !== 7
  || args.some(item => !known.has(item)) || !installRoot || !isAbsolute(installRoot)
  || !version || !expectedManifestDigest) {
  console.error("Usage: node scripts/prepare-local-production-dependencies.mjs --owner-attended --install-root ABSOLUTE_INSTALL_ROOT --version VERSION --expected-manifest-digest sha256:...");
  process.exitCode = 2;
} else {
  try {
    const report = await prepareLocalProductionDependenciesV1({ ownerAttended: true, installRoot, version,
      expectedManifestDigest }, { runner: runBounded });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const state = error?.code === "local_production_dependency_preparation_uncertain"
      || error?.code === "local_production_dependency_preparation_in_progress" ? "uncertain_or_in_progress" : "refused";
    console.error(`Control Room production dependency preparation ${state}.`);
    process.exitCode = 1;
  }
}
