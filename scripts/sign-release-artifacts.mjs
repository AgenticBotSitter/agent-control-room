#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { signReleaseArtifactsV1 } from "./release-signing.mjs";

const required = Object.freeze(["--release-directory", "--version", "--config", "--connector",
  "--connector-manifest", "--connector-min-version", "--updater", "--web-manifest"]);

function parse(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!required.includes(flag) || typeof value !== "string" || value.startsWith("--") || values.has(flag))
      throw new Error("release_arguments_invalid");
    values.set(flag, value);
  }
  if (args.length !== required.length * 2 || required.some(flag => !values.has(flag)))
    throw new Error("release_arguments_invalid");
  const path = flag => resolve(values.get(flag));
  return { releaseDirectory: path("--release-directory"), version: values.get("--version"),
    configPath: path("--config"), connectorPath: path("--connector"),
    connectorManifestPath: path("--connector-manifest"), connectorMinVersion: values.get("--connector-min-version"),
    updaterPath: path("--updater"), webManifestPath: path("--web-manifest") };
}

export async function runSignReleaseArtifactsCliV1(args, options) {
  try {
    const result = await signReleaseArtifactsV1(parse(args), options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error?.message === "release_arguments_invalid"
      ? "Usage: sign-release-artifacts --release-directory DIR --version VERSION --config FILE --connector FILE --connector-manifest FILE --connector-min-version VERSION --updater FILE --web-manifest FILE"
      : "Control Room release signing refused."}\n`);
    return error?.message === "release_arguments_invalid" ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runSignReleaseArtifactsCliV1(process.argv.slice(2));
