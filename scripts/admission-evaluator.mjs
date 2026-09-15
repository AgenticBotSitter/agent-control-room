// Read-only admission evaluator used by the controller and discovery/health scripts.
//
// Extracted from the controller's pre-reservation gates so the same decision ordering
// (issue status, packet validity, effects, dependencies, capacity, locks, scope, base)
// is applied wherever a "Ready" offer is reported. This module performs ONLY HTTP GETs
// (one to /repos/.../git/ref/heads/main and the caller's pre-fetched issues/comments);
// it never POSTs, never mutates labels or comments, and never creates an assignment.
//
// Every caller must supply the same observation window that the controller would have
// at the same instant. The evaluator returns the observation time/base so callers can
// surface them and stay bounded; incomplete observations are reported as errors, never
// as empty results.
//
// The evaluator separates global offer validity (packet, dependencies, base, locks)
// from per-worker fit (active pair, capacity). Discovery uses global validity; the
// controller also applies per-worker fit before accepting a claim.

const ACCEPTED_HISTORY_PATTERN = /<!--\s*agent-control-room-claim:v3\s+issue=(\d+)\s+request=(\d+)\s+actor=(\S+)\s+worker=(\S+)\s+packet=([a-f0-9]{64})\s+accepted=(\d+)/;
const CONTROLLER = comment => comment?.user?.login === "github-actions[bot]" && comment?.user?.type === "Bot";

function isReady(issue) {
  const labels = Array.isArray(issue?.labels) ? issue.labels.map(label => typeof label === "string" ? label : label?.name).filter(label => typeof label === "string") : [];
  const statuses = labels.filter(label => label.startsWith("status:"));
  return statuses.length === 1 && statuses[0] === "status:ready";
}

/** Whether the issue already has a live accepted-claim marker that has not been released. */
export function liveAcceptedHistory(comments, issueNumber) {
  if (!Array.isArray(comments)) return false;
  for (const comment of comments) {
    if (!CONTROLLER(comment) || typeof comment.body !== "string") continue;
    const accepted = /^(CLAIM ACCEPTED|CLAIM RENEWED) —/.test(comment.body);
    const cleared = /^(CLAIM RELEASED|CLAIM EXPIRED) —/.test(comment.body)
      && comment.body.includes(`issue=${issueNumber} `);
    if (cleared) continue;
    if (accepted && comment.body.includes(`issue=${issueNumber} `)) return true;
  }
  return false;
}

function scopesOverlap(own, other) {
  if (typeof own !== "string" || typeof other !== "string") return false;
  const ownPrefix = own.endsWith("/**") ? own.slice(0, -3) : own;
  const otherPrefix = other.endsWith("/**") ? other.slice(0, -3) : other;
  return ownPrefix === otherPrefix
    || (own.endsWith("/**") && other.startsWith(ownPrefix + "/"))
    || (other.endsWith("/**") && own.startsWith(otherPrefix + "/"));
}

/** Whether the actor-and-worker pair holds an active (unreleased) reservation. */
export async function activePairExists({ api, repository, actor, workerId, issues }) {
  if (!api || typeof api.request !== "function" || typeof repository !== "string"
    || typeof actor !== "string" || typeof workerId !== "string") return false;
  for (const issue of (issues ?? [])) {
    if (!Number.isSafeInteger(issue?.number) || issue.pull_request) continue;
    let comments;
    try { comments = await api.request("GET", `/repos/${repository}/issues/${issue.number}/comments?per_page=100`); }
    catch { continue; }
    if (!Array.isArray(comments)) continue;
    for (const comment of comments) {
      if (!CONTROLLER(comment) || typeof comment.body !== "string") continue;
      const match = ACCEPTED_HISTORY_PATTERN.exec(comment.body);
      if (!match) continue;
      const cleared = /^(CLAIM RELEASED|CLAIM EXPIRED) —/.test(comment.body);
      if (cleared) continue;
      if (Number(match[1]) !== issue.number) continue;
      if (match[3] === actor && match[4] === workerId) return true;
    }
  }
  return false;
}

/** Whether every declared dependency issue is closed (i.e. not in `issues?` as open). */
export function dependenciesComplete({ packet, openNumbers }) {
  if (!packet || !Array.isArray(packet.dependencies)) return false;
  const open = openNumbers instanceof Set ? openNumbers : new Set(openNumbers ?? []);
  return packet.dependencies.every(number => !open.has(number));
}

