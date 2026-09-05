import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("compiled operator rehearsal entry imports inertly and invalid setup produces zero native attempts", async () => {
  const entry = await import("../dist-vps/server/rehearsal.js");
  assert.equal(typeof entry.createNativePrivateDatabaseRehearsal, "function");
  assert.equal(typeof entry.rehearsalScopeDigest, "function");
  const runner = entry.createNativePrivateDatabaseRehearsal();
  const result = await runner.run({});
  assert.equal(result.disposition, "setup_incomplete"); assert.equal(result.execution, "native_postgres");
  assert.equal(result.poolsCreated, 0); assert.equal(result.probesCreated, 0);
  assert.equal(result.realPostgresAccepted, false); assert.equal(result.privateBetaAccepted, false);
  assert.equal((await runner.run({})).disposition, "already_attempted");
  const html = await readFile("dist-vps/server/index.js", "utf8");
  assert.doesNotMatch(html, /createNativePrivateDatabaseRehearsal\(\)/);
});
