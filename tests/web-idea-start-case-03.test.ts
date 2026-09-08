import assert from "node:assert/strict";
import test from "node:test";
import { now } from "./helpers/web-foundation";
import { WebIdeaStartOperation } from "../src/web/v1/idea-start-operation";
import { sha256Digest } from "../src/security";
import { fixture, scope, key, at } from "./helpers/web-idea-start";

test("start refuses fake fallback, changed digest and revoked owner before resolving runtime material", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  assert.throws(() => new WebIdeaStartOperation(f.client, f.client, scope, key, f.runtime), /config_invalid/);
  assert.throws(() => new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key,
    { ...f.runtime, driver: { ...f.runtime.driver, mode: "repository_fake" } }), /config_invalid/);
  const service = new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now);
  await assert.rejects(service.start(f.identity, f.saved.sessionId, { sessionDigest: sha256Digest("wrong") }), /conflict/);
  await f.client.query("UPDATE control_role_grants SET revoked_at=$1", [at()]);
  await assert.rejects(service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest }), /access_denied/);
  assert.deepEqual(f.counts(), { calls: 0, resolutions: 0 });
});
