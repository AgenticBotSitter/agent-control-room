// Read-only admission predicates shared by the discovery/health scripts.
// The implementations below mirror the controller's exact pre-reservation
// predicates (same order, same refusal vocabulary, same error codes) so
// reports classify offers exactly as the controller would admit them.
// Per-worker fit (pair/capacity) stays in the controller; reports surface
// those dimensions as explicit unknown markers instead of implying fit
// from global admission. Scope locks are supplied by callers from the
// controller's verified Working/In-review lock reader.
//
// The module performs ONLY HTTP GETs. It never POSTs, never mutates labels or
// comments, and never creates an assignment.

const MARKER_V2 = "<!-- agent-control-room-claim:v2";
const MARKER_V3 = "<!-- agent-control-room-claim:v3";
const CONTROLLER = comment => comment?.user?.login === "github-actions[bot]" && comment?.user?.type === "Bot";

const labelNames = issue => (Array.isArray(issue?.labels) ? issue.labels.map(label =>
  typeof label === "string" ? label : label?.name).filter(label => typeof label === "string") : []);

/** Exact controller Ready predicate: open, not a PR, exactly one status label, and it is ready. */
export function isReady(issue) {
  const statuses = labelNames(issue).filter(label => label.startsWith("status:"));
  return issue?.state === "open" && !issue?.pull_request && statuses.length === 1 && statuses[0] === "status:ready";
}

/**
 * Exact controller accepted-history predicate: the latest controller record wins.
 * An ACCEPTED/RENEWED marker (v2 or v3, bound to this issue) means live unless a
 * later RELEASED/EXPIRED record for the same issue clears it.
 */
export function liveAcceptedHistory(comments, issueNumber) {
  let latest = 0;
  let live = false;
  for (const comment of (Array.isArray(comments) ? comments : [])) {
    if (comment?.user?.login !== "github-actions[bot]" || comment?.user?.type !== "Bot"
      || typeof comment.body !== "string" || !Number.isSafeInteger(comment?.id)) continue;
    const clearing = (comment.body.startsWith("CLAIM RELEASED —") || comment.body.startsWith("CLAIM EXPIRED —"))
      && comment.body.includes(`issue=${issueNumber} `);
    const accepting = (comment.body.startsWith("CLAIM ACCEPTED —") || comment.body.startsWith("CLAIM RENEWED —"))
      && (comment.body.includes(`${MARKER_V2} issue=${issueNumber} `)
        || comment.body.includes(`${MARKER_V3} issue=${issueNumber} `));
    if ((clearing || accepting) && comment.id > latest) {
      latest = comment.id;
      live = accepting;
    }
  }
  return live;
}

