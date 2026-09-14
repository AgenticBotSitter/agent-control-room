// Read-only outcome metrics grouped by the model a contributor reports in its PR body.
import { pathToFileURL } from "node:url";
import { parseHandoff } from "./review-handoff-controller.mjs";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9 ._:/+()-]{0,79}$/;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown"]);
const CORRECTION = /^CHANGES REQUIRED at exact head [`]?([a-f0-9]{40})[`]?[.\s]/im;
export const DEFAULT_MAX_PULL_PAGES = 5;
export const DEFAULT_MAX_COMMENT_PAGES = 20;

function exactField(body, name) {
  if (typeof body !== "string") return undefined;
  const matches = [...body.replace(/\r\n/g, "\n").matchAll(new RegExp(`^${name}:\\s*(.+?)\\s*$`, "gmi"))];
  return matches.length === 1 ? matches[0][1] : undefined;
}

export function parseReportedModel(body) {
  const rawModel = exactField(body, "Worker-Model");
  const rawEffort = exactField(body, "Worker-Effort");
  if (!rawModel || !MODEL.test(rawModel)) return { model: "unreported", effort: "unknown", valid: false };
  const effort = rawEffort?.toLowerCase();
  return { model: rawModel.trim().replace(/\s+/g, " "), effort: effort && EFFORTS.has(effort) ? effort : "unknown",
    valid: Boolean(effort && EFFORTS.has(effort)) };
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
    const key = `${reported.model.toLowerCase()}\u0000${reported.effort}`;
    const row = groups.get(key) ?? { model: reported.model, effort: reported.effort, submissions: 0, merged: 0,
      open: 0, closedWithoutMerge: 0, correctionRequested: 0, correctionRounds: 0, firstPassMerges: 0,
      invalidOrMissingReport: 0 };
    const corrections = new Set((pull.comments ?? []).map(correctionHead).filter(Boolean));
    row.submissions++;
    row.correctionRounds += corrections.size;
    if (corrections.size) row.correctionRequested++;
    if (!reported.valid) row.invalidOrMissingReport++;
    if (pull.merged) { row.merged++; if (!corrections.size) row.firstPassMerges++; }
    else if (pull.state === "open") row.open++;
    else row.closedWithoutMerge++;
    groups.set(key, row);
  }
  return [...groups.values()].map(row => Object.freeze({ ...row,
    mergeRate: row.submissions ? row.merged / row.submissions : undefined,
    correctionRate: row.submissions ? row.correctionRequested / row.submissions : undefined,
  })).sort((a, b) => b.submissions - a.submissions || a.model.localeCompare(b.model));
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
  token, maxPullPages = DEFAULT_MAX_PULL_PAGES, maxCommentPages = DEFAULT_MAX_COMMENT_PAGES } = {}) {
  if (!REPOSITORY.test(repository)) throw new Error("model_outcomes_repository_invalid");
  const root = `https://api.github.com/repos/${repository}`;
  const pullPage = await pages(fetchImpl, `${root}/pulls?state=all&sort=created&direction=desc`, token, maxPullPages);
  const commentPage = await pages(fetchImpl, `${root}/issues/comments?sort=created&direction=desc`, token, maxCommentPages);
  const commentsByPull = new Map();
  for (const comment of commentPage.values) {
    const number = Number(/\/issues\/(\d+)$/.exec(comment?.issue_url ?? "")?.[1]);
    if (!Number.isSafeInteger(number)) continue;
    const list = commentsByPull.get(number) ?? [];
    list.push(comment);
    commentsByPull.set(number, list);
  }
  const pulls = [];
  for (const pull of pullPage.values) {
    if (!Number.isSafeInteger(pull?.number)) continue;
    const issue = Number(exactField(pull.body, "Control-Room-Issue"));
    const comments = [...(commentsByPull.get(pull.number) ?? []),
      ...(Number.isSafeInteger(issue) ? commentsByPull.get(issue) ?? [] : [])];
    pulls.push({ body: pull.body, state: pull.state, merged: Boolean(pull.merged_at), comments });
  }
  return Object.freeze({ repository, generatedAt: new Date().toISOString(), selfReported: true,
    rows: summarizeModelOutcomes(pulls), uncertainty: { truncated: pullPage.truncated || commentPage.truncated },
    note: "Correction rate measures pull requests receiving at least one material changes-required review. It is not a general model-quality ranking." });
}

const percent = value => value === undefined ? "unknown" : `${(value * 100).toFixed(1)}%`;
export function renderModelOutcomes(report) {
  const lines = [`Model outcomes for ${report.repository}`, "Model and effort are self-reported by contributors.",
    "MODEL | EFFORT | SUBMITTED | MERGED | CORRECTION REQUESTED | ROUNDS | CLOSED UNMERGED | MERGE RATE | CORRECTION RATE"];
  for (const row of report.rows) lines.push([row.model, row.effort, row.submissions, row.merged, row.correctionRequested,
    row.correctionRounds, row.closedWithoutMerge, percent(row.mergeRate), percent(row.correctionRate)].join(" | "));
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
