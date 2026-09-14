import { createHash } from "node:crypto";

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
  && comment.body.startsWith(`CLAIM ${state} —`)
  && (comment.body.includes(marker(value))
    || (comment.body.includes(`${MARKER_PREFIX.replace(":v2", ":v3")} issue=${value.issueNumber} `)
      && comment.body.includes(` actor=${value.actor} worker=${value.workerId} `)));

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
      const pair = ` actor=${value.actor} worker=${value.workerId} `;
      if ((await commentsFor(api, repository, issue.number)).some(comment => comment?.user?.login === "github-actions[bot]"
        && comment?.user?.type === "Bot" && typeof comment.body === "string"
        && comment.body.startsWith("CLAIM ACCEPTED —")
        && (comment.body.includes(MARKER_PREFIX) || comment.body.includes(MARKER_PREFIX.replace(":v2", ":v3")))
        && comment.body.includes(pair))) return true;
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
const liveAcceptedHistory = (comments, issueNumber) => {
  let latest = 0;
  let live = false;
  for (const comment of comments) {
    if (comment?.user?.login !== "github-actions[bot]" || comment?.user?.type !== "Bot"
      || typeof comment.body !== "string" || !Number.isSafeInteger(comment?.id)) continue;
    const clearing = (comment.body.startsWith("CLAIM RELEASED —") || comment.body.startsWith("CLAIM EXPIRED —"))
      && comment.body.includes(`issue=${issueNumber} `);
    const accepting = (comment.body.startsWith("CLAIM ACCEPTED —") || comment.body.startsWith("CLAIM RENEWED —"))
      && (comment.body.includes(`${MARKER_PREFIX} issue=${issueNumber} `)
        || comment.body.includes(`${MARKER_PREFIX.replace(":v2", ":v3")} issue=${issueNumber} `));
    if ((clearing || accepting) && comment.id > latest) {
      latest = comment.id;
      live = accepting;
    }
  }
  return live;
};

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
  const now = Date.now();
  const packet = parseClaimPacket(current.body);
  if (!packet) return Object.freeze({ status: "refused", reason: "packet_invalid" });
  if (packet.effects !== "none") return Object.freeze({ status: "refused", reason: "packet_effectful" });
  if (!(await dependenciesComplete(api, repository, packet)))
    return Object.freeze({ status: "refused", reason: "dependencies_incomplete" });
  const held = await pairClaims(api, repository, actor, request.workerId);
  if (held.filter(entry => entry.status === "working").length >= MAX_ACTIVE_WORKING)
    return Object.freeze({ status: "refused", reason: "working_limit" });
  const locks = await verifiedLockScopes(api, repository, value.issueNumber);
  if (locks.legacy.length > 0)
    return Object.freeze({ status: "refused", reason: "legacy_lock_manual", issues: locks.legacy });
  if (locks.mismatched.length > 0)
    return Object.freeze({ status: "refused", reason: "lock_packet_changed", issues: locks.mismatched });
  if (locks.scopes.some(scope => packet.writeScopes.some(own => scopesOverlap(own, scope))))
    return Object.freeze({ status: "refused", reason: "scope_overlap" });
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
    const body = acceptedBodyV3(value, baseSha, packetHash(packet), now);
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
    return Object.freeze({ status: "accepted", ...(await sweepQuietly(api, repository, now)),
      workerId: value.workerId, actor, issueNumber: value.issueNumber, baseSha,
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

/* ---- Self-service claim packets (acr-public-work:v1) and lifecycle commands. ----
 * A Ready issue carries one strict machine-readable packet in its body:
 *   <!-- acr-public-work:v1 {...} -->
 * with target, literal path scopes, dependencies, checks, risk, effects and a
 * finite lease. Lifecycle commands are strict two-to-four-line comments:
 *   CLAIM REQUEST / RENEW / RELEASE  +  worker-id: <id>
 *   CLAIM SUBMIT  +  worker-id: <id>  +  pr: <n>  +  sha: <40 hex>
 * Accepted reservations use v3 markers that bind the packet hash and accept
 * time; v2 markers stay recognized read-only during migration. Dependencies
 * are complete only for closed issues with the done disposition. Renew and
 * submit check the marker-bound lease before mutating. Submit, release and
 * sweep record a pending journal comment before moving labels, reconcile lost
 * responses from exact state, and roll back only an unchanged partial
 * transition — never a newer maintainer status. Expiry keeps an issue In
 * review only for exactly one open PR by the accepted worker targeting main
 * with an exact issue reference. */

export const PACKET_PREFIX = "<!-- acr-public-work:v1";
const PACKET_PATTERN = /<!--\s*acr-public-work:v1\s*(\{.*?\})\s*-->/s;
const SHA40 = /^[a-f0-9]{40}$/;
const MAX_LEASE_HOURS = 720;
export const MAX_ACTIVE_WORKING = 1;
export const MAX_ACTIVE_IN_REVIEW = 2;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isValidScope(scope) {
  if (typeof scope !== "string" || scope.length === 0 || scope.length > 256) return false;
  if (scope.startsWith("/") || scope.includes("\\") || scope.includes("\n") || scope.includes("\r")) return false;
  let rest = scope;
  if (rest.endsWith("/**")) {
    rest = rest.slice(0, -3);
    if (rest.length === 0) return false;
  }
  if (rest.includes("*") || rest.endsWith("/")) return false;
  const segments = rest.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) return false;
  return true;
}

const scopeBase = scope => (scope.endsWith("/**") ? scope.slice(0, -3) : scope);

/** True when a terminal-`/**` or literal scope covers a literal path. */
export function scopeCovers(scope, path) {
  if (!isValidScope(scope) || typeof path !== "string") return false;
  if (scope.endsWith("/**")) {
    const base = scope.slice(0, -3);
    return path === base || path.startsWith(`${base}/`);
  }
  return scope === path;
}

/** Two scopes overlap when either covers the other's base path. */
export function scopesOverlap(a, b) {
  if (!isValidScope(a) || !isValidScope(b)) return false;
  return scopeCovers(a, scopeBase(b)) || scopeCovers(b, scopeBase(a));
}

export function packetsOverlap(pa, pb) {
  const a = pa?.writeScopes;
  const b = pb?.writeScopes;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.some(scopeA => b.some(scopeB => scopesOverlap(scopeA, scopeB)));
}

const PACKET_EFFECTS = new Set(["none", "filesystem", "network"]);

/** Parse and strictly validate the work packet; undefined means unusable. */
export function parseClaimPacket(body) {
  if (typeof body !== "string" || body.length > 65536) return undefined;
  const match = PACKET_PATTERN.exec(body);
  if (!match) return undefined;
  let raw;
  try { raw = JSON.parse(match[1]); } catch { return undefined; }
  if (!isPlainObject(raw)) return undefined;
  const { target, base, writeScopes, dependencies, checks, risk, effects, leaseHours } = raw;
  if (target !== "main" || typeof base !== "string" || !SHA40.test(base)) return undefined;
  if (!Array.isArray(writeScopes) || writeScopes.length === 0
    || !writeScopes.every(scope => typeof scope === "string" && isValidScope(scope))) return undefined;
  if (!Array.isArray(dependencies)
    || !dependencies.every(dep => Number.isSafeInteger(dep) && dep > 0)) return undefined;
  if (!Array.isArray(checks) || checks.length === 0
    || !checks.every(check => typeof check === "string" && check.length > 0 && check.length <= 200)) return undefined;
  if (typeof risk !== "string" || risk.length === 0 || risk.length > 32) return undefined;
  if (!PACKET_EFFECTS.has(effects)) return undefined;
  if (typeof leaseHours !== "number" || !Number.isFinite(leaseHours) || leaseHours <= 0 || leaseHours > MAX_LEASE_HOURS)
    return undefined;
  return Object.freeze({ target, base, writeScopes: Object.freeze([...writeScopes]),
    dependencies: Object.freeze([...dependencies]), checks: Object.freeze([...checks]), risk, effects, leaseHours });
}

export function packetHash(packet) {
  return createHash("sha256").update(JSON.stringify(packet)).digest("hex");
}

const COMMANDS = new Set(["CLAIM REQUEST", "CLAIM RENEW", "CLAIM SUBMIT", "CLAIM RELEASE"]);
const PR_LINE = /^pr: ([1-9][0-9]{0,8})$/;
const SUBMIT_SHA_LINE = /^sha: ([a-f0-9]{40})$/;

/** Parse any lifecycle command; undefined means ignore without API work. */
export function parseClaimCommand(body) {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > 512) return undefined;
  const lines = body.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.length < 2 || !COMMANDS.has(lines[0])) return undefined;
  const worker = WORKER_LINE.exec(lines[1]);
  if (!worker) return undefined;
  const command = lines[0];
  if (command !== "CLAIM SUBMIT") {
    return lines.length === 2
      ? Object.freeze({ command, workerId: worker[1] })
      : undefined;
  }
  if (lines.length !== 4) return undefined;
  const pr = PR_LINE.exec(lines[2]);
  const sha = SUBMIT_SHA_LINE.exec(lines[3]);
  if (!pr || !sha) return undefined;
  return Object.freeze({ command, workerId: worker[1], pr: Number(pr[1]), sha: sha[1] });
}

