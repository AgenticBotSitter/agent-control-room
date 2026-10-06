#!/usr/bin/env node

import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";

const MANIFEST_DIRECTORY = "mutation-checks";
const FIELDS = ["file", "find", "replace", "test", "why"];
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const SOURCE_GUARD_PATTERN = /\b(?:authorize|refuse|forbid)\b|throw new \w*Refus/iu;
const SQL_GUARD_PATTERN = /\b(?:GRANT|REVOKE|SECURITY\s+DEFINER|POLICY|TRIGGER)\b/u;
let activeRestore;
let activeChild;
let activeAuditCleanup;
let interrupted = false;

class MutationProcessCleanupRefusal extends Error {
  constructor(child, error) {
    super(`could not retire test process group ${child.pid}: ${error.message}`);
  }
}

function rethrowCleanupRefusal(error) {
  if (error instanceof MutationProcessCleanupRefusal) throw error;
}

function git(root, args, options = {}) {
  // spawnSync's 1 MiB default maxBuffer truncates `git diff` on a branch with a
  // large changeset, which silently downgrades warnAboutMissingManifest() to
  // its "could not inspect" fallback instead of scanning the real diff.
  return spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
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
  if (result.stdout !== "") {
    throw new Error("refusing to run on a dirty Git checkout; restore the changed files before retrying");
  }
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
    if (isAbsolute(entry.file) || !isInside(root, filePath)) throw new Error(`malformed manifest entry ${index + 1}: file must stay inside the checkout`);
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

function validateAllManifestAnchors(root) {
  const manifestRoot = resolve(root, MANIFEST_DIRECTORY);
  const manifests = readdirSync(manifestRoot).filter(name => name.endsWith(".json")).sort();
  for (const name of manifests) {
    const manifestPath = resolve(manifestRoot, name);
    for (const entry of parseManifest(root, manifestPath)) {
      const source = readFileSync(entry.filePath, "utf8");
      const matches = source.split(entry.find).length - 1;
      if (matches !== 1) {
        throw new Error(`${relative(root, manifestPath)}: ${entry.label}: find matched ${matches} times; expected exactly once`);
      }
    }
  }
}

function restoreFile(root, entry, original, mode) {
  if (lstatSync(entry.filePath).isSymbolicLink()) throw new Error(`could not restore ${entry.file}: target became a symbolic link`);
  writeFileSync(entry.filePath, original);
  chmodSync(entry.filePath, mode);
  git(root, ["restore", "--staged", "--", entry.file], { stdio: "ignore" });
  const restored = readFileSync(entry.filePath);
  if (!restored.equals(original)) throw new Error(`could not restore ${entry.file}`);
}

function stopTestProcess(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function runTest(command, root, timeoutMs, onSpawn) {
  return new Promise(resolveResult => {
    let timedOut = false;
    let settled = false;
    const child = spawn(command, { cwd: root, detached: true, env: process.env, shell: true, stdio: "inherit" });
    activeChild = child;
    console.log(`TEST PROCESS GROUP: ${child.pid}`);
    onSpawn?.();
    const finish = (result, killGroup) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let cleanupError = result.cleanupError;
      if (killGroup) {
        try { stopTestProcess(child, "SIGKILL"); }
        catch (error) { cleanupError = new MutationProcessCleanupRefusal(child, error); }
      }
      if (!cleanupError && activeChild === child) activeChild = undefined;
      resolveResult({ ...result, cleanupError });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { stopTestProcess(child, "SIGKILL"); }
      catch (error) { finish({ timedOut, cleanupError: new MutationProcessCleanupRefusal(child, error) }, false); }
    }, timeoutMs);
    child.once("error", error => {
      finish({ error, timedOut }, false);
    });
    child.once("close", (status, signal) => {
      finish({ status, signal, timedOut }, true);
    });
  });
}

function describeConfigurationError(entry, result) {
  if (result.cleanupError) throw result.cleanupError;
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

async function verifyWhitespaceInsensitive(root, entry, number, timeoutMs) {
  const original = readFileSync(entry.filePath);
  const mode = lstatSync(entry.filePath).mode;
  console.log(`Whitespace check [${number}] ${entry.label}`);
  try {
    activeRestore = () => restoreFile(root, entry, original, mode);
    writeFileSync(entry.filePath, Buffer.concat([original, Buffer.from("\n")]));
    const result = await runTest(entry.test, root, timeoutMs);
    const configurationError = describeConfigurationError(entry, result);
    if (configurationError) throw new Error(configurationError);
    if (result.timedOut || result.signal || result.status !== 0) {
      throw new Error(`${entry.label}: test command fails on a whitespace-only edit; it must exercise guard behavior`);
    }
  } finally {
    activeRestore = undefined;
    restoreFile(root, entry, original, mode);
  }
  console.log("PASS: whitespace-only edit passed.");
}

function codeWhitespaceOffset(text) {
  let quote;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      index = text.indexOf("\n", index + 2);
      if (index < 0) return null;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      index = text.indexOf("*/", index + 2);
      if (index < 0) return null;
      index += 1;
      continue;
    }
    if (/\s/u.test(character)) return index;
  }
  return null;
}

