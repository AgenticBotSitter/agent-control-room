// Synthetic workspace server for the browser fixture. No React, no DOM.
// The browser entry (main.tsx) installs this as a module-scope
// `window.fetch` interceptor before the child component mounts, so the
// first render's effects cannot escape the fixture. A Node-side test
// imports the same module and drives the real product clients against
// the same server shape.
//
// Synthetic-only behaviour: every other URL falls through to a synthetic
// 503 (no network). Unknown projects are 404. The server tracks
// idempotency keys for the propose POST, replays the original receipt on
// repeat, and supports an inject-once failure for testing the
// uncertain-save reconciliation path.

import { fixtures, seedReviewStatus, type LifecycleState, type ProjectFixture, type ReviewDecision } from "./fixture-data";

export interface ServerOptions {
  // When non-null, the next POST /tasks is treated as a synthetic
  // transport cut (returns 503 with no body) so the client falls into
  // the "uncertain" path and the next retry replays the saved
  // idempotency key against a healthy server.
  cutNextPropose?: boolean;
  // Pinned timestamp used in all synthetic responses.
  now: string;
}

export interface WorkspaceServer {
  // Hooks the fixture browser installs at module scope. Returns a
  // teardown function that restores the original `window.fetch`. The
  // browser entry discards the teardown because the fixture lives only
  // for the lifetime of the page; the Node-side test does not need it.
  installWindowFetch: () => () => void;
  // Drive the same logic from a Node fetch-shaped transport.
  handle: (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => Response;
  // Direct access to internal state for the Node-side test.
  _state: ServerState;
}

export interface ServerState {
  projects: Map<string, ProjectFixture>;
  tasks: Map<string, Array<TaskRecord>>;
  results: Map<string, ResultRecord>;
  reviews: Map<string, ReviewRecord>;
  revisions: Map<string, number>;
  lifecycle: Map<string, LifecycleState>;
  idempotency: Map<string, { projectId: string; receipt: TaskReceipt; bodyHash: string }>;
  pendingCuts: { consume: () => boolean };
}

interface TaskRecord {
  jobId: string; projectId: string; title: string; instructions: string;
  status: "succeeded"; runId: string; contentHash: string; sizeBytes: number;
  createdAt: string; updatedAt: string;
}

interface ResultRecord {
  artifactId: string; jobId: string; attemptId: string; runId: string;
  contentHash: string; sizeBytes: number; text: string; receivedAt: string;
}

interface ReviewRecord {
  targetId: string; artifactId: string; jobId: string; projectId: string;
  status: ReviewDecision; feedback: string; revision: number;
  supersedesTargetId?: string; supersededBy?: string;
}

export interface TaskReceipt {
  jobId: string; projectId: string; requestId: string;
  createdAt: string;
  submission: "proposed"; startsWork: false;
}

// Deterministic 64-hex FNV-1a fallback. Real crypto.subtle is preferred
// when available (the browser fixture uses it; Node tests may not).
function fnv64(text: string): string {
  let h1 = 0xcbf29ce4, h2 = 0x84222325;
  for (const byte of new TextEncoder().encode(text)) {
    h1 ^= byte; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= byte; h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  const hex = (h: number) => h.toString(16).padStart(8, "0");
  return "sha256:" + (hex(h1) + hex(h2)).repeat(4);
}

async function digest(text: string): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return "sha256:" + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  return fnv64(text);
}

function digestSync(text: string): string {
  return fnv64(text);
}

export async function createWorkspaceServer(opts: ServerOptions): Promise<WorkspaceServer> {
  const projects = new Map<string, ProjectFixture>();
  const tasks = new Map<string, Array<TaskRecord>>();
  const results = new Map<string, ResultRecord>();
  const reviews = new Map<string, ReviewRecord>();
  const lifecycle = new Map<string, LifecycleState>();
  const idempotency = new Map<string, { projectId: string; receipt: TaskReceipt; bodyHash: string }>();
  const revisions = new Map<string, number>();
  const pendingCuts = { consume: () => { if (opts.cutNextPropose) { opts.cutNextPropose = false; return true; } return false; } };

  function projectOf(id: string): ProjectFixture | undefined {
    return projects.get(id);
  }
  function tasksFor(projectId: string): Array<TaskRecord> {
    return tasks.get(projectId) ?? [];
  }

  function seedProject(fixture: ProjectFixture): void {
    projects.set(fixture.projectId, fixture);
    lifecycle.set(fixture.projectId, "active");
    const initialText = `Synthetic task body for ${fixture.seedTask.jobId}\n\nThis is a fixture. Do not treat it as a real plan.`;
    const initialHash = digestSync(initialText);
    const rec: TaskRecord = {
      jobId: fixture.seedTask.jobId, projectId: fixture.projectId,
      title: fixture.seedTask.title, instructions: fixture.seedTask.instructions,
      status: "succeeded", runId: `run:${fixture.seedTask.jobId}`,
      contentHash: initialHash,
      sizeBytes: new TextEncoder().encode(initialText).byteLength,
      createdAt: opts.now, updatedAt: opts.now,
    };
    tasks.set(fixture.projectId, [rec]);
    const reviewId = `review:${fixture.seedTask.jobId}-r1`;
    const artifactId = `artifact:${fixture.seedTask.jobId}-r1`;
    reviews.set(reviewId, {
      targetId: reviewId, artifactId,
      jobId: fixture.seedTask.jobId, projectId: fixture.projectId,
      status: seedReviewStatus[fixture.projectId] ?? "pending",
      feedback: seedReviewStatus[fixture.projectId] === "ready"
        ? "Synthetic review: this revision matches the recorded checklist. Quality review is recorded, not approval."
        : "Synthetic review: please add a section listing the prerequisites of an interruption and how recovery differs across harnesses.",
      revision: 1,
    });
    results.set(artifactId, {
      artifactId, jobId: fixture.seedTask.jobId,
      attemptId: `attempt:${fixture.seedTask.jobId}`,
      runId: `run:${fixture.seedTask.jobId}`,
      contentHash: initialHash,
      sizeBytes: new TextEncoder().encode(initialText).byteLength,
      text: initialText, receivedAt: opts.now,
    });
    revisions.set(`${fixture.projectId}:${fixture.seedTask.jobId}`, 1);
  }

  for (const fixture of Object.values(fixtures)) seedProject(fixture);

  const fail = (status: number, code: string) => Response.json({ error: code }, { status });

  const taskPage = (projectId: string, after?: string) => {
    if (!projectOf(projectId)) return fail(404, "not_found");
    if (lifecycle.get(projectId) === "archived") return fail(409, "conflict");
    const all = tasksFor(projectId);
    const cursorIdx = after ? all.findIndex(t => t.jobId === after) : -1;
    const visible = after ? all.slice(cursorIdx + 1) : all;
    const page = visible.slice(0, 50);
    const project = projectOf(projectId)!;
    return Response.json({
      project: {
        projectId, title: project.title, summary: project.summary,
        lifecycle: lifecycle.get(projectId) ?? "active",
        version: 1, createdAt: opts.now, updatedAt: opts.now,
        origin: "ordinary", lifecycleEditable: true,
      },
      tasks: page.map(t => ({
        jobId: t.jobId, projectId: t.projectId, requestId: `request:${t.jobId}`,
        title: t.title, state: t.status, version: 2,
        createdAt: t.createdAt, updatedAt: t.updatedAt,
      })),
      nextCursor: page.length === 50 ? page.at(-1)?.jobId ?? null : null,
      canPropose: lifecycle.get(projectId) === "active",
      dispatch: "configured", observedAt: opts.now,
    });
  };

  const taskDetail = (projectId: string, jobId: string) => {
    const project = projectOf(projectId);
    if (!project) return fail(404, "not_found");
    const rec = tasksFor(projectId).find(t => t.jobId === jobId);
    if (!rec) return fail(404, "not_found");
    return Response.json({
      project: {
        projectId, title: project.title, summary: project.summary,
        lifecycle: lifecycle.get(projectId) ?? "active",
        version: 1, createdAt: opts.now, updatedAt: opts.now,
        origin: "ordinary", lifecycleEditable: true,
      },
      task: {
        jobId: rec.jobId, projectId: rec.projectId, requestId: `request:${rec.jobId}`,
        title: rec.title, state: rec.status, version: 2,
        createdAt: rec.createdAt, updatedAt: rec.updatedAt,
      },
      instructions: rec.instructions,
      inputDigest: `sha256:${"b".repeat(64)}`,
      observedAt: opts.now,
      attempts: [{
        attemptId: `attempt:${rec.jobId}`, attemptNumber: 1, state: "succeeded",
        runs: [{
          runId: rec.runId, harness: "hermes", state: "succeeded",
          lastObservedAt: opts.now, stale: false, firstObservedExecutionAt: opts.now,
          finishedObservedAt: opts.now, cancellation: "not_requested",
          source: "native_snapshot", nativeState: "completed", availability: "current",
          usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null, hardCostLimitEnforced: false },
          resultClaim: { contentHash: rec.contentHash, sizeBytes: rec.sizeBytes, verified: false },
          timeline: [{ version: 1, state: "completed", observedAt: opts.now, availability: "current" }],
          earlierObservationsOmitted: false,
        }],
        additionalRunsOmitted: false,
      }],
      earlierAttemptsOmitted: false,
      progressSource: "configured",
      dispatch: "configured", artifacts: "configured", review: "recorded",
    });
  };