const MARKER_V2 = "<!-- agent-control-room-claim:v2";
const MARKER_V3 = "<!-- agent-control-room-claim:v3";
const MARKER_PATTERN = /<!--\s*agent-control-room-claim:v([23])\s+issue=(\d+)\s+request=(\d+)\s+actor=([^\s]+)\s+worker=([^\s]+)(?:\s+packet=([a-f0-9]{64}))?(?:\s+accepted=(\d+))?(?:\s+pr=(\d+)\s+sha=([a-f0-9]{40}))?\s*-->/;

/** Read-only parse of current (v3) and legacy (v2) accepted-claim markers. */
export function parseClaimMarker(body) {
  if (typeof body !== "string") return undefined;
  const match = MARKER_PATTERN.exec(body);
  if (!match) return undefined;
  const parsed = { version: Number(match[1]), issue: Number(match[2]), request: Number(match[3]),
    actor: match[4], worker: match[5] };
  if (!Number.isSafeInteger(parsed.issue) || parsed.issue < 1 || !Number.isSafeInteger(parsed.request) || parsed.request < 1
    || !LOGIN.test(parsed.actor)) return undefined;
  if (match[6]) parsed.packet = match[6];
  if (match[7] !== undefined) {
    const accepted = Number(match[7]);
    if (!Number.isSafeInteger(accepted) || accepted < 0) return undefined;
    parsed.accepted = accepted;
  }
  if (match[8] !== undefined) {
    if (match[9] === undefined) return undefined;
    parsed.pr = Number(match[8]);
    parsed.sha = match[9];
    if (!Number.isSafeInteger(parsed.pr) || parsed.pr < 1) return undefined;
  }
  return Object.freeze(parsed);
}

const markerV3 = (value, packet, accepted, extra = "") =>
  `<!-- agent-control-room-claim:v3 issue=${value.issueNumber} request=${value.requestId} actor=${value.actor} worker=${value.workerId} packet=${packet} accepted=${accepted}${extra} -->`;

const acceptedBodyV3 = (value, sha, hash, accepted) =>
  [`CLAIM ACCEPTED — \`@${value.actor}\` using worker identity \`${value.workerId}\`.`, "",
    `Outcome: public issue #${value.issueNumber} as currently defined`, `Base: \`${sha}\``, "Target: `main`", "",
    "This reservation grants no repository authority. Use only the issue's owned paths, checks and effect limits.",
    markerV3(value, hash, accepted)].join("\n");

const renewedBodyV3 = (value, hash, accepted, base) =>
  [`CLAIM RENEWED — \`@${value.actor}\` using worker identity \`${value.workerId}\` keeps public issue #${value.issueNumber}.`, "",
    `Base: \`${base}\` (immutable from acceptance)`, "The work packet is unchanged; the lease restarts from this renewal.",
    markerV3(value, hash, accepted)].join("\n");

const submittedBodyV3 = (value, hash, accepted, pr, sha) =>
  [`CLAIM SUBMITTED — \`@${value.actor}\` using worker identity \`${value.workerId}\` submitted PR #${pr} for public issue #${value.issueNumber}.`, "",
    `Head: \`${sha}\`. The issue path lock stays in force while the pull request is in review.`,
    markerV3(value, hash, accepted, ` pr=${pr} sha=${sha}`)].join("\n");

const releasedBody = (value, now) =>
  [`CLAIM RELEASED — the reservation by \`@${value.actor}\` using worker identity \`${value.workerId}\` on public issue #${value.issueNumber} is returned.`, "",
    "Safe, effect-free, unsubmitted work is reservable again. A release is not permission to start.",
    `<!-- agent-control-room-claim:v3 issue=${value.issueNumber} request=${value.requestId} actor=${value.actor} worker=${value.workerId} released=${now} -->`].join("\n");

const markerMatches = (comment, value, version) => comment?.user?.login === "github-actions[bot]"
  && comment?.user?.type === "Bot" && typeof comment?.body === "string"
  && comment.body.includes(`<!-- agent-control-room-claim:v${version} issue=${value.issueNumber} `)
  && comment.body.includes(` actor=${value.actor} worker=${value.workerId} `);

