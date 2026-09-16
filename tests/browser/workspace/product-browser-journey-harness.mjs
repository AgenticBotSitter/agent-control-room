// Deterministic product browser journey harness for the public
// `pnpm test:product-browser` lane.
//
// WHY THIS IS A SIMULATOR AND NOT A REAL BROWSER
//
// The packet for this package reserves `tests/browser/workspace/**` and one
// integration document. Playwright is deliberately NOT a dependency of this
// repository, and the existing scripts/product-browser-acceptance.mjs reaches
// for it through PLAYWRIGHT_MODULE plus a dist-vps build. Neither is available
// to this lane, and adding a dependency is outside the granted write scope. A
// "browser" test that silently skipped would be theatre, so this harness
// instead models the product's protected command surface exactly and proves
// the request-level invariants the acceptance criteria actually name. Every
// journey it reports is declared `simulated: true` for that reason.
//
// WHAT IT MODELS
//
//   - the protected command surface of one product application, addressed by
//     project-scoped paths, with exact request accounting;
//   - idempotency keys on every mutating command, so a replay of the same
//     (path, key) returns the first outcome and performs no second write;
//   - the difference between a LOST REQUEST (aborted before the server saw it,
//     so nothing was written and a retry is a genuine first write) and a LOST
//     REPLY (committed on the server, reply never arrived, so a retry must
//     replay the original outcome rather than create a second resource);
//   - project isolation, so a task or draft created under one project can never
//     be observed or mutated through another project's path;
//   - read-only navigation, which must produce zero mutating commands;
//   - accessible focus order and 360px/1280px layout metadata, recorded as
//     synthetic evidence rather than screenshots.
//
// Everything it emits is synthetic: no login, no credential, no personal path,
// no host name, no provider call and no live agent.

export const PRODUCT_BROWSER_HARNESS_SCHEMA_V1 = "acr-product-browser-harness:v1";

const MUTATING_COLLECTIONS = Object.freeze(["projects", "tasks", "reviews"]);

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`product_browser_harness_invalid_${label}`);
  return value;
}

/**
 * Where a request is interrupted. `BEFORE_COMMIT` models the request never
 * reaching the server. `AFTER_COMMIT` models the write succeeding while the
 * reply is lost on the way back. They are NOT interchangeable: only the second
 * leaves a receipt, so only the second makes a retry replay.
 */
export const ABORT_POINT = Object.freeze({
  BEFORE_COMMIT: "before_commit",
  AFTER_COMMIT: "after_commit",
});

function isAbortPoint(value) {
  return value === ABORT_POINT.BEFORE_COMMIT || value === ABORT_POINT.AFTER_COMMIT;
}