/** Bounded paginated comment read. Mirrors the controller's commentsFor: 10 pages max, hard error on shape violation. */
async function fetchCommentsPaged(api, repository, issueNumber) {
  const comments = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api.request("GET", `/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("claim_controller_api_invalid");
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new Error("claim_controller_comment_history_ambiguous");
}

/**
 * Exact controller pair predicate: scans open Working issues (bounded pagination)
 * for a live CLAIM ACCEPTED marker bound to this actor+worker pair.
 */
export async function activePairExists(api, repository, value, excludeIssue) {
  for (let page = 1; page <= 10; page++) {
    const issues = await api.request("GET", `/repos/${repository}/issues?state=open&labels=status%3Aworking&per_page=100&page=${page}`);
    if (!Array.isArray(issues)) throw new Error("claim_controller_api_invalid");
    for (const issue of issues) {
      if (issue?.pull_request || !Number.isSafeInteger(issue?.number) || issue.number === excludeIssue) continue;
      const pair = ` actor=${value.actor} worker=${value.workerId} `;
      if ((await fetchCommentsPaged(api, repository, issue.number)).some(comment => comment?.user?.login === "github-actions[bot]"
        && comment?.user?.type === "Bot" && typeof comment.body === "string"
        && comment.body.startsWith("CLAIM ACCEPTED —")
        && (comment.body.includes(MARKER_V2) || comment.body.includes(MARKER_V3))
        && comment.body.includes(pair))) return true;
    }
    if (issues.length < 100) return false;
  }
  throw new Error("claim_controller_working_set_ambiguous");
}

/**
 * Set-membership dependency pre-check used only when no API is available.
 * A dependency is COMPLETE only per dependencyIssueComplete below; absence from
 * an open-issue set is a necessary but not sufficient signal.
 */
export function dependenciesComplete({ packet, openNumbers }) {
  if (!packet || !Array.isArray(packet.dependencies)) return false;
  const open = openNumbers instanceof Set ? openNumbers : new Set(openNumbers ?? []);
  return packet.dependencies.every(number => !open.has(number));
}

/**
 * Exact controller dependency predicate: a dependency is complete only when the
 * issue fetches cleanly, is not a PR, is closed, was not not_planned, and carries
 * status:done. Never infer completion from set absence alone.
 */
export async function dependencyIssueComplete({ api, repository, number }) {
  if (!api || typeof api.request !== "function" || typeof repository !== "string"
    || !Number.isSafeInteger(number)) return false;
  const issue = await api.request("GET", `/repos/${repository}/issues/${number}`);
  if (!issue || issue.pull_request || issue.state !== "closed") return false;
  if (issue.state_reason === "not_planned") return false;
  if (!labelNames(issue).includes("status:done")) return false;
  return true;
}

export async function dependenciesCompleteDetailed({ api, repository, packet }) {
  if (!packet || !Array.isArray(packet.dependencies)) return false;
  for (const dep of packet.dependencies) {
    if (!(await dependencyIssueComplete({ api, repository, number: dep }))) return false;
  }
  return true;
}

function scopesOverlap(own, other) {
  if (typeof own !== "string" || typeof other !== "string") return false;
  const ownPrefix = own.endsWith("/**") ? own.slice(0, -3) : own;
  const otherPrefix = other.endsWith("/**") ? other.slice(0, -3) : other;
  return ownPrefix === otherPrefix
    || (own.endsWith("/**") && other.startsWith(ownPrefix + "/"))
    || (other.endsWith("/**") && own.startsWith(otherPrefix + "/"));
}

/**
 * Global admission verdict for one Ready issue, in the controller's gate order:
 * ready → accepted-history → packet → effects → dependencies → scope → base.
 * Pair/capacity/locks are per-worker fit and are NOT decided here; when the
 * caller cannot supply them they are returned as explicit unknown markers so no
 * report can present global admission as proof of fit.
 */
export async function evaluateAdmissionDecision({
  issue, comments = [], api, repository, openNumbers, packet, baseSha,
  knownLocks, observedAt = new Date().toISOString(),
}) {
  const base = { observedAt, observedBase: typeof baseSha === "string" ? baseSha : "" };
  const unknownFit = { capacity: "unknown", pair: "unknown", locks: knownLocks === undefined ? "unknown" : "checked" };
  if (!issue || !Number.isSafeInteger(issue?.number)) {
    return Object.freeze({ outcome: "refuse", reason: "issue_unknown", ...base, ...unknownFit });
  }
  if (!isReady(issue)) {
    return Object.freeze({ outcome: "refuse", reason: "issue_not_ready", issue: issue.number, ...base, ...unknownFit });
  }
  if (liveAcceptedHistory(comments, issue.number)) {
    return Object.freeze({ outcome: "refuse", reason: "accepted_history_requires_release", issue: issue.number, ...base, ...unknownFit });
  }
  if (!packet) {
    return Object.freeze({ outcome: "refuse", reason: "packet_invalid", issue: issue.number, ...base, ...unknownFit });
  }
  if (packet.effects !== "none") {
    return Object.freeze({ outcome: "refuse", reason: "packet_effectful", issue: issue.number, ...base, ...unknownFit });
  }
  const depsOk = (api && typeof api.request === "function" && typeof repository === "string")
    ? await dependenciesCompleteDetailed({ api, repository, packet })
    : dependenciesComplete({ packet, openNumbers });
  if (!depsOk) {
    return Object.freeze({ outcome: "refuse", reason: "dependencies_incomplete", issue: issue.number, ...base, ...unknownFit });
  }
  if (knownLocks !== undefined) {
    const locks = Array.isArray(knownLocks) ? knownLocks : [];
    if (locks.some(scope => (packet.writeScopes ?? []).some(own => scopesOverlap(own, scope)))) {
      return Object.freeze({ outcome: "refuse", reason: "scope_overlap", issue: issue.number, ...base, ...unknownFit });
    }
  }
  if (typeof baseSha !== "string" || !/^[a-f0-9]{40}$/.test(baseSha)) {
    return Object.freeze({ outcome: "refuse", reason: "base_unknown", issue: issue.number, ...base, ...unknownFit });
  }
  if (packet.base !== baseSha) {
    return Object.freeze({ outcome: "refuse", reason: "packet_base_stale", issue: issue.number, ...base, packetBase: packet.base, ...unknownFit });
  }
  return Object.freeze({ outcome: "admit", issue: issue.number, ...base, globalOnly: true, packet, ...unknownFit });
}

/** Bounded observation helper: returns the current `main` SHA. Throws on missing base. */
export async function observeMainBase({ api, repository, observedAt = new Date().toISOString() }) {
  if (!api || typeof api.request !== "function" || typeof repository !== "string") {
    throw new Error("admission_evaluator_observation_invalid");
  }
  const ref = await api.request("GET", `/repos/${repository}/git/ref/heads/main`);
  const sha = ref?.object?.sha;
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error("admission_evaluator_base_unavailable");
  }
  return Object.freeze({ baseSha: sha, observedAt });
}

export const __test = Object.freeze({ scopesOverlap, labelNames, MARKER_V2, MARKER_V3, CONTROLLER });
