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

// A fork pull request never receives repository secrets, so its private-name guard
// cannot scan for anything. Failing it closed there would fail every external
// contributor on a step they cannot fix and cannot see, so a fork run skips — and
// says so, because a skip nobody can see is how this guard sat disabled for months.
//
// The fork signal is GitHub's own: the event payload names both the repository the
// workflow runs in and the repository the pull request comes from. They differ only
// for a fork. `GITHUB_ACTIONS` alone is not enough, because it is `true` for forks too.
function readEventPullRequest(env) {
  if (!env.GITHUB_EVENT_PATH) return null;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    return event.pull_request ? event : null;
  } catch {
    return null;
  }
}

// Returns whether a run that cannot supply a list is allowed to skip. Anything this
// cannot prove is a fork is treated as a run of this repository, because the proof has
// to come from the payload: treating unreadable input as a fork would let a caller
// delete GITHUB_EVENT_PATH to buy a clean skip. GitHub always writes the payload on a
// pull_request event, so the unprovable case is the abnormal one, and the abnormal case
// is the one that must not skip. Returns the reason either way, so a skip can explain
// itself.
export function skipDecision(env = process.env) {
  if (env.GITHUB_ACTIONS !== "true") {
    return { skip: true, reason: "not a GitHub Actions run" };
  }
  const event = readEventPullRequest(env);
  if (event === null) {
    return {
      skip: false,
      reason: "the pull-request event payload is unreadable, so a fork cannot be ruled out",
    };
  }
  const head = event.pull_request.head?.repo?.full_name;
  const base = event.repository?.full_name ?? env.GITHUB_REPOSITORY;
  if (!head || !base) {
    return { skip: false, reason: "the event payload does not name both repositories" };
  }
  if (head !== base) {
    return { skip: true, reason: `fork pull request from ${head}` };
  }
  return { skip: false, reason: `pull request from ${head}` };
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
    const { skip, reason } = skipDecision();
    if (skip) {
      console.log(`private-name check skipped: no list configured (${reason})`);
      return;
    }
    // A missing list is not a clean result, and reporting it as one is what let this
    // guard pass while scanning for nothing. The message names the two ways to supply
    // the list and nothing else: there is no term to print, because the list is the
    // thing that is missing.
    console.error(
      "private-name check failed: no list configured, so nothing was scanned. " +
      `This is a run of this repository (${reason}), which is required to supply one: ` +
      "set the CONTROL_ROOM_PRIVATE_NAMES repository secret, or the " +
      "CONTROL_ROOM_PRIVATE_NAMES_FILE variable.",
    );
    process.exitCode = 1;
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