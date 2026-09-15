import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACTION_MARKER = /<!-- agent-control-room-action:v1 worker=([A-Za-z0-9][A-Za-z0-9._:-]{2,79}) state=([a-z-]+) issue=(\d+) -->/;
const STATES = new Set(["working", "in-review", "changes-required", "re-review", "paused"]);
const CLAIM_MARKER = /<!-- agent-control-room-claim:v2 issue=(\d+) request=(\d+) actor=([^\s]+) worker=([A-Za-z0-9][A-Za-z0-9._:-]{2,79}) -->/;
const controller = comment => comment?.user?.login === "github-actions[bot]" && comment?.user?.type === "Bot";

export function parseHandoffMarker(body) {
  if (typeof body !== "string") return undefined;
  const matches = [...body.matchAll(/<!-- agent-control-room-handoff:v1 (\{[^\n]*\}) -->/g)];
  if (matches.length !== 1) return undefined;
  try {
    const value = JSON.parse(matches[0][1]);
    if (!Number.isSafeInteger(value.issue) || value.issue < 1 || !WORKER_ID.test(value.workerId ?? "")
      || !STATES.has(value.state) || !["worker", "reviewer", "integrator"].includes(value.action)
      || !["pending", "complete"].includes(value.phase) || typeof value.acknowledged !== "boolean") return undefined;
    return Object.freeze(value);
  } catch { return undefined; }
}

function labelsOf(issue) {
  return (Array.isArray(issue?.labels) ? issue.labels : [])
    .map(label => typeof label === "string" ? label : label?.name)
    .filter(label => typeof label === "string");
}

export function parseActionMarker(body) {
  if (typeof body !== "string") return undefined;
  const match = ACTION_MARKER.exec(body);
  if (!match) return undefined;
  return Object.freeze({ workerId: match[1], state: match[2], issue: Number(match[3]) });
}

async function apiJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, { headers: {
    accept: "application/vnd.github+json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    "x-github-api-version": "2022-11-28",
    "user-agent": "agent-control-room-worker-inbox",
  } });
  if (!response?.ok) {
    const status = response?.status ?? "invalid";
    if (status === 403 || status === 429) throw new Error("worker_inbox_rate_limited");
    throw new Error(`worker_inbox_api_${status}`);
  }
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error("worker_inbox_api_invalid");
  return value;
}

