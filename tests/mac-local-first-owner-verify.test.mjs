import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const up = await readFile(new URL("../scripts/mac-local/up.mjs", import.meta.url), "utf8");
const owner = await readFile(new URL("../scripts/mac-local/bootstrap-owner.ts", import.meta.url), "utf8");

test("mac:up runs first-owner checks without provisioning owner rows", () => {
  assert.match(up, /scripts\/mac-local\/check-database\.ts/);
  assert.match(up, /scripts\/mac-local\/bootstrap-owner\.ts/);
  assert.match(up, /first-owner setup has not been run; see OWNER_GUIDE_MAC\.md/);
  assert.doesNotMatch(owner, /bootstrapMacLocalOwnerV1|seedMacLocalAdapterRegistryV1|seedMacLocalNodeV1/);
  assert.doesNotMatch(owner, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\s+/i);
  assert.ok(up.indexOf("scripts/mac-local/check-database.ts") < up.indexOf("const hostPid = await readPid"));
  assert.ok(up.indexOf("scripts/mac-local/bootstrap-owner.ts") < up.indexOf("const hostPid = await readPid"));
});

test("an absent binding is distinguished from an invalid binding", () => {
  assert.match(owner, /first_owner_binding_missing/);
  assert.match(owner, /first_owner_binding_conflict/);
  assert.match(owner, /process\.exitCode = 2/);
  assert.match(owner, /process\.exitCode = 1/);
});
