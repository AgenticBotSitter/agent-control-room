#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyInstallerSignedReleaseFromTrustFileV1 } from "../src/installer/v1/signed-release-verifier.mjs";

function parse(args) {
  const values = new Map(), allowed = new Set(["--release-directory", "--trust"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!allowed.has(flag) || typeof value !== "string" || value.startsWith("--") || values.has(flag))
      throw new Error("release_verify_arguments_invalid");
    values.set(flag, value);
  }
  if (args.length !== 4 || [...allowed].some(flag => !values.has(flag)))
    throw new Error("release_verify_arguments_invalid");
  return { releaseDirectory: resolve(values.get("--release-directory")), trustPath: resolve(values.get("--trust")) };
}

export async function runVerifySignedReleaseCliV1(args, options) {
  try {
    const result = await verifyInstallerSignedReleaseFromTrustFileV1(parse(args), options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error?.message === "release_verify_arguments_invalid"
      ? "Usage: verify-signed-release --release-directory DIR --trust FILE"
      : "Control Room signed-release verification refused."}\n`);
    return error?.message === "release_verify_arguments_invalid" ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runVerifySignedReleaseCliV1(process.argv.slice(2));
