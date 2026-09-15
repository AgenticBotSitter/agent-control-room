// Read-only outcome metrics grouped by the model a contributor reports in its PR body.
import { pathToFileURL } from "node:url";
import { parseHandoff } from "./review-handoff-controller.mjs";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9 ._:/+()-]{0,79}$/;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown"]);
const CORRECTION = /^CHANGES REQUIRED at exact head [`]?([a-f0-9]{40})[`]?[.\s]/im;
export const DEFAULT_MAX_PULL_PAGES = 5;
export const DEFAULT_MAX_COMMENT_PAGES = 20;
export const DEFAULT_MAX_ISSUE_PAGES = 20;

function exactField(body, name) {
  if (typeof body !== "string") return undefined;
  const matches = [...body.replace(/\r\n/g, "\n").matchAll(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "gmi"))];
  return matches.length === 1 ? matches[0][1] : undefined;
}

// Reused by the contribution-metrics report so both reports parse PR fields identically.
export { exactField };

export function parseReportedModel(body) {
  const rawModel = exactField(body, "Worker-Model");
  const rawEffort = exactField(body, "Worker-Effort");
  if (!rawModel || !MODEL.test(rawModel)) return { model: "unreported", effort: "unknown", valid: false };
  const effort = rawEffort?.toLowerCase();
  return { model: rawModel.trim().replace(/\s+/g, " "), effort: effort && EFFORTS.has(effort) ? effort : "unknown",
    valid: Boolean(effort && EFFORTS.has(effort)) };
}

// Optional self-reported worker cost fields. Every field is unknown (undefined)
// unless it appears exactly once with an exactly valid value — missing, duplicated,
// malformed, negative, non-finite or overflowed values are never guessed or coerced.
function parseMinutes(raw) {
  if (raw === undefined) return undefined;
  if (!/^\d+(\.\d+)?$/.test(raw.trim())) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseCount(raw) {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function parseReportedMetrics(body) {
  return {
    activeMinutes: parseMinutes(exactField(body, "Worker-Active-Minutes")),
    inputTokens: parseCount(exactField(body, "Worker-Input-Tokens")),
    outputTokens: parseCount(exactField(body, "Worker-Output-Tokens")),
    providerCalls: parseCount(exactField(body, "Worker-Provider-Calls")),
    interruptions: parseCount(exactField(body, "Worker-Interruptions")),
  };
}

// Median of the known values; undefined when none are known. Even counts average
// the two middle values. Used for active minutes and cycle-time durations.
export function median(values) {
  const known = values.filter(value => typeof value === "number" && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!known.length) return undefined;
  const middle = Math.floor(known.length / 2);
  return known.length % 2 ? known[middle] : (known[middle - 1] + known[middle]) / 2;
}

// Safe-integer addition that yields undefined (unknown) on any unknown input or
// overflow, so token totals can never wrap or carry a guessed value.
export function addCounts(...values) {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) return undefined;
    total += value;
    if (!Number.isSafeInteger(total)) return undefined;
  }
  return total;
}

function correctionHead(comment) {
  const handoff = parseHandoff(comment);
  if (handoff?.phase === "complete" && handoff.state === "changes-required" && /^[a-f0-9]{40}$/.test(handoff.head ?? ""))
    return handoff.head;
  return CORRECTION.exec(comment?.body ?? "")?.[1];
}

