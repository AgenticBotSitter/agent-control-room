const CLAIM_HEADER = "CLAIM REQUEST";
const WORKER_LINE = /^worker-id: ([A-Za-z0-9][A-Za-z0-9._:-]{2,79})$/;
const MARKER_PREFIX = "<!-- agent-control-room-claim:v1";

export function parseClaimRequest(body) {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > 512) return undefined;
  const lines = body.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.length !== 2 || lines[0] !== CLAIM_HEADER) return undefined;
  const match = WORKER_LINE.exec(lines[1]);
  return match ? Object.freeze({ workerId: match[1] }) : undefined;
}

const labelNames = issue => (Array.isArray(issue?.labels) ? issue.labels.map(label =>
  typeof label === "string" ? label : label?.name).filter(value => typeof value === "string") : []);
const unique = values => [...new Set(values)];
const marker = issueNumber => `${MARKER_PREFIX} issue=${issueNumber} -->`;
const pendingBody = (issueNumber, workerId) => [
  "CLAIM PENDING — the serialized controller is reserving this issue.",
  "",
  `Worker identity: \`${workerId}\``,
  "",
  "Do not begin work until this same comment says `CLAIM ACCEPTED`.",
  marker(issueNumber),
].join("\n");
const acceptedBody = (issueNumber, workerId, baseSha) => [
  `CLAIM ACCEPTED — worker identity \`${workerId}\`.`,
  "",
  `Outcome: public issue #${issueNumber} as currently defined`,
  `Base: \`${baseSha}\``,
  "Target: `main`",
  "",
  "Use the owned paths, acceptance checks, effect limits and handoff requirements in this issue. " +
    "This reservation does not authorize credentials, live services, deployment or other effects not stated there.",
  marker(issueNumber),
].join("\n");

function acceptedMarker(comment, issueNumber) {
  return comment?.user?.login === "github-actions[bot]" && comment?.user?.type === "Bot"
    && typeof comment?.body === "string" && comment.body.includes(marker(issueNumber))
    && comment.body.startsWith("CLAIM ACCEPTED —");
}

async function commentsFor(api, repository, issueNumber) {
  const comments = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api.request("GET", `/repos/${repository}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("claim_controller_api_invalid");
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new Error("claim_controller_comment_history_ambiguous");
}

async function issueFor(api, repository, issueNumber) {
  const issue = await api.request("GET", `/repos/${repository}/issues/${issueNumber}`);
  if (!issue || typeof issue !== "object" || issue.number !== issueNumber) throw new Error("claim_controller_api_invalid");
  return issue;
}

function isReady(issue) {
  const labels = labelNames(issue);
  const statuses = labels.filter(label => label.startsWith("status:"));
  return issue.state === "open" && !issue.pull_request
    && statuses.length === 1 && statuses[0] === "status:ready";
}

function workingLabels(original) {
  return unique([...original.filter(label => label !== "status:ready" && label !== "help wanted"), "status:working"]);
}

/** Serialized GitHub controller. The accepted comment is the sole permission to start work.
 * A pending marker is deliberately non-authoritative and is removed after a failed attempt. */
export async function runClaimController({ event, repository, api }) {
  const request = parseClaimRequest(event?.comment?.body);
  if (!request || event?.action !== "created" || event?.issue?.pull_request
    || !Number.isSafeInteger(event?.issue?.number) || event.issue.number < 1
    || typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || !api || typeof api.request !== "function") return Object.freeze({ status: "ignored" });

  const issueNumber = event.issue.number;
  const current = await issueFor(api, repository, issueNumber);
  if (!isReady(current)) return Object.freeze({ status: "refused", reason: "issue_not_ready" });
  const comments = await commentsFor(api, repository, issueNumber);
  if (comments.some(comment => acceptedMarker(comment, issueNumber)))
    return Object.freeze({ status: "refused", reason: "already_accepted" });

  const ref = await api.request("GET", `/repos/${repository}/git/ref/heads/main`);
  const baseSha = ref?.object?.sha;
  if (typeof baseSha !== "string" || !/^[a-f0-9]{40}$/.test(baseSha)) throw new Error("claim_controller_api_invalid");
  const originalLabels = unique(labelNames(current));
  const nextLabels = workingLabels(originalLabels);
  let pendingId;
  let labelsChanged = false;
  try {
    const pending = await api.request("POST", `/repos/${repository}/issues/${issueNumber}/comments`,
      { body: pendingBody(issueNumber, request.workerId) });
    if (!Number.isSafeInteger(pending?.id)) throw new Error("claim_controller_api_invalid");
    pendingId = pending.id;
    await api.request("PUT", `/repos/${repository}/issues/${issueNumber}/labels`, { labels: nextLabels });
    labelsChanged = true;
    const verified = await issueFor(api, repository, issueNumber);
    const verifiedLabels = labelNames(verified);
    if (verified.state !== "open" || verifiedLabels.filter(label => label === "status:working").length !== 1
      || verifiedLabels.includes("status:ready") || verifiedLabels.includes("help wanted"))
      throw new Error("claim_controller_state_changed");
    const accepted = acceptedBody(issueNumber, request.workerId, baseSha);
    await api.request("PATCH", `/repos/${repository}/issues/comments/${pendingId}`, { body: accepted });
    return Object.freeze({ status: "accepted", workerId: request.workerId, issueNumber, baseSha });
  } catch (error) {
    // A lost response to the final edit is reconciled by reading the deterministic marker.
    if (pendingId !== undefined) {
      try {
        const saved = await api.request("GET", `/repos/${repository}/issues/comments/${pendingId}`);
        if (acceptedMarker(saved, issueNumber) && labelsChanged) {
          const issue = await issueFor(api, repository, issueNumber);
          if (labelNames(issue).includes("status:working"))
            return Object.freeze({ status: "accepted", workerId: request.workerId, issueNumber, baseSha, reconciled: true });
        }
      } catch { /* Continue conservative rollback. */ }
      if (labelsChanged) {
        try { await api.request("PUT", `/repos/${repository}/issues/${issueNumber}/labels`, { labels: originalLabels }); }
        catch { throw new Error("claim_controller_cleanup_uncertain", { cause: error }); }
      }
      try { await api.request("DELETE", `/repos/${repository}/issues/comments/${pendingId}`); }
      catch { throw new Error("claim_controller_cleanup_uncertain", { cause: error }); }
    }
    throw error;
  }
}

function githubApi(token) {
  return Object.freeze({ async request(method, path, body) {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28", "user-agent": "agent-control-room-claim-controller" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`claim_controller_api_${response.status}`);
    if (response.status === 204) return undefined;
    return response.json();
  } });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { readFile } = await import("node:fs/promises");
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!eventPath || !repository || !token) throw new Error("claim_controller_environment_invalid");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const result = await runClaimController({ event, repository, api: githubApi(token) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
