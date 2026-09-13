const CLAIM_HEADER = "CLAIM REQUEST";
const WORKER_LINE = /^worker-id: ([A-Za-z0-9][A-Za-z0-9._:-]{2,79})$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?(?:\[bot\])?$/;
const MARKER_PREFIX = "<!-- agent-control-room-claim:v2";

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
const normalizedLabels = issue => unique(labelNames(issue)).sort();
const sameLabels = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const marker = value => `${MARKER_PREFIX} issue=${value.issueNumber} request=${value.requestId} actor=${value.actor} worker=${value.workerId} -->`;
const pendingBody = value => ["CLAIM PENDING — the repository controller is reserving this issue.", "",
  `GitHub actor: \`@${value.actor}\``, `Worker identity: \`${value.workerId}\``, "",
  "Do not begin work until this same comment says `CLAIM ACCEPTED`.", marker(value)].join("\n");
const acceptedBody = (value, sha) => [`CLAIM ACCEPTED — \`@${value.actor}\` using worker identity \`${value.workerId}\`.`, "",
  `Outcome: public issue #${value.issueNumber} as currently defined`, `Base: \`${sha}\``, "Target: `main`", "",
  "This reservation grants no repository authority. Use only the issue's owned paths, checks and effect limits.", marker(value)].join("\n");
const revokedBody = value => ["CLAIM REVOKED — STOP; maintainer state changed.", "",
  `GitHub actor: \`@${value.actor}\``, `Worker identity: \`${value.workerId}\``, "",
  "This record is not permission to start or continue work.", marker(value)].join("\n");
const controllerComment = (comment, value, state) => comment?.user?.login === "github-actions[bot]"
  && comment?.user?.type === "Bot" && typeof comment?.body === "string"
  && comment.body.startsWith(`CLAIM ${state} —`) && comment.body.includes(marker(value));

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

async function issueFor(api, repository, number) {
  const issue = await api.request("GET", `/repos/${repository}/issues/${number}`);
  if (!issue || typeof issue !== "object" || issue.number !== number) throw new Error("claim_controller_api_invalid");
  return issue;
}

async function activePairExists(api, repository, value, excludeIssue) {
  for (let page = 1; page <= 10; page++) {
    const issues = await api.request("GET", `/repos/${repository}/issues?state=open&labels=status%3Aworking&per_page=100&page=${page}`);
    if (!Array.isArray(issues)) throw new Error("claim_controller_api_invalid");
    for (const issue of issues) {
      if (issue?.pull_request || !Number.isSafeInteger(issue?.number) || issue.number === excludeIssue) continue;
      const pair = ` actor=${value.actor} worker=${value.workerId} -->`;
      if ((await commentsFor(api, repository, issue.number)).some(comment => comment?.user?.login === "github-actions[bot]"
        && comment?.user?.type === "Bot" && typeof comment.body === "string"
        && comment.body.startsWith("CLAIM ACCEPTED —") && comment.body.includes(MARKER_PREFIX) && comment.body.includes(pair))) return true;
    }
    if (issues.length < 100) return false;
  }
  throw new Error("claim_controller_working_set_ambiguous");
}

function isReady(issue) {
  const statuses = labelNames(issue).filter(label => label.startsWith("status:"));
  return issue.state === "open" && !issue.pull_request && statuses.length === 1 && statuses[0] === "status:ready";
}
const workingLabels = original => unique([...original.filter(label => label !== "status:ready" && label !== "help wanted"), "status:working"]).sort();
const exactState = (issue, labels) => issue.state === "open" && !issue.pull_request && sameLabels(normalizedLabels(issue), labels);
const safeWorkingExtension = (issue, expected) => {
  const actual = normalizedLabels(issue);
  const statuses = actual.filter(label => label.startsWith("status:"));
  return issue.state === "open" && !issue.pull_request && statuses.length === 1 && statuses[0] === "status:working"
    && expected.every(label => actual.includes(label));
};
const safelyWorking = issue => issue.state === "open" && !issue.pull_request
  && labelNames(issue).filter(label => label.startsWith("status:")).join("") === "status:working";
