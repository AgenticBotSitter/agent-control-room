#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";

const MANIFEST_DIRECTORY = "mutation-checks";
const FIELDS = ["file", "find", "replace", "test", "why"];
const GUARD_PATTERN = /authorize|refuse|forbid|throw new .*Refus|REVOKE|GRANT|CHECK \(|SECURITY DEFINER/iu;

function git(root, args, options = {}) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", ...options });
}

function repositoryRoot() {
  const result = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (result.status !== 0) throw new Error("not inside a Git checkout");
  return realpathSync(result.stdout.trim());
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function branchManifest(root) {
  const branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME ||
    git(root, ["branch", "--show-current"]).stdout.trim();
  return resolve(root, MANIFEST_DIRECTORY, `${branch.replaceAll("/", "-")}.json`);
}

function selectedManifest(root, argument) {
  const manifestRoot = resolve(root, MANIFEST_DIRECTORY);
  const unresolved = argument ? resolve(root, argument) : branchManifest(root);
  const candidate = existsSync(unresolved) ? realpathSync(unresolved) : unresolved;
  if (!isInside(manifestRoot, candidate) || dirname(candidate) !== manifestRoot || basename(candidate).startsWith(".")) {
    console.log(`Ignoring manifest outside ${MANIFEST_DIRECTORY}/: ${argument ?? candidate}`);
    return null;
  }
  return candidate;
}

function requireCleanCheckout(root) {
  const result = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (result.status !== 0) throw new Error("could not inspect the Git checkout");
  if (result.stdout !== "") throw new Error("refusing to run on a dirty Git checkout");
}

function parseManifest(root, manifestPath) {
  let value;
  try {
    value = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`malformed manifest ${relative(root, manifestPath)}: ${error.message}`);
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("malformed manifest: expected a non-empty JSON array");
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`malformed manifest entry ${index + 1}: expected an object`);
    }
    const keys = Object.keys(entry).sort();
    if (keys.join("\0") !== [...FIELDS].sort().join("\0")) {
      throw new Error(`malformed manifest entry ${index + 1}: expected only ${FIELDS.join(", ")}`);
    }
    for (const field of FIELDS) {
      if (typeof entry[field] !== "string" || entry[field].length === 0) {
        throw new Error(`malformed manifest entry ${index + 1}: ${field} must be a non-empty string`);
      }
    }
    if (entry.find === entry.replace) {
      throw new Error(`malformed manifest entry ${index + 1}: find and replace must differ`);
    }
    const filePath = resolve(root, entry.file);
    if (!isInside(root, filePath) || !existsSync(filePath) || lstatSync(filePath).isSymbolicLink() ||
        !lstatSync(filePath).isFile() || !isInside(root, realpathSync(filePath))) {
      throw new Error(`malformed manifest entry ${index + 1}: file must be a regular file inside the checkout`);
    }
    if (git(root, ["ls-files", "--error-unmatch", "--", entry.file]).status !== 0) {
      throw new Error(`malformed manifest entry ${index + 1}: file must be tracked by Git`);
    }
    return { ...entry, filePath, label: `${entry.file} — ${entry.why}` };
  });
}

function restoreFile(root, entry, original, mode) {
  writeFileSync(entry.filePath, original);
  chmodSync(entry.filePath, mode);
  git(root, ["restore", "--staged", "--", entry.file], { stdio: "ignore" });
  const restored = readFileSync(entry.filePath);
  if (!restored.equals(original)) throw new Error(`could not restore ${entry.file}`);
}

function verifyEntry(root, entry, number) {
  const original = readFileSync(entry.filePath);
  const mode = lstatSync(entry.filePath).mode;
  const text = original.toString("utf8");
  const matches = text.split(entry.find).length - 1;
  if (matches !== 1) throw new Error(`${entry.label}: find matched ${matches} times; expected exactly once`);

  console.log(`\n[${number}] ${entry.label}`);
  let result;
  try {
    writeFileSync(entry.filePath, text.replace(entry.find, entry.replace));
    result = spawnSync(entry.test, {
      cwd: root,
      env: process.env,
      shell: true,
      stdio: "inherit",
    });
  } finally {
    restoreFile(root, entry, original, mode);
  }

  if (result.error) throw new Error(`${entry.label}: test command could not start: ${result.error.message}`);
  const shellSignal = result.status >= 128
    ? Object.entries(osConstants.signals).find(([, number]) => number === result.status - 128)?.[0]
    : undefined;
  const crashSignal = result.signal ?? shellSignal;
  if (crashSignal) {
    console.log(`PASS: test command crashed with signal ${crashSignal}; the mutation was caught.`);
    return;
  }
  if (result.status !== 0) {
    console.log(`PASS: test failed with exit ${result.status}; the mutation was caught.`);
    return;
  }
  throw new Error(`${entry.label}: mutation survived because the test command still passed`);
}

function warnAboutMissingManifest(root) {
  const base = process.env.BASE_REF;
  if (!base) return;
  const baseRevision = base.includes("/") ? base : `origin/${base}`;
  const result = git(root, ["diff", "--unified=0", `${baseRevision}...HEAD`, "--", "src"]);
  if (result.status !== 0) {
    console.log("::warning::Could not inspect src/** changes for guard-like code.");
    return;
  }
  const guardLine = result.stdout.split(/\r?\n/u).find((line) =>
    /^[+-](?![+-])/u.test(line) && GUARD_PATTERN.test(line.slice(1)));
  if (guardLine) {
    console.log("::warning::This PR changes guard-like code under src/** but has no branch mutation manifest. " +
      "The heuristic checks changed lines for authorize, refuse, forbid, refusal throws, REVOKE, GRANT, " +
      "CHECK (, or SECURITY DEFINER.");
  }
}

function main() {
  const root = repositoryRoot();
  if (process.argv[2] === "--warn-only") {
    warnAboutMissingManifest(root);
    return;
  }
  const manifestPath = selectedManifest(root, process.argv[2]);
  if (!manifestPath) return;
  if (!existsSync(manifestPath)) {
    console.log(`No mutation manifest for this branch (${relative(root, manifestPath)}); skipping mutations.`);
    warnAboutMissingManifest(root);
    return;
  }
  requireCleanCheckout(root);
  const entries = parseManifest(root, manifestPath);
  const failures = [];
  for (const [index, entry] of entries.entries()) {
    try {
      requireCleanCheckout(root);
      verifyEntry(root, entry, index + 1);
    } catch (error) {
      failures.push(error.message);
      console.error(`FAIL: ${error.message}`);
    }
  }
  requireCleanCheckout(root);
  if (failures.length > 0) throw new Error(`${failures.length} mutation check(s) failed`);
  console.log(`\nAll ${entries.length} mutation check(s) were caught and every file was restored.`);
}

try {
  main();
} catch (error) {
  console.error(`Mutation checks failed: ${error.message}`);
  process.exitCode = 1;
}
