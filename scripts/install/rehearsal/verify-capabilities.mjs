#!/usr/bin/env node
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

import { isMainModuleV1 } from "../../../src/installer/shared/is-main-module.mjs";

export const REQUIRED_INSTALLER_CAPABILITIES_V1 = Object.freeze({
  schema: "control-room.installer-capabilities/v1",
  version: 1,
  rehearsal: Object.freeze({
    config: "control-room.e2e2-rehearsal-config/v1",
    freshDatabase: true,
    softwareAuthenticator: "es256-fixed-v1",
    evidence: "control-room.e2e2-evidence/v1",
    ownerReadableEvidence: true,
    tailscale: Object.freeze({
      mutationAllowed: false,
      capture: "skipped (rehearsal)",
      activate: "skipped (rehearsal)",
      restore: "skipped (rehearsal)",
    }),
  }),
});
const refuse = code => { throw Object.assign(new Error(code), { code }); };

function exactArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--input" || !argv[1]) refuse("arguments_refused");
  return argv[1];
}
function same(left, right) {
  if (Array.isArray(right)) return Array.isArray(left) && left.length === right.length && right.every((item, index) => same(left[index], item));
  if (right && typeof right === "object") return left && typeof left === "object" && !Array.isArray(left)
    && Object.keys(right).every(key => same(left[key], right[key]));
  return left === right;
}
export function verifyInstallerCapabilitiesV1(value) {
  if (!same(value, REQUIRED_INSTALLER_CAPABILITIES_V1)) refuse("installer_capabilities_refused");
  return true;
}
export async function main(argv = process.argv.slice(2)) {
  const path = exactArguments(argv);
  if (!isAbsolute(path) || normalize(path) !== path) refuse("capabilities_path_refused");
  const stat = await lstat(path).catch(() => refuse("capabilities_path_refused"));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) refuse("capabilities_path_refused");
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch { refuse("installer_capabilities_refused"); }
  verifyInstallerCapabilitiesV1(value);
  process.stdout.write("PASS: installer rehearsal capabilities include no Tailscale mutation\n");
}
if (isMainModuleV1(process.argv[1], import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error?.code ?? error?.message ?? "installer_capabilities_refused"}\n`); process.exitCode = 1; });
}