async function pages(fetchImpl, url, token, maxPages = 10) {
  const values = [];
  for (let page = 1; page <= maxPages; page++) {
    const separator = url.includes("?") ? "&" : "?";
    const batch = await apiJson(fetchImpl, `${url}${separator}per_page=100&page=${page}`, token);
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  throw new Error("worker_inbox_history_ambiguous");
}

export async function readWorkerInbox({ workerId, repository = "AgenticBotSitter/agent-control-room",
  token, fetchImpl = fetch }) {
  if (!WORKER_ID.test(workerId ?? "")) throw new Error("worker_inbox_worker_id_invalid");
  if (!REPOSITORY.test(repository)) throw new Error("worker_inbox_repository_invalid");
  const root = `https://api.github.com/repos/${repository}`;
  const issues = await pages(fetchImpl, `${root}/issues?state=open`, token);
  const actions = [];
  for (const issue of issues) {
    if (issue?.pull_request || !Number.isSafeInteger(issue?.number)) continue;
    const labels = labelsOf(issue);
    const statusLabels = labels.filter(label => label.startsWith("status:"));
    const actionLabels = labels.filter(label => label.startsWith("action:"));
    const base = {
      workerId,
      issue: issue.number,
      title: typeof issue.title === "string" ? issue.title : "",
      issueUrl: typeof issue.html_url === "string" ? issue.html_url : `${root.replace("api.github.com/repos", "github.com")}/issues/${issue.number}`,
    };
    let comments;
    try { comments = await pages(fetchImpl, `${root}/issues/${issue.number}/comments?direction=asc`, token); }
    catch (error) {
      if (error?.message === "worker_inbox_rate_limited") throw error;
      actions.push(Object.freeze({ ...base, state: "attention", disposition: "attention", trust: "unverified",
        action: "History could not be verified; refresh before continuing.", reason: /^worker_inbox_/.test(error.message) ? error.message : "worker_inbox_history_unavailable" }));
      continue;
    }
    // Comment creation IDs determine ordering; edits and acknowledgement do not reassign work.
    comments = comments.map((comment, index) => ({ comment, index })).sort((a, b) =>
      Number.isSafeInteger(a.comment.id) && Number.isSafeInteger(b.comment.id) ? a.comment.id - b.comment.id : a.index - b.index)
      .map(item => item.comment);
    const records = comments.flatMap((comment, order) => {
      const legacy = parseActionMarker(comment?.body);
      if (legacy) return [{ marker: legacy, comment, order, trust: "advisory" }];
      if (!controller(comment)) return [];
      const handoff = parseHandoffMarker(comment.body);
      if (handoff) return [{ marker: handoff, comment, order, trust: "controller-record", kind: "handoff" }];
      const claim = CLAIM_MARKER.exec(comment.body ?? "");
      const outcome = /^CLAIM (ACCEPTED|REVOKED|PENDING) —/.exec(comment.body ?? "");
      if (claim && outcome) return [{ marker: { issue: Number(claim[1]), workerId: claim[4], state: "working" },
        comment, order, trust: "controller-record", kind: "claim", outcome: outcome[1] }];
      return [];
    });
    const official = records.filter(record => record.trust === "controller-record" && record.marker.issue === issue.number);
    const claim = official.filter(record => record.kind === "claim").at(-1);
    const assignment = claim?.outcome === "REVOKED" ? claim : official.at(-1);
    // Public advice may add a visible correction but cannot reassign a controller reservation.
    if (assignment && assignment.marker.workerId !== workerId) continue;
    const advisory = records.filter(record => record.trust === "advisory" && record.marker.workerId === workerId
      && (!assignment || record.order > assignment.order)).at(-1);
    const wrongIssue = records.filter(record => record.trust === "controller-record"
      && record.marker.issue !== issue.number && record.marker.workerId === workerId).at(-1);
    const controllerStop = assignment?.kind === "handoff" && assignment.marker.phase === "complete"
      && assignment.marker.state === "paused" && assignment.marker.action === "worker";
    const latest = assignment?.outcome === "REVOKED" || controllerStop ? assignment : advisory ?? assignment ?? wrongIssue;
    const malformed = comments.some(comment => controller(comment) && comment.body?.includes("<!-- agent-control-room-handoff:v1") && !parseHandoffMarker(comment.body));
    const conflicting = statusLabels.length > 1 || actionLabels.length > 1;
    if (latest && latest.marker.workerId !== workerId) continue;
    if (!latest && !conflicting && !malformed) continue;
    const marker = latest?.marker;
    const revoked = latest?.outcome === "REVOKED";
    const mismatch = marker && (marker.issue !== issue.number || statusLabels.length !== 1
      || statusLabels[0] !== `status:${marker.state}` || (latest.kind === "handoff" && actionLabels[0] !== `action:${marker.action}`));
    const attention = !latest || latest.trust === "advisory" || conflicting || malformed || mismatch || marker?.state === "blocked"
      || latest?.outcome === "PENDING" || marker?.phase === "pending";
    const waiting = ["in-review", "re-review"].includes(marker?.state);
    const disposition = revoked || controllerStop ? "stop" : attention ? "attention" : waiting ? "waiting" : marker?.state === "paused" ? "paused" : "action";
    const next = revoked ? "STOP. The controller revoked this assignment; do not start or continue work."
      : controllerStop ? "STOP work and report HANDOFF stopped, referencing this controller marker comment."
        : latest?.trust === "advisory" ? "Read this ADVISORY request and verify the current controller assignment before taking action."
      : attention ? "Read the issue and reconcile incomplete history, labels, or handoff before continuing."
        : waiting ? "Wait for review; do not begin another implementation pass."
          : marker?.state === "paused" ? "Wait for the named dependency or decision."
            : marker?.state === "changes-required" ? "Correct the existing pull request and request re-review."
              : "Continue the assigned implementation within the accepted claim and issue limits.";
    actions.push(Object.freeze({ ...base, state: attention && !revoked && !controllerStop ? "attention" : revoked ? "revoked" : marker.state,
      disposition, trust: latest?.trust ?? "unverified", action: next,
      markerState: marker?.state, markerCommentId: latest?.comment.id,
      requestedAt: latest?.comment.created_at, head: marker?.head, pr: marker?.pr,
      instruction: latest?.kind === "handoff" && typeof marker?.instruction === "string" ? marker.instruction : undefined,
      instructionUrl: latest?.comment.html_url, acknowledged: marker?.acknowledged,
      ...(latest?.kind === "handoff" && marker.phase === "complete" && !marker.acknowledged
        && (marker.state === "changes-required" || controllerStop)
        ? { acknowledgment: `${controllerStop ? "Report HANDOFF stopped" : "Acknowledge handoff"} for marker comment ${latest.comment.id} using the controller acknowledgment request.` } : {}),
    }));
  }
  return Object.freeze(actions.sort((a, b) => a.issue - b.issue));
}

export function renderWorkerInbox(workerId, actions) {
  if (!actions.length) return `No current assignment found for worker ${workerId} in verified open-issue history.`;
  return [
    `WORKER INBOX for worker ${workerId}`,
    "Controller records coordinate cooperative work; they do not grant execution authority. ADVISORY markers are unverified requests, including shared-login posts and account associations.",
    "",
    ...actions.flatMap(action => [
      `Issue #${action.issue}: ${action.title}`,
      `State: ${action.state}`,
      ...(action.markerState && action.markerState !== action.state ? [`Requested state: ${action.markerState}`] : []),
      `Record: ${action.trust === "advisory" ? "ADVISORY" : action.trust}; ${action.disposition}`,
      `Next: ${action.action}`,
      ...(action.acknowledgment ? [action.acknowledgment] : []),
      ...(action.pr ? [`Pull request: ${action.issueUrl.replace(/\/issues\/\d+$/, `/pull/${action.pr}`)}`] : []),
      ...(action.head ? [`Reviewed/submitted commit: ${action.head}`] : []),
      ...(action.instruction ? ["Correction details:", action.instruction] : []),
      `Instructions: ${action.instructionUrl ?? action.issueUrl}`,
      "",
    ]),
  ].join("\n").trimEnd();
}

function argumentsFor(argv) {
  const values = { repository: "AgenticBotSitter/agent-control-room", json: false, tokenFromGh: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--worker-id") values.workerId = argv[++index];
    else if (argv[index] === "--repository") values.repository = argv[++index];
    else if (argv[index] === "--json") values.json = true;
    else if (argv[index] === "--token-from-gh") values.tokenFromGh = true;
    else throw new Error(`worker_inbox_argument_invalid:${argv[index]}`);
  }
  return values;
}

export function resolveInboxToken({ environment = process.env, tokenFromGh = false, runCommand = spawnSync } = {}) {
  const direct = environment?.GITHUB_TOKEN;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (!tokenFromGh) return undefined;
  const result = runCommand("gh", ["auth", "token"], { encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
  if (!result || result.status !== 0) throw new Error("worker_inbox_gh_token_unavailable");
  const value = String(result.stdout ?? "").trim();
  return value || undefined;
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const token = resolveInboxToken({ tokenFromGh: options.tokenFromGh });
  const actions = await readWorkerInbox({ ...options, token });
  console.log(options.json ? JSON.stringify({ workerId: options.workerId, actions }, null, 2)
    : renderWorkerInbox(options.workerId, actions));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(`public-worker-inbox: ${error.message}`); process.exitCode = 1; });
