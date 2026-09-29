import assert from "node:assert/strict";
import test from "node:test";
import { issueTaskFileAccessV1, verifyTaskFileAccessV1 } from "../src/web/v1/task-file-access";

const key = new Uint8Array(32).fill(7), now = Date.parse("2026-09-27T12:00:00.000Z");
const scope = { projectId: "project:one", jobId: "job:one", runId: "run:one", artifactId: "artifact:one",
  contentHash: `sha256:${"a".repeat(64)}`, sizeBytes: 12, disposition: "preview" as const };

test("file tickets preserve project, task, run and result provenance", () => {
  const issued = issueTaskFileAccessV1(key, scope, now);
  const claims = verifyTaskFileAccessV1(key, issued.token, scope, now + 1);
  assert.deepEqual({ projectId: claims.projectId, jobId: claims.jobId, runId: claims.runId, artifactId: claims.artifactId },
    { projectId: scope.projectId, jobId: scope.jobId, runId: scope.runId, artifactId: scope.artifactId });
  assert.equal(issued.expiresAt, "2026-09-27T12:01:00.000Z");
});

test("wrong-project, expired, changed-disposition and tampered tickets are refused", () => {
  const issued = issueTaskFileAccessV1(key, scope, now);
  for (const expected of [{ ...scope, projectId: "project:other" }, { ...scope, disposition: "download" as const }])
    assert.throws(() => verifyTaskFileAccessV1(key, issued.token, expected, now + 1), /task_file_access_refused/);
  assert.throws(() => verifyTaskFileAccessV1(key, issued.token, scope, now + 60_000), /task_file_access_refused/);
  assert.throws(() => verifyTaskFileAccessV1(key, `${issued.token}x`, scope, now + 1), /task_file_access_refused/);
});

test("oversized and arbitrary-path file claims are refused before a ticket is issued", () => {
  assert.throws(() => issueTaskFileAccessV1(key, { ...scope, sizeBytes: 65_537 }, now));
  assert.throws(() => issueTaskFileAccessV1(key, { ...scope, artifactId: "../../private" }, now));
  assert.throws(() => issueTaskFileAccessV1(key, scope, now, 300_001), /task_file_access_invalid/);
});