  const propose = (projectId: string, body: string, idempotencyKey: string) => {
    if (!projectOf(projectId)) return fail(404, "not_found");
    if (lifecycle.get(projectId) !== "active") return fail(409, "conflict");
    if (pendingCuts.consume()) return new Response(null, { status: 503 });
    const prior = idempotency.get(idempotencyKey);
    if (prior && prior.bodyHash === digestSync(body)) {
      return Response.json({
        receipt: prior.receipt, replayed: true,
      });
    }
    let draft: { title?: unknown; instructions?: unknown };
    try { draft = JSON.parse(body); } catch { return fail(400, "invalid_request"); }
    if (typeof draft.title !== "string" || typeof draft.instructions !== "string") return fail(400, "invalid_request");
    const now = opts.now;
    const jobId = `job:${projectId.replace(/[^a-z0-9]/gi, "")}:${Date.parse(now)}:${Math.floor(Math.random() * 1e6)}`;
    const rec: TaskRecord = {
      jobId, projectId, title: draft.title, instructions: draft.instructions,
      status: "succeeded",
      runId: `run:${jobId}`, contentHash: digestSync(`Synthetic draft body for ${jobId}`),
      sizeBytes: new TextEncoder().encode(draft.instructions).byteLength,
      createdAt: now, updatedAt: now,
    };
    const list = tasksFor(projectId); list.push(rec);
    const receipt: TaskReceipt = {
      jobId, projectId, requestId: `request:${jobId}`,
      createdAt: now,
      submission: "proposed", startsWork: false,
    };
    idempotency.set(idempotencyKey, { projectId, receipt, bodyHash: digestSync(body) });
    return Response.json({
      receipt, replayed: false,
    });
  };

