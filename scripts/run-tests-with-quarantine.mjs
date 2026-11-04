import { isMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";
import { spawnSync } from "node:child_process";
import { readQuarantine, validateQuarantine } from "./check-test-quarantine.mjs";

const testFilePattern = /^tests\/.+\.test\.(?:ts|tsx|mjs|js)$/;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function runNode(args, spawn = spawnSync) {
  const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
  // Round 17 diagnostics for the two lanes whose hosted runner disappeared.
  // Keep the existing test selection, concurrency, signals and exit status.
  if (env.GITHUB_ACTIONS === "true" && args.some(arg =>
    arg === "tests/codex-canonical-result-publication.test.ts"
    || arg === "tests/improve-control-room-loop-bridge.test.ts")) {
    env.CONTROL_ROOM_CI_TEST_DIAGNOSTICS_PID = String(process.pid);
    args = ["--import", new URL("./ci/test-process-diagnostics.mjs", import.meta.url).href, ...args];
  }
  const result = spawn(process.execPath, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function parseEntry(identifier) {
  const separator = identifier.indexOf("::");
  return { file: identifier.slice(0, separator), name: identifier.slice(separator + 2) };
}

export function runGate(args, entries, spawn = spawnSync) {
  const files = args.filter(argument => testFilePattern.test(argument));
  const byFile = new Map();
  for (const entry of entries) {
    const parsed = parseEntry(entry.test);
    const names = byFile.get(parsed.file) ?? [];
    names.push(parsed.name);
    byFile.set(parsed.file, names);
  }
  const affected = files.filter(file => byFile.has(file));
  if (affected.length === 0) return runNode(args, spawn);

  const common = args.filter(argument => !testFilePattern.test(argument));
  const unaffected = files.filter(file => !byFile.has(file));
  let status = unaffected.length === 0 ? 0 : runNode([...common, ...unaffected], spawn);
  for (const file of affected) {
    const pattern = `^(?:${byFile.get(file).map(escapeRegex).join("|")})$`;
    const next = runNode([...common, `--test-skip-pattern=${pattern}`, file], spawn);
    if (next !== 0) status = next;
  }
  return status;
}

export function runQuarantined(entries, spawn = spawnSync) {
  let status = 0;
  for (const entry of entries) {
    const { file, name } = parseEntry(entry.test);
    console.log(`quarantined: ${entry.test} (${entry.issue}, owner: ${entry.owner})`);
    const next = runNode(["--import", "tsx", "--test", `--test-name-pattern=^${escapeRegex(name)}$`, file], spawn);
    if (next !== 0) status = next;
  }
  if (entries.length === 0) console.log("no quarantined tests");
  return status;
}

function main() {
  const quarantinedMode = process.argv[2] === "--quarantined";
  const args = quarantinedMode ? process.argv.slice(3) : process.argv.slice(2);
  const entries = readQuarantine();
  const errors = validateQuarantine(entries);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  process.exitCode = quarantinedMode ? runQuarantined(entries) : runGate(args, entries);
}

if (isMainModuleV1(process.argv[1], import.meta.url)) main();
