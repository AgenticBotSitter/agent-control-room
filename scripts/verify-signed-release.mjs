#!/usr/bin/env node
import { isMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";
import { resolve } from "node:path";
import { verifyInstallerSignedReleaseFromTrustFileV1 } from "../src/installer/v1/signed-release-verifier.mjs";

function parse(args) {
  const values = new Map(), allowed = new Set(["--release-directory", "--trust", "--installed-version", "--built-from"]);
  let allowRollback = false;
  for (let index = 0; index < args.length;) {
    const flag = args[index];
    if (flag === "--allow-rollback") { if (allowRollback) throw new Error("release_verify_arguments_invalid"); allowRollback = true; index += 1; continue; }
    const value = args[index + 1];
    if (!allowed.has(flag) || typeof value !== "string" || value.startsWith("--") || values.has(flag))
      throw new Error("release_verify_arguments_invalid");
    values.set(flag, value);
    index += 2;
  }
  if ([...allowed].some(flag => !values.has(flag)))
    throw new Error("release_verify_arguments_invalid");
  return { releaseDirectory: resolve(values.get("--release-directory")), trustPath: resolve(values.get("--trust")),
    installedVersion: values.get("--installed-version"), expectedBuiltFrom: values.get("--built-from"), allowRollback };
}

export async function runVerifySignedReleaseCliV1(args, options) {
  try {
    const result = await verifyInstallerSignedReleaseFromTrustFileV1(parse(args), options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error?.message === "release_verify_arguments_invalid"
      ? "Usage: verify-signed-release --release-directory DIR --trust FILE --installed-version VERSION --built-from COMMIT [--allow-rollback]"
      : "Control Room signed-release verification refused."}\n`);
    return error?.message === "release_verify_arguments_invalid" ? 2 : 1;
  }
}

if (isMainModuleV1(process.argv[1], import.meta.url))
  process.exitCode = await runVerifySignedReleaseCliV1(process.argv.slice(2));
