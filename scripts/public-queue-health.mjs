// Read-only queue health for the public Agent Control Room work queue.
//
// Reports whether useful work is flowing: substantial Ready packages, active workers,
// review queues, correction owners, stale action handoffs and reviewer capacity. It
// never writes GitHub state, never changes a label, and stays bounded (and says so)
// under pagination or API uncertainty.
//
// Reuses the public issue labels, accepted-claim markers, action markers and the
// worker-inbox marker parser so one grammar defines every handoff record.
import { pathToFileURL } from "node:url";
import { parseActionMarker } from "./public-worker-inbox.mjs";
import { parseHandoff } from "./review-handoff-controller.mjs";
import { parseClaimPacket } from "./automatic-claim-controller.mjs";
import { evaluateAdmissionDecision, observeMainBase } from "./admission-evaluator.mjs";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CLAIM_MARKER = /<!-- agent-control-room-claim:v2 issue=(\d+) request=(\d+) actor=([A-Za-z0-9][A-Za-z0-9-]{0,38}) worker=([A-Za-z0-9][A-Za-z0-9._:-]{2,79}) -->/;
const SECRET_PATTERNS = [/gh[pousr]_[A-Za-z0-9]{16,}/g, /github_pat_[A-Za-z0-9_]{20,}/g];
// A submission declares the issue it delivers in its header block: the repository's own
// `Outcome / issue: #N` form, a closing keyword, or an implementation claim. A prose
// mention ("...the issue #170 labels...") is not a declaration.
const PR_DECLARATION = [
  /^[ \t]*(?:[-*][ \t]*)?(?:Outcome[ \t]*\/[ \t]*)?Issue(?:[ \t]+and[ \t]+completed[ \t]+outcome)?[ \t]*:?[ \t]*#(\d+)\b/im,
  /^[ \t]*(?:Closes?|Fixes?|Resolves?)[ \t]*:?[ \t]*#(\d+)\b/im,
  /^[ \t]*(?:Implements?|Delivers?)[ \t]*:?[ \t]*#(\d+)\b/im,
];
const PR_DECLARATION_WINDOW = 2000;

/**
 * Identities whose transition markers are recognised as *advisory* legacy records.
 *
 * Trust is never derived from `author_association`. Every repository OWNER, MEMBER and
 * COLLABORATOR can post a comment, so treating membership as trust would let an
 * unauthorized comment satisfy a required handoff and silently suppress a missing-record
 * warning. Authority belongs to the serialized controller alone; the identities below are
 * named explicitly and everything they post is reported as advisory, never authoritative.
 */
export const DEFAULT_ADVISORY_LOGINS = Object.freeze(["MarvinAi5"]);

/** Minimum number of substantial Ready packages that must stay available. */
export const READY_FLOOR = 4;
export const DEFAULT_MAX_PAGES = 10;
export const DEFAULT_MAX_PULL_PAGES = 5;

export const STATUSES = Object.freeze([
  "ready", "working", "in-review", "changes-required", "re-review",
  "waiting", "needs-decision", "paused",
]);

/**
 * The exact responsibility area acting next in each state. Areas name a role only —
 * never a preferred person, login or bot brand.
 */
export const RESPONSIBILITY_AREAS = Object.freeze({
  "ready": "Qualified worker: request the atomic claim.",
  "working": "Accepted worker: build the complete package.",
  "in-review": "Reviewer: review the exact submitted commit.",
  "changes-required": "Original worker: correct the same pull request.",
  "re-review": "Reviewer: review the correction and affected behavior.",
  "waiting": "Named prerequisite owner: supply the defined missing input.",
  "needs-decision": "Named lead or owner: make the stated decision.",
  "paused": "Nobody: work is intentionally inactive.",
});

/** States whose next actor must be named by exactly one action label. */
const REQUIRED_ACTION = Object.freeze({
  "in-review": "action:reviewer",
  "changes-required": "action:worker",
  "re-review": "action:reviewer",
  "needs-decision": "action:decision",
});