const acceptedMarkerFor = (comments, value) => {
  const markers = comments
    .filter(comment => markerMatches(comment, value, 3) || markerMatches(comment, value, 2))
    .map(comment => ({ comment, marker: parseClaimMarker(comment.body) }))
    .filter(entry => entry.marker && entry.marker.issue === value.issueNumber
      && entry.marker.actor === value.actor && entry.marker.worker === value.workerId);
  const accepted = markers.filter(entry => entry.comment.body.startsWith("CLAIM ACCEPTED —")
    || entry.comment.body.startsWith("CLAIM RENEWED —"));
  const live = accepted.filter(entry =>
    !clearedByReleaseOrExpiry(comments, value.issueNumber, value.actor, value.workerId, entry.comment.id));
  if (live.length === 0) return undefined;
  const current = live.reduce((best, entry) => (entry.comment.id > best.comment.id ? entry : best));
  if (!Number.isSafeInteger(current.comment.id)) return undefined;
  return current;
};

const safelyInReview = issue => issue.state === "open" && !issue.pull_request
  && labelNames(issue).filter(label => label.startsWith("status:")).join("") === "status:in-review";

const recordAccepted = (comments, value) => acceptedMarkerFor(comments, value)?.marker.accepted;

async function issuesByStatus(api, repository, status) {
  const found = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api.request("GET", `/repos/${repository}/issues?state=open&labels=status%3A${status}&per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("claim_controller_api_invalid");
    found.push(...batch.filter(issue => issue && !issue.pull_request && Number.isSafeInteger(issue?.number)));
    if (batch.length < 100) return found;
  }
  throw new Error("claim_controller_issue_set_ambiguous");
}

/** Live accepted/renewed markers for one issue; clearing markers after each marker end it. */
const liveAcceptedMarkers = (comments, issueNumber) => {
  const found = [];
  for (const comment of comments) {
    if (comment?.user?.login !== "github-actions[bot]" || comment?.user?.type !== "Bot"
      || typeof comment.body !== "string" || !Number.isSafeInteger(comment?.id)) continue;
    if (!comment.body.startsWith("CLAIM ACCEPTED —") && !comment.body.startsWith("CLAIM RENEWED —")) continue;
    const marker = parseClaimMarker(comment.body);
    if (!marker || marker.issue !== issueNumber) continue;
    if (clearedByReleaseOrExpiry(comments, issueNumber, marker.actor, marker.worker, comment.id)) continue;
    found.push({ comment, marker });
  }
  return found;
};

/** Locked path scopes from other Working and In-review packets with verified marker identity.
 * Packet-less legacy locks and locks whose current packet drifted from the accepted
 * marker fail closed instead of being collected and ignored. */
async function verifiedLockScopes(api, repository, excludeIssue) {
  const scopes = [];
  const legacy = [];
  const mismatched = [];
  for (const status of ["working", "in-review"]) {
    for (const issue of await issuesByStatus(api, repository, status)) {
      if (issue.number === excludeIssue) continue;
      const packet = parseClaimPacket(issue.body);
      if (!packet) {
        legacy.push(issue.number);
        continue;
      }
      const comments = await commentsFor(api, repository, issue.number);
      let live = [];
      try {
        live = liveAcceptedMarkers(comments, issue.number)
          .filter(entry => entry.marker.version === 3 && entry.marker.packet);
      } catch {
        mismatched.push(issue.number);
        continue;
      }
      if (live.length === 1 && packetHash(packet) === live[0].marker.packet) {
        scopes.push(...packet.writeScopes);
        continue;
      }
      // An expired open-PR claim keeps its path lock: the pull request is still
      // in review, so overlapping paths stay refused. The expired marker carries
      // the accepted packet hash, so a drifted body fails closed below instead
      // of locking paths nobody reserved.
      if (live.length === 0) {
        const expired = comments
          .filter(comment => comment?.user?.login === "github-actions[bot]" && comment?.user?.type === "Bot"
            && typeof comment.body === "string" && comment.body.startsWith("CLAIM EXPIRED —"))
          .map(comment => parseExpiredMarker(comment.body))
          .filter(marker => marker && marker.issue === issue.number && marker.reason === "open_pr");
        if (expired.length === 1 && expired[0].packet === packetHash(packet)) {
          scopes.push(...packet.writeScopes);
          continue;
        }
      }
      mismatched.push(issue.number);
      continue;
    }
  }
  const sorted = values => Object.freeze([...new Set(values)].sort((a, b) => a - b));
  return Object.freeze({ scopes, legacy: sorted(legacy), mismatched: sorted(mismatched) });
}

/** Active reservations held by one login-and-worker pair across Working and In-review. */
async function pairClaims(api, repository, actor, workerId) {
  const active = [];
  for (const status of ["working", "in-review"]) {
    for (const issue of await issuesByStatus(api, repository, status)) {
      const comments = await commentsFor(api, repository, issue.number);
      for (const comment of comments) {
        const parsed = parseClaimMarker(comment.body);
        if (!parsed || parsed.actor !== actor || parsed.worker !== workerId) continue;
        if (comment.body.startsWith("CLAIM RELEASED —")) continue;
        const released = clearedByReleaseOrExpiry(comments, issue.number, actor, workerId, comment.id);
        if (!released && (comment.body.startsWith("CLAIM ACCEPTED —") || comment.body.startsWith("CLAIM RENEWED —")
          || comment.body.startsWith("CLAIM SUBMITTED —"))) {
          active.push({ issue: issue.number, status, submitted: comment.body.startsWith("CLAIM SUBMITTED —") });
          break;
        }
      }
    }
  }
  return Object.freeze(active);
}

async function dependenciesComplete(api, repository, packet) {
  for (const dep of packet.dependencies) {
    const issue = await issueFor(api, repository, dep);
    if (!issue || issue.pull_request || issue.state !== "closed") return false;
    if (issue.state_reason === "not_planned") return false;
    if (!labelNames(issue).includes("status:done")) return false;
  }
  return true;
}

function exactIssueReference(text, issueNumber) {
  return typeof text === "string"
    && new RegExp(`(?:^|[^0-9])#${issueNumber}(?![0-9])`).test(text);
}

function openPrReferences(body, issueNumber) {
  return exactIssueReference(body, issueNumber);
}

function prReferencesIssue(pr, issueNumber) {
  return exactIssueReference(pr?.body, issueNumber) || exactIssueReference(pr?.title, issueNumber);
}

async function openPrsForIssue(api, repository, issueNumber) {
  const detailed = await openPrRefsForIssue(api, repository, issueNumber);
  return Object.freeze(detailed.matching);
}

async function openPrRefsForIssue(api, repository, issueNumber) {
  const matching = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await api.request("GET", `/repos/${repository}/pulls?state=open&per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("claim_controller_api_invalid");
    for (const pr of batch) {
      if (pr && Number.isSafeInteger(pr?.number) && prReferencesIssue(pr, issueNumber)) matching.push(pr);
    }
    if (batch.length < 100) return Object.freeze({ matching: Object.freeze(matching), truncated: false });
  }
  return Object.freeze({ matching: Object.freeze(matching), truncated: true });
}

function validEvent(event, command, repository, api, extra = true) {
  const requestId = event?.comment?.id;
  const actor = event?.comment?.user?.login;
  return command && event?.action === "created" && !event?.issue?.pull_request
    && Number.isSafeInteger(event?.issue?.number) && event.issue.number >= 1
    && Number.isSafeInteger(requestId) && requestId >= 1
    && typeof actor === "string" && LOGIN.test(actor)
    && typeof repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    && api && typeof api.request === "function" && extra;
}

/** Piggyback expiry sweep never blocks the triggering command; failures are reported, not fatal. */
async function sweepQuietly(api, repository, now) {
  try {
    return { sweep: await runClaimSweep({ repository, api, now }) };
  } catch (error) {
    return { sweep: Object.freeze({ status: "error", message: error?.message ?? "unknown" }) };
  }
}

/** Marker-bound lease state: renew and submit must check expiry before acting. */
const leaseStatus = (record, packet, now) => {
  if (!record?.marker || record.marker.version !== 3 || !record.marker.packet
    || !Number.isSafeInteger(record.marker.accepted)) return "lease_unknown";
  if (!packet) return "packet_changed";
  const ageHours = (now - record.marker.accepted) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours < 0 || ageHours > packet.leaseHours) return "lease_expired";
  return "active";
};

const acceptedBase = body => {
  const match = /Base: `([a-f0-9]{40})`/.exec(typeof body === "string" ? body : "");
  return match ? match[1] : undefined;
};

/** CLAIM RENEW extends only the same worker's unchanged packet. */
export async function runClaimRenew({ event, repository, api, now = Date.now() }) {
  const command = parseClaimCommand(event?.comment?.body);
  const actor = event?.comment?.user?.login;
  if (!command || command.command !== "CLAIM RENEW"
    || !validEvent(event, command, repository, api)) return Object.freeze({ status: "ignored" });
  const value = { issueNumber: event.issue.number, requestId: event.comment.id, actor, workerId: command.workerId };
  const current = await issueFor(api, repository, value.issueNumber);
  if (!safelyWorking(current)) return Object.freeze({ status: "refused", reason: "issue_not_working" });
  const record = acceptedMarkerFor(await commentsFor(api, repository, value.issueNumber), value);
  if (!record) return Object.freeze({ status: "refused", reason: "no_accepted_claim_for_pair" });
  if (record.marker.version !== 3 || !record.marker.packet)
    return Object.freeze({ status: "refused", reason: "legacy_claim_manual" });
  const packet = parseClaimPacket(current.body);
  if (!packet || packetHash(packet) !== record.marker.packet)
    return Object.freeze({ status: "refused", reason: "packet_changed" });
  const lease = leaseStatus(record, packet, now);
  if (lease !== "active") return Object.freeze({ status: "refused", reason: lease });
  const base = acceptedBase(record.comment.body);
  if (!base) return Object.freeze({ status: "refused", reason: "base_unknown" });
  const renewed = await api.request("PATCH", `/repos/${repository}/issues/comments/${record.comment.id}`,
    { body: renewedBodyV3(value, packetHash(packet), now, base) });
  if (!Number.isSafeInteger(renewed?.id)) throw new Error("claim_controller_api_invalid");
  const saved = await api.request("GET", `/repos/${repository}/issues/comments/${record.comment.id}`);
  if (typeof saved?.body !== "string" || !saved.body.startsWith("CLAIM RENEWED —"))
    throw new Error("claim_controller_state_changed");
  return Object.freeze({ status: "renewed", ...(await sweepQuietly(api, repository, now)),
    workerId: value.workerId, actor, issueNumber: value.issueNumber, accepted: now });
}

const SUBMIT_PENDING_PATTERN = /<!--\s*agent-control-room-claim:v3\s+issue=(\d+)\s+submit-pending=(\d+)\s+actor=([^\s]+)\s+worker=([^\s]+)\s+packet=([a-f0-9]{64})\s+accepted=(\d+)\s+pr=(\d+)\s+sha=([a-f0-9]{40})\s*-->/;

const submitPendingBodyV3 = (value, hash, accepted, pr, sha, now) =>
  [`CLAIM SUBMIT PENDING — \`@${value.actor}\` using worker identity \`${value.workerId}\` will submit PR #${pr} for public issue #${value.issueNumber}.`, "",
    `Head: \`${sha}\`. Labels move to In review only after this pending record exists, so a lost response can be reconciled without duplicating the transition.`,
    `<!-- agent-control-room-claim:v3 issue=${value.issueNumber} submit-pending=${now} actor=${value.actor} worker=${value.workerId} packet=${hash} accepted=${accepted} pr=${pr} sha=${sha} -->`].join("\n");

const findSubmitPending = (comments, value, pr, sha, hash) => {
  for (const comment of comments) {
    if (comment?.user?.login !== "github-actions[bot]" || comment?.user?.type !== "Bot"
      || typeof comment.body !== "string" || !Number.isSafeInteger(comment?.id)) continue;
    if (!comment.body.startsWith("CLAIM SUBMIT PENDING —")) continue;
    const match = SUBMIT_PENDING_PATTERN.exec(comment.body);
    if (!match) continue;
    if (Number(match[1]) === value.issueNumber && match[3] === value.actor && match[4] === value.workerId
      && match[5] === hash && Number(match[7]) === pr && match[8] === sha)
      return { comment, packet: match[5] };
  }
  return undefined;
};

const findSubmitted = (comments, value, pr, sha) => {
  for (const comment of comments) {
    if (comment?.user?.login !== "github-actions[bot]" || comment?.user?.type !== "Bot"
      || typeof comment.body !== "string" || !Number.isSafeInteger(comment?.id)) continue;
    if (!comment.body.startsWith("CLAIM SUBMITTED —")) continue;
    const marker = parseClaimMarker(comment.body);
    if (marker && marker.issue === value.issueNumber && marker.actor === value.actor
      && marker.worker === value.workerId && marker.pr === pr && marker.sha === sha) return comment;
  }
  return undefined;
};

const nonStatusLabels = labels => labels.filter(label => !label.startsWith("status:"));

/** Restore one status label only when the fresh issue is exactly the expected partial state. */
async function restoreStatusLabel(api, repository, issueNumber, restore, originalNonStatus, error) {
  const fresh = await issueFor(api, repository, issueNumber);
  const statuses = labelNames(fresh).filter(label => label.startsWith("status:"));
  const nonStatus = nonStatusLabels(normalizedLabels(fresh));
  if (fresh.state === "open" && !fresh.pull_request && statuses.length === 0
    && JSON.stringify(nonStatus) === JSON.stringify([...originalNonStatus].sort()))
    await addLabels(api, repository, issueNumber, [restore]);
  else throw error;
  const restored = await issueFor(api, repository, issueNumber);
  if (!labelNames(restored).includes(restore)) throw error;
}

/** CLAIM SUBMIT verifies the open PR, target, author and exact head, then moves to In review with the path lock kept. */
export async function runClaimSubmit({ event, repository, api, now = Date.now() }) {
  const command = parseClaimCommand(event?.comment?.body);
  const actor = event?.comment?.user?.login;
  if (!command || command.command !== "CLAIM SUBMIT"
    || !validEvent(event, command, repository, api,
      Number.isSafeInteger(command.pr) && SHA40.test(command.sha))) return Object.freeze({ status: "ignored" });
  const value = { issueNumber: event.issue.number, requestId: event.comment.id, actor, workerId: command.workerId };
  const prMatches = async (packetHashValue, accepted) => {
    const pr = await api.request("GET", `/repos/${repository}/pulls/${command.pr}`);
    return pr && pr.state === "open" && pr.base?.ref === "main" && pr.head?.sha === command.sha
      && pr.user?.login === actor && prReferencesIssue(pr, value.issueNumber)
      ? { pr, hash: packetHashValue, accepted } : undefined;
  };
  const current = await issueFor(api, repository, value.issueNumber);
  if (!safelyWorking(current)) {
    const pendingComments = await commentsFor(api, repository, value.issueNumber);
    const submitted = findSubmitted(pendingComments, value, command.pr, command.sha);
    if (submitted) {
      const after = await issueFor(api, repository, value.issueNumber);
      const statuses = labelNames(after).filter(label => label.startsWith("status:"));
      if (after.state === "open" && statuses.length === 1 && statuses[0] === "status:in-review")
        return Object.freeze({ status: "submitted", reconciled: true,
          workerId: value.workerId, actor, issueNumber: value.issueNumber, pr: command.pr, sha: command.sha });
    }
    const packet = parseClaimPacket(current.body);
    const pending = packet ? findSubmitPending(pendingComments, value, command.pr, command.sha, packetHash(packet)) : undefined;
    if (pending && (await prMatches(pending.packet, recordAccepted(pendingComments, value))) && safelyInReview(current)) {
      const submittedBody = submittedBodyV3(value, pending.packet,
        recordAccepted(pendingComments, value) ?? now, command.pr, command.sha);
      try {
        await api.request("PATCH", `/repos/${repository}/issues/comments/${pending.comment.id}`, { body: submittedBody });
      } catch (error) {
        const saved = await api.request("GET", `/repos/${repository}/issues/comments/${pending.comment.id}`);
        if (typeof saved?.body !== "string" || !saved.body.startsWith("CLAIM SUBMITTED —")) throw error;
      }
      return Object.freeze({ status: "submitted", reconciled: true,
        workerId: value.workerId, actor, issueNumber: value.issueNumber, pr: command.pr, sha: command.sha });
    }
    return Object.freeze({ status: "refused", reason: "issue_not_working" });
  }
  const record = acceptedMarkerFor(await commentsFor(api, repository, value.issueNumber), value);
  if (!record) return Object.freeze({ status: "refused", reason: "no_accepted_claim_for_pair" });
  if (record.marker.version !== 3 || !record.marker.packet)
    return Object.freeze({ status: "refused", reason: "legacy_claim_manual" });
  const packet = parseClaimPacket(current.body);
  if (!packet || packetHash(packet) !== record.marker.packet)
    return Object.freeze({ status: "refused", reason: "packet_changed" });
  const lease = leaseStatus(record, packet, now);
  if (lease !== "active") return Object.freeze({ status: "refused", reason: lease });
  const claims = await pairClaims(api, repository, actor, command.workerId);
  if (claims.filter(entry => entry.status === "in-review").length >= MAX_ACTIVE_IN_REVIEW)
    return Object.freeze({ status: "refused", reason: "in_review_limit" });
  const bound = await prMatches(packetHash(packet), record.marker.accepted ?? now);
  if (!bound) return Object.freeze({ status: "refused", reason: "pr_binding_invalid" });
  const originalLabels = normalizedLabels(current);
  const originalNonStatus = nonStatusLabels(originalLabels);
  let pending = findSubmitPending(await commentsFor(api, repository, value.issueNumber),
    value, command.pr, command.sha, bound.hash);
  if (!pending) {
    try {
      const created = await api.request("POST", `/repos/${repository}/issues/${value.issueNumber}/comments`,
        { body: submitPendingBodyV3(value, bound.hash, bound.accepted, command.pr, command.sha, now) });
      if (!Number.isSafeInteger(created?.id)) throw new Error("claim_controller_api_invalid");
      pending = { comment: created, packet: bound.hash };
    } catch (error) {
      pending = findSubmitPending(await commentsFor(api, repository, value.issueNumber),
        value, command.pr, command.sha, bound.hash);
      if (!pending) throw error;
    }
  }
  try {
    await removeLabel(api, repository, value.issueNumber, "status:working");
    await addLabels(api, repository, value.issueNumber, ["status:in-review"]);
  } catch (error) {
    await restoreStatusLabel(api, repository, value.issueNumber, "status:working", originalNonStatus, error);
    throw error;
  }
  const after = await issueFor(api, repository, value.issueNumber);
  const statuses = labelNames(after).filter(label => label.startsWith("status:"));
  if (after.state !== "open" || after.pull_request || statuses.length !== 1 || statuses[0] !== "status:in-review"
    || !originalNonStatus.every(label => labelNames(after).includes(label)))
    throw new Error("claim_controller_state_changed");
  try {
    await api.request("PATCH", `/repos/${repository}/issues/comments/${pending.comment.id}`,
      { body: submittedBodyV3(value, bound.hash, bound.accepted, command.pr, command.sha) });
  } catch (error) {
    const saved = await api.request("GET", `/repos/${repository}/issues/comments/${pending.comment.id}`);
    if (typeof saved?.body !== "string" || !saved.body.startsWith("CLAIM SUBMITTED —")) throw error;
  }
  const finalIssue = await issueFor(api, repository, value.issueNumber);
  const finalComment = await api.request("GET", `/repos/${repository}/issues/comments/${pending.comment.id}`);
  if (!safelyInReview(finalIssue) || typeof finalComment?.body !== "string"
    || !finalComment.body.startsWith("CLAIM SUBMITTED —")) throw new Error("claim_controller_state_changed");
  return Object.freeze({ status: "submitted", ...(await sweepQuietly(api, repository, now)),
    workerId: value.workerId, actor, issueNumber: value.issueNumber, pr: command.pr,
    sha: command.sha, preservedLabels: Object.freeze(originalLabels.filter(label => !label.startsWith("status:"))) });
}

const RELEASE_PENDING_PATTERN = /<!--\s*agent-control-room-claim:v3\s+issue=(\d+)\s+release-pending=(\d+)\s+actor=([^\s]+)\s+worker=([^\s]+)\s+packet=([a-f0-9]{64})\s*-->/;

const releasePendingBodyV3 = (value, hash, now) =>
  [`CLAIM RELEASE PENDING — the reservation by \`@${value.actor}\` using worker identity \`${value.workerId}\` on public issue #${value.issueNumber} will return to Ready.`, "",
    "Labels move to Ready only after this pending record exists, so a lost response can be reconciled without duplicating the transition.",
    `<!-- agent-control-room-claim:v3 issue=${value.issueNumber} release-pending=${now} actor=${value.actor} worker=${value.workerId} packet=${hash} -->`].join("\n");

const findReleasePending = (comments, value, hash) => {
  for (const comment of comments) {
    if (comment?.user?.login !== "github-actions[bot]" || comment?.user?.type !== "Bot"
      || typeof comment.body !== "string" || !Number.isSafeInteger(comment?.id)) continue;
    if (!comment.body.startsWith("CLAIM RELEASE PENDING —")) continue;
    const match = RELEASE_PENDING_PATTERN.exec(comment.body);
    if (!match) continue;
    if (Number(match[1]) === value.issueNumber && match[3] === value.actor && match[4] === value.workerId
      && match[5] === hash) return comment;
  }
  return undefined;
};

/** CLAIM RELEASE returns safe, effect-free, unsubmitted work to Ready. */
export async function runClaimRelease({ event, repository, api, now = Date.now() }) {
  const command = parseClaimCommand(event?.comment?.body);
  const actor = event?.comment?.user?.login;
  if (!command || command.command !== "CLAIM RELEASE"
    || !validEvent(event, command, repository, api)) return Object.freeze({ status: "ignored" });
  const value = { issueNumber: event.issue.number, requestId: event.comment.id, actor, workerId: command.workerId };
  const current = await issueFor(api, repository, value.issueNumber);
  const safelyReady = issue => issue.state === "open" && !issue.pull_request
    && labelNames(issue).filter(label => label.startsWith("status:")).join("") === "status:ready";
  const releaseable = async issue => {
    const comments = await commentsFor(api, repository, value.issueNumber);
    const record = acceptedMarkerFor(comments, value);
    if (!record || record.marker.version !== 3 || !record.marker.packet) return undefined;
    const packet = parseClaimPacket(issue.body);
    if (!packet || packet.effects !== "none" || packetHash(packet) !== record.marker.packet) return undefined;
    if (comments.some(comment => comment?.user?.login === "github-actions[bot]" && comment?.user?.type === "Bot"
      && typeof comment.body === "string" && comment.body.startsWith("CLAIM SUBMITTED —")
      && comment.body.includes(`issue=${value.issueNumber} `))) return undefined;
    if ((await openPrsForIssue(api, repository, value.issueNumber)).length > 0) return undefined;
    return { packet: packetHash(packet) };
  };
  if (!safelyWorking(current)) {
    const pendingComments = await commentsFor(api, repository, value.issueNumber);
    const released = pendingComments.some(comment => comment?.user?.login === "github-actions[bot]"
      && comment?.user?.type === "Bot" && typeof comment.body === "string"
      && comment.body.startsWith("CLAIM RELEASED —") && comment.body.includes(`issue=${value.issueNumber} `)
      && comment.body.includes(`actor=${value.actor} worker=${value.workerId} `));
    if (released && safelyReady(current))
      return Object.freeze({ status: "released", reconciled: true,
        workerId: value.workerId, actor, issueNumber: value.issueNumber });
    const ready = await releaseable(current);
    const pending = ready
      ? findReleasePending(pendingComments, value, ready.packet) : undefined;
    if (ready && pending && safelyReady(current)) {
      try {
        await api.request("PATCH", `/repos/${repository}/issues/comments/${pending.id}`,
          { body: releasedBody(value, now) });
      } catch (error) {
        const saved = await api.request("GET", `/repos/${repository}/issues/comments/${pending.id}`);
        if (typeof saved?.body !== "string" || !saved.body.startsWith("CLAIM RELEASED —")) throw error;
      }
      return Object.freeze({ status: "released", reconciled: true,
        workerId: value.workerId, actor, issueNumber: value.issueNumber });
    }
    return Object.freeze({ status: "refused", reason: "issue_not_working" });
  }
  const ready = await releaseable(current);
  if (!ready) {
    const comments = await commentsFor(api, repository, value.issueNumber);
    const record = acceptedMarkerFor(comments, value);
    if (!record) return Object.freeze({ status: "refused", reason: "no_accepted_claim_for_pair" });
    if (record.marker.version !== 3 || !record.marker.packet)
      return Object.freeze({ status: "refused", reason: "legacy_claim_manual" });
    const packet = parseClaimPacket(current.body);
    if (!packet || packetHash(packet) !== record.marker.packet)
      return Object.freeze({ status: "refused", reason: "packet_changed" });
    return Object.freeze({ status: "refused", reason: "release_unsafe" });
  }
  const originalLabels = normalizedLabels(current);
  const originalNonStatus = nonStatusLabels(originalLabels);
  let pending = findReleasePending(await commentsFor(api, repository, value.issueNumber), value, ready.packet);
  if (!pending) {
    try {
      const created = await api.request("POST", `/repos/${repository}/issues/${value.issueNumber}/comments`,
        { body: releasePendingBodyV3(value, ready.packet, now) });
      if (!Number.isSafeInteger(created?.id)) throw new Error("claim_controller_api_invalid");
      pending = created;
    } catch (error) {
      pending = findReleasePending(await commentsFor(api, repository, value.issueNumber), value, ready.packet);
      if (!pending) throw error;
    }
  }
  try {
    await removeLabel(api, repository, value.issueNumber, "status:working");
    await addLabels(api, repository, value.issueNumber, ["status:ready"]);
  } catch (error) {
    await restoreStatusLabel(api, repository, value.issueNumber, "status:working", originalNonStatus, error);
    throw error;
  }
  const after = await issueFor(api, repository, value.issueNumber);
  if (!safelyReady(after) || !originalNonStatus.every(label => labelNames(after).includes(label)))
    throw new Error("claim_controller_state_changed");
  try {
    await api.request("PATCH", `/repos/${repository}/issues/comments/${pending.id}`,
      { body: releasedBody(value, now) });
  } catch (error) {
    const saved = await api.request("GET", `/repos/${repository}/issues/comments/${pending.id}`);
    if (typeof saved?.body !== "string" || !saved.body.startsWith("CLAIM RELEASED —")) throw error;
  }
  const finalIssue = await issueFor(api, repository, value.issueNumber);
  const finalComment = await api.request("GET", `/repos/${repository}/issues/comments/${pending.id}`);
  if (!safelyReady(finalIssue) || typeof finalComment?.body !== "string"
    || !finalComment.body.startsWith("CLAIM RELEASED —")) throw new Error("claim_controller_state_changed");
  return Object.freeze({ status: "released", ...(await sweepQuietly(api, repository, now)),
    workerId: value.workerId, actor, issueNumber: value.issueNumber });
}

/**
 * Expire stale Working claims. Effect-free work without a pull request may
 * return to Ready; an open pull request stays In review; ambiguous or
 * effectful work becomes Needs decision. Legacy v2 claims without packet or
 * lease data are left untouched for maintainer migration.
 */
export async function runClaimSweep({ repository, api, now = Date.now() }) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || !api || typeof api.request !== "function" || !Number.isSafeInteger(now))
    throw new Error("claim_controller_sweep_invalid");
  const outcomes = await recoverPendingExpiries(api, repository, now);
  for (const issue of await issuesByStatus(api, repository, "working")) {
    const comments = await commentsFor(api, repository, issue.number);
    const accepted = comments.filter(comment => comment?.user?.login === "github-actions[bot]"
      && comment?.user?.type === "Bot" && typeof comment.body === "string"
      && (comment.body.startsWith("CLAIM ACCEPTED —") || comment.body.startsWith("CLAIM RENEWED —")));
    const parsed = accepted
      .map(comment => ({ comment, marker: parseClaimMarker(comment.body) }))
      .filter(entry => entry.marker && entry.marker.issue === issue.number);
    const live = parsed.filter(entry => !clearedByReleaseOrExpiry(comments, issue.number, entry.marker.actor, entry.marker.worker, entry.comment.id));
    if (live.length !== 1 || live[0].marker.version !== 3 || !live[0].marker.packet
      || !Number.isSafeInteger(live[0].marker.accepted)) {
      const legacy = live.length === 1 && live[0].marker.version === 2;
      if (!legacy) {
        const fresh = await issueFor(api, repository, issue.number);
        if (safelyWorking(fresh)) {
          outcomes.push(await sweepTransition(api, repository, issue.number,
            "status:working", "status:needs-decision", "needs-decision", "ambiguous_claim", "", now));
          continue;
        }
      }
      outcomes.push({ issue: issue.number, action: legacy ? "skipped_legacy" : "needs-decision",
        reason: legacy ? "legacy_claim_manual" : "ambiguous_claim" });
      continue;
    }
    const packet = parseClaimPacket(issue.body);
    const ageHours = (now - live[0].marker.accepted) / 3_600_000;
    const pair = ` actor=${live[0].marker.actor} worker=${live[0].marker.worker} `;
    if (!packet || packetHash(packet) !== live[0].marker.packet
      || !Number.isFinite(ageHours) || ageHours < 0 || ageHours <= packet.leaseHours) {
      if (packet && packetHash(packet) === live[0].marker.packet) {
        outcomes.push({ issue: issue.number, action: "active" });
        continue;
      }
      outcomes.push(await sweepTransition(api, repository, issue.number,
        "status:working", "status:needs-decision", "needs-decision", "packet_changed", pair, now));
      continue;
    }
    if (packet.effects !== "none") {
      outcomes.push(await sweepTransition(api, repository, issue.number,
        "status:working", "status:needs-decision", "needs-decision", "effectful_claim", pair, now));
      continue;
    }
    const refs = await openPrRefsForIssue(api, repository, issue.number);
    if (refs.truncated) {
      outcomes.push(await sweepTransition(api, repository, issue.number,
        "status:working", "status:needs-decision", "needs-decision", "ambiguous_pr_list", pair, now));
      continue;
    }
    const owned = refs.matching.filter(pr => pr?.user?.login === live[0].marker.actor && pr?.base?.ref === "main");
    if (owned.length === 1) {
      outcomes.push(await sweepTransition(api, repository, issue.number,
        "status:working", "status:in-review", "in-review", "open_pr", pair, now, packetHash(packet)));
      continue;
    }
    if (owned.length > 1) {
      outcomes.push(await sweepTransition(api, repository, issue.number,
        "status:working", "status:needs-decision", "needs-decision", "ambiguous_pr", pair, now));
      continue;
    }
    outcomes.push(await sweepTransition(api, repository, issue.number,
      "status:working", "status:ready", "ready", "lease_expired_no_pr", pair, now));
  }
  return Object.freeze({ status: "swept", outcomes: Object.freeze(outcomes) });
}