  const resultsPage = (projectId: string, jobId: string) => {
    if (!projectOf(projectId)) return fail(404, "not_found");
    if (!tasksFor(projectId).some(t => t.jobId === jobId)) return fail(404, "not_found");
    const revision = revisions.get(`${projectId}:${jobId}`) ?? 1;
    const result = results.get(`artifact:${jobId}-r${revision}`);
    const reviewId = `review:${jobId}-r${revision}`;
    const review = reviews.get(reviewId);
    if (!result || !review) return fail(404, "not_found");
    return Response.json({
      projectId, jobId, observedAt: opts.now,
      resultSource: "configured", reviewSource: "configured",
      items: [{
        artifactId: result.artifactId, attemptId: result.attemptId, runId: result.runId,
        contentHash: result.contentHash, sizeBytes: result.sizeBytes,
        receivedAt: result.receivedAt, byteCheck: "matched_recorded_claim",
        qualityAccepted: false,
      }],
      reviews: [{
        targetId: review.targetId, kind: "document",
        targetDigest: result.contentHash, contentHash: result.contentHash,
        revision: review.revision, supersedesTargetId: review.supersedesTargetId ?? null,
        status: review.status, matchingArtifactIds: [result.artifactId],
        additionalEvidenceOmitted: false,
        reviews: [{
          id: `decision:${review.targetId}`,
          decision: review.status === "ready" ? "accepted" : "changes_requested",
          authority: "advisory", reviewedAt: opts.now,
        }],
        verifications: [], findings: [],
        missingVerificationScenarioIds: [],
        openFindingCount: review.status === "ready" ? 0 : 1,
        grantsApproval: false, grantsExecutionAuthority: false,
      }],
      additionalResultsOmitted: false, additionalTargetsOmitted: false,
      canReadContent: true, reviewCommands: "configured", verificationCommands: "configured",
    });
  };

