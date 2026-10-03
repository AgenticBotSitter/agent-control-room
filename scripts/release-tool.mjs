#!/usr/bin/env node
import { isMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";
/**
 * Builds a public-release candidate from a private integration ref without
 * reading a remote.  The prepare result is intentionally an in-memory packet:
 * it leaves no candidate branch, tag, file, index, or Git object behind.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const SEMVER = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SAFE_REF = /^(?:HEAD|[A-Za-z0-9][A-Za-z0-9._\/-]*)$/u;
const SAFE_BRANCH = /^release\/v[0-9A-Za-z._-]+$/u;
const SAFE_TOKEN = /^[a-f0-9]{64}$/u;
const SECRET_PATTERNS = Object.freeze([
  // A header alone is an intentionally harmless parser-test fixture; a key needs body bytes too.
  ["private_key", /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{16,}/u],
  ["github_token", /gh[pousr]_(?![A-Za-z0-9]*?(?:Sentinel|PLACEHOLDER))[A-Za-z0-9]{20,}/u],
  ["aws_access_key", /AKIA(?!PLACEHOLDERACCESSKEY)[0-9A-Z]{16}/u],
  ["gitlab_token", /glpat-[A-Za-z0-9_-]{20,}/u],
]);

export class ReleaseRefusal extends Error {
  constructor(code) { super(code); this.code = code; }
}

const refuse = code => { throw new ReleaseRefusal(code); };
const digest = value => createHash("sha256").update(value).digest("hex");
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function command(executable, args, { cwd, env = process.env, input } = {}) {
  const result = spawnSync(executable, args, {
    cwd, env, input, encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed`);
  }
  return result.stdout;
}

function git(root, args, options) { return command("git", args, { cwd: root, ...options }); }

function assertSafeRef(value) {
  if (typeof value !== "string" || !SAFE_REF.test(value) || value.includes("..") || value.endsWith(".")) {
    refuse("release_source_ref_invalid");
  }
  return value;
}

function releaseDate(value = new Date().toISOString().slice(0, 10)) {
  if (!DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) refuse("release_date_invalid");
  return value;
}

function versionBase(value) {
  const match = SEMVER.exec(value);
  if (!match) refuse("release_version_invalid");
  return match.slice(1, 4).map(Number);
}

function bumpPatch(value) {
  const [major, minor, patch] = versionBase(value);
  return `${major}.${minor}.${patch + 1}`;
}

function compareVersions(left, right) {
  const leftParts = versionBase(left), rightParts = versionBase(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return rightParts[index] - leftParts[index];
  }
  return 0;
}

function areaForSubject(subject) {
  const lowered = subject.toLowerCase();
  if (/^(?:docs?|readme)(?:\([^)]*\))?!?:/u.test(lowered) || lowered.includes("documentation")) return "Documentation";
  if (/^(?:test|tests)(?:\([^)]*\))?!?:/u.test(lowered) || /\btest(?:s|ing)?\b/u.test(lowered)) return "Tests and verification";
  if (/^(?:db|database|migration)(?:\([^)]*\))?!?:/u.test(lowered) || /\b(?:postgres|migration|database)\b/u.test(lowered)) return "Database and data safety";
  if (/^(?:ui|web|product)(?:\([^)]*\))?!?:/u.test(lowered) || /\b(?:screen|browser|page|view)\b/u.test(lowered)) return "Product experience";
  if (/^(?:build|ci|script|deploy|release)(?:\([^)]*\))?!?:/u.test(lowered) || /\b(?:build|check|release|workflow|tool)\b/u.test(lowered)) return "Tooling and operations";
  return "Other improvements";
}

export function groupCommitSubjects(subjects) {
  const groups = new Map();
  for (const raw of subjects) {
    const subject = String(raw).replace(/[\r\n\0]/gu, " ").trim();
    if (!subject) continue;
    const area = areaForSubject(subject);
    groups.set(area, [...(groups.get(area) ?? []), subject]);
  }
  return [...groups.entries()].map(([area, entries]) => ({ area, entries }));
}

export function renderChangelog({ version, date, subjects }) {
  const groups = groupCommitSubjects(subjects);
  const lines = [`## v${version} — ${date}`, "", "This public release combines the selected private integration work into one clean commit."];
  if (groups.length === 0) lines.push("", "- No new commit subjects were selected.");
  for (const group of groups) {
    lines.push("", `### ${group.area}`, "", ...group.entries.map(entry => `- ${entry}`));
  }
  return `${lines.join("\n")}\n`;
}

export function scanTrackedSecrets(root, runGit = git) {
  const files = runGit(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  const findings = [];
  for (const file of files) {
    const path = resolve(root, file);
    let text;
    try { text = readFileSync(path, "utf8"); } catch { continue; }
    for (const [kind, pattern] of SECRET_PATTERNS) {
      const match = pattern.exec(text);
      if (!match) continue;
      const before = text.slice(0, match.index);
      findings.push({ file: relative(root, path), line: before.split(/\r?\n/u).length, kind });
    }
  }
  return findings;
}

function gateCommands() {
  return [
    { name: "private-name guard", executable: process.execPath, args: ["scripts/check-private-names.mjs"] },
    { name: "type check", executable: "pnpm", args: ["check"] },
    { name: "demo type check", executable: "pnpm", args: ["run", "check:demo"] },
    { name: "migration ledger", executable: "pnpm", args: ["db:verify"] },
    { name: "lane coverage", executable: process.execPath, args: ["scripts/check-test-lane-coverage.mjs"] },
  ];
}

export function runReleaseGates({ root, privateNamesFile, runCommand = command, env = process.env }) {
  if (typeof privateNamesFile !== "string" || !existsSync(privateNamesFile)) refuse("private_names_file_required");
  const secretFindings = scanTrackedSecrets(root);
  if (secretFindings.length > 0) refuse("secret_scan_refused");
  const gateEnv = { ...env, CONTROL_ROOM_PRIVATE_NAMES_FILE: privateNamesFile };
  for (const gate of gateCommands()) {
    try { runCommand(gate.executable, gate.args, { cwd: root, env: gateEnv }); }
    catch { refuse(`gate_failed:${gate.name}`); }
  }
  return gateCommands().map(gate => gate.name);
}

function sourceDetails({ root, sourceRef, runGit = git }) {
  const ref = assertSafeRef(sourceRef);
  let source;
  try { source = runGit(root, ["rev-parse", "--verify", `${ref}^{commit}`]).trim(); }
  catch { refuse("release_source_ref_missing"); }
  let packageJson;
  try { packageJson = JSON.parse(runGit(root, ["show", `${source}:package.json`])); }
  catch { refuse("release_package_missing"); }
  const tags = runGit(root, ["tag", "--list"]).split(/\r?\n/u).filter(Boolean);
  const versions = tags.filter(tag => SEMVER.test(tag)).map(tag => ({ tag, version: tag.replace(/^v/u, "") }));
  const latest = versions.sort((left, right) => compareVersions(left.version, right.version))[0];
  let previousSource;
  if (latest) {
    try {
      const metadata = JSON.parse(runGit(root, ["show", `${latest.tag}:RELEASE_INFO.json`]));
      if (metadata.source !== source && /^[a-f0-9]{40}$/u.test(metadata.source)
        && runGit(root, ["merge-base", "--is-ancestor", metadata.source, source]) === "") previousSource = metadata.source;
    } catch { /* A pre-tool tag has no release metadata and cannot define a commit range. */ }
  }
  const range = previousSource ? `${previousSource}..${source}` : source;
  const subjects = runGit(root, ["log", "--format=%s", range]).split(/\r?\n/u).filter(Boolean);
  // The private package version is the release train. The date suffix makes a
  // candidate unique without allowing an unrelated local tag to change an
  // already-reviewed approval token between prepare and publish.
  return { source, packageVersion: packageJson.version, basis: packageJson.version, subjects, previousSource };
}