const expiredBody = (issueNumber, action, reason, pair = "", now, hash = "") =>
  [`CLAIM EXPIRED — the Working reservation on public issue #${issueNumber} ended (${action}: ${reason}).`, "",
    "Quiet effect-free work is reservable again; an open pull request stays in review; ambiguous or effectful work needs a maintainer decision.",
    `<!-- agent-control-room-claim:v3 issue=${issueNumber} expired=${now} action=${action} reason=${reason}${pair}${hash ? ` packet=${hash}` : ""} -->`].join("\n");

const EXPIRY_PENDING_PATTERN = /<!--\s*agent-control-room-claim:v3\s+issue=(\d+)\s+expiry-pending=(\d+)\s+action=([a-z-]+)\s+reason=([a-z_]+)\s+from=(status:[a-z-]+)\s+to=(status:[a-z-]+)(?:\s+actor=([^\s]+)\s+worker=([^\s]+))?(?:\s+packet=([a-f0-9]{64}))?\s*-->/;

const expiryPendingBody = (issueNumber, action, reason, from, to, pair = "", now, hash = "") =>
  [`CLAIM EXPIRY PENDING — the Working reservation on public issue #${issueNumber} will end (${action}: ${reason}).`, "",
    "Labels move only after this pending record exists, so a lost response can be reconciled without duplicating the transition.",
    `<!-- agent-control-room-claim:v3 issue=${issueNumber} expiry-pending=${now} action=${action} reason=${reason} from=${from} to=${to}${pair ? ` ${pair.trim()}` : ""}${hash ? ` packet=${hash}` : ""} -->`].join("\n");

