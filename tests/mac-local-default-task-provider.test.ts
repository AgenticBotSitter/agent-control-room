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

test("agent review production composition separates coordinator planning from reviewer recording", async () => {
  const source = await readFile("src/web/v1/mac-local-default-task-provider.ts", "utf8");
  assert.match(source, /createPrivatePostgresDatabase\(databaseRoles\.agentReviewer\)/u);
  assert.match(source, /verifyAgentReviewerDatabase\(reviewerPool\.client/u);
  assert.match(source, /new AgentReviewServiceV1\(readPool\.client[\s\S]*new AgentReviewServiceV1\(reviewerPool\.client/u);
  assert.match(source, /createPlan: planService\.createPlan\.bind\(planService\), record: recordService\.record\.bind\(recordService\)/u);
  assert.match(source, /reviewerPool\.close\(\)/u);
  assert.doesNotMatch(source, /ownerReviews:\s*agentReviews/u);
});
