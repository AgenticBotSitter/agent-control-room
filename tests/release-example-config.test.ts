// The examples/release operator config must satisfy the REAL production
// validators (offline shape checks only — no database, no listener, no keys
// loaded). If this test fails, the example drifted from the code it documents.
import test from "node:test";
import assert from "node:assert/strict";
import { requirePrivateVpsMode } from "../scripts/run-private-vps.mjs";
import { validatePrivateStartupConfiguration } from "../src/web/v1/private-startup.ts";
import * as example from "../examples/release/operator-config.example.mjs";

test("example operator config passes the real website-only validators", async () => {
  assert.equal(example.schema, "control-room.private-vps-configuration/v1");
  const prepared = await example.createConfiguration({ signal: new AbortController().signal });
  assert.equal(requirePrivateVpsMode(prepared), "website-only");
  // Type-only assertion: the example is untyped .mjs, so literals widen to
  // string; runtime shape is what this test proves (see assertions below).
  const web = prepared.configuration.web as Parameters<typeof validatePrivateStartupConfiguration>[0];
  const checked = validatePrivateStartupConfiguration(web);
  assert.equal(checked.origin, "https://control-room.example.com");
  assert.equal(checked.database.host, "127.0.0.1");
});
