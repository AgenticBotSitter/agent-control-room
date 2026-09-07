import assert from "node:assert/strict";
import test from "node:test";
import { createIdeaSynthesisClient } from "../src/web/v1/idea-synthesis-client";
import { sha256Digest } from "../src/security";

const sessionId = "idea:recap-client", value = { runId: "idea-run:recap-client", sessionDigest: sha256Digest("session") };
const receipt = { sessionId, ...value, synthesisDigest: sha256Digest("recap"), startsWork: false, replayed: false };
test("recap client validates exact saved receipt and never automatically retries unknown responses", async () => {
  for (const response of [null, { ...receipt, runId: "idea-run:other" }, { ...receipt, sessionId: "idea:other" },
    { ...receipt, sessionDigest: sha256Digest("other") }, { ...receipt, startsWork: true }]) {
    let requests = 0;
    const client = createIdeaSynthesisClient(async () => { requests++; if (!response) throw new Error("lost"); return Response.json(response); });
    await assert.rejects(client.synthesize(sessionId, value), /uncertain/); assert.equal(requests, 1);
  }
});
test("recap client holds overlapping calls, rejects supplied content, and uses private request settings", async () => {
  let release!: () => void, requests = 0; const wait = new Promise<void>(resolve => { release = resolve; });
  const client = createIdeaSynthesisClient(async (url, options) => {
    requests++; assert.equal(String(url), `/api/v1/ideas/${encodeURIComponent(sessionId)}/synthesis`);
    assert.equal(options?.redirect, "error"); assert.equal(options?.credentials, "same-origin");
    assert.deepEqual(JSON.parse(String(options?.body)), value); await wait; return Response.json(receipt);
  });
  await assert.rejects(client.synthesize(sessionId, { ...value, executiveSummary: "injected" }), /invalid_request/);
  const first = client.synthesize(sessionId, value);
  await assert.rejects(client.synthesize(sessionId, value), /uncertain/); assert.equal(requests, 1); release();
  assert.deepEqual(await first, receipt);
});
