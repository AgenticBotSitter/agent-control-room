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
import { spawn, spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";

const MANIFEST_DIRECTORY = "mutation-checks";
const FIELDS = ["file", "find", "replace", "test", "why"];
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const SOURCE_GUARD_PATTERN = /\b(?:authorize|refuse|forbid)\b|throw new \w*Refus/iu;
const SQL_GUARD_PATTERN = /\b(?:GRANT|REVOKE|SECURITY\s+DEFINER|POLICY|TRIGGER)\b/u;
let activeRestore;
let activeChild;
let interrupted = false;

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
  let manifestStat;
  try { manifestStat = lstatSync(unresolved); } catch { manifestStat = undefined; }
  if (manifestStat?.isSymbolicLink()) {
    throw new Error(`refusing symbolic-link manifest ${relative(root, unresolved)}`);
  }
  const candidate = manifestStat ? realpathSync(unresolved) : unresolved;
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

function requireCleanAfterTest(root) {
  const result = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (result.status !== 0) throw new Error("could not inspect the Git checkout after the test command");
  if (result.stdout !== "") {
    const paths = result.stdout.trim().split(/\r?\n/u).map(line => line.slice(3)).join(", ");
    throw new Error(`test command left the checkout dirty (stray files or edits): ${paths}`);
  }
}

function mutationTimeoutMs() {
  const configured = process.env.MUTATION_CHECK_TIMEOUT_MS;
  if (configured === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^\d+$/u.test(configured) || Number(configured) < 1) {
    throw new Error("MUTATION_CHECK_TIMEOUT_MS must be a positive integer number of milliseconds");
  }
  return Number(configured);
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
      if (typeof entry[field] !== "string" || (field !== "replace" && entry[field].length === 0)) {
        throw new Error(`malformed manifest entry ${index + 1}: ${field} must be a non-empty string`);
      }
    }
    if (entry.find === entry.replace) {
      throw new Error(`malformed manifest entry ${index + 1}: find and replace must differ`);
    }
    const filePath = resolve(root, entry.file);
    if (!isInside(root, filePath)) throw new Error(`malformed manifest entry ${index + 1}: file must stay inside the checkout`);
    if (!existsSync(filePath)) throw new Error(`malformed manifest entry ${index + 1}: file must exist`);
    if (lstatSync(filePath).isSymbolicLink()) throw new Error(`malformed manifest entry ${index + 1}: file must not be a symbolic link`);
    if (!lstatSync(filePath).isFile()) throw new Error(`malformed manifest entry ${index + 1}: file must be a regular file`);
    if (!isInside(root, realpathSync(filePath))) throw new Error(`malformed manifest entry ${index + 1}: file must not resolve outside the checkout`);
    if (git(root, ["ls-files", "--error-unmatch", "--", entry.file]).status !== 0) {
      throw new Error(`malformed manifest entry ${index + 1}: file must be tracked by Git`);
    }
    return { ...entry, filePath, label: `${entry.file} — ${entry.why}` };
  });
}

function restoreFile(root, entry, original, mode) {
  if (lstatSync(entry.filePath).isSymbolicLink()) throw new Error(`could not restore ${entry.file}: target became a symbolic link`);
  writeFileSync(entry.filePath, original);
  chmodSync(entry.filePath, mode);
  git(root, ["restore", "--staged", "--", entry.file], { stdio: "ignore" });
  const restored = readFileSync(entry.filePath);
  if (!restored.equals(original)) throw new Error(`could not restore ${entry.file}`);
}

function runTest(command, root, timeoutMs) {
  return new Promise(resolveResult => {
    let timedOut = false;
    const child = spawn(command, { cwd: root, env: process.env, shell: true, stdio: "inherit" });
    activeChild = child;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", error => {
      clearTimeout(timer);
      resolveResult({ error, timedOut });
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolveResult({ status, signal, timedOut });
    });
  });
}

