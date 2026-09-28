import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { readQuarantine, validateQuarantine } from "./check-test-quarantine.mjs";

const testFilePattern = /^tests\/.+\.test\.(?:ts|tsx|mjs|js)$/;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function runNode(args, spawn = spawnSync) {
  const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
