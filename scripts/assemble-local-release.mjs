#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { assembleLocalReleaseV1 } from "../src/installer/v1/local-release-assembly.mjs";

const args = process.argv.slice(2).filter(value => value !== "--");
const value = flag => {
  const indexes = args.reduce((result, item, index) => item === flag ? [...result, index] : result, []);
  return indexes.length === 1 && indexes[0] < args.length - 1 ? args[indexes[0] + 1] : undefined;
};
const releaseRoot = value("--release-root");
const outputDirectory = value("--output-directory");
const known = new Set(["--release-root", "--output-directory", releaseRoot, outputDirectory].filter(Boolean));

if (!releaseRoot || !outputDirectory || !isAbsolute(releaseRoot) || !isAbsolute(outputDirectory)
  || args.length !== 4 || args.some(item => !known.has(item))) {
  console.error("Usage: node scripts/assemble-local-release.mjs --release-root ABSOLUTE_RELEASE_ROOT --output-directory ABSOLUTE_EMPTY_OUTPUT_DIRECTORY");
  process.exitCode = 2;
} else {
  try {
    const report = await assembleLocalReleaseV1({
      releaseRoot,
      outputDirectory,
    });
    console.log(JSON.stringify(report, null, 2));
  } catch {
    console.error("Control Room local release assembly refused the input.");
    process.exitCode = 1;
  }
}
