/**
 * Focused qualification tests for issue #215 (source package, effect-free).
 *
 * Run: node --import tsx --test scripts/test-persistent-work-source-qualification.ts
 *
 * Covers every acceptance case: valid staged completion (with owner
 * signature), database-first and checkpoint-first split failures, lost
 * acknowledgements, write timeouts, stale/rolled-back checkpoints,
 * advance-contract guards, revoked signer refusal alongside mismatched signer
 * identity, a valid signing path, incomplete artifact restore, wrong database
 * restore identity, missing restore evidence as a bounded blocked state, the
 * always-blocked aggregate disposition, and exact replay. Proves statically
 * that the runner exposes no network, subprocess, credential, filesystem-write,
 * database-write or effect adapter.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { redactSecrets, assertNoSecretMaterial } from "../src/security/redaction";
import {
  qualifyPersistentWorkSource,
  qualifyAllPersistentWorkSources,
  summarizeQualification,
  SCENARIO_NAMES,
} from "./qualify-persistent-work-source";

const RUNNER_SOURCE = readFileSync(new URL("./qualify-persistent-work-source.ts", import.meta.url), "utf8");

test("runner exposes no network, subprocess, credential, filesystem, database or effect adapter", () => {
  const forbidden = [
    "child_process", "spawnSync", "spawn(", "execFile", "exec(",
    "node:net", "node:http", "node:https", "node:dgram", "node:fs",
    "from \"fs\"", "from 'fs'", "writeFile", "appendFile", "fetch(",
    "WebSocket", "XMLHttpRequest", "process.env",
    "generateKeyPair", "generateKey", "randomBytes", "randomUUID", "randomInt",
    "Date.", "performance.now", "eval(", "Function(",
    "createConnection", ".connect(",
  ];
  for (const pattern of forbidden) {
    assert.ok(!RUNNER_SOURCE.includes(pattern), `runner must not contain ${pattern}`);
  }
  const imports = [...RUNNER_SOURCE.matchAll(/from\s+["']([^"']+)["']/g)].map(match => match[1]);
  assert.ok(imports.length > 0, "runner must import its contracts explicitly");
  const allowed = new Set([
    "../src/completion-gate/v1/staged-checkpoint",
    "../src/completion-gate/v1/etcd-checkpoint-store",
    "../src/completion-gate/v1/etcd-checkpoint-record",
    "../src/completion-gate/v1/etcd-checkpoint-advance",
    "../src/security/rollback-checkpoint",
    "../src/security/redaction",
    "../src/security/digest",
    "../src/harness/v1/bounded-owner-signature",
    "../src/artifacts/v1/artifact-backup-inventory",
    "../tests/helpers/security-recovery-fault-matrix",
  ]);
  for (const specifier of imports) {
    assert.ok(allowed.has(specifier), `runner imports unapproved module ${specifier}`);
  }
});

test("every scenario record is sanitized plain data with no secret material", async () => {
  for (const scenario of SCENARIO_NAMES) {
    const record = await qualifyPersistentWorkSource(scenario);
    assert.equal(record.schema, "control-room.persistent-work-source-qualification/v1");
    assert.equal(record.case, scenario);
    assert.ok(record.verdict === "pass" || record.verdict === "blocked");
    assertNoSecretMaterial(record, `record for ${scenario}`);
    assert.deepEqual(record.redactedPaths, []);
    assert.equal(record.evidence.workApproved, false);
    JSON.parse(JSON.stringify(record));
  }
});

test("sanitizer redacts hostile material instead of passing it through", () => {
  const { value, redactedPaths } = redactSecrets({ note: "password=hunter2-abcdef", nested: { api_key: "sk_test_1234567890ab" } });
  const projected = value as { note: string; nested: { api_key: string } };
  assert.equal(projected.note, "[REDACTED]");
  assert.equal(projected.nested.api_key, "[REDACTED]");
  assert.ok(redactedPaths.length === 2);
});

test("valid staged completion passes with observable single advance and owner signature", async () => {
  const record = await qualifyPersistentWorkSource("valid-staged-completion");
  assert.equal(record.verdict, "pass");
  assert.equal(record.reason, "staged-completion-verified");
  assert.equal(record.evidence.anchorRevision, 1);
  assert.equal(record.evidence.completedRevision, 2);
  assert.equal(record.evidence.checkpointAdvances, 1);
  assert.equal(record.evidence.signatureLength, 64);
  assert.equal(record.evidence.syntheticInput, true);
});

test("database-first split is blocked and the anchor is untouched", async () => {
  const record = await qualifyPersistentWorkSource("database-first-split");
  assert.equal(record.verdict, "blocked");
  assert.equal(record.reason, "completion-checkpoint-split:database-first");
  assert.equal(record.evidence.checkpointAdvances, 0);
});

test("checkpoint-first split is blocked", async () => {
  const record = await qualifyPersistentWorkSource("checkpoint-first-split");
  assert.equal(record.verdict, "blocked");
  assert.equal(record.reason, "completion-checkpoint-split:checkpoint-first");
});

test("lost acknowledgement is uncertain, never completion, and never retried", async () => {
  const record = await qualifyPersistentWorkSource("lost-acknowledgement");
  assert.equal(record.verdict, "blocked");
  assert.equal(record.reason, "lost-checkpoint-acknowledgement");
  assert.equal(record.evidence.transactions, 1);
  assert.equal(record.evidence.committedWrites, 1);
  assert.equal(record.evidence.treatedAsCompletion, false);
});

test("checkpoint write timeout is uncertain and never retried", async () => {
  const record = await qualifyPersistentWorkSource("checkpoint-write-timeout");
  assert.equal(record.verdict, "blocked");
  assert.equal(record.reason, "checkpoint-write-timeout-uncertain");
  assert.equal(record.evidence.transactions, 1);
  assert.equal(record.evidence.treatedAsCompletion, false);
});

test("stale checkpoint replay is refused as rollback", async () => {
  const record = await qualifyPersistentWorkSource("stale-checkpoint-rollback");
  assert.equal(record.verdict, "blocked");
  assert.equal(record.reason, "stale-checkpoint-rollback-refused");
  assert.equal(record.evidence.anchorRevision, 2);
});

test("checkpoint record and advance contracts hold in both directions", async () => {
  const record = await qualifyPersistentWorkSource("checkpoint-advance-contract-guards");
  assert.equal(record.verdict, "pass");
  assert.equal(record.reason, "checkpoint-contracts-hold");
  assert.equal(record.evidence.guardsHeld, 3);
});

test("revoked signer is refused at the channel after the malformed identity is rejected", async () => {
  const record = await qualifyPersistentWorkSource("revoked-or-mismatched-signer");
  assert.equal(record.verdict, "blocked");
  assert.equal(record.reason, "revoked-signer-refused");
  assert.equal(record.evidence.malformedIdentityRejected, true);
  assert.equal(record.evidence.revokedChannelRefused, true);
  assert.equal(record.evidence.signatureProduced, false);
});

test("valid signing path verifies through the production signer", async () => {
  const record = await qualifyPersistentWorkSource("valid-signing-path");
  assert.equal(record.verdict, "pass");
  assert.equal(record.reason, "signing-path-verified");
  assert.equal(record.evidence.signatureLength, 64);
  assert.equal(record.evidence.syntheticInput, true);
});

test("incomplete artifact restore is blocked with both digests named", async () => {
  const record = await qualifyPersistentWorkSource("incomplete-artifact-restore");
  assert.equal(record.verdict, "blocked");
  assert.equal(record.reason, "incomplete-artifact-restore");
  assert.notEqual(record.evidence.expectedDigest, record.evidence.restoredDigest);
});

test("wrong database restore identity is blocked", async () => {
  const record = await qualifyPersistentWorkSource("wrong-database-restore-identity");
  assert.equal(record.verdict, "blocked");
  assert.equal(record.reason, "wrong-database-restore-identity");
});

test("missing restore evidence is a bounded blocked state, not a fabricated pass", async () => {
  const record = await qualifyPersistentWorkSource("missing-restore-evidence");
  assert.equal(record.verdict, "blocked");
  assert.equal(record.reason, "missing-database-restore-evidence:missing-artifact-restore-evidence");
  assert.equal(record.evidence.fabricatedPass, false);
});

test("exact replay is byte-identical across the full suite", async () => {
  const first = await qualifyAllPersistentWorkSources();
  const second = await qualifyAllPersistentWorkSources();
  assert.equal(first.length, SCENARIO_NAMES.length);
  assert.deepEqual(first.map(record => record.case), [...SCENARIO_NAMES]);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  const passes = first.filter(record => record.verdict === "pass").map(record => record.case).sort();
  assert.deepEqual(passes, ["checkpoint-advance-contract-guards", "valid-signing-path", "valid-staged-completion"]);
});

test("aggregate disposition stays blocked without real restore evidence", async () => {
  const records = await qualifyAllPersistentWorkSources();
  const disposition = summarizeQualification(records);
  assert.equal(disposition.disposition, "blocked");
  assert.equal(disposition.reason, "missing-real-restore-evidence:synthetic-passes-are-internal-logic-only");
  assert.equal(disposition.scenarios, SCENARIO_NAMES.length);
  // Synthetic passes never become acceptance evidence: every scenario record
  // carries workApproved false, and the disposition never approves either.
  assert.deepEqual(disposition.syntheticPasses,
    ["checkpoint-advance-contract-guards", "valid-signing-path", "valid-staged-completion"]);
  assert.ok(disposition.blocked.length === SCENARIO_NAMES.length - disposition.syntheticPasses.length);
  assert.equal(JSON.stringify(summarizeQualification(records)), JSON.stringify(disposition));
});