export function summarizeModelOutcomes(pulls) {
  const groups = new Map();
  for (const pull of pulls) {
    const reported = parseReportedModel(pull.body);
    const metrics = parseReportedMetrics(pull.body);
    const key = `${reported.model.toLowerCase()}\u0000${reported.effort}`;
    const row = groups.get(key) ?? { model: reported.model, effort: reported.effort, submissions: 0, merged: 0,
      open: 0, closedWithoutMerge: 0, correctionRequested: 0, correctionRounds: 0, firstPassMerges: 0,
      invalidOrMissingReport: 0, activeMinutes: [], activeMinutesUnknown: 0, inputTokens: 0, inputTokensUnknown: 0,
      outputTokens: 0, outputTokensUnknown: 0, providerCallsUnknown: 0, interruptionsUnknown: 0 };
    const corrections = new Set((pull.comments ?? []).map(correctionHead).filter(Boolean));
    row.submissions++;
    row.correctionRounds += corrections.size;
    if (corrections.size) row.correctionRequested++;
    if (!reported.valid) row.invalidOrMissingReport++;
    if (metrics.activeMinutes === undefined) row.activeMinutesUnknown++;
    else row.activeMinutes.push(metrics.activeMinutes);
    // A wrapped total would be a guessed value: on overflow the running total
    // itself becomes unknown and the overflowed contribution is counted there.
    for (const [field, unknownField] of [["inputTokens", "inputTokensUnknown"], ["outputTokens", "outputTokensUnknown"]]) {
      const value = metrics[field];
      if (value === undefined) { row[unknownField]++; continue; }
      const total = row[field] === undefined ? undefined : addCounts(row[field], value);
      if (total === undefined) row[unknownField]++;
      row[field] = total;
    }
    if (metrics.providerCalls === undefined) row.providerCallsUnknown++;
    if (metrics.interruptions === undefined) row.interruptionsUnknown++;
    if (pull.merged) { row.merged++; if (!corrections.size) row.firstPassMerges++; }
    else if (pull.state === "open") row.open++;
    else row.closedWithoutMerge++;
    groups.set(key, row);
  }
  return [...groups.values()].map(row => Object.freeze({ ...row,
    activeMinutesMedian: median(row.activeMinutes),
    mergeRate: row.submissions ? row.merged / row.submissions : undefined,
    correctionRate: row.submissions ? row.correctionRequested / row.submissions : undefined,
  })).sort((a, b) => b.submissions - a.submissions || a.model.localeCompare(b.model));
}

const CLAIM_ACCEPTED = /CLAIM ACCEPTED/;
const CLAIM_ACCEPTED_MS = /accepted=(\d{10,16})/;
const MINUTE_MS = 60_000;

function ms(value) {
  const time = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(time) && time >= 0 ? time : undefined;
}