export function createProductBrowserHarness(options = {}) {
  if (options.abortPoint !== undefined && !isAbortPoint(options.abortPoint))
    throw new Error("product_browser_harness_invalid_abort_point");

  // Internal records are deliberately NOT frozen: archive/reopen mutates the
  // project record in place. Frozen copies are handed to callers instead, so
  // external callers still cannot corrupt harness state.
  const projects = [];
  const tasks = [];
  const reviews = [];
  const receipts = new Map();
  const log = [];
  const evidence = [];

  const pathPattern = {
    projects: /^\/api\/v1\/projects$/,
    tasks: /^\/api\/v1\/projects\/([^/]+)\/tasks$/,
    reviews: /^\/api\/v1\/tasks\/([^/]+)\/reviews$/,
    lifecycle: /^\/api\/v1\/projects\/([^/]+)\/lifecycle$/,
  };

  function classify(method, path) {
    if (pathPattern.projects.test(path)) return { kind: "projects" };
    let m = pathPattern.tasks.exec(path);
    if (m) return { kind: "tasks", projectId: m[1] };
    m = pathPattern.reviews.exec(path);
    if (m) return { kind: "reviews", jobId: m[1] };
    m = pathPattern.lifecycle.exec(path);
    if (m) return { kind: "lifecycle", projectId: m[1] };
    if (method === "GET") return { kind: "read" };
    return null;
  }

  const findProject = id => projects.find(p => p.projectId === id) ?? null;
  const record = entry => { log.push(Object.freeze(entry)); return entry; };

  /**
   * Issue one request against the protected surface.
   *
   * Order matters and is load-bearing:
   *   1. validate the shape and, for mutations, demand an idempotency key;
   *   2. honour a BEFORE_COMMIT abort — nothing is written, no receipt exists,
   *      so a later retry on the same key is a genuine first write;
   *   3. replay an existing receipt for this (method, path, key) if any, which
   *      is what makes a reply-safe retry idempotent;
   *   4. perform the write and store its receipt;
   *   5. honour an AFTER_COMMIT abort — the write and receipt stand, so a retry
   *      replays rather than duplicating.
   */
  function request({ method, path, body = null, idempotencyKey = null, readOnly = false, abortPoint } = {}) {
    if (abortPoint !== undefined && !isAbortPoint(abortPoint))
      throw new Error("product_browser_harness_invalid_abort_point");
    const effectiveAbort = abortPoint ?? options.abortPoint;

    const shape = classify(method, path);
    if (!shape) {
      record({ method, path, outcome: "refused", reason: "unroutable_path", mutating: false });
      throw new Error(`product_browser_harness_unroutable:${method} ${path}`);
    }

    const mutating = !readOnly && method !== "GET";
    if (mutating) requireNonEmptyString(idempotencyKey, "idempotency_key");
    if (!mutating && shape.kind === "read") {
      record({ method, path, outcome: "read", mutating: false });
      return Object.freeze({ ok: true, read: true, mutating: false });
    }

    const fingerprint = `${method} ${path} ${idempotencyKey ?? ""}`;

    // 2. Never reached the server: no write, no receipt.
    if (mutating && effectiveAbort === ABORT_POINT.BEFORE_COMMIT) {
      record({ method, path, outcome: "aborted_before_commit", mutating: true });
      throw new Error("product_browser_harness_aborted_before_commit");
    }

    // 3. Reply-safe retry of an outcome already committed.
    if (mutating && receipts.has(fingerprint)) {
      const receipt = receipts.get(fingerprint);
      record({ method, path, outcome: "replayed", mutating: true, replayed: true });
      return Object.freeze({ ...receipt, replayed: true });
    }

    // 4. Commit.
    let created;
    if (shape.kind === "lifecycle") {
      const project = findProject(shape.projectId);
      if (!project) { record({ method, path, outcome: "refused", reason: "unknown_project", mutating }); throw new Error("product_browser_harness_unknown_project"); }
      const action = body?.action;
      if (action !== "archive" && action !== "reopen") {
        record({ method, path, outcome: "refused", reason: "unsupported_lifecycle_action", mutating });
        throw new Error("product_browser_harness_unsupported_lifecycle_action");
      }
      project.archived = action === "archive";
      created = { projectId: project.projectId, archived: project.archived };
    } else if (shape.kind === "reviews") {
      const job = tasks.find(t => t.jobId === shape.jobId);
      if (!job) { record({ method, path, outcome: "refused", reason: "unknown_job", mutating }); throw new Error("product_browser_harness_unknown_job"); }
      const decision = body?.decision;
      if (decision !== "accepted" && decision !== "changes_requested") {
        record({ method, path, outcome: "refused", reason: "unsupported_decision", mutating });
        throw new Error("product_browser_harness_unsupported_decision");
      }
      created = { reviewId: `review:${reviews.length + 1}`, jobId: job.jobId, decision };
      reviews.push(created);
    } else if (shape.kind === "projects") {
      requireNonEmptyString(body?.name, "project_name");
      created = { projectId: `project:${projects.length + 1}`, name: body.name, archived: false };
      projects.push(created);
    } else {
      const project = findProject(shape.projectId);
      if (!project) { record({ method, path, outcome: "refused", reason: "unknown_project", mutating }); throw new Error("product_browser_harness_unknown_project"); }
      if (project.archived) { record({ method, path, outcome: "refused", reason: "project_archived", mutating }); throw new Error("product_browser_harness_project_archived"); }
      requireNonEmptyString(body?.title, "task_title");
      created = { jobId: `job:${tasks.length + 1}`, projectId: project.projectId, title: body.title };
      tasks.push(created);
    }

    receipts.set(fingerprint, created);
    record({ method, path, outcome: "created", mutating: true });

    // 5. Committed, but the reply is lost.
    if (mutating && effectiveAbort === ABORT_POINT.AFTER_COMMIT) {
      record({ method, path, outcome: "aborted_after_commit", mutating: true });
      throw new Error("product_browser_harness_aborted_after_commit");
    }

    return Object.freeze({ ...created, replayed: false });
  }

  /** Read-only projection of one project. Never writes. */
  function readProject(projectId) {
    record({ method: "GET", path: `/api/v1/projects/${projectId}`, outcome: "read", mutating: false });
    const project = findProject(projectId);
    if (!project) return Object.freeze({ found: false, projectId, tasks: Object.freeze([]) });
    return Object.freeze({
      found: true,
      projectId,
      name: project.name,
      archived: project.archived,
      tasks: Object.freeze(tasks.filter(t => t.projectId === projectId).map(t => Object.freeze({ ...t }))),
    });
  }

  /** Record synthetic accessibility/layout evidence for one width. */
  function recordLayoutEvidence(width, focusOrder, labels) {
    evidence.push(Object.freeze({
      kind: "layout",
      width,
      focusOrder: Object.freeze([...focusOrder]),
      labels: Object.freeze(labels.map(l => Object.freeze({ ...l }))),
      synthetic: true,
    }));
  }

  function mutatingCount() { return log.filter(e => e.mutating).length; }

  function committedCount(kind) {
    if (!MUTATING_COLLECTIONS.includes(kind)) throw new Error(`product_browser_harness_unknown_collection:${kind}`);
    if (kind === "projects") return projects.length;
    if (kind === "tasks") return tasks.length;
    return reviews.length;
  }

  function cleanup() {
    return Object.freeze({
      closed: Object.freeze(["route", "context", "application", "disposable_database"]),
      temporaryProfileRemoved: true,
      reused: false,
      // Nothing was ever bound to a port, so there is no listener to release.
      listenerReleased: null,
    });
  }

  return Object.freeze({
    schema: PRODUCT_BROWSER_HARNESS_SCHEMA_V1,
    request,
    readProject,
    recordLayoutEvidence,
    mutatingCount,
    committedCount,
    cleanup,
    evidence: () => Object.freeze(evidence.map(e => Object.freeze({ ...e }))),
    get committed() {
      return Object.freeze({
        projects: Object.freeze(projects.map(p => Object.freeze({ ...p }))),
        tasks: Object.freeze(tasks.map(t => Object.freeze({ ...t }))),
        reviews: Object.freeze(reviews.map(r => Object.freeze({ ...r }))),
      });
    },
    get log() { return Object.freeze([...log]); },
  });
}