/** States where a submitted pull request is expected to exist. */
const SUBMITTED_STATES = new Set(["working", "in-review", "changes-required", "re-review"]);

function sanitize(value) {
  if (typeof value !== "string") return "";
  let text = value;
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[redacted]");
  return text;
}

function labelsOf(issue) {
  return (Array.isArray(issue?.labels) ? issue.labels : [])
    .map(label => typeof label === "string" ? label : label?.name)
    .filter(label => typeof label === "string");
}

const statusesOf = labels => labels.filter(label => label.startsWith("status:"));
const actionsOf = labels => labels.filter(label => label.startsWith("action:"));
const issueUrlOf = (repository, number) => `https://github.com/${repository}/issues/${number}`;
const statusLink = (repository, status) =>
  `https://github.com/${repository}/issues?q=is%3Aissue+is%3Aopen+label%3Astatus%3A${status}`;

/** Parse an accepted/revoked claim marker posted by the trusted serialized controller. */
export function parseClaimMarker(body) {
  if (typeof body !== "string") return undefined;
  const match = CLAIM_MARKER.exec(body);
  if (!match) return undefined;
  return Object.freeze({
    issue: Number(match[1]), request: Number(match[2]),
    actor: match[3], workerId: match[4],
  });
}

/** The issue a submitted pull request declares it delivers, if any. */
export function declaredSubmissionIssue(body, window = PR_DECLARATION_WINDOW) {
  if (typeof body !== "string") return undefined;
  const normalized = body.replace(/\r\n/g, "\n");
  const bindings = [...normalized.matchAll(/^Control-Room-Issue: ([1-9][0-9]*)$/gm)];
  // Match the handoff controller's single canonical binding across the whole body.
  // Do not fall back to prose when a malformed or duplicate canonical field exists.
  if (/^Control-Room-Issue:/m.test(normalized)) {
    if (bindings.length !== 1 || (normalized.match(/^Control-Room-Issue:/gm) ?? []).length !== 1) return undefined;
    const issue = Number(bindings[0][1]);
    return Number.isSafeInteger(issue) ? issue : undefined;
  }
  const header = body.slice(0, window);
  for (const pattern of PR_DECLARATION) {
    const match = pattern.exec(header);
    if (match) return Number(match[1]);
  }
  return undefined;
}

async function apiJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, { headers: {
    accept: "application/vnd.github+json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    "x-github-api-version": "2022-11-28",
    "user-agent": "agent-control-room-queue-health",
  } });
  if (!response?.ok) throw new Error(`queue_health_api_${response?.status ?? "invalid"}`);
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error("queue_health_api_invalid");
  return value;
}

/**
 * Bounded pagination. Returns `truncated` instead of pretending the full history was
 * read, so an uncertain report stays visibly uncertain.
 */
async function pages(fetchImpl, url, token, maxPages) {
  const values = [];
  for (let page = 1; page <= maxPages; page++) {
    const separator = url.includes("?") ? "&" : "?";
    const batch = await apiJson(fetchImpl, `${url}${separator}per_page=100&page=${page}`, token);
    values.push(...batch);
    if (batch.length < 100) return { values, truncated: false };
  }
  return { values, truncated: true };
}

/**
 * Every submission each issue declares, keyed by issue number, newest first.
 *
 * Cross-reference events are deliberately not used: GitHub records them for any
 * mention, so a shared integration pull request that references many issues would look
 * like a submission for each one. A pull request's own declared issue is exact.
 */
async function readDeclaredSubmissions({ fetchImpl, root, token, maxPages = DEFAULT_MAX_PULL_PAGES }) {
  const list = await pages(fetchImpl, `${root}/pulls?state=all&sort=created&direction=desc`, token, maxPages);
  const byIssue = new Map();
  const bindingProblems = [];
  for (const pull of list.values) {
    if (!Number.isSafeInteger(pull?.number)) continue;
    const issue = declaredSubmissionIssue(pull.body);
    if (issue === undefined) {
      if (pull.state === "open") bindingProblems.push({ pr: pull.number,
        url: typeof pull.html_url === "string" ? pull.html_url : "",
        reason: "submission_issue_binding_missing_or_invalid" });
      continue;
    }
    const existing = byIssue.get(issue) ?? [];
    existing.push(Object.freeze({
      number: pull.number,
      state: pull.state === "closed" ? "closed" : "open",
      merged: Boolean(pull.merged_at),
      url: typeof pull.html_url === "string" ? pull.html_url : "",
    }));
    byIssue.set(issue, existing);
  }
  return { byIssue, truncated: list.truncated, bindingProblems };
}