const parsePair = pair => {
  const match = /actor=([^\s]+)\s+worker=([^\s]+)/.exec(typeof pair === "string" ? pair : "");
  return match ? { actor: match[1], worker: match[2] } : {};
};

const EXPIRED_MARKER_PATTERN = /<!--\s*agent-control-room-claim:v3\s+issue=(\d+)\s+expired=(\d+)\s+action=([a-z-]+)(?:\s+reason=([a-z_]+))?(?:\s+actor=([^\s]+)\s+worker=([^\s]+))?(?:\s+packet=([a-f0-9]{64}))?\s*-->/;

/** Read-only parse of expiry markers; only open-PR expiries carry a packet hash. */
const parseExpiredMarker = body => {
  if (typeof body !== "string") return undefined;
  const match = EXPIRED_MARKER_PATTERN.exec(body);
  if (!match) return undefined;
  const parsed = { issue: Number(match[1]), expired: Number(match[2]), action: match[3] };
  if (!Number.isSafeInteger(parsed.issue) || parsed.issue < 1
    || !Number.isSafeInteger(parsed.expired) || parsed.expired < 0) return undefined;
  if (match[4] !== undefined) parsed.reason = match[4];
  if (match[5] !== undefined) {
    if (!LOGIN.test(match[5])) return undefined;
    parsed.actor = match[5]; parsed.worker = match[6];
  }
  if (match[7] !== undefined) parsed.packet = match[7];
  return Object.freeze(parsed);
};

