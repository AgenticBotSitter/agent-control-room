import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("compiled preparation entry is separate, inert and refuses incomplete setup without a native pool", async () => {
  const entry = await import("../dist-vps/server/preparation.js");
  assert.equal(typeof entry.createNativePrivateFixturePreparation, "function");
  assert.equal(typeof entry.fixtureMigratorScopeDigest, "function");
  assert.equal("buildPrivateRehearsalFixture" in entry, false);
  const preparer = entry.createNativePrivateFixturePreparation(), result = await preparer.prepare({});
  assert.equal(result.evidence.disposition, "setup_incomplete"); assert.equal(result.evidence.execution, "native_postgres");
  assert.equal(result.evidence.poolCreated, false); assert.equal(result.evidence.realPostgresAccepted, false);
  assert.equal(result.takeMaterial, undefined);
  assert.equal((await preparer.prepare({})).evidence.disposition, "already_attempted");
  const app = await readFile("dist-vps/server/index.js", "utf8");
  assert.doesNotMatch(app, /createNativePrivateFixturePreparation\(\)/);
});
