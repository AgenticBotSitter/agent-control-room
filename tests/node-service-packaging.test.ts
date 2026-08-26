import assert from "node:assert/strict";
import test from "node:test";
import { verifyServicePackages } from "../src/node-service-packaging/v1/conformance";

test("value-free native service packages satisfy the CR-6A static conformance contract", async () => {
  const results = await verifyServicePackages();
  assert.deepEqual(results.map((result) => result.platform), ["linux", "macos", "windows"]);
  assert.ok(results.every((result) => result.checks.length >= 4));
});