const findExpiryPendings = (comments, issueNumber) => {
  const found = [];
  for (const comment of comments) {
    if (comment?.user?.login !== "github-actions[bot]" || comment?.user?.type !== "Bot"
      || typeof comment.body !== "string" || !Number.isSafeInteger(comment?.id)) continue;
    if (!comment.body.startsWith("CLAIM EXPIRY PENDING —")) continue;
    const match = EXPIRY_PENDING_PATTERN.exec(comment.body);
    if (!match || Number(match[1]) !== issueNumber) continue;
    found.push({ comment, action: match[3], reason: match[4], from: match[5], to: match[6],
      actor: match[7], worker: match[8], packet: match[9] });
  }
  return found;
};

const findExpiryPending = (comments, issueNumber, action, reason, from, to, pair = "", hash = "") => {
  const { actor, worker } = parsePair(pair);
  return findExpiryPendings(comments, issueNumber).find(entry => entry.action === action
    && entry.reason === reason && entry.from === from && entry.to === to
    && (entry.actor ?? undefined) === actor && (entry.worker ?? undefined) === worker
    && (entry.packet ?? "") === hash);
};

/** Finalize pending expiries whose labels already moved, so a crash between labels and marker recovers. */
async function recoverPendingExpiries(api, repository, now) {
  const outcomes = [];
  for (const status of ["ready", "in-review", "needs-decision"]) {
    for (const issue of await issuesByStatus(api, repository, status)) {
      const comments = await commentsFor(api, repository, issue.number);
      for (const pending of findExpiryPendings(comments, issue.number)) {
        const labels = labelNames(issue);
        const statuses = labels.filter(label => label.startsWith("status:"));
        if (statuses.length !== 1 || statuses[0] !== pending.to || labels.includes(pending.from)) continue;
        try {
          await api.request("PATCH", `/repos/${repository}/issues/comments/${pending.comment.id}`,
            { body: expiredBody(issue.number, pending.action, pending.reason,
              pending.actor ? ` actor=${pending.actor} worker=${pending.worker} ` : "", now, pending.packet ?? "") });
        } catch (error) {
          const saved = await api.request("GET", `/repos/${repository}/issues/comments/${pending.comment.id}`);
          if (typeof saved?.body !== "string" || !saved.body.startsWith("CLAIM EXPIRED —")) throw error;
        }
        outcomes.push(Object.freeze({ issue: issue.number, action: pending.action,
          reason: pending.reason, recovered: true }));
      }
    }
  }
  return outcomes;
}