/**
 * The serialized controller (`github-actions[bot]`, a GitHub App bot account) is the only
 * authoritative source of review, correction and ownership transitions.
 */
const CONTROLLER = comment => comment?.user?.login === "github-actions[bot]" && comment?.user?.type === "Bot";

/**
 * Whether a marker comes from an identity authorised to post it.
 *
 * The controller is authoritative. A configured advisory identity is recognised but is
 * never authoritative. Association grants nothing: it is checked only to prove the
 * absence of authority, never to supply it.
 */
function trusted(marker, comment, advisoryLogins) {
  if (!marker) return false;
  return CONTROLLER(comment) || advisoryLogins.includes(comment?.user?.login);
}

/**
 * The latest workflow record for an issue, with its provenance.
 *
 * A controller `handoff:v1` record is authoritative. A legacy `action:v1` marker is
 * advisory: per the contributor handbook it "can describe a requested handoff but cannot
 * prove that a maintainer, rather than a worker using that same account, authorized it."
 * The controller record therefore wins whenever both exist, and the report names which
 * one it used instead of presenting advisory data as authoritative.
 */
function latestWorkflowRecord(comments, issueNumber, advisoryLogins) {
  let controllerRecord;
  let advisory;
  for (const comment of comments) {
    const handoff = parseHandoff(comment);
    if (handoff && handoff.issue === issueNumber) controllerRecord = { marker: handoff, trust: "controller-record" };
    if (CONTROLLER(comment)) continue;
    const marker = parseActionMarker(comment?.body);
    if (trusted(marker, comment, advisoryLogins) && marker.issue === issueNumber) advisory = { marker, trust: "advisory" };
  }
  return controllerRecord ?? advisory;
}

/** Latest trusted accepted-claim marker on an issue, if any. */
function latestClaim(comments, issueNumber, advisoryLogins) {
  const matches = comments.flatMap(comment => {
    const marker = parseClaimMarker(comment?.body);
    return trusted(marker, comment, advisoryLogins) && marker.issue === issueNumber ? [marker] : [];
  });
  return matches.at(-1);
}

function currentClaim(comments, issueNumber, advisoryLogins) {
  let authoritativeSeen = false;
  let active;
  const v3 = new RegExp(`<!--\\s*agent-control-room-claim:v3\\s+issue=${issueNumber}\\s+request=(\\d+)\\s+actor=([^\\s]+)\\s+worker=([^\\s]+)\\s+packet=([a-f0-9]{64})\\s+accepted=(\\d+)`);
  for (const comment of comments) {
    if (!CONTROLLER(comment) || typeof comment.body !== "string") continue;
    const accepted = /^(CLAIM ACCEPTED|CLAIM RENEWED) —/.test(comment.body);
    const cleared = /^(CLAIM RELEASED|CLAIM EXPIRED) —/.test(comment.body)
      && comment.body.includes(`issue=${issueNumber} `);
    if (!accepted && !cleared) continue;
    authoritativeSeen = true;
    if (cleared) { active = undefined; continue; }
    const current = v3.exec(comment.body);
    const legacy = parseClaimMarker(comment.body);
    if (current) active = { issue: issueNumber, request: Number(current[1]), actor: current[2],
      workerId: current[3], packetBound: true };
    else if (legacy?.issue === issueNumber) active = { ...legacy, packetBound: false };
  }
  if (authoritativeSeen) return { claim: active, packetBound: active?.packetBound === true };
  const advisory = latestClaim(comments, issueNumber, advisoryLogins);
  return { claim: advisory, packetBound: false };
}

