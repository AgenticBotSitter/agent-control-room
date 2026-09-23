#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { assembleMacosLocalLauncherBundleV1 } from "../src/installer/v1/macos-local-launcher-bundle.mjs";

const args = process.argv.slice(2).filter(value => value !== "--");
const one = flag => {
  const positions = args.reduce((all, value, index) => value === flag ? [...all, index] : all, []);
  return positions.length === 1 && positions[0] < args.length - 1 ? args[positions[0] + 1] : undefined;
};
const sourceRoot = one("--source-root");
const releaseDirectory = one("--release-directory");
const nativeArtifactDirectory = one("--native-artifact-directory");
const journalNativeArtifactDirectory = one("--journal-native-artifact-directory");
const outputDirectory = one("--output-directory");
const known = new Set(["--source-root", "--release-directory", "--native-artifact-directory",
  "--journal-native-artifact-directory", "--output-directory", sourceRoot, releaseDirectory,
  nativeArtifactDirectory, journalNativeArtifactDirectory, outputDirectory].filter(Boolean));

if (args.length !== 10 || args.some(value => !known.has(value))
  || ![sourceRoot, releaseDirectory, nativeArtifactDirectory, journalNativeArtifactDirectory, outputDirectory]
    .every(value => value && isAbsolute(value))) {
  console.error("Usage: node scripts/assemble-macos-local-launcher.mjs --source-root ABSOLUTE_SOURCE_ROOT --release-directory ABSOLUTE_RELEASE_DIRECTORY --native-artifact-directory ABSOLUTE_NATIVE_ARTIFACT_DIRECTORY --journal-native-artifact-directory ABSOLUTE_JOURNAL_NATIVE_ARTIFACT_DIRECTORY --output-directory ABSOLUTE_EMPTY_OUTPUT_DIRECTORY");
  process.exitCode = 2;
} else {
  try {
    const report = await assembleMacosLocalLauncherBundleV1({ sourceRoot, releaseDirectory, nativeArtifactDirectory,
      journalNativeArtifactDirectory, outputDirectory });
    console.log(JSON.stringify(report, null, 2));
  } catch {
    console.error("Control Room refused to assemble the macOS local launcher bundle.");
    process.exitCode = 1;
  }
}
