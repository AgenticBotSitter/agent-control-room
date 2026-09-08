import assert from "node:assert/strict";
import test from "node:test";
import { now } from "./helpers/web-foundation";
import { WebIdeaStartOperation } from "../src/web/v1/idea-start-operation";
import { fixture, scope, key, at } from "./helpers/web-idea-start";

test("owner access is checked again after runtime lookup", async t => {
  const f = await fixture(); t.after(() => f.db.close()); const resolve = f.runtime.resolve.bind(f.runtime);
  f.runtime.resolve = async (...args) => {
    const value = await resolve(...args); await f.client.query("UPDATE control_role_grants SET revoked_at=$1", [at()]); return value;
  };
  await assert.rejects(new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now)
    .start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest }), /access_denied/);
  assert.equal(f.counts().calls, 0); assert.equal((await f.client.query("SELECT * FROM control_idea_bot_run_events")).rows.length, 0);
});
