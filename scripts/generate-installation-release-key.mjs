#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateInstallationReleaseKeyV1 } from "./release-signing.mjs";

function parse(args) {
  const values = new Map(), allowed = new Set(["--protected-root", "--gateway-config", "--version-floor"]);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!allowed.has(flag) || typeof value !== "string" || value.startsWith("--") || values.has(flag))
      throw new Error("release_key_arguments_invalid");
    values.set(flag, value);
  }
  if (args.length !== 6 || [...allowed].some(flag => !values.has(flag))) throw new Error("release_key_arguments_invalid");
  return { protectedRoot: resolve(values.get("--protected-root")),
    gatewayConfigPath: resolve(values.get("--gateway-config")), versionFloor: values.get("--version-floor") };
}

export async function runGenerateInstallationReleaseKeyCliV1(args, options) {
  try {
    const result = await generateInstallationReleaseKeyV1(parse(args), options);
    process.stdout.write(`${JSON.stringify({ schema: result.schema, keyId: result.trust.keyId,
      publicKey: result.trust.publicKey, versionFloor: result.trust.versionFloor }, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error?.message === "release_key_arguments_invalid"
      ? "Usage: generate-installation-release-key --protected-root DIR --gateway-config FILE --version-floor VERSION"
      : "Control Room installation release-key generation refused."}\n`);
    return error?.message === "release_key_arguments_invalid" ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await runGenerateInstallationReleaseKeyCliV1(process.argv.slice(2));