export function approvalFor(candidate) {
  return digest(JSON.stringify({ schema: 1, source: candidate.source, version: candidate.version, date: candidate.date, changelog: candidate.changelog }));
}

export function buildReleaseCandidate({ root = process.cwd(), sourceRef = "HEAD", date, runGit = git }) {
  const selectedDate = releaseDate(date);
  const details = sourceDetails({ root, sourceRef, runGit });
  const version = `${bumpPatch(details.basis)}-${selectedDate.replaceAll("-", "")}`;
  const changelog = renderChangelog({ version, date: selectedDate, subjects: details.subjects });
  const candidate = { sourceRef, source: details.source, previousSource: details.previousSource, date: selectedDate, version, branch: `release/v${version}`, tag: `v${version}`, changelog };
  return { ...candidate, approval: approvalFor(candidate) };
}

export function prepareReleaseCandidate(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const privateNamesFile = options.privateNamesFile ?? options.env?.CONTROL_ROOM_PRIVATE_NAMES_FILE ?? process.env.CONTROL_ROOM_PRIVATE_NAMES_FILE;
  const candidate = buildReleaseCandidate({ root, sourceRef: options.sourceRef ?? "HEAD", date: options.date, runGit: options.runGit });
  const gates = runReleaseGates({ root, privateNamesFile, runCommand: options.runCommand, env: options.env });
  return Object.freeze({ ...candidate, gates: Object.freeze(gates), tree: `${candidate.source}^{tree}` });
}

