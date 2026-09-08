import assert from "node:assert/strict";
import test from "node:test";
import { createTaskCoordinatorLifecycle } from "../src/web/v1/task-coordinator-lifecycle";
import { managedFixture } from "./helpers/web-idea-start";

test("managed runtime rejects aliased pools and closes databases after failed or stalled runtime cleanup", async t => {
  for (const stalled of [false, true]) await t.test(String(stalled), async t => {
    const f = await managedFixture(); t.after(f.cleanup);
    assert.throws(() => createTaskCoordinatorLifecycle({ ...f.config, ideaCreation: undefined }), /config_invalid/);
    assert.throws(() => createTaskCoordinatorLifecycle({ ...f.config,
      ideaRuntime: { ...f.config.ideaRuntime, database: f.config.ideaCreation.database } }), /config_invalid/);
    f.config.ideaRuntime.close = async () => {
      f.closed.push("runtime"); if (stalled) await new Promise<void>(() => {}); throw new Error("synthetic cleanup failure");
    };
    const owner = createTaskCoordinatorLifecycle({ ...f.config, closeMs: 20 }); await assert.rejects(owner.close(), /close_uncertain/);
    assert.deepEqual([...f.closed].sort(), ["idea", "runtime", "runtime-db", "task"]);
  });
});
