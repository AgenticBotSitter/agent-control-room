#!/usr/bin/env node
import { isAbsolute } from "node:path";
import { assembleMacosLocalLauncherBundleV1, assembleMacosLocalLauncherBundleV2 }
  from "../src/installer/v1/macos-local-launcher-bundle.mjs";

const args = process.argv.slice(2).filter(value => value !== "--");
const one = flag => {
  const positions = args.reduce((all, value, index) => value === flag ? [...all, index] : all, []);
  return positions.length === 1 && positions[0] < args.length - 1 ? args[positions[0] + 1] : undefined;
};
const sourceRoot = one("--source-root");
const releaseDirectory = one("--release-directory");
const nativeArtifactDirectory = one("--native-artifact-directory");
const journalNativeArtifactDirectory = one("--journal-native-artifact-directory");
const installedConfigurationNativeArtifactDirectory = one("--installed-configuration-native-artifact-directory");
const macosServiceNativeArtifactDirectory = one("--macos-service-native-artifact-directory");
const expanded = args.includes("--installed-configuration-native-artifact-directory")
  || args.includes("--macos-service-native-artifact-directory");
const outputDirectory = one("--output-directory");
const known = new Set(["--source-root", "--release-directory", "--native-artifact-directory",
  "--journal-native-artifact-directory", "--output-directory", sourceRoot, releaseDirectory,
  nativeArtifactDirectory, journalNativeArtifactDirectory, outputDirectory,
  ...(expanded ? ["--installed-configuration-native-artifact-directory", "--macos-service-native-artifact-directory",
    installedConfigurationNativeArtifactDirectory, macosServiceNativeArtifactDirectory] : [])].filter(Boolean));

if (args.length !== (expanded ? 14 : 10) || args.some(value => !known.has(value))
  || ![sourceRoot, releaseDirectory, nativeArtifactDirectory, journalNativeArtifactDirectory, outputDirectory,
    ...(expanded ? [installedConfigurationNativeArtifactDirectory, macosServiceNativeArtifactDirectory] : [])]
    .every(value => value && isAbsolute(value))) {
  console.error("Usage: node scripts/assemble-macos-local-launcher.mjs --source-root ABSOLUTE_SOURCE_ROOT --release-directory ABSOLUTE_RELEASE_DIRECTORY --native-artifact-directory ABSOLUTE_NATIVE_ARTIFACT_DIRECTORY --journal-native-artifact-directory ABSOLUTE_JOURNAL_NATIVE_ARTIFACT_DIRECTORY --output-directory ABSOLUTE_EMPTY_OUTPUT_DIRECTORY [--installed-configuration-native-artifact-directory ABSOLUTE_CONFIGURATION_ARTIFACT_DIRECTORY --macos-service-native-artifact-directory ABSOLUTE_SERVICE_ARTIFACT_DIRECTORY]");
  process.exitCode = 2;
} else {
  try {
    const assemble = expanded ? assembleMacosLocalLauncherBundleV2 : assembleMacosLocalLauncherBundleV1;
    const report = await assemble({ sourceRoot, releaseDirectory, nativeArtifactDirectory,
      journalNativeArtifactDirectory, outputDirectory,
      ...(expanded ? { installedConfigurationNativeArtifactDirectory, macosServiceNativeArtifactDirectory } : {}) });
    console.log(JSON.stringify(report, null, 2));
  } catch {
    console.error("Control Room refused to assemble the macOS local launcher bundle.");
    process.exitCode = 1;
  }
}
