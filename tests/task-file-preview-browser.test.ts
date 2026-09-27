import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createTaskBrowserClient } from "../src/web/v1/task-browser-client";
import { BrowserRequestError } from "../src/web/v1/browser-client";
import type { TaskResultMetadata } from "../src/web/v1/task-result-wire";

const text = "# Protected result\n\nSafe text only.";
const bytes = new TextEncoder().encode(text);
const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const href = "/api/v1/projects/project%3Aone/tasks/job%3Aone/files/artifact%3Aone?disposition=preview&token=signed-ticket";
const artifact: TaskResultMetadata = { artifactId: "artifact:one", attemptId: "attempt:one", runId: "run:one",
  contentHash: hash, sizeBytes: bytes.byteLength, receivedAt: "2026-09-27T12:00:00.000Z", byteCheck: "matched_recorded_claim",
  qualityAccepted: false, fileAccess: { previewHref: href, downloadHref: href.replace("preview", "download"),
    expiresAt: "2026-09-27T12:01:00.000Z" } };

test("the browser previews text only through the exact protected URL and verifies its bytes", async () => {
  const client = createTaskBrowserClient(async (url, init) => {
    assert.equal(url, href); assert.equal(init?.method, "GET"); assert.equal(init?.credentials, "same-origin");
    return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
  });
  const result = await client.resultContent("project:one", "job:one", artifact);
  assert.equal(result.text, text); assert.equal(result.artifact.runId, "run:one"); assert.equal(result.untrustedContent, true);
});

test("cross-scope URLs and oversized preview responses are refused", async () => {
  const never = async () => { throw new Error("transport must not be reached"); };
  await assert.rejects(createTaskBrowserClient(never).resultContent("project:one", "job:one", {
    ...artifact, fileAccess: { ...artifact.fileAccess!, previewHref: href.replace("project%3Aone", "project%3Aother") },
  }), (error: unknown) => error instanceof BrowserRequestError && error.code === "unavailable");
  const oversized = createTaskBrowserClient(async () => new Response(new Uint8Array(65_537),
    { headers: { "content-type": "text/plain" } }));
  await assert.rejects(oversized.resultContent("project:one", "job:one", artifact),
    (error: unknown) => error instanceof BrowserRequestError && error.code === "unavailable");
});