const liveAcceptedHistory = (comments, issueNumber) => comments.some(comment =>
  comment?.user?.login === "github-actions[bot]" && comment?.user?.type === "Bot"
  && typeof comment.body === "string" && comment.body.startsWith("CLAIM ACCEPTED —")
  && comment.body.includes(`${MARKER_PREFIX} issue=${issueNumber} `));

async function removeLabel(api, repository, issueNumber, label) {
  let error;
  try { await api.request("DELETE", `/repos/${repository}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`); }
  catch (cause) { error = cause; }
  const fresh = await issueFor(api, repository, issueNumber);
  if (labelNames(fresh).includes(label)) throw new Error("claim_controller_cleanup_uncertain", { cause: error });
}

async function addLabels(api, repository, issueNumber, labels) {
  let error;
  try { await api.request("POST", `/repos/${repository}/issues/${issueNumber}/labels`, { labels }); }
  catch (cause) { error = cause; }
  const fresh = await issueFor(api, repository, issueNumber);
  if (!labels.every(label => labelNames(fresh).includes(label)))
    throw new Error("claim_controller_cleanup_uncertain", { cause: error });
}

async function recoverPending(api, repository, value) {
  const matches = (await commentsFor(api, repository, value.issueNumber))
    .filter(comment => controllerComment(comment, value, "PENDING") || controllerComment(comment, value, "ACCEPTED"));
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id)) throw new Error("claim_controller_pending_ambiguous");
  return matches[0];
}