async function sweepTransition(api, repository, issueNumber, from, to, action, reason, pair = "", now, hash = "") {
  const before = await issueFor(api, repository, issueNumber);
  const beforeStatuses = labelNames(before).filter(label => label.startsWith("status:"));
  if (before.state !== "open" || before.pull_request || beforeStatuses.length !== 1 || beforeStatuses[0] !== from)
    throw new Error("claim_controller_state_changed");
  const originalNonStatus = nonStatusLabels(normalizedLabels(before));
  let pending = findExpiryPending(await commentsFor(api, repository, issueNumber),
    issueNumber, action, reason, from, to, pair, hash);
  if (!pending) {
    try {
      const created = await api.request("POST", `/repos/${repository}/issues/${issueNumber}/comments`,
        { body: expiryPendingBody(issueNumber, action, reason, from, to, pair, now, hash) });
      if (!Number.isSafeInteger(created?.id)) throw new Error("claim_controller_api_invalid");
      pending = { comment: created, action, reason, from, to, ...parsePair(pair) };
    } catch (error) {
      pending = findExpiryPending(await commentsFor(api, repository, issueNumber),
        issueNumber, action, reason, from, to, pair, hash);
      if (!pending) throw error;
      pending = { ...pending };
    }
  }
  try {
    await removeLabel(api, repository, issueNumber, from);
    await addLabels(api, repository, issueNumber, [to]);
  } catch (error) {
    await restoreStatusLabel(api, repository, issueNumber, from, originalNonStatus, error);
    throw error;
  }
  const after = await issueFor(api, repository, issueNumber);
  const afterStatuses = labelNames(after).filter(label => label.startsWith("status:"));
  if (after.state !== "open" || after.pull_request || afterStatuses.length !== 1 || afterStatuses[0] !== to
    || !originalNonStatus.every(label => labelNames(after).includes(label)))
    throw new Error("claim_controller_state_changed");
  try {
    await api.request("PATCH", `/repos/${repository}/issues/comments/${pending.comment.id}`,
      { body: expiredBody(issueNumber, action, reason, pair, now, hash) });
  } catch (error) {
    const saved = await api.request("GET", `/repos/${repository}/issues/comments/${pending.comment.id}`);
    if (typeof saved?.body !== "string" || !saved.body.startsWith("CLAIM EXPIRED —")) throw error;
  }
  const finalIssue = await issueFor(api, repository, issueNumber);
  const finalStatuses = labelNames(finalIssue).filter(label => label.startsWith("status:"));
  const finalComment = await api.request("GET", `/repos/${repository}/issues/comments/${pending.comment.id}`);
  if (finalIssue.state !== "open" || finalIssue.pull_request || finalStatuses.length !== 1 || finalStatuses[0] !== to
    || typeof finalComment?.body !== "string" || !finalComment.body.startsWith("CLAIM EXPIRED —"))
    throw new Error("claim_controller_state_changed");
  return Object.freeze({ issue: issueNumber, action, reason });
}

const clearedByReleaseOrExpiry = (comments, issueNumber, actor, worker, afterId = 0) => comments.some(other =>
  Number.isSafeInteger(other?.id) && other.id > afterId
  && other?.user?.login === "github-actions[bot]" && other?.user?.type === "Bot" && typeof other.body === "string"
  && (other.body.startsWith("CLAIM RELEASED —") || other.body.startsWith("CLAIM EXPIRED —"))
  && other.body.includes(`issue=${issueNumber} `)
  && other.body.includes(`actor=${actor} worker=${worker} `));

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
  if (process.argv.includes("--sweep")) {
    const result = await runClaimSweep({ repository, api: githubApi(token) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const event = JSON.parse(await readFile(eventPath, "utf8"));
    const command = parseClaimCommand(event?.comment?.body)?.command ?? "";
    const runner = { "CLAIM REQUEST": runClaimController, "CLAIM RENEW": runClaimRenew,
      "CLAIM SUBMIT": runClaimSubmit, "CLAIM RELEASE": runClaimRelease }[command] ?? runClaimController;
    const result = await runner({ event, repository, api: githubApi(token) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}
