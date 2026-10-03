import { isMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";
import { readFileSync } from "node:fs";

const DAY_MS = 24 * 60 * 60 * 1_000;
const ISSUE = /^#[1-9][0-9]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateQuarantine(entries, today = new Date()) {
  const errors = [];
  if (!Array.isArray(entries)) return ["quarantine must be a JSON array"];
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    const label = `entry ${index + 1}`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const keys = Object.keys(entry).sort();
    if (keys.join(",") !== "added,issue,owner,test") errors.push(`${label} must contain exactly test, issue, added, and owner`);
    if (typeof entry.test !== "string" || !/^tests\/.+\.test\.(?:ts|tsx|mjs|js)::.+/.test(entry.test)) {
      errors.push(`${label} must identify a Node tests/*.test.{ts,tsx,mjs,js} test`);
    }
    else if (seen.has(entry.test)) errors.push(`${label} duplicates ${entry.test}`);
    else seen.add(entry.test);
    if (typeof entry.issue !== "string" || !ISSUE.test(entry.issue)) errors.push(`${label} must reference a GitHub issue as #<number>`);
    if (typeof entry.owner !== "string" || entry.owner.trim().length === 0) errors.push(`${label} must name an owner role`);
    if (typeof entry.added !== "string" || !DATE.test(entry.added)) {
      errors.push(`${label} has an invalid added date`);
      continue;
    }
    const added = Date.parse(`${entry.added}T00:00:00.000Z`);
    if (!Number.isFinite(added) || new Date(added).toISOString().slice(0, 10) !== entry.added) {
      errors.push(`${label} has an invalid added date`);
      continue;
    }
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const ageDays = Math.floor((todayUtc - added) / DAY_MS);
    if (ageDays < 0) errors.push(`${label} has a future added date`);
    else if (ageDays > 14) errors.push(`${label} is ${ageDays} days old; quarantine entries expire after 14 days`);
  }
  return errors;
}

export function readQuarantine(path = "tests/quarantine.json") {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const path = process.argv[2] ?? "tests/quarantine.json";
  let entries;
  try { entries = readQuarantine(path); }
  catch (error) {
    console.error(`cannot read quarantine list ${path}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }
  const errors = validateQuarantine(entries);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log(`quarantine list valid (${entries.length} entries)`);
}

if (isMainModuleV1(process.argv[1], import.meta.url)) main();