  const resultContent = (projectId: string, jobId: string, artifactId: string) => {
    if (!projectOf(projectId)) return fail(404, "not_found");
    const result = results.get(artifactId);
    if (!result || result.jobId !== jobId) return fail(404, "not_found");
    return Response.json({
      projectId, jobId,
      artifact: {
        artifactId: result.artifactId, attemptId: result.attemptId, runId: result.runId,
        contentHash: result.contentHash, sizeBytes: result.sizeBytes,
        receivedAt: result.receivedAt, byteCheck: "matched_recorded_claim",
        qualityAccepted: false,
      },
      text: result.text, contentVerifiedAt: opts.now, untrustedContent: true,
    });
  };

  const recordReview = (projectId: string, jobId: string, body: string) => {
    if (!projectOf(projectId)) return fail(404, "not_found");
    if (!tasksFor(projectId).some(t => t.jobId === jobId)) return fail(404, "not_found");
    let payload: { artifactId?: string; targetId?: string; decision?: string; feedback?: string };
    try { payload = JSON.parse(body); } catch { return fail(400, "invalid_request"); }
    if (!payload.targetId || !payload.artifactId) return fail(400, "invalid_request");
    const review = reviews.get(payload.targetId);
    if (!review || review.projectId !== projectId || review.jobId !== jobId) return fail(404, "not_found");
    if (payload.decision !== "accepted" && payload.decision !== "changes_requested") return fail(400, "invalid_request");
    review.status = payload.decision === "accepted" ? "ready" : "changes_requested";
    review.feedback = payload.decision === "accepted" ? "" : (payload.feedback ?? "");
    return Response.json({
      targetId: review.targetId, jobId, projectId,
      artifactId: review.artifactId, decision: review.status,
      revision: review.revision, startsWork: false,
    });
  };

  const requestRevision = (projectId: string, jobId: string, body: string) => {
    if (!projectOf(projectId)) return fail(404, "not_found");
    if (!tasksFor(projectId).some(t => t.jobId === jobId)) return fail(404, "not_found");
    let payload: { targetId?: string; instructions?: string };
    try { payload = JSON.parse(body); } catch { return fail(400, "invalid_request"); }
    if (!payload.targetId) return fail(400, "invalid_request");
    const review = reviews.get(payload.targetId);
    if (!review) return fail(404, "not_found");
    const next = review.revision + 1;
    revisions.set(`${projectId}:${jobId}`, next);
    const newText = `Revision ${next} for ${jobId}\n\n${payload.instructions ?? "No new instructions."}\n\nThis is a synthetic revision fixture.`;
    const newHash = digestSync(newText);
    const newResult: ResultRecord = {
      artifactId: `artifact:${jobId}-r${next}`,
      jobId, attemptId: `attempt:${jobId}-r${next}`, runId: `run:${jobId}-r${next}`,
      contentHash: newHash, sizeBytes: new TextEncoder().encode(newText).byteLength,
      text: newText, receivedAt: opts.now,
    };
    results.set(newResult.artifactId, newResult);
    const newReviewId = `review:${jobId}-r${next}`;
    reviews.set(newReviewId, {
      targetId: newReviewId, artifactId: newResult.artifactId,
      jobId, projectId, status: "pending",
      feedback: "Synthetic review: revision uploaded; review pending.",
      revision: next,
    });
    review.supersededBy = newReviewId;
    return Response.json({
      targetId: newReviewId, jobId, projectId,
      artifactId: newResult.artifactId, revision: next, startsWork: false,
    });
  };