function describeConfigurationError(entry, result) {
  if (result.error) return `${entry.label}: test command could not start: ${result.error.message}`;
  if (result.status === 126 || result.status === 127) {
    return `${entry.label}: test command configuration error (exit ${result.status})`;
  }
  return null;
}

async function verifyBaseline(root, entry, number, timeoutMs) {
  console.log(`\nBaseline [${number}] ${entry.label}`);
  const result = await runTest(entry.test, root, timeoutMs);
  const configurationError = describeConfigurationError(entry, result);
  if (configurationError) throw new Error(configurationError);
  if (result.timedOut) throw new Error(`${entry.label}: baseline failing because the test command timed out`);
  if (result.signal) throw new Error(`${entry.label}: baseline failing because the test command crashed with signal ${result.signal}`);
  if (result.status !== 0) throw new Error(`${entry.label}: baseline failing with exit ${result.status}`);
  console.log("PASS: baseline passed.");
}

async function verifyEntry(root, entry, number, timeoutMs) {
  const original = readFileSync(entry.filePath);
  const mode = lstatSync(entry.filePath).mode;
  const text = original.toString("utf8");
  const matches = text.split(entry.find).length - 1;
  if (matches !== 1) throw new Error(`${entry.label}: find matched ${matches} times; expected exactly once`);

  console.log(`\n[${number}] ${entry.label}`);
  let result;
  try {
    activeRestore = () => restoreFile(root, entry, original, mode);
    writeFileSync(entry.filePath, text.replace(entry.find, () => entry.replace));
    result = await runTest(entry.test, root, timeoutMs);
  } finally {
    activeChild = undefined;
    activeRestore = undefined;
    restoreFile(root, entry, original, mode);
  }

  const configurationError = describeConfigurationError(entry, result);
  if (configurationError) throw new Error(configurationError);
  if (result.timedOut) throw new Error(`${entry.label}: test command timed out after ${timeoutMs}ms`);
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
  const result = git(root, ["diff", "--unified=0", `${baseRevision}...HEAD`, "--", "src", "db/migrations", "db/roles"]);
  if (result.status !== 0) {
    console.log("::warning::Could not inspect src/** or db/** changes for guard-like code.");
    return;
  }
  const guardLine = result.stdout.split(/\r?\n/u).find((line) => {
    if (!/^[+-](?![+-])/u.test(line)) return false;
    const changed = line.slice(1);
    return SOURCE_GUARD_PATTERN.test(changed) || SQL_GUARD_PATTERN.test(changed);
  });
  if (guardLine) {
    console.log("::warning::This PR changes guard-like code under src/**, db/migrations/**, or db/roles/** but has no branch mutation manifest. " +
      "The heuristic checks source refusal words and uppercase SQL GRANT, REVOKE, SECURITY DEFINER, POLICY, or TRIGGER markers.");
  }
}

function restoreOnSignal(signal) {
  if (interrupted) return;
  interrupted = true;
  try {
    if (activeChild && !activeChild.killed) activeChild.kill(signal);
    if (activeRestore) activeRestore();
  } catch (error) {
    console.error(`Mutation checks failed while restoring after ${signal}: ${error.message}`);
  }
  process.exit(1);
}

process.on("SIGINT", () => restoreOnSignal("SIGINT"));
process.on("SIGTERM", () => restoreOnSignal("SIGTERM"));

async function main() {
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
  const timeoutMs = mutationTimeoutMs();
  for (const [index, entry] of entries.entries()) {
    try {
      requireCleanCheckout(root);
      await verifyBaseline(root, entry, index + 1, timeoutMs);
    } catch (error) {
      failures.push(error.message);
      console.error(`FAIL: ${error.message}`);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} mutation check(s) failed`);
  for (const [index, entry] of entries.entries()) {
    try {
      requireCleanCheckout(root);
      await verifyEntry(root, entry, index + 1, timeoutMs);
      requireCleanAfterTest(root);
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
  await main();
} catch (error) {
  console.error(`Mutation checks failed: ${error.message}`);
  process.exitCode = 1;
}
