#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { recordInstallerInstalledReleaseV1 } from "../src/installer/v1/signed-release-verifier.mjs";

function parse(args) {
  if (args.length !== 4 || args[0] !== "--trust" || args[2] !== "--installed-version"
    || !args[1] || !args[3] || args[1].startsWith("--") || args[3].startsWith("--"))
    throw new Error("release_record_arguments_invalid");
  return { trustPath: resolve(args[1]), installedVersion: args[3] };
}

export async function runRecordInstalledReleaseCliV1(args, options) {
  try {
    const trust = await recordInstallerInstalledReleaseV1(parse(args), options);
    process.stdout.write(`${JSON.stringify({ keyId: trust.keyId, versionFloor: trust.versionFloor }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error?.message === "release_record_arguments_invalid"
      ? "Usage: record-installed-release --trust FILE --installed-version VERSION"
      : "Control Room installed-release recording refused."}\n`);
    return error?.message === "release_record_arguments_invalid" ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runRecordInstalledReleaseCliV1(process.argv.slice(2));