/**
 * Whether every declared dependency issue is closed, done and not not_planned.
 * Equivalent to the controller's previous `dependenciesComplete(api, repository, packet)`:
 * a dependency is complete only when the issue is fetched, not a PR, `state === "closed"`,
 * `state_reason !== "not_planned"`, and labelled `status:done`.
 */
export async function dependencyIssueComplete({ api, repository, number }) {
  if (!api || typeof api.request !== "function" || typeof repository !== "string"
    || !Number.isSafeInteger(number)) return false;
  const issue = await api.request("GET", `/repos/${repository}/issues/${number}`);
  if (!issue || issue.pull_request || issue.state !== "closed") return false;
  if (issue.state_reason === "not_planned") return false;
  const labels = (Array.isArray(issue?.labels) ? issue.labels : [])
    .map(label => typeof label === "string" ? label : label?.name)
    .filter(label => typeof label === "string");
  if (!labels.includes("status:done")) return false;
  return true;
}

export async function dependenciesCompleteDetailed({ api, repository, packet }) {
  if (!packet || !Array.isArray(packet.dependencies)) return false;
  for (const dep of packet.dependencies) {
    if (!(await dependencyIssueComplete({ api, repository, number: dep }))) return false;
  }
  return true;
}

/** Evaluate whether a single Ready issue is a valid global offer and (optionally) per-worker fit. */
export async function evaluateAdmissionDecision({
  issue, comments = [], api, repository, openNumbers, packet, packetBase, baseSha,
  actor, workerId, observedAt = new Date().toISOString(),
}) {
  if (!issue || !Number.isSafeInteger(issue?.number)) {
    return Object.freeze({ outcome: "refuse", reason: "issue_unknown", observedAt, observedBase: baseSha ?? "" });
  }
  if (!isReady(issue)) {
    return Object.freeze({ outcome: "refuse", reason: "issue_not_ready", issue: issue.number, observedAt, observedBase: baseSha ?? "" });
  }
  if (liveAcceptedHistory(comments, issue.number)) {
    return Object.freeze({ outcome: "refuse", reason: "accepted_history_requires_release", issue: issue.number, observedAt, observedBase: baseSha ?? "" });
  }
  if (!packet) {
    return Object.freeze({ outcome: "refuse", reason: "packet_invalid", issue: issue.number, observedAt, observedBase: baseSha ?? "" });
  }
  if (packet.effects !== "none") {
    return Object.freeze({ outcome: "refuse", reason: "packet_effectful", issue: issue.number, observedAt, observedBase: baseSha ?? "" });
  }
  if (!dependenciesComplete({ packet, openNumbers })) {
    return Object.freeze({ outcome: "refuse", reason: "dependencies_incomplete", issue: issue.number, observedAt, observedBase: baseSha ?? "" });
  }
  if (typeof baseSha !== "string" || !/^[a-f0-9]{40}$/.test(baseSha)) {
    return Object.freeze({ outcome: "refuse", reason: "base_unknown", issue: issue.number, observedAt, observedBase: baseSha ?? "" });
  }
  if (packet.base !== baseSha) {
    return Object.freeze({ outcome: "refuse", reason: "packet_base_stale", issue: issue.number, observedAt, observedBase: baseSha, packetBase: packet.base });
  }
  // Per-worker fit is opt-in: discovery callers omit `actor`/`workerId` and the
  // evaluator returns the global verdict only. The controller supplies both and
  // gates the remaining pair/capacity/lock/scope checks before transitioning to
  // Working. Lock and scope data is the controller's responsibility because the
  // evaluator must not POST.
  if (actor === undefined && workerId === undefined) {
    return Object.freeze({ outcome: "admit", issue: issue.number, observedAt, observedBase: baseSha,
      globalOnly: true, packet });
  }
  return Object.freeze({ outcome: "admit", issue: issue.number, observedAt, observedBase: baseSha, packet });
}

/** Bounded observation helper: returns the current `main` SHA. Throws on missing base or pagination error. */
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

export const __test = Object.freeze({ scopesOverlap, isReady, ACCEPTED_HISTORY_PATTERN, CONTROLLER });
