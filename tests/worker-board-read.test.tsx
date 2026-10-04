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
    deadAssignment: null,
    recentResults: [{ projectId: "project:one", jobId: "job:done", title: "fixture.done", status: "succeeded", finishedAt: "2026-09-29T10:00:00.000Z" }] } }));
  assert.match(html, /Current task:/); assert.match(html, /fixture\.active/);
  assert.match(html, /projects\/project%3Aone\/tasks\/job%3Aactive/); assert.match(html, /Last 3 results:/);
  assert.match(html, /fixture\.done/); assert.match(html, /succeeded/);
});

test("worker card calls absent canonical records unknown rather than idle or empty", () => {
  const html = renderToStaticMarkup(createElement(WorkerBoardRow, { worker, attribution: { workerId: "node:one", currentTask: null,
    deadAssignment: null, recentResults: [] } }));
  assert.match(html, /unknown — no active assignment, lease, or attempt is recorded/);
  assert.match(html, /unknown — no terminal result is recorded/);
});

/** R7-03: a dead assignment is never presented as work in progress, and the
 * card must not claim the worker is Working on it. `deadAssignment` is
 * reported as itself: assigned, but no live lease holds it. */
test("a dead assignment is reported as an expired lease, not as the worker's current task", () => {
  const dead = { projectId: "project:one", jobId: "job:dead", title: "fixture.dead", since: "2026-09-29T10:00:00.000Z" };
  // A FRESH observation: the card reads a saved observation as stale once it is
  // older than the named telemetry lifetime, and a stale card is labelled
  // "Stale — status unknown" before any status is considered -- which would make
  // the "not Working" assertion below pass for the wrong reason.
  const online: OperatorCapacityWorkerV1 = { ...worker, state: "online", lastObservedAt: new Date().toISOString() };
  const html = renderToStaticMarkup(createElement(WorkerBoardRow, { worker: online,
    attribution: { workerId: "node:one", currentTask: null, deadAssignment: dead, recentResults: [] } }));
  assert.match(html, /Lease expired/);
  assert.match(html, /fixture\.dead/);
  assert.match(html, /no live lease holds it, so this is not work in progress/);
  // The current-task line must not offer it as the task, and the status chip
  // must not be promoted to "Working" on the strength of a dead lease.
  assert.doesNotMatch(html, /prefix="Started"/);
  assert.doesNotMatch(html, /Working/);
  assert.doesNotMatch(html, /Stale — status unknown/);
  assert.doesNotMatch(html, /unknown — no active assignment/);
  // The link still points at the real task so the owner can inspect it.
  assert.match(html, /projects\/project%3Aone\/tasks\/job%3Adead/);
});

/** A live assignment is still shown as current work, and the card still
 * promotes the worker to Working on it -- the fix must not cost that. */
test("a live assignment is still the current task and still reads as working", () => {
  const online: OperatorCapacityWorkerV1 = { ...worker, state: "online", lastObservedAt: new Date().toISOString() };
  const html = renderToStaticMarkup(createElement(WorkerBoardRow, { worker: online, attribution: { workerId: "node:one",
    currentTask: { projectId: "project:one", jobId: "job:active", title: "fixture.active", since: "2026-09-29T11:00:00.000Z" },
    deadAssignment: null, recentResults: [] } }));
  assert.match(html, /Working/);
  assert.match(html, /fixture\.active/);
  assert.doesNotMatch(html, /Lease expired/);
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
    dead_project_id: null, dead_job_id: null, dead_payload: null, dead_since: null,
    result_project_id: "project:one", result_job_id: "job:done", result_payload: validJob("project:one", "succeeded"), result_state: "succeeded", result_finished_at: "2026-09-29T10:00:00.000Z", result_rank: 1 }] as T[] }; } };
  const result = await new DatabaseWorkerBoardReadSourceV1(db as never).read({ tenantId: "tenant:one", now: "2026-09-29T12:00:00.000Z" });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0]?.values, ["tenant:one", "2026-09-29T12:00:00.000Z"]);
  assert.match(calls[0]?.sql ?? "", /LIMIT 500/); assert.match(calls[0]?.sql ?? "", /LIMIT 3/); assert.match(calls[0]?.sql ?? "", /tenant_id=\$1/);
  assert.deepEqual(result.workers[0]?.recentResults.map(item => item.status), ["succeeded"]);
  // R7-03: the live-lease condition is INSIDE the lateral that picks the
  // current attempt, not a filter applied afterwards. A lease joined after the
  // attempt was chosen cannot stop a dead attempt being chosen.
  const sql = calls[0]?.sql ?? "";
  const currentLateral = sql.slice(sql.indexOf("LEFT JOIN LATERAL"), sql.indexOf("current_job ON"));
  assert.match(currentLateral, /JOIN control_leases l ON[\s\S]*l\.state='active' AND l\.expires_at>\$2::timestamptz/,
    "the current attempt must require a live lease inside the lateral that picks it");
  // And 'since' is the LIVE lease's own acquired_at, never a fallback that
  // would read as when the work started when no lease is live.
  assert.match(sql, /current_attempt\.acquired_at AS current_since/);
  assert.doesNotMatch(sql, /COALESCE\(current_lease\.acquired_at/);
  assert.doesNotMatch(sql, /current_lease\.acquired_at AS current_since/,
    "the lease must be reached through the lateral that requires one, not re-joined afterwards");
  assert.deepEqual(result.workers[0]?.deadAssignment, null);
});

/** The dead-assignment row is read only when the wire carries one, and its job
 * payload is validated exactly as strictly as a current task's. */
test("a dead assignment is mapped from its own row and an unparsable payload fails closed", async () => {
  const dead = { projectId: "project:one", jobId: "job:dead", title: "fixture.task", since: "2026-09-29T10:00:00.000Z" };
  const base = { worker_id: "node:one", current_project_id: null, current_job_id: null, current_payload: null, current_since: null,
    result_project_id: null, result_job_id: null, result_payload: null, result_state: null, result_finished_at: null, result_rank: null,
    dead_project_id: "project:one", dead_job_id: "job:dead", dead_payload: validJob("project:one", "leased"),
    dead_since: "2026-09-29T10:00:00.000Z" };
  const read = async (row: unknown) => new DatabaseWorkerBoardReadSourceV1({ query: async () => ({ rows: [row] }) } as never)
    .read({ tenantId: "tenant:one", now: "2026-09-29T12:00:00.000Z" });
  assert.deepEqual((await read(base)).workers[0]?.deadAssignment, dead);
  // A payload that is not a job record, or belongs to another project, is a
  // failure rather than a silently dropped row.
  await assert.rejects(read({ ...base, dead_payload: { id: "job:dead" } }),
    /invalid_worker_board_record/u, "an unparsable dead-assignment payload must fail closed");
  await assert.rejects(read({ ...base, dead_payload: validJob("project:other", "leased") }),
    /invalid_worker_board_record/u, "a dead assignment from another project must fail closed");
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