function noExistingRef(root, ref, runGit = git) {
  try { runGit(root, ["show-ref", "--verify", "--quiet", ref]); refuse("release_ref_already_exists"); }
  catch (error) { if (error instanceof ReleaseRefusal) throw error; }
}

function makeReleaseTree(root, candidate) {
  const index = command("git", ["rev-parse", "--git-path", `release-index-${process.pid}-${Date.now()}`], { cwd: root }).trim();
  const indexPath = isAbsolute(index) ? index : resolve(root, index);
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    command("git", ["read-tree", candidate.source], { cwd: root, env });
    const blob = command("git", ["hash-object", "-w", "--stdin"], { cwd: root, env, input: candidate.changelog }).trim();
    command("git", ["update-index", "--add", "--cacheinfo", `100644,${blob},CHANGELOG.md`], { cwd: root, env });
    const metadata = `${JSON.stringify({ schema: 1, source: candidate.source, version: candidate.version, date: candidate.date }, null, 2)}\n`;
    const metadataBlob = command("git", ["hash-object", "-w", "--stdin"], { cwd: root, env, input: metadata }).trim();
    command("git", ["update-index", "--add", "--cacheinfo", `100644,${metadataBlob},RELEASE_INFO.json`], { cwd: root, env });
    return command("git", ["write-tree"], { cwd: root, env }).trim();
  } finally {
    try { unlinkSync(indexPath); } catch { /* index is only a disposable local helper */ }
  }
}

function createAnnotatedTag(root, candidate, commit) {
  const tagger = command("git", ["var", "GIT_COMMITTER_IDENT"], { cwd: root }).trim();
  const body = `object ${commit}\ntype commit\ntag ${candidate.tag}\ntagger ${tagger}\n\nRelease ${candidate.tag}\n`;
  return command("git", ["mktag"], { cwd: root, input: body }).trim();
}

function createReleaseRefs(root, candidate, commit, tagObject) {
  const transaction = [
    "start",
    `create refs/heads/${candidate.branch} ${commit}`,
    `create refs/tags/${candidate.tag} ${tagObject}`,
    "prepare",
    "commit",
    "",
  ].join("\n");
  command("git", ["update-ref", "--stdin"], { cwd: root, input: transaction });
}