function oldest(records) {
  return records.slice().sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0))[0];
}

function ageDays(since, now) {
  const time = Date.parse(since);
  if (!Number.isFinite(time)) return undefined;
  return Math.max(0, Math.floor((now - time) / 86_400_000));
}

/**
 * Read queue health. Read-only: it issues GET requests only and never mutates labels,
 * issues, pull requests or workflow state.
 */
export async function readQueueHealth({
  repository = "AgenticBotSitter/agent-control-room",
  token, fetchImpl = fetch, advisoryLogins = DEFAULT_ADVISORY_LOGINS,
  readSubmissions = readDeclaredSubmissions,
  maxPages = DEFAULT_MAX_PAGES, maxPullPages = DEFAULT_MAX_PULL_PAGES,
  now = Date.now(),
} = {}) {
  if (!REPOSITORY.test(repository ?? "")) throw new Error("queue_health_repository_invalid");
  const root = `https://api.github.com/repos/${repository}`;
  const list = await pages(fetchImpl, `${root}/issues?state=open`, token, maxPages);

  // A work issue carries at least one workflow label. Ordinary issues (#12 and similar
  // coordination records) carry none and are not queue state.
  const workIssues = list.values.filter(issue => !issue?.pull_request && Number.isSafeInteger(issue?.number)
    && (statusesOf(labelsOf(issue)).length > 0 || actionsOf(labelsOf(issue)).length > 0));

  const counts = Object.fromEntries(STATUSES.map(status => [status, 0]));
  let truncated = list.truncated;
  const anomalies = [];
  const reviewRecords = [];
  const correctionRecords = [];
  let claimed = 0;
  let submissions;
  let submissionReads = 0;
  // Tracked apart from the queue-wide flag: an incomplete pull history must never be used
  // to infer that a submission is absent or resolved.
  let submissionTruncated = false;

  // Pull data is read at most once, and only if some issue actually needs it.
  const submissionFor = async issueNumber => {
    if (!submissions) {
      submissions = await readSubmissions({ fetchImpl, root, token, maxPages: maxPullPages });
      truncated = truncated || submissions.truncated;
      submissionTruncated = submissionTruncated || submissions.truncated;
    }
    submissionReads += 1;
    return submissions.byIssue.get(issueNumber) ?? [];
  };

  for (const issue of workIssues) {
    const labels = labelsOf(issue);
    const statuses = statusesOf(labels);
    const actions = actionsOf(labels);
    const status = statuses.length === 1 ? statuses[0].slice("status:".length) : undefined;
    const codes = [];
    const since = typeof issue.updated_at === "string" ? issue.updated_at : "";
    let responsibilityArea;

    if (statuses.length === 0) codes.push("status_label_missing");
    else if (statuses.length > 1) codes.push("status_label_ambiguous");
    else if (!STATUSES.includes(status)) codes.push("status_not_supported");
    else responsibilityArea = RESPONSIBILITY_AREAS[status];

    if (actions.length > 1) codes.push("action_label_ambiguous");
    if (status && REQUIRED_ACTION[status]) {
      if (actions.length === 0) codes.push("action_label_missing");
      else if (actions.length === 1 && actions[0] !== REQUIRED_ACTION[status])
        codes.push("action_label_mismatch");
    }

    // Comment-level records carry correction ownership and claim provenance.
    const needsComments = status !== undefined && (SUBMITTED_STATES.has(status) || status === "changes-required");
    let comments = [];
    let commentHistoryTruncated = false;
    if (needsComments) {
      const history = await pages(fetchImpl, `${root}/issues/${issue.number}/comments?direction=asc`, token, maxPages);
      comments = history.values;
      commentHistoryTruncated = history.truncated;
      truncated = truncated || history.truncated;
    }

    const record = latestWorkflowRecord(comments, issue.number, advisoryLogins);
    const claimState = currentClaim(comments, issue.number, advisoryLogins);
    const claim = claimState.claim;
    if (claim) claimed += 1;

    if (status === "working" && commentHistoryTruncated) codes.push("claim_history_indeterminate");
    else if (status === "working" && !claim) codes.push("working_claim_missing");
    else if (status === "working" && !claimState.packetBound)
      codes.push("legacy_claim_blocks_queue");

    if (status === "changes-required" && !record) codes.push("worker_action_marker_missing");
    // A record exists but carries no authority. A legacy shared-account marker cannot
    // authorize the transition, so it must not suppress the missing-record signal.
    if (status === "changes-required" && record?.trust === "advisory")
      codes.push("worker_action_marker_not_authoritative");
    // A correction was requested but the issue still advertises an active review.
    if (status === "in-review" && (record?.marker.state === "changes-required" || actions.includes("action:worker")))
      codes.push("correction_not_applied");

    // Submitted work: compare the advertised state with the issue's declared submissions.
    if (status && SUBMITTED_STATES.has(status)) {
      const declared = await submissionFor(issue.number);
      const open = declared.filter(pull => pull.state === "open");
      const closed = declared.filter(pull => pull.state === "closed");
      // A submission exists but the issue still advertises active implementation.
      if (status === "working" && open.length > 0) codes.push("submitted_work_still_working");
      // Review or correction is advertised with no open submission. Never infer absence
      // from an incomplete pull history: report it as indeterminate instead.
      if (status !== "working" && open.length === 0) {
        if (submissionTruncated) codes.push("submission_indeterminate");
        else if (closed.length > 0) codes.push("linked_pull_request_mismatch");
        else codes.push("submission_missing");
      }
    }

    if (status && STATUSES.includes(status)) {
      counts[status] += 1;
      if (status === "in-review" || status === "re-review")
        reviewRecords.push({ issue: issue.number, title: sanitize(issue.title), since, ageDays: ageDays(since, now),
          responsibilityArea: RESPONSIBILITY_AREAS[status], url: issueUrlOf(repository, issue.number) });
      if (status === "changes-required")
        correctionRecords.push({ issue: issue.number, title: sanitize(issue.title), since,
          ageDays: ageDays(since, now), responsibilityArea: RESPONSIBILITY_AREAS[status],
          workerId: record?.marker.workerId, recordTrust: record?.trust,
          url: issueUrlOf(repository, issue.number) });
    }

    if (codes.length > 0) anomalies.push(Object.freeze({
      issue: issue.number,
      title: sanitize(issue.title),
      codes: Object.freeze([...new Set(codes)].sort()),
      responsibilityArea: responsibilityArea ?? "Unclassified: repair the workflow labels before acting.",
      url: issueUrlOf(repository, issue.number),
    }));
  }

  // Run the shared admission evaluator over every Ready issue so the same offer
  // classification the controller and discovery apply also appears in queue health.
  // Distinct blockers for stale base, invalid packet, effects, dependencies,
  // accepted-history, worker capacity and path locks are reported individually,
  // and incomplete reads are reported as a bounded-observation error rather than
  // silently synthesised. Already-accepted work retains the pinned base from its
  // claim marker; only Ready offers that are not currently accepted are evaluated.
  const readyIssues = workIssues.filter(issue => labelsOf(issue).includes("status:ready"));
  // Comments are fetched at most once for any issue that needs admission evaluation
  // so we can detect an already-accepted Ready offer (CLAIM ACCEPTED marker) and
  // leave its pinned base intact even when the live main has moved on.
  const commentsByIssue = new Map();
  const commentsForIssue = async number => {
    if (commentsByIssue.has(number)) return commentsByIssue.get(number);
    const value = await fetchImpl(`${root}/issues/${number}/comments`, { headers: {
      accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "agent-control-room-queue-health",
    } });
    const list = value?.ok ? await value.json() : [];
    commentsByIssue.set(number, Array.isArray(list) ? list : []);
    return commentsByIssue.get(number);
  };
  let observation;
  try {
    const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "agent-control-room-queue-health" };
    const apiAdapter = { request: async (method, requestedPath) => {
      if (method !== "GET") return null;
      const cleaned = requestedPath.replace(/^\/repos\/[^/]+\//, "/");
      const url = `${root}${cleaned}`;
      const response = await fetchImpl(url, { headers });
      if (!response?.ok) return null;
      return await response.json();
    } };
    observation = await observeMainBase({ api: apiAdapter, repository });
  } catch { observation = undefined; }
  const baseSha = observation?.baseSha;
  const openNumbers = new Set(workIssues.map(issue => issue.number));
  const blockedOffers = [];
  for (const issue of readyIssues) {
    const labels = labelsOf(issue);
    const conflicts = labels.filter(label => label.startsWith("status:")).length !== 1
      || labels.some(label => label.startsWith("action:"));
    const packet = parseClaimPacket(issue.body);
    // Already accepted work retains its pinned base from the marker; queue health
    // does not reclassify it as blocked just because main has advanced. We fetch
    // the issue's comments lazily so a live accepted-claim marker is respected.
    const issueComments = await commentsForIssue(issue.number);
    const claim = latestClaim(issueComments, issue.number, advisoryLogins);
    if (claim) continue;
    let admission;
    let admissionError;
    let requiresBaseObservation = false;
    if (conflicts) {
      admission = Object.freeze({ outcome: "refuse", reason: "conflicting_ready_labels",
        observedAt: observation?.observedAt ?? "", observedBase: baseSha ?? "" });
    } else if (!packet) {
      admission = Object.freeze({ outcome: "refuse", reason: "packet_invalid",
        observedAt: observation?.observedAt ?? "", observedBase: baseSha ?? "" });
    } else if (baseSha === undefined) {
      requiresBaseObservation = true;
      const openDeps = packet.dependencies.filter(number => openNumbers.has(number));
      if (openDeps.length > 0) {
        admission = Object.freeze({ outcome: "refuse", reason: "dependencies_incomplete",
          observedAt: observation?.observedAt ?? "", observedBase: baseSha ?? "" });
      } else {
        admission = Object.freeze({ outcome: "admit", reason: "admission_incomplete_observation",
          observedAt: observation?.observedAt ?? "", observedBase: baseSha ?? "" });
      }
    } else {
      try {
        admission = await evaluateAdmissionDecision({
          issue, comments: [], packet, openNumbers, baseSha, observedAt: observation.observedAt,
        });
      } catch (error) {
        admissionError = /^admission_evaluator_/.test(error?.message) ? error.message : "admission_evaluator_unavailable";
      }
    }
    if (admission?.outcome === "admit" && !requiresBaseObservation) continue;
    const offer = {
      issue: issue.number,
      title: sanitize(issue.title),
      url: issueUrlOf(repository, issue.number),
      ...(admission ? {
        admission: Object.freeze({
          outcome: admission.outcome, reason: admission.reason,
          observedAt: admission.observedAt, observedBase: admission.observedBase,
          ...(admission.packetBase ? { packetBase: admission.packetBase } : {}),
        }),
      } : {}),
      ...(admissionError ? { admissionError } : {}),
    };
    blockedOffers.push(Object.freeze(offer));
  }

  const warnings = [];
  if (counts.ready < READY_FLOOR) warnings.push("ready_floor_below_minimum");
  if (truncated) warnings.push("queue_read_truncated");
  // The admission observation only matters when at least one Ready offer could
  // not be classified against the live main ref. An empty Ready queue, or a
  // queue where every offer was classified by packet/conflicts alone, does not
  // raise this warning.
  const offersNeedingBaseObservation = blockedOffers.filter(offer =>
    offer.admission?.reason === "admission_incomplete_observation"
    || offer.admission?.reason === "packet_base_stale"
    || offer.admissionError).length;
  if (observation === undefined && offersNeedingBaseObservation > 0)
    warnings.push("admission_observation_unavailable");
  if (blockedOffers.some(offer => offer.admissionError)) warnings.push("admission_evaluation_incomplete");

  return Object.freeze({
    repository,
    readyFloor: READY_FLOOR,
    counts: Object.freeze(counts),
    links: Object.freeze(Object.fromEntries(STATUSES.map(status => [status, statusLink(repository, status)]))),
    activeReviewCount: counts["in-review"] + counts["re-review"],
    claimedAssignments: claimed,
    oldestReview: oldest(reviewRecords),
    oldestCorrection: oldest(correctionRecords),
    anomalies: Object.freeze(anomalies.sort((a, b) => a.issue - b.issue)),
    blockedOffers: Object.freeze(blockedOffers.sort((a, b) => a.issue - b.issue)),
    submissionBindingProblems: Object.freeze(submissions?.bindingProblems ?? []),
    warnings: Object.freeze(warnings),
    uncertainty: Object.freeze({
      truncated,
      maxPages,
      submissionReads,
      observationComplete: observation !== undefined,
      note: truncated
        ? "A bounded read hit its page limit; counts are a lower bound."
        : "Every open issue was read within the configured bound.",
    }),
  });
}

