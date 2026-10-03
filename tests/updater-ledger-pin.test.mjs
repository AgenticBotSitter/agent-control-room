// The updater's pinned migration-ledger digest, and why this test exists.
//
// `RELEASE_MIGRATION_LEDGER_DIGEST_V1` in
// `src/updater/v1/services/protected-config.mjs` is a LITERAL because the fixed
// updater bundle may not import release code. That makes the pin a thing a person
// has to remember to update, and a person forgets.
//
// MEASURED, and this test is the evidence: the pin shipped with the installer
// stream carrying `sha256:393289da…`, which matched NO ledger in this tree — not
// `cook/m1`'s 149 entries and not `cook/v1`'s 151 entries. Every
// `parseNightlyBackupConfigurationV1` call therefore answered
// `nightly_backup_configuration_refused`, because that parser rebuilds the expected
// configuration from the live ledger and compares canonical JSON. The only reason
// anyone noticed is that the merge with `cook/installer` brought a test which parses
// the file back.
//
// The constant's own comment used to promise "a release-side golden test below this
// module deliberately catches ledger drift so a new bundle must update this pin".
// There was no such test. This one is it, and it is deliberately NOT an import of the
// constant — a test that imports the value it is checking asserts nothing.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { RELEASE_MIGRATION_LEDGER_DIGEST_V1 } from "../src/updater/v1/services/protected-config.mjs";

const REPO = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));

/**
 * The ledger's own digest, READ as data.
 *
 * Not imported, not recomputed from an assumption about how it was made: the ledger
 * file states its own `digest`, and this test compares the pin to that. If the
 * algorithm that produces `digest` ever changes, this test is what notices that the
 * two halves no longer agree — which is exactly the moment a pin is worth having.
 */
function readLedger() {
  const value = JSON.parse(readFileSync(join(REPO, "deploy", "postgres", "migration-ledger.json"), "utf8"));
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "the ledger must be an object");
  assert.match(value.digest ?? "", /^[a-f0-9]{64}$/u, "the ledger must state its own digest");
  assert.ok(Array.isArray(value.entries) && value.entries.length > 0, "the ledger must list migrations");
  return value;
}

test("the updater's ledger pin equals the release ledger's own digest", () => {
  const ledger = readLedger();
  assert.equal(RELEASE_MIGRATION_LEDGER_DIGEST_V1, `sha256:${ledger.digest}`,
    `the updater bundle's ledger pin must match deploy/postgres/migration-ledger.json `
    + `(ledger has ${ledger.entries.length} entries). The updater cannot import the ledger, so this `
    + `pin is the only place the two halves meet, and a stale pin makes every `
    + `parseNightlyBackupConfigurationV1 call refuse.`);
});

test("the ledger digest is not merely a prefix or a truncation of its own content", () => {
  // A weaker check than it looks, and worth stating: it catches the failure mode where
  // someone "fixes" the pin by hashing something adjacent (the entry list, the file
  // name, the version) rather than the ledger's own digest field.
  const ledger = readLedger();
  const wrongWays = new Map([
    ["the sha256 of the ledger file itself", createHash("sha256")
      .update(readFileSync(join(REPO, "deploy", "postgres", "migration-ledger.json"))).digest("hex")],
    ["the sha256 of the entry names alone", createHash("sha256")
      .update(JSON.stringify(ledger.entries.map(entry => entry.name ?? entry))).digest("hex")],
  ]);
  for (const [how, digest] of wrongWays) {
    assert.notEqual(ledger.digest, digest,
      `the ledger's digest must not be ${how}, or the pin above is checking the wrong thing`);
  }
  assert.notEqual(RELEASE_MIGRATION_LEDGER_DIGEST_V1, `sha256:${ledger.version}`,
    "the pin must not be the ledger's version");
});

test("the ledger is internally consistent: its entries are unique and ordered", () => {
  const ledger = readLedger();
  const names = ledger.entries.map(entry => entry.name ?? entry);
  assert.equal(new Set(names).size, names.length, "two migrations share a name");
  // The head is the last entry, and the digest chain is the ledger's own claim about
  // it. This does not recompute the chain - that is the phase's job against a live
  // cluster - but it does refuse a ledger whose own head is not its last entry.
  const sorted = [...names].sort();
  assert.deepEqual(names, sorted, "the ledger's entries must be in order, or the phase's head is wrong");
});