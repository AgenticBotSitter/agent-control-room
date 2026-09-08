import assert from "node:assert/strict";
import test from "node:test";
import { createTaskCoordinatorLifecycle } from "../src/web/v1/task-coordinator-lifecycle";
import { managedFixture, deferred } from "./helpers/web-idea-start";

test("managed discussion drains an in-flight turn, blocks another turn and closes captured resources once", async t => {
  const f = await managedFixture(); t.after(f.cleanup); const entered = deferred(), release = deferred();
  const invoke = f.runtime.driver.invoke.bind(f.runtime.driver);
  f.runtime.driver.invoke = async input => { entered.resolve(); await release.promise; return invoke(input); };
  const owner = createTaskCoordinatorLifecycle(f.config);
  // Changing caller-owned methods after construction cannot replace the captured ports.
  f.runtime.driver.invoke = async () => { throw new Error("mutated driver"); };
  f.config.ideaRuntime.close = async () => { throw new Error("mutated close"); };
  const pending = owner.ideaCreation!.start!(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  await entered.promise; const closing = owner.close(); assert.equal(owner.isReady(), false);
  await assert.rejects(owner.ideaCreation!.start!(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest }), /unavailable/);
  assert.deepEqual(f.closed, []); release.resolve();
  const result = await pending; await closing; await owner.close();
  assert.equal(f.counts().calls, 1); assert.equal(result.state, "failed_definite");
  assert.equal((await f.client.query("SELECT * FROM control_idea_contributions")).rows.length, 1);
  assert.equal(f.closed[0], "runtime"); assert.deepEqual([...f.closed].sort(), ["idea", "runtime", "runtime-db", "task"]);
});
