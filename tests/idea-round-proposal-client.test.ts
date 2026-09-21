import assert from "node:assert/strict";
import test from "node:test";
import { createIdeaRoundProposalClient } from "../src/web/v1/idea-round-proposal-client";
import { createIdeaBrowserClient } from "../src/web/v1/idea-browser-client";
import { BrowserRequestError } from "../src/web/v1/browser-client";

const sessionId = "idea:client-round", projectId = "project:client-round";
const digest = "sha256:" + "a".repeat(64);
const receipt = {
  sessionId, sessionDigest: digest, projectId, round: 1, startsWork: false,
  receipts: ["one", "two", "three"].map((name, index) => ({
    receipt: { jobId: `job:${name}`, projectId, requestId: `request:${index}`, createdAt: "2026-09-20T00:00:00.000Z", submission: "proposed", startsWork: false },
    replayed: false,
  })),
};

test("the idea-round browser client makes one explicit task-preparation request", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const client = createIdeaRoundProposalClient(async (input, init) => {
    calls.push({ input, init });
    return Response.json(receipt, { status: 201 });
  });
  const result = await client.propose(sessionId, { sessionDigest: digest, projectId, round: 1 });
  assert.equal(result.startsWork, false);
  assert.equal(result.receipts.length, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, `/api/v1/ideas/${encodeURIComponent(sessionId)}/rounds/1/proposals`);
  assert.equal(calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { sessionDigest: digest, projectId, round: 1 });
});

test("the idea-round browser client preserves an uncertain result instead of retrying", async () => {
  let calls = 0;
  const client = createIdeaRoundProposalClient(async () => { calls++; throw new Error("offline"); });
  await assert.rejects(client.propose(sessionId, { sessionDigest: digest, projectId, round: 1 }),
    (error: unknown) => error instanceof BrowserRequestError && error.code === "uncertain");
  assert.equal(calls, 1);
});

test("the Idea browser client requests a reviewed result projection without sending evidence", async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const client = createIdeaBrowserClient(async (input, init) => {
    calls.push({ input, init });
    return Response.json({ sessionId, taskKey: "idea-task:client-projection",
      contribution: { contributionId: "contribution:client-projection", contributionDigest: digest }, replayed: false, startsWork: false }, { status: 201 });
  });
  const result = await client.projectReviewedResult(sessionId, "idea-task:client-projection");
  assert.equal(result.startsWork, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, `/api/v1/ideas/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent("idea-task:client-projection")}/contribution`);
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.body, undefined);
});