/** Only an actor-and-worker-bound accepted controller comment grants a reservation. */
export async function runClaimController({ event, repository, api }) {
  const request = parseClaimRequest(event?.comment?.body);
  const actor = event?.comment?.user?.login;
  const requestId = event?.comment?.id;
  if (!request || event?.action !== "created" || event?.issue?.pull_request
    || !Number.isSafeInteger(event?.issue?.number) || event.issue.number < 1
    || !Number.isSafeInteger(requestId) || requestId < 1 || typeof actor !== "string" || !LOGIN.test(actor)
    || typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || !api || typeof api.request !== "function") return Object.freeze({ status: "ignored" });

  const value = { issueNumber: event.issue.number, requestId, actor, workerId: request.workerId };
  const current = await issueFor(api, repository, value.issueNumber);
  if (!isReady(current)) return Object.freeze({ status: "refused", reason: "issue_not_ready" });
  if (liveAcceptedHistory(await commentsFor(api, repository, value.issueNumber), value.issueNumber))
    return Object.freeze({ status: "refused", reason: "accepted_history_requires_release" });
  if (await activePairExists(api, repository, value)) return Object.freeze({ status: "refused", reason: "actor_worker_pair_active" });
  const ref = await api.request("GET", `/repos/${repository}/git/ref/heads/main`);
  const baseSha = ref?.object?.sha;
  if (typeof baseSha !== "string" || !/^[a-f0-9]{40}$/.test(baseSha)) throw new Error("claim_controller_api_invalid");
  const originalLabels = normalizedLabels(current);
  const nextLabels = workingLabels(originalLabels);
  let transitionLabels = nextLabels;
  let pendingId;
  let transitionStarted = false;
  let workingAttempted = false;
  try {
    try {
      const pending = await api.request("POST", `/repos/${repository}/issues/${value.issueNumber}/comments`, { body: pendingBody(value) });
      if (!Number.isSafeInteger(pending?.id)) throw new Error("claim_controller_api_invalid");
      pendingId = pending.id;
    } catch (error) {
      const saved = await recoverPending(api, repository, value);
      pendingId = saved.id;
      if (controllerComment(saved, value, "ACCEPTED")) {
        const acceptedIssue = await issueFor(api, repository, value.issueNumber);
        if (!safelyWorking(acceptedIssue)) throw new Error("claim_controller_state_changed");
        return Object.freeze({ status: "accepted", workerId: value.workerId, actor,
          issueNumber: value.issueNumber, baseSha, reconciled: true });
      }
      if (!controllerComment(saved, value, "PENDING")) throw error;
    }

    const fresh = await issueFor(api, repository, value.issueNumber);
    if (!exactState(fresh, originalLabels) || !isReady(fresh)) throw new Error("claim_controller_state_changed");
    transitionStarted = true;
    await removeLabel(api, repository, value.issueNumber, "status:ready");
    if (originalLabels.includes("help wanted")) await removeLabel(api, repository, value.issueNumber, "help wanted");
    workingAttempted = true;
    await addLabels(api, repository, value.issueNumber, ["status:working"]);
    const afterPut = await issueFor(api, repository, value.issueNumber);
    if (exactState(afterPut, nextLabels) || safeWorkingExtension(afterPut, nextLabels)) {
      transitionLabels = normalizedLabels(afterPut);
    }
    else throw new Error("claim_controller_state_changed");

    if (await activePairExists(api, repository, value, value.issueNumber)) throw new Error("claim_controller_pair_race");
    if (!exactState(await issueFor(api, repository, value.issueNumber), transitionLabels)) throw new Error("claim_controller_state_changed");
    const body = acceptedBody(value, baseSha);
    let reconciled = false;
    try { await api.request("PATCH", `/repos/${repository}/issues/comments/${pendingId}`, { body }); }
    catch (error) {
      const saved = await api.request("GET", `/repos/${repository}/issues/comments/${pendingId}`);
      if (!controllerComment(saved, value, "ACCEPTED")) throw error;
      reconciled = true;
    }
    const finalIssue = await issueFor(api, repository, value.issueNumber);
    const finalComment = await api.request("GET", `/repos/${repository}/issues/comments/${pendingId}`);
    if (!exactState(finalIssue, transitionLabels) || !controllerComment(finalComment, value, "ACCEPTED")) throw new Error("claim_controller_state_changed");
    return Object.freeze({ status: "accepted", workerId: value.workerId, actor, issueNumber: value.issueNumber, baseSha,
      ...(reconciled ? { reconciled: true } : {}) });
  } catch (error) {
    if (pendingId !== undefined) {
      try {
        const saved = await api.request("GET", `/repos/${repository}/issues/comments/${pendingId}`);
        const issue = await issueFor(api, repository, value.issueNumber);
        if (controllerComment(saved, value, "ACCEPTED") && exactState(issue, transitionLabels))
          return Object.freeze({ status: "accepted", workerId: value.workerId, actor, issueNumber: value.issueNumber, baseSha, reconciled: true });
      } catch { /* Continue only with fresh exact-state recovery. */ }
      const savedBeforeCleanup = await api.request("GET", `/repos/${repository}/issues/comments/${pendingId}`);
      if (controllerComment(savedBeforeCleanup, value, "ACCEPTED")) {
        let revokeError;
        try { await api.request("PATCH", `/repos/${repository}/issues/comments/${pendingId}`, { body: revokedBody(value) }); }
        catch (cause) { revokeError = cause; }
        const revoked = await api.request("GET", `/repos/${repository}/issues/comments/${pendingId}`);
        if (controllerComment(revoked, value, "ACCEPTED"))
          throw new Error("claim_controller_cleanup_uncertain", { cause: revokeError ?? error });
      }
      if (transitionStarted) {
        const fresh = await issueFor(api, repository, value.issueNumber);
        if (workingAttempted && labelNames(fresh).includes("status:working"))
          await removeLabel(api, repository, value.issueNumber, "status:working");
        const withoutWorking = await issueFor(api, repository, value.issueNumber);
        const statuses = labelNames(withoutWorking).filter(label => label.startsWith("status:"));
        if (withoutWorking.state === "open" && statuses.length === 0) {
          const restore = originalLabels.filter(label => label === "status:ready" || label === "help wanted");
          if (restore.length) await addLabels(api, repository, value.issueNumber, restore);
        }
      }
      const saved = await api.request("GET", `/repos/${repository}/issues/comments/${pendingId}`);
      if (controllerComment(saved, value, "PENDING")) await api.request("DELETE", `/repos/${repository}/issues/comments/${pendingId}`);
    }
    throw error;
  }
}

function githubApi(token) {
  return Object.freeze({ async request(method, path, body) {
    const response = await fetch(`https://api.github.com${path}`, { method,
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28", "user-agent": "agent-control-room-claim-controller" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error(`claim_controller_api_${response.status}`);
    if (response.status === 204) return undefined;
    return response.json();
  } });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { readFile } = await import("node:fs/promises");
  const { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: repository, GITHUB_TOKEN: token } = process.env;
  if (!eventPath || !repository || !token) throw new Error("claim_controller_environment_invalid");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const result = await runClaimController({ event, repository, api: githubApi(token) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