export function publishRelease({ root = process.cwd(), sourceRef, date, approval, push = false, runGit = git }) {
  if (push !== true && push !== false) refuse("release_push_option_invalid");
  if (typeof approval !== "string" || !SAFE_TOKEN.test(approval)) refuse("release_approval_required");
  const candidate = buildReleaseCandidate({ root, sourceRef, date, runGit });
  if (approval !== candidate.approval) refuse("release_approval_invalid");
  if (!SAFE_BRANCH.test(candidate.branch)) refuse("release_branch_invalid");
  noExistingRef(root, `refs/heads/${candidate.branch}`, runGit);
  noExistingRef(root, `refs/tags/${candidate.tag}`, runGit);
  const tree = makeReleaseTree(root, candidate);
  const commit = command("git", ["commit-tree", tree, "-m", `Release ${candidate.tag}`], { cwd: root }).trim();
  const tagObject = createAnnotatedTag(root, candidate, commit);
  createReleaseRefs(root, candidate, commit, tagObject);
  const pushCommand = `git push origin ${quote(`refs/heads/${candidate.branch}`)} ${quote(`refs/tags/${candidate.tag}`)}`;
  const ghCommand = `gh release create ${quote(candidate.tag)} --target ${quote(candidate.branch)} --title ${quote(candidate.tag)} --notes-file CHANGELOG.md`;
  if (push) {
    command("git", ["push", "origin", `refs/heads/${candidate.branch}`, `refs/tags/${candidate.tag}`], { cwd: root });
    command("gh", ["release", "create", candidate.tag, "--target", candidate.branch, "--title", candidate.tag, "--notes-file", "CHANGELOG.md"], { cwd: root });
  }
  return Object.freeze({ ...candidate, commit, tree, pushCommand, ghCommand, pushed: push });
}

function oneValue(args, flag, required = false) {
  const positions = args.map((item, index) => item === flag ? index : -1).filter(index => index >= 0);
  if (positions.length > 1 || positions.length === 1 && positions[0] === args.length - 1) refuse("release_arguments_invalid");
  const value = positions.length === 1 ? args[positions[0] + 1] : undefined;
  if (required && !value) refuse("release_arguments_invalid");
  return value;
}

function parseCli(args) {
  const [action, ...rest] = args;
  const allowed = action === "prepare"
    ? new Set(["--source-ref", "--date", "--private-names-file"])
    : action === "publish" ? new Set(["--source-ref", "--date", "--approval", "--push"]) : undefined;
  if (!allowed || rest.some((item, index) => item.startsWith("--") && !allowed.has(item)
    || !item.startsWith("--") && (index === 0 || !rest[index - 1].startsWith("--")))) refuse("release_arguments_invalid");
  return { action, sourceRef: oneValue(rest, "--source-ref", action === "publish") ?? "HEAD", date: oneValue(rest, "--date"),
    privateNamesFile: oneValue(rest, "--private-names-file"), approval: oneValue(rest, "--approval", action === "publish"),
    push: rest.filter(item => item === "--push").length === 1 };
}

function summary(candidate) {
  console.log(`Release candidate v${candidate.version} from ${candidate.sourceRef} (${candidate.source})`);
  console.log(`Branch: ${candidate.branch}`);
  console.log(`Tag: ${candidate.tag}`);
  console.log("Gates passed:");
  for (const gate of candidate.gates) console.log(`- ${gate}`);
  console.log("\nCHANGELOG.md section:\n");
  console.log(candidate.changelog.trim());
  console.log(`\nOwner approval token: ${candidate.approval}`);
  console.log(`Publish after approval: pnpm release:publish -- --source-ref ${candidate.sourceRef} --date ${candidate.date} --approval ${candidate.approval}`);
}

export function main(args = process.argv.slice(2)) {
  try {
    const cli = parseCli(args.filter(value => value !== "--"));
    if (cli.action === "prepare") summary(prepareReleaseCandidate(cli));
    else {
      const result = publishRelease(cli);
      console.log(`Created local release commit ${result.commit} on ${result.branch} and tag ${result.tag}.`);
      console.log(`Push when ready: ${result.pushCommand}`);
      console.log(`Create the GitHub release after pushing: ${result.ghCommand}`);
    }
  } catch (error) {
    console.error(`release refused: ${error instanceof ReleaseRefusal ? error.code : "release_internal_failure"}`);
    process.exitCode = 1;
  }
}

if (isMainModuleV1(process.argv[1], import.meta.url)) main();