/** Human-readable report. Names roles and areas, never a preferred person or bot. */
export function renderQueueHealth(report) {
  const lines = [
    `Queue health for ${report.repository}`,
    "",
    `Counts (Ready floor: ${report.readyFloor})`,
  ];
  for (const status of STATUSES) {
    const count = report.counts[status];
    const flag = status === "ready" && count < report.readyFloor ? "  <- below floor" : "";
    lines.push(`  ${status}: ${count}${flag}`);
  }
  lines.push("", `Active reviews: ${report.activeReviewCount}`, `Claimed assignments: ${report.claimedAssignments}`);
  // The responsibility area is reported for every actionable record, not only anomalies,
  // so a reader always knows who acts next without naming a person or bot. A correction
  // also reports whether its record is controller-authoritative or merely advisory.
  const describe = record => record
    ? `#${record.issue} ${record.title} (since ${record.since}${record.ageDays === undefined ? "" : `, ${record.ageDays}d`})`
      + `\n  next: ${record.responsibilityArea}`
      + (record.recordTrust ? `\n  record: ${record.recordTrust}` : "")
    : "none";
  lines.push(`Oldest review: ${describe(report.oldestReview)}`);
  lines.push(`Oldest correction: ${describe(report.oldestCorrection)}`);
  lines.push("", `Warnings: ${report.warnings.length ? report.warnings.join(", ") : "none"}`);
  lines.push(`Uncertainty: ${report.uncertainty.note}`);
  lines.push("", `Workflow anomalies: ${report.anomalies.length}`);
  for (const anomaly of report.anomalies) {
    lines.push(`  #${anomaly.issue} ${anomaly.title}`);
    lines.push(`    codes: ${anomaly.codes.join(", ")}`);
    lines.push(`    next: ${anomaly.responsibilityArea}`);
    lines.push(`    ${anomaly.url}`);
  }
  lines.push("", "Links");
  for (const problem of report.submissionBindingProblems ?? [])
    lines.push(`Submission needs maintainer reconciliation: PR #${problem.pr} ${problem.reason} ${problem.url}`);
  for (const status of STATUSES) lines.push(`  ${status}: ${report.links[status]}`);
  return lines.join("\n");
}

export function renderQueueHealthJson(report) {
  return JSON.stringify(report, null, 2);
}

function argumentsFor(argv) {
  const values = { repository: "AgenticBotSitter/agent-control-room", json: false };
  for (let index = 0; index < argv.length; index++) {
    // A bare separator is accepted so `pnpm queue:health -- --json` still works.
    if (argv[index] === "--") continue;
    if (argv[index] === "--repository") values.repository = argv[++index];
    else if (argv[index] === "--json") values.json = true;
    else if (argv[index] === "--max-pages") values.maxPages = Number(argv[++index]);
    else throw new Error(`queue_health_argument_invalid:${argv[index]}`);
  }
  return values;
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const report = await readQueueHealth({ ...options, token: process.env.GITHUB_TOKEN });
  console.log(options.json ? renderQueueHealthJson(report) : renderQueueHealth(report));
  // A degraded queue reports through the content, not the exit code, so a caller can
  // always distinguish a completed read from a failed one.
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(`public-queue-health: ${sanitize(error.message)}`); process.exitCode = 1; });
