import { pathToFileURL } from "node:url";

const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACTION_MARKER = /<!-- agent-control-room-action:v1 worker=([A-Za-z0-9][A-Za-z0-9._:-]{2,79}) state=([a-z-]+) issue=(\d+) -->/;
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const WORKER_STATES = new Set(["changes-required", "working", "blocked"]);

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
  if (!response?.ok) throw new Error(`worker_inbox_api_${response?.status ?? "invalid"}`);
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
  token, fetchImpl = fetch, trustedLogins = ["MarvinAi5"] }) {
  if (!WORKER_ID.test(workerId ?? "")) throw new Error("worker_inbox_worker_id_invalid");
  if (!REPOSITORY.test(repository)) throw new Error("worker_inbox_repository_invalid");
  const root = `https://api.github.com/repos/${repository}`;
  const issues = await pages(fetchImpl, `${root}/issues?state=open&labels=action%3Aworker`, token);
  const actions = [];
  for (const issue of issues) {
    if (issue?.pull_request || !Number.isSafeInteger(issue?.number)) continue;
    const labels = labelsOf(issue);
    const statusLabels = labels.filter(label => label.startsWith("status:"));
    const actionLabels = labels.filter(label => label.startsWith("action:"));
    if (statusLabels.length !== 1 || actionLabels.length !== 1 || actionLabels[0] !== "action:worker") continue;
    const comments = await pages(fetchImpl, `${root}/issues/${issue.number}/comments?direction=asc`, token);
    const trustedMarkers = comments.flatMap(comment => {
      const marker = parseActionMarker(comment?.body);
      const trustedLogin = trustedLogins.includes(comment?.user?.login);
      return marker && (trustedLogin || TRUSTED_ASSOCIATIONS.has(comment?.author_association))
        && marker.issue === issue.number ? [{ marker, comment }] : [];
    });
    const latest = trustedMarkers.at(-1);
    if (!latest || latest.marker.workerId !== workerId || !WORKER_STATES.has(latest.marker.state)) continue;
    const expectedStatus = `status:${latest.marker.state}`;
    if (statusLabels[0] !== expectedStatus) continue;
    actions.push(Object.freeze({
      issue: issue.number,
      title: typeof issue.title === "string" ? issue.title : "",
      state: latest.marker.state,
      action: latest.marker.state === "changes-required" ? "Correct the existing pull request and request re-review."
        : latest.marker.state === "blocked" ? "Read the named blocker and provide the requested information or handoff."
          : "Continue the assigned implementation.",
      issueUrl: typeof issue.html_url === "string" ? issue.html_url : `${root.replace("api.github.com/repos", "github.com")}/issues/${issue.number}`,
      instructionUrl: typeof latest.comment?.html_url === "string" ? latest.comment.html_url : undefined,
    }));
  }
  return Object.freeze(actions.sort((a, b) => a.issue - b.issue));
}

export function renderWorkerInbox(workerId, actions) {
  if (!actions.length) return `No action currently assigned to worker ${workerId}.`;
  return [
    `ACTION REQUIRED for worker ${workerId}`,
    "",
    ...actions.flatMap(action => [
      `Issue #${action.issue}: ${action.title}`,
      `State: ${action.state}`,
      `Next: ${action.action}`,
      `Instructions: ${action.instructionUrl ?? action.issueUrl}`,
      "",
    ]),
  ].join("\n").trimEnd();
}

function argumentsFor(argv) {
  const values = { repository: "AgenticBotSitter/agent-control-room", json: false };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--worker-id") values.workerId = argv[++index];
    else if (argv[index] === "--repository") values.repository = argv[++index];
    else if (argv[index] === "--json") values.json = true;
    else throw new Error(`worker_inbox_argument_invalid:${argv[index]}`);
  }
  return values;
}

async function main() {
  const options = argumentsFor(process.argv.slice(2));
  const actions = await readWorkerInbox({ ...options, token: process.env.GITHUB_TOKEN });
  console.log(options.json ? JSON.stringify({ workerId: options.workerId, actions }, null, 2)
    : renderWorkerInbox(options.workerId, actions));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(`public-worker-inbox: ${error.message}`); process.exitCode = 1; });
