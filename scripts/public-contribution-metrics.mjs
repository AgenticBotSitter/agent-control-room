// Read-only contribution cost report: worker, reviewer and lead phases with
// honest unknown handling, similar-work grouping, and a sample threshold below
// which delegation and direct-build methods are shown without a winner.
import { pathToFileURL } from "node:url";
import { parseHandoff } from "./review-handoff-controller.mjs";
import { addCounts, exactField, median, parseReportedMetrics, parseReportedModel,
  renderDuration, summarizeIssueCycleTimes } from "./public-model-outcomes.mjs";

export const METRICS_SCHEMA_V1 = "acr-contribution-metrics:v1";
// No /g flag: parsePhaseRecord calls exec on fresh inputs and a shared
// global regex would resume from the previous match's lastIndex.
const MARKER = /<!--\s*acr-contribution-metrics:v1\s*(\{.*?\})\s*-->/s;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9 ._:/+()-]{0,79}$/;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown"]);
// One record per cost phase. Delegated work has packet/review/correction/
// integration lead phases plus worker and reviewer phases; direct work has a
// single lead-direct phase instead of worker phases.
export const ROLES = new Set(["worker", "reviewer", "lead-packet", "lead-review", "lead-correction",
  "lead-integration", "lead-direct"]);
export const COMPARABLE_GROUP_MINIMUM = 5;
export const DEFAULT_FLOW_WINDOW_HOURS = 24;
export const DEFAULT_METRICS_MAINTAINERS = Object.freeze(["AgentControlRoomMaintainer"]);
const MINUTE_MS = 60_000;
const SECRET_PATTERNS = [/gh[pousr]_[A-Za-z0-9]{16,}/g, /github_pat_[A-Za-z0-9_]{20,}/g];
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const CLAIM_V3 = /<!--\s*agent-control-room-claim:v3\s+issue=(\d+)\s+request=\d+\s+actor=([^\s]+)\s+worker=[^\s]+\s+packet=[a-f0-9]{64}\s+accepted=(\d+)/;

const FLOW_OWNERS = Object.freeze({
  ready: ["queue-pickup", 60],
  working: ["worker", 240],
  "in-review": ["reviewer", 60],
  "changes-required": ["worker-correction", 60],
  "re-review": ["reviewer", 60],
  "needs-decision": ["lead-or-owner", 60],
  waiting: ["dependency", 1_440],
});

