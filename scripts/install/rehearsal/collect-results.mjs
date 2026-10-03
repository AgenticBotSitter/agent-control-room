#!/usr/bin/env node
import { readJsonlPrefixV1 } from "../../../src/installer/shared/jsonl-prefix.mjs";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";

import { isMainModuleV1 } from "../../../src/installer/shared/is-main-module.mjs";

const MAX_BYTES = 64 * 1024 * 1024;
const EVIDENCE_SCHEMA = "control-room.e2e2-evidence/v1";
const RUNTIME_TREES = Object.freeze(["node", "pnpm", "esbuild", "postgresql"]);
const SEATBELT_ROLES = Object.freeze(["postgres", "supervisor"]);
const P0_OPERATIONS = Object.freeze(["read", "write", "signal"]);
const TAILSCALE_STEPS = Object.freeze(["capture", "activate", "restore"]);
const REHEARSAL_ROOT = "/Library/Application Support/Control Room Rehearsal";
const refuse = code => { throw Object.assign(new Error(code), { code }); };

function exactArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!/^--[a-z][a-z-]*$/u.test(flag ?? "") || value === undefined || values[flag] !== undefined) refuse("arguments_refused");
    values[flag] = value;
  }
  return values;
}

async function regularFile(path, code) {
  if (!isAbsolute(path) || normalize(path) !== path) refuse(code);
  const stat = await lstat(path).catch(() => refuse(code));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES
    || stat.uid !== process.geteuid() || (stat.mode & 0o077) !== 0) refuse(code);
  return readFile(path, "utf8");
}

function jsonLines(text, code) {
  const { values } = readJsonlPrefixV1(text, { refuse: () => refuse(code) });
  if (values.length === 0 || values.length > 100_000) refuse(code);
  return values;
}

function journalDone(journal, command, action) {
  const matches = journal.filter(row => row?.schema === "control-room.install-journal/v2"
    && row.command === command && row.phase === "done" && row.action === action);
  return matches.length === 1 ? matches[0] : undefined;
}

function tableRow(check, passed, detail) { return Object.freeze({ check, passed, detail }); }