// Objective GitHub cycle-time measurements for one linked issue. Every duration
// is milliseconds between two observed GitHub timestamps, or undefined when
// either endpoint is missing. Waiting time measures wall-clock time currently
// spent waiting — it is never presented as active model time.
export function summarizeIssueCycleTimes(pulls, issuesByNumber, nowMs = Date.now()) {
  const byIssue = new Map();
  for (const pull of pulls) {
    const issue = Number(exactField(pull.body, "Control-Room-Issue"));
    if (!Number.isSafeInteger(issue)) continue;
    const list = byIssue.get(issue) ?? [];
    list.push(pull);
    byIssue.set(issue, list);
  }
  const outcomes = [];
  for (const [issue, linked] of byIssue) {
    const comments = linked.flatMap(pull => pull.comments ?? []);
    const at = comment => ms(comment?.created_at);
    const claimComment = comments.filter(comment => CLAIM_ACCEPTED.test(comment?.body ?? ""))
      .sort((a, b) => (at(a) ?? Infinity) - (at(b) ?? Infinity))[0];
    let claimMs = at(claimComment);
    const acceptedMs = Number(CLAIM_ACCEPTED_MS.exec(claimComment?.body ?? "")?.[1]);
    if (Number.isSafeInteger(acceptedMs)) claimMs = acceptedMs;
    const completeRecords = comments
      .map(comment => ({ record: parseHandoff(comment), createdMs: at(comment) }))
      .filter(entry => entry.record?.phase === "complete" && entry.createdMs !== undefined);
    const submitMs = completeRecords.filter(entry => entry.record.state === "in-review")
      .map(entry => entry.createdMs).sort((a, b) => a - b)[0];
    const legacyCorrections = comments.filter(comment => CORRECTION.test(comment?.body ?? ""))
      .map(comment => at(comment)).filter(value => value !== undefined);
    const changesMs = [
      ...completeRecords.filter(entry => entry.record.state === "changes-required").map(entry => entry.createdMs),
      ...legacyCorrections,
    ].sort((a, b) => a - b)[0];
    const resubmitMs = completeRecords.filter(entry => entry.record.state === "re-review"
      && (changesMs === undefined || entry.createdMs >= changesMs)).map(entry => entry.createdMs)
      .sort((a, b) => a - b)[0];
    const decisionMs = [
      ...completeRecords.filter(entry => entry.record.state === "changes-required"
        || entry.record.action === "integrator").map(entry => entry.createdMs),
      ...legacyCorrections,
    ].sort((a, b) => a - b)[0];
    const firstPrMs = linked.map(pull => ms(pull.created_at)).filter(value => value !== undefined)
      .sort((a, b) => a - b)[0];
    const mergeMs = linked.map(pull => ms(pull.merged_at)).filter(value => value !== undefined)
      .sort((a, b) => a - b)[0];
    const span = (from, to) => (from === undefined || to === undefined || to < from) ? undefined : to - from;
    const labels = issuesByNumber?.get?.(issue)?.labels ?? [];
    const status = labels.filter(label => label.startsWith("status:")).sort()[0];
    const waitingOwner = mergeMs !== undefined ? undefined
      : status === "status:working" || status === "status:changes-required" ? "worker"
      : status === "status:in-review" || status === "status:re-review" ? "reviewer"
      : labels.includes("action:integrator") ? "integrator" : "unknown";
    const lastEventMs = [claimMs, firstPrMs, submitMs, decisionMs, resubmitMs]
      .filter(value => value !== undefined).sort((a, b) => a - b).at(-1);
    outcomes.push(Object.freeze({ issue,
      claimToFirstPrMs: span(claimMs, firstPrMs),
      submitToDecisionMs: span(submitMs, decisionMs),
      changesToResubmitMs: span(changesMs, resubmitMs),
      claimToMergeMs: span(claimMs, mergeMs),
      waitingMs: waitingOwner === undefined || lastEventMs === undefined ? undefined : Math.max(0, nowMs - lastEventMs),
      waitingOwner: waitingOwner ?? (mergeMs !== undefined ? "none" : "unknown"),
    }));
  }
  const aggregate = list => {
    const known = list.filter(value => value !== undefined);
    return { known: known.length, unknown: list.length - known.length, medianMs: median(known) };
  };
  const waiting = outcomes.filter(outcome => outcome.waitingMs !== undefined);
  const waitingGroups = new Map();
  for (const outcome of waiting) {
    const list = waitingGroups.get(outcome.waitingOwner) ?? [];
    list.push(outcome.waitingMs);
    waitingGroups.set(outcome.waitingOwner, list);
  }
  return Object.freeze({ outcomes: Object.freeze(outcomes),
    aggregate: Object.freeze({
      claimToFirstPr: aggregate(outcomes.map(outcome => outcome.claimToFirstPrMs)),
      submitToDecision: aggregate(outcomes.map(outcome => outcome.submitToDecisionMs)),
      changesToResubmit: aggregate(outcomes.map(outcome => outcome.changesToResubmitMs)),
      claimToMerge: aggregate(outcomes.map(outcome => outcome.claimToMergeMs)),
    }),
    waitingByOwner: Object.freeze([...waitingGroups].map(([owner, list]) =>
      ({ owner, issues: list.length, medianWaitingMs: median(list) }))),
  });
}

export function renderDuration(msValue) {
  if (msValue === undefined) return "unknown";
  if (msValue < MINUTE_MS) return `${Math.round(msValue / 1000)}s`;
  if (msValue < 24 * 60 * MINUTE_MS) return `${(msValue / MINUTE_MS).toFixed(1)}m`;
  return `${(msValue / (24 * 60 * MINUTE_MS)).toFixed(1)}d`;
}

