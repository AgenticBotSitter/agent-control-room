import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function configuredPrivateNameTerms(env = process.env) {
  let source = env.CONTROL_ROOM_PRIVATE_NAMES;
  if (env.CONTROL_ROOM_PRIVATE_NAMES_FILE) {
    try {
      source = readFileSync(env.CONTROL_ROOM_PRIVATE_NAMES_FILE, "utf8");
    } catch {
      throw new Error("private-name check failed: configured list could not be read");
    }
  }
  if (!source) return [];
  return [...new Set(source.split(/\r?\n/).map(term => term.trim()).filter(Boolean))];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactor(terms) {
  const expression = new RegExp(terms
    .toSorted((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|"), "giu");
  return value => value.replace(expression, "<redacted>");
}

export function redactPrivateNames(value, env = process.env) {
  const terms = configuredPrivateNameTerms(env);
  return terms.length === 0 ? value : redactor(terms)(value);
}

export function findPrivateNameMatches({ root = process.cwd(), env = process.env } = {}) {
  const terms = configuredPrivateNameTerms(env);
  if (terms.length === 0) return { configured: false, matches: [] };

  let tracked;
  try {
    tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    throw new Error("private-name check failed: tracked files could not be listed");
  }

  const lowerTerms = terms.map(term => term.toLocaleLowerCase());
  const redact = redactor(terms);
  const matches = [];
  for (const file of tracked) {
    const displayFile = redact(file)
      .replaceAll("\r", "\\r")
      .replaceAll("\n", "\\n")
      .replaceAll("\t", "\\t");
    const lowerFile = file.toLocaleLowerCase();
    if (lowerTerms.some(term => lowerFile.includes(term))) {
      matches.push({ file: displayFile, line: 0 });
    }

    let source;
    try {
      const path = join(root, file);
      source = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path, "utf8");
    } catch {
      continue;
    }
    source.split(/\r?\n/).forEach((line, index) => {
      const lowerLine = line.toLocaleLowerCase();
      if (lowerTerms.some(term => lowerLine.includes(term))) {
        matches.push({ file: displayFile, line: index + 1 });
      }
    });
  }
  return { configured: true, matches };
}

export function main() {
  let result;
  try {
    result = findPrivateNameMatches();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "private-name check failed");
    process.exitCode = 1;
    return;
  }
  if (!result.configured) {
    console.log("private-name check skipped: no list configured");
    return;
  }
  if (result.matches.length === 0) {
    console.log("private-name check passed");
    return;
  }
  for (const match of result.matches) {
    console.error(`${match.file}:${match.line}: private name <redacted>`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
