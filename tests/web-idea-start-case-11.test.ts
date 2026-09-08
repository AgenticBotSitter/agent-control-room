import assert from "node:assert/strict";
import test from "node:test";
import { createTaskCoordinatorLifecycle } from "../src/web/v1/task-coordinator-lifecycle";
import { managedFixture, deferred } from "./helpers/web-idea-start";

test("managed drain timeout retains unknown in-flight history and rejects a late reply", async t => {
  const f = await managedFixture(); t.after(f.cleanup); const entered = deferred(), release = deferred();
  const invoke = f.runtime.driver.invoke.bind(f.runtime.driver);
  f.runtime.driver.invoke = async input => { entered.resolve(); await release.promise; return invoke(input); };
  const owner = createTaskCoordinatorLifecycle({ ...f.config, drainMs: 10, closeMs: 20 });
  const pending = owner.ideaCreation!.start!(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  const rejected = assert.rejects(pending, /uncertain/); await entered.promise;
  await assert.rejects(owner.close(), /close_uncertain/); await rejected;
  const before = await f.client.query("SELECT * FROM control_idea_bot_run_events");
  release.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await f.client.query("SELECT * FROM control_idea_bot_run_events")).rows, before.rows);
  assert.equal((await f.client.query("SELECT * FROM control_idea_contributions")).rows.length, 0);
  assert.equal(f.counts().calls, 1);
});
