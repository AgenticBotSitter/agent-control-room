import assert from "node:assert/strict";
import test from "node:test";
import * as provider from "../src/web/v1/mac-local-default-task-provider";
import { MAC_LOCAL_TASK_PROVIDER_V1, MAC_LOCAL_THREE_AGENT_KINDS_V1 } from "../src/web/v1/mac-local-task-provider";

test("default Mac-local provider exposes the exact three-worker provider contract", () => {
  assert.deepEqual(Object.keys(provider).sort(), ["createTaskApplication", "schema", "workerKinds"]);
  assert.equal(provider.schema, MAC_LOCAL_TASK_PROVIDER_V1);
  assert.deepEqual(provider.workerKinds, MAC_LOCAL_THREE_AGENT_KINDS_V1);
  assert.equal(typeof provider.createTaskApplication, "function");
});