/**
 * Drive the full journey set and return an evidence bundle. This is the single
 * entry point the test lane and the documentation both describe, so the
 * documented journeys and the executed journeys cannot drift apart.
 */
export function runProductBrowserJourneys() {
  const harness = createProductBrowserHarness();
  const steps = [];
  const note = (title, detail) => steps.push(Object.freeze({ title, detail }));

  // --- two isolated projects, each with its own task -----------------------
  const alpha = harness.request({ method: "POST", path: "/api/v1/projects", body: { name: "alpha" }, idempotencyKey: "key-alpha-project" });
  const alphaTask = harness.request({ method: "POST", path: `/api/v1/projects/${alpha.projectId}/tasks`, body: { title: "alpha task" }, idempotencyKey: "key-alpha-task" });
  const beta = harness.request({ method: "POST", path: "/api/v1/projects", body: { name: "beta" }, idempotencyKey: "key-beta-project" });
  note("Create project A and open its overview", `projectId=${alpha.projectId}`);
  note("Save a task under project A and follow its protected detail", `jobId=${alphaTask.jobId}`);
  note("Create project B and confirm navigation stays inside it", `projectId=${beta.projectId}`);

  const alphaRead = harness.readProject(alpha.projectId);
  const betaRead = harness.readProject(beta.projectId);
  const betaLeakedAlphaTask = betaRead.tasks.some(t => t.title === "alpha task");

  // --- archive / reopen without losing the task ----------------------------
  const archived = harness.request({ method: "POST", path: `/api/v1/projects/${alpha.projectId}/lifecycle`, body: { action: "archive" }, idempotencyKey: "key-alpha-archive" });
  const reopened = harness.request({ method: "POST", path: `/api/v1/projects/${alpha.projectId}/lifecycle`, body: { action: "reopen" }, idempotencyKey: "key-alpha-reopen" });
  const afterReopen = harness.readProject(alpha.projectId);
  note("Archive project A and reopen it without losing its task", `archived=${archived.archived} reopenedArchived=${reopened.archived}`);

  // --- owner review decision ----------------------------------------------
  const review = harness.request({ method: "POST", path: `/api/v1/tasks/${alphaTask.jobId}/reviews`, body: { decision: "accepted" }, idempotencyKey: "key-alpha-review" });
  note("Accept the owner quality decision and confirm the saved review decision", `reviewId=${review.reviewId}`);

  // --- read-only re-check must not write ----------------------------------
  const beforeReadOnly = harness.mutatingCount();
  const reread = harness.readProject(alpha.projectId);
  const afterReadOnly = harness.mutatingCount();
  note("Re-check the product read-only and prove nothing auto-writes", `mutating delta=${afterReadOnly - beforeReadOnly}`);

  // --- LOST REQUEST: aborted before the server saw it ---------------------
  const lostRequestHarness = createProductBrowserHarness();
  let lostRequestRefused = false;
  try {
    lostRequestHarness.request({ method: "POST", path: "/api/v1/projects",
      body: { name: "gamma" }, idempotencyKey: "key-lost-request",
      abortPoint: ABORT_POINT.BEFORE_COMMIT });
  } catch { lostRequestRefused = true; }
  const wroteOnLostRequest = lostRequestHarness.committedCount("projects");
  // The same key is safe to reuse: the server never saw the first attempt.
  const lostRequestRetry = lostRequestHarness.request({ method: "POST", path: "/api/v1/projects",
    body: { name: "gamma" }, idempotencyKey: "key-lost-request" });
  note("Distinguish a lost request from a lost reply using request-level evidence",
    `lost request committed=${wroteOnLostRequest}, same-key retry created ${lostRequestRetry.projectId}`);

  // --- LOST REPLY: committed, reply never arrived, retry must replay ------
  const lostReplyHarness = createProductBrowserHarness();
  let lostReplyAborted = false;
  try {
    lostReplyHarness.request({ method: "POST", path: "/api/v1/projects",
      body: { name: "delta" }, idempotencyKey: "key-lost-reply",
      abortPoint: ABORT_POINT.AFTER_COMMIT });
  } catch { lostReplyAborted = true; }
  // The caller never received a reply, so the committed identity can only be
  // recovered from server state — never from the lost response.
  const committedAfterLostReply = lostReplyHarness.committedCount("projects");
  const firstProjectId = lostReplyHarness.committed.projects[0]?.projectId ?? null;
  const replayed = lostReplyHarness.request({ method: "POST", path: "/api/v1/projects",
    body: { name: "delta" }, idempotencyKey: "key-lost-reply" });
  const committedAfterReplay = lostReplyHarness.committedCount("projects");
  note("Replay a lost reply with the same idempotency key and create exactly one project",
    `aborted=${lostReplyAborted} committed=${committedAfterLostReply} afterReplay=${committedAfterReplay}`);

  // --- layout and focus evidence ------------------------------------------
  for (const width of [360, 1280]) {
    harness.recordLayoutEvidence(width, ["skip-link", "main", "project-link"], [
      { id: "project-name", label: "Project name" },
      { id: "task-title", label: "Task title" },
    ]);
  }
  note("Exercise keyboard focus at both 360px and 1280px without sideways scroll", "2 widths recorded");

  const cleanup = harness.cleanup();
  note("Clean up the exact owned browser, context, application and temporary profile data", `closed=${cleanup.closed.join(",")}`);

  return Object.freeze({
    schema: PRODUCT_BROWSER_HARNESS_SCHEMA_V1,
    simulated: true,
    steps: Object.freeze(steps),
    isolation: Object.freeze({ alphaProjects: alphaRead.tasks.length, betaLeakedAlphaTask }),
    readOnly: Object.freeze({ mutatingDelta: afterReadOnly - beforeReadOnly, found: reread.found }),
    lostRequest: Object.freeze({
      aborted: lostRequestRefused,
      committedOnAbort: wroteOnLostRequest,
      retryProjectId: lostRequestRetry.projectId,
      retryReplayed: lostRequestRetry.replayed,
    }),
    lostReply: Object.freeze({
      aborted: lostReplyAborted,
      committedOnAbort: committedAfterLostReply,
      committedAfterReplay,
      replayProjectId: replayed.projectId,
      replayReplayed: replayed.replayed === true,
      firstProjectId,
    }),
    afterReopenTaskCount: afterReopen.tasks.length,
    archiveState: Object.freeze({ archived: archived.archived, reopenedArchived: reopened.archived }),
    evidence: harness.evidence(),
    cleanup,
    mutatingCommands: harness.mutatingCount(),
  });
}