import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkerBoardRow } from "../private-app/app/workers/workers-board";
import { readWorkerBoardV1 } from "../src/web/v1/worker-board-browser-client";
import { DatabaseWorkerBoardReadSourceV1 } from "../src/web/v1/worker-board-read";
import type { OperatorCapacityWorkerV1 } from "../src/web/v1/operator-capacity-browser-client";

const worker: OperatorCapacityWorkerV1 = { workerId: "node:one", platform: "macos", state: "busy",
  lastObservedAt: "2026-09-29T12:00:00.000Z", attribution: "self_reported",
  capacity: { evidence: "measured", value: { availableSlots: 0, totalSlots: 1 } }, capability: { evidence: "measured", value: "verified" } };

test("worker card links its canonical current task and shows the last three recorded results", () => {
  const html = renderToStaticMarkup(createElement(WorkerBoardRow, { worker, attribution: { workerId: "node:one",
    currentTask: { projectId: "project:one", jobId: "job:active", title: "fixture.active", since: "2026-09-29T11:00:00.000Z" },
    recentResults: [{ projectId: "project:one", jobId: "job:done", title: "fixture.done", status: "succeeded", finishedAt: "2026-09-29T10:00:00.000Z" }] } }));
  assert.match(html, /Current task:/); assert.match(html, /fixture\.active/);
  assert.match(html, /projects\/project%3Aone\/tasks\/job%3Aactive/); assert.match(html, /Last 3 results:/);
  assert.match(html, /fixture\.done/); assert.match(html, /succeeded/);
});

test("worker card calls absent canonical records unknown rather than idle or empty", () => {
  const html = renderToStaticMarkup(createElement(WorkerBoardRow, { worker, attribution: { workerId: "node:one", currentTask: null, recentResults: [] } }));
  assert.match(html, /unknown — no active assignment, lease, or attempt is recorded/);
  assert.match(html, /unknown — no terminal result is recorded/);
});

test("worker-board browser read is bounded GET-only and rejects untrusted response shapes", async () => {
  let init: RequestInit | undefined;
  const available = await readWorkerBoardV1(async (_input, options) => { init = options; return Response.json({ observedAt: "2026-09-29T12:00:00.000Z", workers: [] }); });
  assert.equal(available.state, "available"); assert.equal(init?.method, "GET"); assert.equal(init?.cache, "no-store");
  const invalid = await readWorkerBoardV1(async () => Response.json({ workers: [] }));
  assert.deepEqual(invalid, { state: "unavailable" });
});

test("worker attribution read is tenant-bound, takes one active task and caps terminal history at three", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = { query: async <T,>(sql: string, values: unknown[]) => { calls.push({ sql, values }); return { rows: [{ worker_id: "node:one",
    current_project_id: "project:one", current_job_id: "job:active", current_payload: validJob("project:one", "leased"), current_since: "2026-09-29T11:00:00.000Z",
    result_project_id: "project:one", result_job_id: "job:done", result_payload: validJob("project:one", "succeeded"), result_state: "succeeded", result_finished_at: "2026-09-29T10:00:00.000Z", result_rank: 1 }] as T[] }; } };
  const result = await new DatabaseWorkerBoardReadSourceV1(db as never).read({ tenantId: "tenant:one", now: "2026-09-29T12:00:00.000Z" });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0]?.values, ["tenant:one", "2026-09-29T12:00:00.000Z"]);
  assert.match(calls[0]?.sql ?? "", /LIMIT 500/); assert.match(calls[0]?.sql ?? "", /LIMIT 3/); assert.match(calls[0]?.sql ?? "", /tenant_id=\$1/);
  assert.deepEqual(result.workers[0]?.recentResults.map(item => item.status), ["succeeded"]);
});

function validJob(projectId: string, state: "leased" | "succeeded") {
  return { id: "job:fixture", kind: "job", tenantId: "tenant:one", contractVersion: "control-room-domain/v1", workflowId: "workflow:one", projectId,
    jobType: "fixture.task", specVersion: "1.0.0", inputDigest: `sha256:${"a".repeat(64)}`, state, version: 1, createdAt: "2026-09-29T10:00:00.000Z",
    updatedAt: "2026-09-29T10:00:00.000Z", priority: 1, requiredCapability: "fixture", dependsOnJobIds: [],
    authority: { projectId, allowedExecutor: "adapter:one", allowedOperations: ["execute"], credentialRefs: [], filesystemRoots: [], networkPolicy: "none",
      allowedNetworkDestinations: [], effectPolicy: "preauthorized", maxRisk: "low", maxDurationSeconds: 60, maxConcurrentEffects: 1,
      expiresAt: "2026-09-30T10:00:00.000Z", digest: `sha256:${"b".repeat(64)}` },
    retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false, ambiguousEffectPolicy: "attention" } };
}
