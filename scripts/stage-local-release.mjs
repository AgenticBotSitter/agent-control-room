#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { stageLocalReleaseV1 } from "../src/installer/v1/local-release-stager.mjs";

const args = process.argv.slice(2).filter(value => value !== "--");
const one = flag => {
  const indexes = args.reduce((all, item, index) => item === flag ? [...all, index] : all, []);
  return indexes.length === 1 && indexes[0] < args.length - 1 ? args[indexes[0] + 1] : undefined;
};
const releaseDirectory = one("--release-directory");
const installRoot = one("--install-root");
const ownerCount = args.filter(value => value === "--owner-attended").length;
const known = new Set(["--owner-attended", "--release-directory", "--install-root",
  releaseDirectory, installRoot].filter(Boolean));

if (ownerCount !== 1 || args.length !== 5 || args.some(item => !known.has(item))
  || !releaseDirectory || !installRoot || !isAbsolute(releaseDirectory) || !isAbsolute(installRoot)) {
  console.error("Usage: node scripts/stage-local-release.mjs --owner-attended --release-directory ABSOLUTE_RELEASE_DIRECTORY --install-root ABSOLUTE_INSTALL_ROOT");
  process.exitCode = 2;
} else {
  try {
    console.log(JSON.stringify(await stageLocalReleaseV1({ ownerAttended: true, releaseDirectory, installRoot }), null, 2));
  } catch {
    console.error("Control Room refused to stage the local release.");
    process.exitCode = 1;
  }
}