export function collectResultsV1(journal, evidence) {
  if (!Array.isArray(journal) || !Array.isArray(evidence) || evidence.some(row => row?.schema !== EVIDENCE_SCHEMA)) {
    refuse("rehearsal_evidence_refused");
  }
  const rows = [];
  const installed = journalDone(journal, "install", "transaction");
  const transactionId = installed?.transactionId, commit = installed?.commit, root = installed?.root;
  const correlation = typeof transactionId === "string" && /^[a-f0-9-]{36}$/u.test(transactionId)
    && typeof commit === "string" && /^[a-f0-9]{40}$/u.test(commit) && root === REHEARSAL_ROOT
    && journal.length > 0 && journal.every(row => row?.schema === "control-room.install-journal/v2"
      && row.transactionId === transactionId && row.commit === commit && row.root === root)
    && evidence.length > 0 && evidence.every(row => row.transactionId === transactionId && row.commit === commit && row.root === root);
  rows.push(tableRow("single rehearsal transaction", correlation,
    correlation ? `transaction=${transactionId}; root=${root}; commit=${commit}` : "mixed, stale, or unbound records"));
  rows.push(tableRow("installer completed", correlation && installed?.data?.state === "installed", installed?.data?.state ?? "missing"));
  const fresh = journalDone(journal, "install", "fresh-database");
  rows.push(tableRow("fresh database selected", fresh?.data?.selected === true, fresh ? JSON.stringify(fresh.data) : "missing"));
  for (const tree of RUNTIME_TREES) {
    const matches = evidence.filter(row => row.kind === "runtime-root-metadata" && row.tree === tree);
    const passed = matches.length === 1 && matches[0].passed === true && Number.isSafeInteger(matches[0].entries) && matches[0].entries > 0;
    rows.push(tableRow(`root metadata: ${tree}`, passed, matches.length === 1 ? `${matches[0].entries ?? 0} entries` : `${matches.length} records`));
  }
  for (const role of SEATBELT_ROLES) {
    const matches = evidence.filter(row => row.kind === "seatbelt" && row.role === role);
    const passed = matches.length === 1 && matches[0].applied === true && matches[0].skipped === false;
    rows.push(tableRow(`Seatbelt applied: ${role}`, passed, matches.length === 1 ? `applied=${matches[0].applied}; skipped=${matches[0].skipped}` : `${matches.length} records`));
  }
  for (const step of TAILSCALE_STEPS) {
    const matches = evidence.filter(row => row.kind === "tailscale-step" && row.step === step);
    const passed = matches.length === 1 && matches[0].outcome === "skipped (rehearsal)";
    rows.push(tableRow(`Tailscale ${step}`, passed, matches.length === 1 ? matches[0].outcome : `${matches.length} records`));
  }
  const spawnCount = evidence.filter(row => row.kind === "spawn-count"), spawns = evidence.filter(row => row.kind === "spawn-t1");
  const expected = spawnCount.length === 1 ? spawnCount[0].expected : undefined;
  const spawnIds = spawns.map(row => row.spawnId);
  const t1 = Number.isSafeInteger(expected) && expected > 0 && spawns.length === expected && new Set(spawnIds).size === expected
    && spawns.every(row => typeof row.spawnId === "string" && row.spawnId.length > 0 && row.passed === true);
  rows.push(tableRow("T1 before every spawn", t1, `checked=${spawns.length}; expected=${expected ?? "missing"}`));
  const owner = evidence.filter(row => row.kind === "owner-uid");
  const ownerUid = owner.length === 1 ? owner[0].uid : undefined;
  for (const operation of P0_OPERATIONS) {
    const matches = evidence.filter(row => row.kind === "p0-denial" && row.operation === operation);
    const passed = Number.isSafeInteger(ownerUid) && ownerUid >= 501 && matches.length === 1
      && matches[0].uid === ownerUid && matches[0].denied === true;
    rows.push(tableRow(`P0 owner ${operation} denied`, passed, matches.length === 1 ? `uid=${matches[0].uid}; denied=${matches[0].denied}` : `${matches.length} records`));
  }
  const health = journalDone(journal, "install", "health-check"), healthEvidence = evidence.filter(row => row.kind === "health");
  const healthPassed = health?.data?.healthy === true && health?.data?.samples === 3
    && /^sha256:[a-f0-9]{64}$/u.test(health?.data?.schemaDigest ?? "") && healthEvidence.length === 1
    && healthEvidence[0].healthy === true && healthEvidence[0].samples === 3
    && healthEvidence[0].schemaDigest === health.data.schemaDigest;
  rows.push(tableRow("health 3/3", healthPassed, healthEvidence.length === 1
    ? `healthy=${healthEvidence[0].healthy}; samples=${healthEvidence[0].samples}` : `${healthEvidence.length} evidence records`));
  const passkeys = evidence.filter(row => row.kind === "passkey");
  const passkeyPassed = correlation && passkeys.length === 1 && passkeys[0].status === "registered";
  rows.push(tableRow("practice passkey registered", passkeyPassed, passkeys.length === 1
    ? String(passkeys[0].status ?? "missing") : `${passkeys.length} evidence records`));
  return Object.freeze({ schema: "control-room.e2e2-result/v1", passed: rows.every(row => row.passed), rows: Object.freeze(rows) });
}

export function renderResultsV1(result) {
  const lines = ["# E2E-2 rehearsal results", "", `Overall: **${result.passed ? "PASS" : "FAIL"}**`, "",
    "| Check | Result | Evidence |", "|---|---:|---|",
    ...result.rows.map(row => `| ${row.check.replaceAll("|", "\\|")} | ${row.passed ? "PASS" : "FAIL"} | ${row.detail.replaceAll("|", "\\|")} |`), ""];
  return lines.join("\n");
}

async function writeExclusive(path, bytes) {
  if (!isAbsolute(path) || normalize(path) !== path) refuse("output_path_refused");
  const parent = await realpath(dirname(path)).catch(() => refuse("output_path_refused"));
  const stat = await lstat(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse("output_path_refused");
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600)
    .catch(error => error?.code === "EEXIST" ? refuse("output_exists") : Promise.reject(error));
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  const args = exactArguments(argv);
  if (!args["--journal"] || !args["--evidence"] || !args["--output"] || Object.keys(args).some(flag => !["--journal", "--evidence", "--output"].includes(flag))) {
    refuse("arguments_refused");
  }
  const journal = jsonLines(await regularFile(args["--journal"], "install_journal_refused"), "install_journal_refused");
  const evidence = jsonLines(await regularFile(args["--evidence"], "rehearsal_evidence_refused"), "rehearsal_evidence_refused");
  const result = collectResultsV1(journal, evidence), report = renderResultsV1(result);
  await writeExclusive(args["--output"], report);
  process.stdout.write(report);
  if (!result.passed) process.exitCode = 1;
}

if (isMainModuleV1(process.argv[1], import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error?.code ?? error?.message ?? "result_collection_failed"}\n`); process.exitCode = 1; });
}
