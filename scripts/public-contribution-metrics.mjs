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

// Maintainer append template for recording one lead phase without changing
// workflow authority. Post the filled block as a comment on the issue or PR.
// Unknown stays null; never guess a count the provider did not report.
/*
<!-- acr-contribution-metrics:v1 {"schema":"acr-contribution-metrics:v1","role":"lead-review","model":"PROVIDER/MODEL","effort":"medium","activeMinutes":25,"inputTokens":12000,"outputTokens":800,"providerCalls":3,"interruptions":0,"startedAt":"2026-09-01T10:00:00.000Z","endedAt":"2026-09-01T10:25:00.000Z","issue":223,"pr":null,"interrupted":false} -->
*/
export const LEAD_PHASE_TEMPLATE_ROLES = ["lead-packet", "lead-review", "lead-correction", "lead-integration", "lead-direct"];

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
  maxIssuePages = DEFAULT_MAX_ISSUE_PAGES } = {}) {
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
    issuesByNumber.set(entry.number, { labels: (entry.labels ?? []).map(label => label?.name).filter(name => typeof name === "string") });
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
    pulls.push({ number: pull.number, body: pull.body, state: pull.state, merged: Boolean(pull.merged_at), comments,
      created_at: pull.created_at, merged_at: pull.merged_at, correctionRounds: corrections.size });
  }
  const allComments = [...commentsByPull.values()].flat();
  const { records, malformed } = parsePhaseRecords(allComments);
  return Object.freeze({ repository, generatedAt: new Date().toISOString(), selfReported: true,
    malformedPhaseRecords: malformed,
    comparison: compareDelegatedToDirect({ pulls, issuesByNumber, phaseRecords: records }),
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
  if (report.malformedPhaseRecords) lines.push(`WARNING: ${report.malformedPhaseRecords} malformed phase record(s) rejected into unknown.`);
  if (report.uncertainty.truncated) lines.push("WARNING: GitHub history was truncated; totals and comparisons are incomplete.");
  lines.push(report.note);
  return lines.join("\n");
}

async function main() {
  const json = process.argv.includes("--json");
  const repository = process.argv.find(value => REPOSITORY.test(value)) ?? "AgenticBotSitter/agent-control-room";
  const report = await readContributionMetrics({ repository, token: process.env.GITHUB_TOKEN });
  console.log(json ? JSON.stringify(report, null, 2) : renderContributionMetrics(report));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(`public-contribution-metrics: ${error.message}`); process.exitCode = 1; });