function optionalCount(value) {
  if (value === null || value === undefined) return undefined;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalMinutes(value) {
  if (value === null || value === undefined) return undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalInstant(value) {
  if (value === null || value === undefined) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= 0 ? new Date(time).toISOString() : undefined;
}

// Parses one machine-readable lead/reviewer phase comment. Malformed records
// are rejected into unknown (the caller counts them) rather than coerced.
export function parsePhaseRecord(body) {
  if (typeof body !== "string") return undefined;
  const raw = MARKER.exec(body)?.[1];
  if (!raw) return undefined;
  let value;
  try { value = JSON.parse(raw); } catch { return undefined; }
  if (!value || value.schema !== METRICS_SCHEMA_V1 || !ROLES.has(value.role)) return undefined;
  if (typeof value.model !== "string" || !MODEL.test(value.model)) return undefined;
  const effort = String(value.effort ?? "unknown").toLowerCase();
  if (!EFFORTS.has(effort)) return undefined;
  const activeMinutes = optionalMinutes(value.activeMinutes);
  const inputTokens = optionalCount(value.inputTokens);
  const outputTokens = optionalCount(value.outputTokens);
  const providerCalls = optionalCount(value.providerCalls);
  const interruptions = optionalCount(value.interruptions);
  if (value.activeMinutes != null && activeMinutes === undefined) return undefined;
  if (value.inputTokens != null && inputTokens === undefined) return undefined;
  if (value.outputTokens != null && outputTokens === undefined) return undefined;
  if (value.providerCalls != null && providerCalls === undefined) return undefined;
  if (value.interruptions != null && interruptions === undefined) return undefined;
  const startedAt = optionalInstant(value.startedAt);
  const endedAt = optionalInstant(value.endedAt);
  if (value.startedAt != null && startedAt === undefined) return undefined;
  if (value.endedAt != null && endedAt === undefined) return undefined;
  return Object.freeze({ schema: METRICS_SCHEMA_V1, role: value.role, model: value.model, effort,
    activeMinutes, inputTokens, outputTokens, providerCalls, interruptions, startedAt, endedAt,
    issue: Number.isSafeInteger(value.issue) ? value.issue : undefined,
    pr: Number.isSafeInteger(value.pr) ? value.pr : undefined,
    interrupted: value.interrupted === true });
}

export function parsePhaseRecords(comments) {
  const records = [];
  let malformed = 0;
  for (const comment of comments ?? []) {
    if (typeof comment?.body !== "string" || !comment.body.includes(METRICS_SCHEMA_V1)) continue;
    // A comment carries at most one phase record; extra markers are malformed.
    const markers = [...comment.body.matchAll(/<!--\s*acr-contribution-metrics:v1[\s\S]*?-->/g)];
    if (markers.length !== 1) { malformed++; continue; }
    const record = parsePhaseRecord(comment.body);
    if (record) records.push(record);
    else malformed++;
  }
  return { records, malformed };
}

// Lead and reviewer timing affects an operational KPI, so a syntactically valid
// public comment is not enough. It must come from a configured role account and
// bind to the issue/PR where it was posted. Worker timing is sourced separately
// from a claim-bound pull request.
export function parseTrustedPhaseRecords(comments, { trustedLogins = DEFAULT_METRICS_MAINTAINERS,
  pullIssue = new Map(), knownIssues = new Set() } = {}) {
  if (!Array.isArray(trustedLogins) || trustedLogins.some(login => !LOGIN.test(login)))
    throw new Error("contribution_metrics_trusted_login_invalid");
  const records = [], seen = new Set();
  let malformed = 0, untrusted = 0, duplicate = 0;
  for (const comment of comments ?? []) {
    if (typeof comment?.body !== "string" || !comment.body.includes(METRICS_SCHEMA_V1)) continue;
    const markers = [...comment.body.matchAll(/<!--\s*acr-contribution-metrics:v1[\s\S]*?-->/g)];
    const record = markers.length === 1 ? parsePhaseRecord(comment.body) : undefined;
    if (!record) { malformed++; continue; }
    const location = Number(/\/issues\/(\d+)$/.exec(comment.issue_url ?? "")?.[1]);
    const issueKnown = Number.isSafeInteger(record.issue) && knownIssues.has(record.issue);
    const prMatches = record.pr === undefined || pullIssue.get(record.pr) === record.issue;
    const locationMatches = location === record.issue || (record.pr !== undefined && location === record.pr);
    if (!trustedLogins.includes(comment.user?.login) || !issueKnown || !prMatches || !locationMatches) {
      untrusted++;
      continue;
    }
    const key = [record.role, record.model, record.effort, record.startedAt, record.endedAt,
      record.activeMinutes, record.issue, record.pr ?? ""].join("\u0000");
    if (seen.has(key)) { duplicate++; continue; }
    seen.add(key);
    records.push(record);
  }
  return Object.freeze({ records: Object.freeze(records), malformed, untrusted, duplicate });
}

// Maintainer append template for recording one lead phase without changing
// workflow authority. Post the filled block as a comment on the issue or PR.
// Unknown stays null; never guess a count the provider did not report.
/*
<!-- acr-contribution-metrics:v1 {"schema":"acr-contribution-metrics:v1","role":"lead-review","model":"PROVIDER/MODEL","effort":"medium","activeMinutes":25,"inputTokens":12000,"outputTokens":800,"providerCalls":3,"interruptions":0,"startedAt":"2026-09-01T10:00:00.000Z","endedAt":"2026-09-01T10:25:00.000Z","issue":223,"pr":null,"interrupted":false} -->
*/
export const LEAD_PHASE_TEMPLATE_ROLES = ["lead-packet", "lead-review", "lead-correction", "lead-integration", "lead-direct"];

function finiteInstant(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function publicText(value) {
  let text = typeof value === "string" ? value.slice(0, 240) : "";
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[redacted]");
  return text;
}

function unionMinutes(intervals, from, to) {
  const clipped = intervals.map(([start, end]) => [Math.max(start, from), Math.min(end, to)])
    .filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const interval of clipped) {
    const last = merged.at(-1);
    if (!last || interval[0] > last[1]) merged.push([...interval]);
    else last[1] = Math.max(last[1], interval[1]);
  }
  const coveredMs = merged.reduce((total, [start, end]) => total + end - start, 0);
  let cursor = from, longestGapMs = 0;
  for (const [start, end] of merged) {
    longestGapMs = Math.max(longestGapMs, start - cursor);
    cursor = Math.max(cursor, end);
  }
  longestGapMs = Math.max(longestGapMs, to - cursor);
  return { coveredMs, longestGapMs, intervals: merged };
}

// Work coverage uses explicitly reported work-session boundaries only. A claim,
// open PR or status label is assignment state, not proof that a model was active.
// Sessions crossing the report boundary contribute to time-window coverage, but
// their active minutes are left unknown because they cannot be split honestly.
export function summarizeWorkCoverage(records, { nowMs = Date.now(), windowHours = DEFAULT_FLOW_WINDOW_HOURS } = {}) {
  if (!Number.isFinite(nowMs) || nowMs < 0 || !Number.isFinite(windowHours) || windowHours <= 0 || windowHours > 24 * 31)
    throw new Error("contribution_metrics_window_invalid");
  const windowEndMs = nowMs;
  const windowStartMs = nowMs - windowHours * 60 * MINUTE_MS;
  const intervals = [];
  let timingUnknown = 0, timingInvalid = 0, timingLoose = 0;
  let activeMinutes = 0, activeMinutesKnown = 0, boundaryPartial = 0;
  const roles = new Map();
  for (const record of records ?? []) {
    const start = finiteInstant(record.startedAt), end = finiteInstant(record.endedAt);
    if (start === undefined || end === undefined || record.activeMinutes === undefined) { timingUnknown++; continue; }
    const elapsedMinutes = (end - start) / MINUTE_MS;
    if (end <= start || end > nowMs + MINUTE_MS || record.activeMinutes > elapsedMinutes + 1) { timingInvalid++; continue; }
    if (end <= windowStartMs || start >= windowEndMs) continue;
    const role = roles.get(record.role) ?? { role: record.role, sessions: 0, activeMinutes: 0, activeMinutesKnown: 0 };
    role.sessions++;
    if (start >= windowStartMs && end <= windowEndMs) {
      activeMinutes += record.activeMinutes;
      activeMinutesKnown++;
      role.activeMinutes += record.activeMinutes;
      role.activeMinutesKnown++;
    } else boundaryPartial++;
    // A broad session window with much less active time cannot prove when the
    // work happened. It still contributes its exact active-agent minutes, but
    // never inflates the team's continuous-coverage calculation.
    if (elapsedMinutes - record.activeMinutes <= 1) intervals.push([start, end]);
    else timingLoose++;
    roles.set(record.role, role);
  }
  const union = unionMinutes(intervals, windowStartMs, windowEndMs);
  const windowMinutes = (windowEndMs - windowStartMs) / MINUTE_MS;
  return Object.freeze({ windowHours, windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(windowEndMs).toISOString(), windowMinutes,
    reportedSessions: intervals.length, reportedCoverageMinutes: union.coveredMs / MINUTE_MS,
    reportedCoveragePercent: windowMinutes ? union.coveredMs / MINUTE_MS / windowMinutes : undefined,
    longestUnreportedGapMinutes: union.longestGapMs / MINUTE_MS,
    activeAgentMinutes: activeMinutes, activeMinutesKnown, boundaryPartial,
    timingUnknown, timingInvalid, timingLoose,
    byRole: Object.freeze([...roles.values()].sort((a, b) => a.role.localeCompare(b.role)).map(Object.freeze)),
    note: "Coverage is self-reported work-session time. Claims and open pull requests are not counted as active work; missing sessions make coverage incomplete." });
}

export function summarizeCurrentBottlenecks(issues, nowMs = Date.now()) {
  const rows = [];
  for (const issue of issues ?? []) {
    if (issue?.pull_request || issue?.state !== "open" || !Number.isSafeInteger(issue?.number)) continue;
    const labels = (issue.labels ?? []).map(label => typeof label === "string" ? label : label?.name)
      .filter(value => typeof value === "string");
    const statuses = labels.filter(label => label.startsWith("status:"));
    if (statuses.length !== 1) continue;
    const status = statuses[0].slice(7);
    const mapping = FLOW_OWNERS[status];
    if (!mapping) continue;
    const updatedMs = finiteInstant(issue.updated_at);
    const ageMinutes = updatedMs === undefined ? undefined : Math.max(0, (nowMs - updatedMs) / MINUTE_MS);
    const owner = labels.includes("action:integrator") ? "integrator" : mapping[0];
    const thresholdMinutes = owner === "integrator" ? 60 : mapping[1];
    rows.push(Object.freeze({ issue: issue.number, title: publicText(issue.title),
      status, owner, ageMinutes, thresholdMinutes,
      overdue: ageMinutes === undefined ? undefined : ageMinutes >= thresholdMinutes,
      url: typeof issue.html_url === "string" ? issue.html_url : undefined }));
  }
  return Object.freeze(rows.sort((a, b) => (b.overdue === true ? 1 : 0) - (a.overdue === true ? 1 : 0)
    || (b.ageMinutes ?? -1) - (a.ageMinutes ?? -1) || a.issue - b.issue));
}

export function summarizeAcceptedOutcomes(pulls, issuesByNumber, nowMs = Date.now()) {
  const substantial = new Set(["size:feature-package", "size:integration-package", "size:platform-package"]);
  const seen24h = new Set(), seen7d = new Set(), classified = new Set();
  let mergedIn7d = 0, classificationUnknown = 0;
  for (const pull of pulls ?? []) {
    if (!pull.merged) continue;
    const issue = Number(exactField(pull.body, "Control-Room-Issue"));
    const mergedMs = finiteInstant(pull.merged_at);
    if (!Number.isSafeInteger(issue) || mergedMs === undefined || mergedMs > nowMs || nowMs - mergedMs > 7 * 24 * 60 * MINUTE_MS)
      continue;
    mergedIn7d++;
    const linked = issuesByNumber?.get?.(issue);
    const labels = linked?.labels ?? [];
    if (linked?.state !== "closed" || !labels.includes("status:done") || !labels.some(label => substantial.has(label))) {
      classificationUnknown++;
      continue;
    }
    classified.add(issue);
    seen7d.add(issue);
    if (nowMs - mergedMs <= 24 * 60 * MINUTE_MS) seen24h.add(issue);
  }
  return Object.freeze({ accepted24h: seen24h.size, accepted7d: seen7d.size,
    mergedPulls7d: mergedIn7d, classificationUnknown,
    note: "Counts unique closed, status:done issues with a substantial package-size label; commits and unclassified pull requests do not count." });
}

function groupKey(labels) {
  const pick = prefix => labels.filter(label => label.startsWith(prefix)).sort()[0] ?? `${prefix}unknown`;
  return `${pick("difficulty:")}|${pick("size:")}|${pick("risk:")}`;
}

// Compares complete accepted outcomes (merged PRs), not commits or issue
// counts. Delegated totals include packet design, worker implementation,
// independent checking, every lead review/correction round and integration.
// Direct totals include lead implementation, independent checking and
// integration. Groups are comparable only within the same difficulty, size
// and risk labels; below five accepted outcomes per comparable group the
// report shows observations without a winner and never a single best score.
export function compareDelegatedToDirect({ pulls, issuesByNumber, phaseRecords, nowMs = Date.now() }) {
  const phasesByIssue = new Map();
  for (const record of phaseRecords) {
    if (record.issue === undefined) continue;
    const list = phasesByIssue.get(record.issue) ?? [];
    list.push(record);
    phasesByIssue.set(record.issue, list);
  }
  // A phase with an explicit pr binds to that pull only; a phase without one
  // is an issue-level record. Keep one PR per issue: an issue-level record
  // applies to each linked pull.
  const phasesFor = (issue, number) => (phasesByIssue.get(issue) ?? [])
    .filter(record => record.pr === undefined || record.pr === null || record.pr === number);
  const cycles = summarizeIssueCycleTimes(pulls, issuesByNumber, nowMs);
  const cycleByIssue = new Map(cycles.outcomes.map(outcome => [outcome.issue, outcome]));
  const groups = new Map();
  for (const pull of pulls) {
    if (!pull.merged) continue;
    const issue = Number(exactField(pull.body, "Control-Room-Issue"));
    if (!Number.isSafeInteger(issue)) continue;
    const labels = issuesByNumber?.get?.(issue)?.labels ?? [];
    const key = groupKey(labels);
    const group = groups.get(key) ?? { group: key, labels: key.split("|"), delegated: [], direct: [] };
    const worker = parseReportedMetrics(pull.body);
    const phases = phasesFor(issue, pull.number);
    const leadPhases = phases.filter(record => record.role.startsWith("lead-"));
    const reviewerPhase = phases.find(record => record.role === "reviewer");
    const directPhase = leadPhases.find(record => record.role === "lead-direct");
    const cycle = cycleByIssue.get(issue);
    if (directPhase && !parseReportedModel(pull.body).valid && worker.activeMinutes === undefined
      && leadPhases.every(record => record.role === "lead-direct")) {
      // Direct work: lead implementation plus independent checking. A missing
      // phase source is unknown cost, never zero cost.
      group.direct.push({ issue,
        activeMinutes: addCounts(directPhase.activeMinutes === undefined ? undefined : Math.round(directPhase.activeMinutes),
          reviewerPhase ? reviewerPhase.activeMinutes : undefined),
        totalTokens: addCounts(directPhase.inputTokens, directPhase.outputTokens,
          ...(reviewerPhase ? [reviewerPhase.inputTokens, reviewerPhase.outputTokens] : [undefined])),
        claimToMergeMs: cycle?.claimToMergeMs,
        correctionRounds: 0 });
    } else {
      const workerTokens = addCounts(worker.inputTokens, worker.outputTokens);
      const workerMinutes = worker.activeMinutes === undefined ? undefined : Math.round(worker.activeMinutes);
      const leadTokens = leadPhases.map(record => addCounts(record.inputTokens, record.outputTokens));
      const leadMinutes = leadPhases.map(record => record.activeMinutes);
      const reviewerTokens = reviewerPhase ? addCounts(reviewerPhase.inputTokens, reviewerPhase.outputTokens) : undefined;
      const reviewerMinutes = reviewerPhase ? reviewerPhase.activeMinutes : undefined;
      // Totals stay unknown unless every phase source is known: addCounts
      // yields undefined on any unknown input or overflow. Absent lead phases
      // are unknown lead cost, not zero lead cost.
      const allLeadTokens = leadPhases.length ? leadTokens : [undefined];
      const allLeadMinutes = leadPhases.length ? leadMinutes : [undefined];
      group.delegated.push({ issue,
        activeMinutes: addCounts(workerMinutes, reviewerMinutes, ...allLeadMinutes.map(value =>
          (value === undefined ? undefined : Math.round(value)))),
        totalTokens: addCounts(workerTokens, reviewerTokens, ...allLeadTokens),
        leadTokens: allLeadTokens.every(value => value !== undefined)
          ? allLeadTokens.reduce((total, value) => addCounts(total, value) ?? -1, 0) : undefined,
        leadMinutes: allLeadMinutes.every(value => value !== undefined)
          ? allLeadMinutes.reduce((total, value) => total + value, 0) : undefined,
        claimToMergeMs: cycle?.claimToMergeMs,
        correctionRounds: pull.correctionRounds ?? 0,
        firstPass: (pull.correctionRounds ?? 0) === 0 });
    }
    groups.set(key, group);
  }
  const summarize = list => {
    const minutes = list.map(entry => entry.activeMinutes).filter(value => value !== undefined);
    const tokens = list.map(entry => entry.totalTokens).filter(value => value !== undefined);
    const merges = list.map(entry => entry.claimToMergeMs).filter(value => value !== undefined);
    return { accepted: list.length,
      entries: Object.freeze(list.map(entry => Object.freeze({ ...entry }))),
      medianActiveMinutes: median(minutes), activeMinutesUnknown: list.length - minutes.length,
      medianTotalTokens: median(tokens), totalTokensUnknown: list.length - tokens.length,
      medianClaimToMergeMs: median(merges), claimToMergeUnknown: list.length - merges.length,
      firstPassAccepted: list.filter(entry => entry.firstPass).length,
      medianCorrectionRounds: median(list.map(entry => entry.correctionRounds)) };
  };
  return Object.freeze([...groups.values()].map(group => {
    const delegated = summarize(group.delegated);
    const direct = summarize(group.direct);
    const comparable = group.delegated.length >= COMPARABLE_GROUP_MINIMUM
      && group.direct.length >= COMPARABLE_GROUP_MINIMUM;
    return Object.freeze({ group: group.group, difficulty: group.labels[0], size: group.labels[1], risk: group.labels[2],
      delegated: Object.freeze(delegated), direct: Object.freeze(direct),
      // No winner below threshold and never a single best-model score:
      // each signal stands alone, and small samples stay observations.
      verdict: comparable ? "comparable" : "observations-only",
      acceptedPer100kTokens: comparable ? ["delegated", "direct"].map(method => {
        const rows = method === "delegated" ? group.delegated : group.direct;
        const known = rows.filter(entry => entry.totalTokens !== undefined);
        const tokensSum = known.map(entry => entry.totalTokens)
          .reduce((total, value) => (total === undefined ? undefined : addCounts(total, value)), 0);
        return { method, accepted: rows.length, acceptedPer100kTokens: tokensSum ? rows.length / (tokensSum / 100_000) : undefined,
          tokensUnknown: rows.length - known.length };
      }) : undefined });
  }));
}

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const DEFAULT_MAX_PULL_PAGES = 5;
export const DEFAULT_MAX_COMMENT_PAGES = 20;
export const DEFAULT_MAX_ISSUE_PAGES = 20;

async function api(fetchImpl, url, token) {
  const response = await fetchImpl(url, { headers: { accept: "application/vnd.github+json",
    ...(token ? { authorization: `Bearer ${token}` } : {}), "x-github-api-version": "2022-11-28",
    "user-agent": "agent-control-room-contribution-metrics" } });
  if (!response?.ok) throw new Error(`contribution_metrics_api_${response?.status ?? "invalid"}`);
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error("contribution_metrics_api_invalid");
  return value;
}

async function pages(fetchImpl, url, token, maxPages) {
  const values = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await api(fetchImpl, `${url}${url.includes("?") ? "&" : "?"}per_page=100&page=${page}`, token);
    values.push(...batch);
    if (batch.length < 100) return { values, truncated: false };
  }
  return { values, truncated: true };
}

export async function readContributionMetrics({ repository = "AgenticBotSitter/agent-control-room", fetchImpl = fetch,
  token, maxPullPages = DEFAULT_MAX_PULL_PAGES, maxCommentPages = DEFAULT_MAX_COMMENT_PAGES,
  maxIssuePages = DEFAULT_MAX_ISSUE_PAGES, nowMs = Date.now(), windowHours = DEFAULT_FLOW_WINDOW_HOURS,
  trustedMetricsLogins = DEFAULT_METRICS_MAINTAINERS } = {}) {
  if (!REPOSITORY.test(repository)) throw new Error("contribution_metrics_repository_invalid");
  const root = `https://api.github.com/repos/${repository}`;
  const pullPage = await pages(fetchImpl, `${root}/pulls?state=all&sort=created&direction=desc`, token, maxPullPages);
  const commentPage = await pages(fetchImpl, `${root}/issues/comments?sort=created&direction=desc`, token, maxCommentPages);
  const issuePage = await pages(fetchImpl, `${root}/issues?state=all&sort=created&direction=desc`, token, maxIssuePages);
  const commentsByPull = new Map();
  for (const comment of commentPage.values) {
    const number = Number(/\/issues\/(\d+)$/.exec(comment?.issue_url ?? "")?.[1]);
    if (!Number.isSafeInteger(number)) continue;
    const list = commentsByPull.get(number) ?? [];
    list.push(comment);
    commentsByPull.set(number, list);
  }
  const issuesByNumber = new Map();
  for (const entry of issuePage.values) {
    if (!Number.isSafeInteger(entry?.number)) continue;
    issuesByNumber.set(entry.number, { state: entry.state,
      labels: (entry.labels ?? []).map(label => label?.name).filter(name => typeof name === "string") });
  }
  const pulls = [];
  for (const pull of pullPage.values) {
    if (!Number.isSafeInteger(pull?.number)) continue;
    const issue = Number(exactField(pull.body, "Control-Room-Issue"));
    const comments = [...(commentsByPull.get(pull.number) ?? []),
      ...(Number.isSafeInteger(issue) ? commentsByPull.get(issue) ?? [] : [])];
    const corrections = new Set(comments.map(comment => {
      const handoff = parseHandoff(comment);
      if (handoff?.phase === "complete" && handoff.state === "changes-required" && /^[a-f0-9]{40}$/.test(handoff.head ?? "")) return handoff.head;
      return /^CHANGES REQUIRED at exact head [`]?([a-f0-9]{40})[`]?[.\s]/im.exec(comment?.body ?? "")?.[1];
    }).filter(Boolean));
    pulls.push({ number: pull.number, author: pull.user?.login, body: pull.body, state: pull.state,
      merged: Boolean(pull.merged_at), comments,
      created_at: pull.created_at, merged_at: pull.merged_at, correctionRounds: corrections.size });
  }
  const allComments = [...commentsByPull.values()].flat();
  const pullIssue = new Map(pulls.map(pull => [pull.number, Number(exactField(pull.body, "Control-Room-Issue"))]));
  const knownIssues = new Set([...issuesByNumber.keys()]);
  const trusted = parseTrustedPhaseRecords(allComments,
    { trustedLogins: trustedMetricsLogins, pullIssue, knownIssues });
  let excludedWorkerRecords = 0;
  const workerRecords = pulls.flatMap(pull => {
    const issue = Number(exactField(pull.body, "Control-Room-Issue"));
    const model = parseReportedModel(pull.body);
    const metrics = parseReportedMetrics(pull.body);
    if (!model.valid || !Number.isSafeInteger(issue)) return [];
    const acceptedClaims = pull.comments.flatMap(comment => {
      if (comment?.user?.login !== "github-actions[bot]" || comment.user?.type !== "Bot") return [];
      const accepted = CLAIM_V3.exec(comment.body ?? "");
      return Number(accepted?.[1]) === issue && accepted?.[2] === pull.author
        ? [Number(accepted[3])] : [];
    }).filter(Number.isFinite);
    const startedMs = finiteInstant(metrics.startedAt);
    const claimBound = acceptedClaims.length === 1
      && (startedMs === undefined || startedMs >= acceptedClaims[0]);
    if (!claimBound) { excludedWorkerRecords++; return []; }
    return [{ role: "worker", model: model.model, effort: model.effort, issue, pr: pull.number, ...metrics }];
  });
  const coverage = summarizeWorkCoverage([...trusted.records, ...workerRecords], { nowMs, windowHours });
  return Object.freeze({ repository, generatedAt: new Date().toISOString(), selfReported: true,
    malformedPhaseRecords: trusted.malformed, untrustedPhaseRecords: trusted.untrusted,
    duplicatePhaseRecords: trusted.duplicate, excludedWorkerRecords,
    comparison: compareDelegatedToDirect({ pulls, issuesByNumber, phaseRecords: trusted.records }),
    acceptedOutcomes: summarizeAcceptedOutcomes(pulls, issuesByNumber, nowMs),
    flowCoverage: Object.freeze({ ...coverage, excludedUntrusted: trusted.untrusted + excludedWorkerRecords }),
    bottlenecks: summarizeCurrentBottlenecks(issuePage.values, nowMs),
    uncertainty: { truncated: pullPage.truncated || commentPage.truncated || issuePage.truncated },
    note: "Worker, reviewer and lead costs are self-reported and may be non-comparable across subscription cost, cached tokens, reasoning tokens, human help and provider routing. Waiting time is wall-clock time, never active model time." });
}

export function renderContributionMetrics(report) {
  const lines = [`Contribution costs for ${report.repository}`, "Worker, reviewer and lead costs are self-reported.",
    "GROUP | METHOD | ACCEPTED | MEDIAN ACTIVE MIN (UNKNOWN) | MEDIAN TOTAL TOKENS (UNKNOWN) | MEDIAN CLAIM TO MERGE (UNKNOWN) | FIRST PASS | MEDIAN CORRECTION ROUNDS"];
  for (const group of report.comparison) {
    for (const method of ["delegated", "direct"]) {
      const row = group[method];
      lines.push([group.group, method, row.accepted,
        `${row.medianActiveMinutes ?? "unknown"} (${row.activeMinutesUnknown})`,
        `${row.medianTotalTokens ?? "unknown"} (${row.totalTokensUnknown})`,
        `${renderDuration(row.medianClaimToMergeMs)} (${row.claimToMergeUnknown})`,
        row.firstPassAccepted, row.medianCorrectionRounds ?? "unknown"].join(" | "));
    }
    if (group.verdict === "comparable") {
      for (const entry of group.acceptedPer100kTokens ?? [])
        lines.push(`${group.group}: ${entry.method} accepted ${entry.accepted} outcome(s) per 100k reported tokens${entry.acceptedPer100kTokens === undefined ? " (unknown token base)" : ` = ${entry.acceptedPer100kTokens.toFixed(2)}`}; tokens unknown for ${entry.tokensUnknown}.`);
    } else {
      lines.push(`${group.group}: observations only — fewer than ${COMPARABLE_GROUP_MINIMUM} accepted outcomes per method; no winner declared.`);
    }
  }
  if (report.flowCoverage) {
    const flow = report.flowCoverage;
    lines.push("", `FLOW COVERAGE | LAST ${flow.windowHours}H`,
      `Reported work-session coverage: ${(flow.reportedCoveragePercent * 100).toFixed(1)}% (${flow.reportedCoverageMinutes.toFixed(1)} of ${flow.windowMinutes.toFixed(1)} minutes)`,
      `Reported active agent-minutes: ${flow.activeAgentMinutes.toFixed(1)} from ${flow.activeMinutesKnown} complete in-window session(s)`,
      `Longest unreported gap: ${flow.longestUnreportedGapMinutes.toFixed(1)} minutes`,
      `Timing unavailable: ${flow.timingUnknown}; loose: ${flow.timingLoose}; invalid: ${flow.timingInvalid}; boundary-partial: ${flow.boundaryPartial}`,
      `Untrusted or unbound timing excluded: ${flow.excludedUntrusted ?? 0}`,
      flow.note);
  }
  if (report.acceptedOutcomes) lines.push("",
    `ACCEPTED SUBSTANTIAL OUTCOMES | 24H ${report.acceptedOutcomes.accepted24h} | 7D ${report.acceptedOutcomes.accepted7d}`,
    `Unclassified merged pull requests in 7D: ${report.acceptedOutcomes.classificationUnknown}`,
    report.acceptedOutcomes.note);
  if (report.bottlenecks) {
    const overdue = report.bottlenecks.filter(row => row.overdue);
    lines.push("", `CURRENT BOTTLENECKS | ${overdue.length} overdue of ${report.bottlenecks.length} actionable issue(s)`);
    for (const row of overdue) lines.push(`#${row.issue} ${row.status} -> ${row.owner}; no GitHub activity for ${row.ageMinutes.toFixed(1)}m (target ${row.thresholdMinutes}m)`);
  }
  if (report.malformedPhaseRecords) lines.push(`WARNING: ${report.malformedPhaseRecords} malformed phase record(s) rejected into unknown.`);
  if (report.untrustedPhaseRecords) lines.push(`WARNING: ${report.untrustedPhaseRecords} untrusted or unbound phase record(s) excluded.`);
  if (report.duplicatePhaseRecords) lines.push(`WARNING: ${report.duplicatePhaseRecords} duplicate phase record(s) counted once.`);
  if (report.uncertainty.truncated) lines.push("WARNING: GitHub history was truncated; totals and comparisons are incomplete.");
  lines.push(report.note);
  return lines.join("\n");
}

function argumentsFor(argv) {
  const values = { repository: "AgenticBotSitter/agent-control-room", json: false,
    windowHours: DEFAULT_FLOW_WINDOW_HOURS, trustedMetricsLogins: [...DEFAULT_METRICS_MAINTAINERS] };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--") continue;
    if (argv[index] === "--json") values.json = true;
    else if (argv[index] === "--window-hours") values.windowHours = Number(argv[++index]);
    else if (argv[index] === "--trusted-login") values.trustedMetricsLogins.push(argv[++index]);
    else if (REPOSITORY.test(argv[index])) values.repository = argv[index];
    else throw new Error(`contribution_metrics_argument_invalid:${argv[index]}`);
  }
  return values;
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const report = await readContributionMetrics({ ...options, token: process.env.GITHUB_TOKEN });
  console.log(options.json ? JSON.stringify(report, null, 2) : renderContributionMetrics(report));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(`public-contribution-metrics: ${error.message}`); process.exitCode = 1; });
