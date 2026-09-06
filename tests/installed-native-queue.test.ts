import test from "node:test";
import assert from "node:assert/strict";
import { createInstalledNativeQueueFactories } from "../src/web/v1/installed-native-queue";

test("installed queue factory construction is inert and validates before opening a resource", async () => {
  let opens = 0;
  const factories = createInstalledNativeQueueFactories({ openWorkerDatabase: () => { opens++; throw new Error("unexpected open"); } });
  assert.equal(opens, 0); assert.equal(Object.isFrozen(factories), true);
  assert.deepEqual(Object.keys(factories), ["prepareNativeSubmission", "startNativeWorker"]);
  await assert.rejects(factories.startNativeWorker({} as never), /config_invalid/); assert.equal(opens, 0);
  assert.throws(() => createInstalledNativeQueueFactories({ backend: "other" as never, openWorkerDatabase: () => { throw new Error(); } }), /config_invalid/);
});