function commentProbe(original, entry) {
  if (!/\.(?:[cm]?jsx?|[cm]?tsx?)$/u.test(entry.file)) return null;
  const targetOffset = original.indexOf(entry.find);
  const whitespaceOffset = codeWhitespaceOffset(entry.find);
  if (targetOffset < 0 || whitespaceOffset === null) return null;
  const offset = targetOffset + whitespaceOffset;
  return Buffer.concat([
    original.subarray(0, offset),
    Buffer.from(" /* mutation-check text probe */ "),
    original.subarray(offset + 1),
  ]);
}

async function verifyTextuallyDifferent(root, entry, number, timeoutMs) {
  const original = readFileSync(entry.filePath);
  const mode = lstatSync(entry.filePath).mode;
  const probe = commentProbe(original, entry);
  if (!probe) return;
  console.log(`Text probe [${number}] ${entry.label}`);
  try {
    activeRestore = () => restoreFile(root, entry, original, mode);
    writeFileSync(entry.filePath, probe);
    const result = await runTest(entry.test, root, timeoutMs);
    const configurationError = describeConfigurationError(entry, result);
    if (configurationError) throw new Error(configurationError);
    if (result.timedOut || result.signal || result.status !== 0) {
      throw new Error(`${entry.label}: test command fails on a semantically neutral text-only edit; it must exercise guard behavior`);
    }
  } finally {
    activeRestore = undefined;
    restoreFile(root, entry, original, mode);
  }
  console.log("PASS: semantically neutral text-only edit passed.");
}