async function api(fetchImpl, url, token) {
  const response = await fetchImpl(url, { headers: { accept: "application/vnd.github+json",
    ...(token ? { authorization: `Bearer ${token}` } : {}), "x-github-api-version": "2022-11-28",
    "user-agent": "agent-control-room-model-outcomes" } });
  if (!response?.ok) throw new Error(`model_outcomes_api_${response?.status ?? "invalid"}`);
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error("model_outcomes_api_invalid");
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

export async function readModelOutcomes({ repository = "AgenticBotSitter/agent-control-room", fetchImpl = fetch,
  token, maxPullPages = DEFAULT_MAX_PULL_PAGES, maxCommentPages = DEFAULT_MAX_COMMENT_PAGES,
  maxIssuePages = DEFAULT_MAX_ISSUE_PAGES } = {}) {
  if (!REPOSITORY.test(repository)) throw new Error("model_outcomes_repository_invalid");
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
    pulls.push({ body: pull.body, state: pull.state, merged: Boolean(pull.merged_at), comments,
      created_at: pull.created_at, merged_at: pull.merged_at });
  }
  const cycleTimes = summarizeIssueCycleTimes(pulls, issuesByNumber);
  return Object.freeze({ repository, generatedAt: new Date().toISOString(), selfReported: true,
    rows: summarizeModelOutcomes(pulls), cycleTimes,
    uncertainty: { truncated: pullPage.truncated || commentPage.truncated || issuePage.truncated },
    note: "Correction rate measures pull requests receiving at least one material changes-required review. It is not a general model-quality ranking." });
}

const percent = value => value === undefined ? "unknown" : `${(value * 100).toFixed(1)}%`;
const tokens = value => value === undefined ? "unknown" : `${value}`;
export function renderModelOutcomes(report) {
  const lines = [`Model outcomes for ${report.repository}`, "Model and effort are self-reported by contributors.",
    "MODEL | EFFORT | SUBMITTED | MERGED | CORRECTION REQUESTED | ROUNDS | CLOSED UNMERGED | MERGE RATE | CORRECTION RATE | MEDIAN ACTIVE MIN | INPUT TOKENS (UNKNOWN) | OUTPUT TOKENS (UNKNOWN)"];
  for (const row of report.rows) lines.push([row.model, row.effort, row.submissions, row.merged, row.correctionRequested,
    row.correctionRounds, row.closedWithoutMerge, percent(row.mergeRate), percent(row.correctionRate),
    row.activeMinutesMedian ?? "unknown", `${tokens(row.inputTokens)} (${row.inputTokensUnknown})`,
    `${tokens(row.outputTokens)} (${row.outputTokensUnknown})`].join(" | "));
  if (report.cycleTimes) {
    const aggregate = report.cycleTimes.aggregate;
    const cell = entry => `${renderDuration(entry.medianMs)} (n=${entry.known}, unknown=${entry.unknown})`;
    lines.push("CYCLE MEDIAN | CLAIM TO FIRST PR | SUBMIT TO DECISION | CHANGES TO RESUBMIT | CLAIM TO MERGE");
    lines.push(["cycle", cell(aggregate.claimToFirstPr), cell(aggregate.submitToDecision),
      cell(aggregate.changesToResubmit), cell(aggregate.claimToMerge)].join(" | "));
    for (const waiting of report.cycleTimes.waitingByOwner)
      lines.push(`Waiting on ${waiting.owner}: ${waiting.issues} issue(s), median ${renderDuration(waiting.medianWaitingMs)}. Waiting time is not active model time.`);
  }
  if (report.uncertainty.truncated) lines.push("WARNING: GitHub history was truncated; totals and comparisons are incomplete.");
  lines.push(report.note);
  return lines.join("\n");
}

async function main() {
  const json = process.argv.includes("--json");
  const repository = process.argv.find(value => REPOSITORY.test(value)) ?? "AgenticBotSitter/agent-control-room";
  const report = await readModelOutcomes({ repository, token: process.env.GITHUB_TOKEN });
  console.log(json ? JSON.stringify(report, null, 2) : renderModelOutcomes(report));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(`public-model-outcomes: ${error.message}`); process.exitCode = 1; });