  const setLifecycle = (projectId: string, body: string) => {
    if (!projectOf(projectId)) return fail(404, "not_found");
    let payload: { lifecycle?: string };
    try { payload = JSON.parse(body); } catch { return fail(400, "invalid_request"); }
    if (payload.lifecycle !== "active" && payload.lifecycle !== "archived") return fail(400, "invalid_request");
    lifecycle.set(projectId, payload.lifecycle);
    return Response.json({ projectId, lifecycle: payload.lifecycle, updatedAt: opts.now, startsWork: false });
  };

  const handle: WorkspaceServer["handle"] = (url, init) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.includes("/api/v1/") ? url.slice(url.indexOf("/api/v1/")) : "";
    const headers = new Headers(init?.headers ?? {});
    if (method === "GET") {
      const pageMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/tasks(?:\?after=(.+))?$/);
      if (pageMatch) return taskPage(decodeURIComponent(pageMatch[1]), pageMatch[2] ? decodeURIComponent(pageMatch[2]) : undefined);
      const detailMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/?]+)$/);
      if (detailMatch) return taskDetail(decodeURIComponent(detailMatch[1]), decodeURIComponent(detailMatch[2]));
      const contentMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/results\/([^/?]+)$/);
      if (contentMatch) return resultContent(decodeURIComponent(contentMatch[1]), decodeURIComponent(contentMatch[2]), decodeURIComponent(contentMatch[3]));
      const resultsMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/results$/);
      if (resultsMatch) return resultsPage(decodeURIComponent(resultsMatch[1]), decodeURIComponent(resultsMatch[2]));
      return fail(503, "synthetic_not_found");
    }
    if (method === "POST") {
      const proposeMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/tasks$/);
      if (proposeMatch) {
        const key = headers.get("idempotency-key") ?? "";
        if (!key) return fail(400, "invalid_request");
        return propose(decodeURIComponent(proposeMatch[1]), init?.body ?? "", key);
      }
      const reviewMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/reviews$/);
      if (reviewMatch) return recordReview(decodeURIComponent(reviewMatch[1]), decodeURIComponent(reviewMatch[2]), init?.body ?? "");
      const revisionMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/tasks\/([^/]+)\/revisions$/);
      if (revisionMatch) return requestRevision(decodeURIComponent(revisionMatch[1]), decodeURIComponent(revisionMatch[2]), init?.body ?? "");
      const lifecycleMatch = path.match(/^\/api\/v1\/projects\/([^/]+)\/lifecycle$/);
      if (lifecycleMatch) return setLifecycle(decodeURIComponent(lifecycleMatch[1]), init?.body ?? "");
      return fail(503, "synthetic_not_found");
    }
    return fail(503, "synthetic_not_found");
  };

  const installWindowFetch: WorkspaceServer["installWindowFetch"] = () => {
    if (typeof window === "undefined") return () => {};
    const original = window.fetch.bind(window);
    const ours = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers ?? {});
      const body = init?.body ? (typeof init.body === "string" ? init.body : "") : "";
      return Promise.resolve(handle(url, { method: init?.method, body, headers: Object.fromEntries(headers.entries()) }));
    };
    window.fetch = ours as typeof window.fetch;
    return () => { window.fetch = original; };
  };

  return {
    installWindowFetch, handle,
    _state: { projects, tasks, results, reviews, revisions, lifecycle, idempotency, pendingCuts },
  };
}