async function requireParsableMutation(entry) {
  if (/\.json$/u.test(entry.file)) {
    try {
      JSON.parse(readFileSync(entry.filePath, "utf8"));
    } catch (error) {
      throw new Error(`${entry.label}: mutation does not parse: ${error.message}`);
    }
    return;
  }
  if (/\.(?:jsx|[cm]?js)$/u.test(entry.file)) {
    const result = spawnSync(process.execPath, ["--check", entry.filePath], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${entry.label}: mutation does not parse: ${result.stderr.trim()}`);
    return;
  }
  if (/\.[cm]?tsx?$/u.test(entry.file)) {
    let typescript;
    try {
      ({ default: typescript } = await import("typescript"));
    } catch (error) {
      throw new Error(`${entry.label}: TypeScript parser is unavailable: ${error.message}`);
    }
    const compilerOptions = {
      module: typescript.ModuleKind.ESNext,
      target: typescript.ScriptTarget.ESNext,
      ...(entry.file.endsWith(".tsx") ? { jsx: typescript.JsxEmit.Preserve } : {}),
    };
    const result = typescript.transpileModule(readFileSync(entry.filePath, "utf8"), {
      compilerOptions,
      fileName: entry.filePath,
      reportDiagnostics: true,
    });
    const diagnostics = result.diagnostics?.filter(diagnostic => diagnostic.category === typescript.DiagnosticCategory.Error) ?? [];
    if (diagnostics.length > 0) {
      throw new Error(`${entry.label}: mutation does not parse: ${typescript.flattenDiagnosticMessageText(diagnostics[0].messageText, " ")}`);
    }
  }
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
    console.log(`APPLIED MUTATION [${number}] ${entry.file}`);
    await requireParsableMutation(entry);
    result = await runTest(entry.test, root, timeoutMs, () => {
      console.log(`RUNNING MUTATED TEST [${number}] ${entry.file}`);
    });
  } finally {
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
    if (activeChild && !activeChild.killed) stopTestProcess(activeChild, signal);
  } catch (error) {
    console.error(`Mutation checks could not stop the test group after ${signal}: ${error.message}`);
  }
  try {
    if (activeRestore) activeRestore();
  } catch (error) {
    console.error(`Mutation checks failed while restoring after ${signal}: ${error.message}`);
  }
  try {
    activeAuditCleanup?.();
  } catch (error) {
    console.error(`Mutation checks failed while releasing the audit lock after ${signal}: ${error.message}`);
  }
  process.exit(1);
}

process.on("SIGINT", () => restoreOnSignal("SIGINT"));
process.on("SIGTERM", () => restoreOnSignal("SIGTERM"));

// A maintenance audit preserves the caller's existing edits. The normal CI
// path below still requires a clean checkout and refuses the whole manifest
// when any baseline fails. Audit results distinguish that failure from a kill.
async function auditAll(root) {
  const timeout = mutationTimeoutMs();
  const before = () => {
    const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const diff = git(root, ["diff", "HEAD", "--binary"]);
    if (status.status !== 0 || diff.status !== 0) throw new Error("could not snapshot the checkout");
    return status.stdout + diff.stdout;
  };
  const snapshot = before();
  const baselines = new Map();
  let failures = 0;
  for (const name of readdirSync(resolve(root, MANIFEST_DIRECTORY)).filter(name => name.endsWith(".json")).sort()) {
    const manifestPath = selectedManifest(root, join(MANIFEST_DIRECTORY, name));
    const entries = parseManifest(root, manifestPath);
    for (const [index, entry] of entries.entries()) {
      const record = { manifest: name, entry: index + 1, file: entry.file, why: entry.why };
      try {
        const matches = readFileSync(entry.filePath, "utf8").split(entry.find).length - 1;
        if (matches !== 1) throw new Error(`find matched ${matches} times; expected exactly once`);
        let baseline = baselines.get(entry.test);
        if (baseline === undefined) {
          try {
            await verifyBaseline(root, entry, index + 1, timeout);
            baseline = null;
          } catch (error) { rethrowCleanupRefusal(error); baseline = error.message; }
          baselines.set(entry.test, baseline);
        }
        if (baseline) {
          record.status = "baseline-failed";
          record.error = baseline;
        } else {
          await verifyWhitespaceInsensitive(root, entry, index + 1, timeout);
          await verifyTextuallyDifferent(root, entry, index + 1, timeout);
          await verifyEntry(root, entry, index + 1, timeout);
          record.status = "caught";
        }
      } catch (error) {
        rethrowCleanupRefusal(error);
        record.status = "failed";
        record.error = error.message;
      }
      // A reused baseline is valid only while every test restores the same tree.
      // Stop on contamination instead of attributing later failures to guards.
      if (before() !== snapshot) throw new Error(`audit test changed the checkout: ${name} entry ${index + 1}`);
      if (record.status !== "caught") failures += 1;
      console.log(`AUDIT: ${JSON.stringify(record)}`);
      if (process.env.MUTATION_CHECK_AUDIT_OUTPUT) appendFileSync(process.env.MUTATION_CHECK_AUDIT_OUTPUT, `${JSON.stringify(record)}\n`);
    }
  }
  if (failures) throw new Error(`${failures} audit entries were not proved caught`);
}

async function main() {
  const root = repositoryRoot();
  if (process.argv[2] === "--audit-all") {
    const lockRoot = join(root, ".test-tmp");
    mkdirSync(lockRoot, { recursive: true });
    const lock = join(lockRoot, "mutation-audit.lock");
    try { mkdirSync(lock); } catch (error) {
      if (error.code === "EEXIST") throw new Error("another maintenance audit owns this checkout (or left its lock after SIGKILL)");
      throw error;
    }
    activeAuditCleanup = () => rmSync(lock, { recursive: true, force: true });
    try { return await auditAll(root); }
    finally { activeAuditCleanup(); activeAuditCleanup = undefined; }
  }
  if (process.argv[2] === "--anchors-only") {
    validateAllManifestAnchors(repositoryRoot());
    console.log("All declared mutation anchors match exactly once.");
    return;
  }
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
  validateAllManifestAnchors(root);
  const entries = parseManifest(root, manifestPath);
  const failures = [];
  const timeoutMs = mutationTimeoutMs();
  for (const [index, entry] of entries.entries()) {
    try {
      requireCleanCheckout(root);
      await verifyBaseline(root, entry, index + 1, timeoutMs);
      await verifyWhitespaceInsensitive(root, entry, index + 1, timeoutMs);
      await verifyTextuallyDifferent(root, entry, index + 1, timeoutMs);
    } catch (error) {
      rethrowCleanupRefusal(error);
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
      rethrowCleanupRefusal(error);
      failures.push(error.message);
      console.error(`FAIL: ${error.message}`);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} mutation check(s) failed`);
  console.log(`\nAll ${entries.length} mutation check(s) were caught and every file was restored.`);
}

try {
  await main();
} catch (error) {
  console.error(`Mutation checks failed: ${error.message}`);
  process.exitCode = 1;
}
