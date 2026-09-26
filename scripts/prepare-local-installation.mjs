/** Standalone read-only preparation check shipped inside the release bundle. */
import { fileURLToPath } from "node:url";
import { prepareLocalInstallationReleaseV1 } from "../src/installer/v1/local-installation-release.mjs";

const values = process.argv.slice(2).filter(value => value !== "--");
const oneValue = flag => {
  const indexes = values.reduce((all, value, index) => value === flag ? [...all, index] : all, []);
  return indexes.length === 1 && indexes[0] !== values.length - 1 ? values[indexes[0] + 1] : undefined;
};
const suppliedRoot = oneValue("--release-root");
const expectedDigest = oneValue("--expected-digest");
const releaseRoot = suppliedRoot ?? fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const known = new Set(["--dry-run", "--release-root", "--expected-digest",
  ...(suppliedRoot ? [suppliedRoot] : []), ...(expectedDigest ? [expectedDigest] : [])]);
const valid = values.every(value => known.has(value))
  && values.filter(value => value === "--dry-run").length <= 1;

if (!valid) {
  console.error("Usage: node scripts/prepare-local-installation.mjs [--release-root ABSOLUTE_RELEASE_ROOT] [--expected-digest sha256:...] [--dry-run]");
  process.exitCode = 2;
} else {
  try {
    const report = await prepareLocalInstallationReleaseV1({ releaseRoot,
      ...(expectedDigest ? { expectedDigest } : {}) });
    console.log(JSON.stringify(report, null, 2));
  } catch {
    console.log(JSON.stringify({ schema: "control-room.local-installation-package-preparation/v1",
      mode: "dry-run", readyForOwnerSetup: false, startsService: false, createsDatabase: false,
      writesCredentials: false, failureReason: "local_installation_package_refused" }, null, 2));
    process.exitCode = 1;
  }
}
