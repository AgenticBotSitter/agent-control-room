import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as provider from "../src/web/v1/mac-local-default-task-provider";
import { MAC_LOCAL_TASK_PROVIDER_V1, MAC_LOCAL_THREE_AGENT_KINDS_V1 } from "../src/web/v1/mac-local-task-provider";

test("default Mac-local provider exposes the exact three-worker provider contract", () => {
  assert.deepEqual(Object.keys(provider).sort(), ["createTaskApplication", "schema", "workerKinds"]);
  assert.equal(provider.schema, MAC_LOCAL_TASK_PROVIDER_V1);
  assert.deepEqual(provider.workerKinds, MAC_LOCAL_THREE_AGENT_KINDS_V1);
  assert.equal(typeof provider.createTaskApplication, "function");
});

test("configured run limits are wired into every local executor", async () => {
  const source = await readFile(new URL("../src/web/v1/mac-local-default-task-provider.ts", import.meta.url), "utf8");
  assert.match(source, /const runLimits = await loadMacLocalTaskRunLimitsFromRootV1\(protectedRoot\)/u);
  const constructors = [
    "createOwnerTrustedLocalHermesDeliveryV1",
    "createOwnerTrustedLocalClaudeDeliveryV1",
    "createOwnerTrustedLocalCodexDeliveryV1",
  ];
  for (const [index, constructor] of constructors.entries()) {
    const start = source.indexOf(`${constructor}(`);
    assert.notEqual(start, -1, `${constructor} must be present`);
    const next = constructors[index + 1];
    const end = next ? source.indexOf(`${next}(`, start + constructor.length) : source.indexOf("submission =", start);
    assert.ok(end > start, `${constructor} boundary must be present`);
    const wiring = source.slice(start, end);
    assert.match(wiring, /deadlineMs: runLimits\.wallTimeMs, outputBytes: runLimits\.outputBytes/u,
      `${constructor} must receive both protected run limits`);
  }
});
