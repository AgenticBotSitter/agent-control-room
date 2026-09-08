import assert from "node:assert/strict";
import test from "node:test";
import { createTaskCoordinatorLifecycle } from "../src/web/v1/task-coordinator-lifecycle";
import { managedFixture, deferred } from "./helpers/web-idea-start";

test("managed shutdown during runtime lookup cannot claim or contact a provider", async t => {
  const f = await managedFixture(); t.after(f.cleanup); const entered = deferred(), release = deferred();
  const resolve = f.runtime.resolve.bind(f.runtime);
  f.runtime.resolve = async (...args) => { entered.resolve(); await release.promise; return resolve(...args); };
  const owner = createTaskCoordinatorLifecycle(f.config);
  const pending = owner.ideaCreation!.start!(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  // Existing lifecycle deliberately reports an interrupted admitted command as
  // uncertain once teardown wins, even though the assertions below prove no claim.
  const rejected = assert.rejects(pending, /unavailable|save_uncertain/);
  await entered.promise; const closing = owner.close(); release.resolve(); await rejected; await closing;
  assert.equal(f.counts().calls, 0); assert.equal((await f.client.query("SELECT * FROM control_idea_bot_run_events")).rows.length, 0);
});
