#!/usr/bin/env node
import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyTrustedRuntimeInstallation } from "../../src/updater/v1/trusted-runtime.mjs";

const runtimePolicyPath = fileURLToPath(new URL("../../src/updater/v1/policy/runtime-inventory.json", import.meta.url));
const initPolicyPath = fileURLToPath(new URL("../../src/updater/v1/policy/init-config.json", import.meta.url));

function runtimeDirectory(argv) {
  if (argv.length !== 2 || argv[0] !== "--runtime-directory" || !isAbsolute(argv[1]) || resolve(argv[1]) !== argv[1]) {
    throw new Error("usage: check-trusted-runtime --runtime-directory ABSOLUTE_PATH");
  }
  return argv[1];
}

export async function checkTrustedRuntime(path) {
  const [manifestPolicy, initPolicy] = await Promise.all([runtimePolicyPath, initPolicyPath]
    .map(async file => JSON.parse(await readFile(file, "utf8"))));
  return verifyTrustedRuntimeInstallation({ runtimeDirectory: path, manifestPolicy, initPolicy });
}

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  void checkTrustedRuntime(runtimeDirectory(process.argv.slice(2))).then(result => {
    process.stdout.write(`${JSON.stringify({ schema: "control-room.t1-check/v1", state: "passed",
      runtimeDirectory: result.runtimeDirectory, developerDirectory: result.developerTools.developerDirectory,
      tools: Object.keys(result.tools) })}\n`);
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : "t1_check_failed"}\n`);
    process.exitCode = 1;
  });
}
