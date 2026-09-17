import assert from "node:assert/strict";
import test from "node:test";
import { parseActionMarker, parseHandoffMarker, readWorkerInbox, renderWorkerInbox, resolveInboxToken } from "../scripts/public-worker-inbox.mjs";
const workerId = "worker:test-01";
const repository = "AgenticBotSitter/agent-control-room";
const broker = { url: "http://127.0.0.1:9999/v1/worker-operations", token: "synthetic-worker-token" };
function brokerReply({ includeReady = false, issues = [issue()], comments = [claim()], ...extra } = {}) {
  return new Response(JSON.stringify({ version: "acr-worker-broker-operations:v1", ok: true,
    operation: includeReady ? "ready-queue-discovery" : "worker-inbox-read", workerId,
    snapshot: { repository, complete: true, commentErrors: {}, base: { sha: "a".repeat(40) },
      issues: issues.map(item => ({ ...item, isPullRequest: false })),
      comments: Object.fromEntries(issues.map(item => [item.number, comments.map(c => ({ ...c, author: c.user.login, bot: c.user.type === "Bot" }))])), ...extra } }));
}

test("broker-first reads reuse controller parsing without any direct request", async () => {
  const calls = [];
  const actions = await readWorkerInbox({ workerId, repository, broker, fetchImpl: async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, `Bearer ${broker.token}`);
    assert.deepEqual(JSON.parse(init.body), { operation: "worker-inbox-read", workerId });
    return brokerReply({ comments: [claim(), handoff({ state: "changes-required" })], issues: [issue(["status:changes-required", "action:worker"])] });
  } });
  assert.equal(actions[0].state, "changes-required");
  assert.equal(actions[0].trust, "controller-record");
  assert.deepEqual(calls, [broker.url]);
});

test("broker ready snapshot retains packet and uses the existing admission evaluator", async () => {
  const actions = await readWorkerInbox({ workerId, repository, broker, includeReady: true,
    fetchImpl: async () => brokerReply({ includeReady: true, issues: [{ ...issue(["status:ready"], 1), body: packet() }], comments: [] }) });
  assert.equal(actions[0].state, "ready-candidate");
  assert.equal(actions[0].admission.outcome, "admit");
});

test("broker failures defer fallback, honor Retry-After and retain backoff after restart", async () => {
  let clock = 1000;
  let direct = 0, privateReads = 0;
  const state = {};
  const fetchImpl = async (url, init) => {
    if (url === broker.url) { privateReads++; return new Response("{}", { status: 429, headers: { "retry-after": "600" } }); }
    direct++;
    assert.equal(init.headers.authorization, "Bearer synthetic-github-token");
    return fakeFetch().fetchImpl(url);
  };
  const options = { workerId, repository, broker, token: "synthetic-github-token", fetchImpl, now: () => clock };
  await assert.rejects(readWorkerInbox({ ...options, brokerState: state }), /worker_inbox_broker_unavailable/);
  assert.equal(direct, 0);
  assert.equal(state.nextBrokerAt, 601000);
  const restarted = JSON.parse(JSON.stringify(state));
  clock = 500000;
  await assert.rejects(readWorkerInbox({ ...options, brokerState: restarted }), /worker_inbox_broker_unavailable/);
  assert.equal(privateReads, 1);
  clock = 601000;
  const actions = await readWorkerInbox({ ...options, brokerState: restarted });
  assert.equal(actions[0].state, "working");
  assert.equal(direct, 2);
});

test("incomplete or foreign broker data cannot clear the inbox", async () => {
  for (const extra of [{ complete: false }, { repository: "other/repo" }, { comments: {} }]) {
    await assert.rejects(readWorkerInbox({ workerId, repository, broker,
      fetchImpl: async () => brokerReply(extra) }), /worker_inbox_broker_unavailable/);
  }
});

test("an unbounded broker stream is cancelled at the ceiling, never drained", async () => {
  const chunk = new Uint8Array(64 * 1024);
  let pulled = 0;
  const endless = new ReadableStream({
    pull(controller) { pulled++; controller.enqueue(chunk); },
    cancel() { pulled = -Math.abs(pulled); },
  });
  const state = {};
  await assert.rejects(readWorkerInbox({ workerId, repository, broker, brokerState: state,
    fetchImpl: async () => new Response(endless) }), /worker_inbox_broker_unavailable/);
  // Only the ceiling plus one chunk was ever pulled, and the stream was cancelled.
  assert.ok(pulled < 0, "stream was cancelled");
  assert.ok(-pulled <= 4 * 1024 * 1024 / chunk.length + 2, `pulled ${-pulled} chunks`);
  assert.ok(state.nextBrokerAt > 0, "backoff scheduled");
});

test("a broker body at the ceiling still parses", async () => {
  const padding = "p".repeat(4 * 1024 * 1024 - 1500);
  const actions = await readWorkerInbox({ workerId, repository, broker,
    fetchImpl: async () => brokerReply({ comments: [claim()], issues: [{ ...issue(), note: padding }] }) });
  assert.ok(actions.length > 0);
});
test("capacity update is discoverable even when the personal inbox is empty", () => {
  const rendered = renderWorkerInbox(workerId, []);
  assert.match(rendered, /2 active builds \/ 5 total assignments/);
  assert.match(rendered, /does not consume an active-build slot/);
  assert.match(rendered, /Corrections first/);
  assert.match(rendered, /immediately after submission/);
  assert.match(rendered, /Refresh public-main CONTRIBUTOR_HANDBOOK.md/);
});
const bot = { login: "github-actions[bot]", type: "Bot" };
const issue = (labels = ["action:worker", "status:working"], number = 170) => ({ number, title: "Assignment", labels, state: "open" });
const legacy = (worker = workerId, state = "working", id = 1) => ({ id, user: { login: "MarvinAi5", type: "User" }, author_association: "OWNER",
  body: `<!-- agent-control-room-action:v1 worker=${worker} state=${state} issue=170 -->` });
const claim = (outcome = "ACCEPTED", worker = workerId, id = 1) => ({ id, user: bot,
  body: `CLAIM ${outcome} — record\n<!-- agent-control-room-claim:v2 issue=170 request=2 actor=MarvinAi5 worker=${worker} -->` });
const handoff = (values = {}, id = 2) => ({ id, user: bot, body: `<!-- agent-control-room-handoff:v1 ${JSON.stringify({
  issue: 170, pr: 171, workerId, actor: "MarvinAi5", head: "a".repeat(40), state: "working", action: "worker",
  requestId: 1, previousId: null, phase: "complete", reviewUrl: null, acknowledged: false, ...values,
})} -->` });
function fakeFetch({ issues = [issue()], comments = [claim()], failIssue, full = false } = {}) {
  const calls = [];
  return { calls, fetchImpl: async url => {
    calls.push(url);
    const number = /\/issues\/(\d+)\/comments/.exec(url)?.[1];
    if (number === String(failIssue)) throw new Error("offline private details");
    return { ok: true, async json() { return number ? full ? Array(100).fill(claim()) : comments : issues; } };
  } };
}
const read = options => readWorkerInbox({ workerId, fetchImpl: fakeFetch(options).fetchImpl });
const packet = values => `<!-- acr-public-work:v1 ${JSON.stringify({ target: "main", base: "a".repeat(40),
  writeScopes: ["src/example/**"], dependencies: [], checks: ["pnpm check"], risk: "ordinary", effects: "none", leaseHours: 24, ...values })} -->`;
const currentClaim = (outcome, extra = "", id = 3) => ({ id, user: bot, body: `CLAIM ${outcome} — record\n<!-- agent-control-room-claim:v3 issue=170 request=2 actor=MarvinAi5 worker=${workerId} packet=${"b".repeat(64)} accepted=1000${extra} -->` });

test("current controller submission and renewal reach the worker", async () => {
  for (const outcome of ["ACCEPTED", "RENEWED"]) {
    const result = await read({ comments: [currentClaim(outcome)] });
    assert.equal(result[0].disposition, "action");
  }
  const result = await read({ issues: [issue(["status:in-review"])], comments: [claim(),
    currentClaim("SUBMITTED", ` pr=171 sha=${"c".repeat(40)}`)] });
  assert.equal(result[0].disposition, "waiting");
  assert.equal(result[0].pr, 171);
  assert.equal(result[0].head, "c".repeat(40));
  const beforeHandoff = await read({ issues: [issue(["status:working"])], comments: [claim(),
    currentClaim("SUBMITTED", ` pr=171 sha=${"c".repeat(40)}`)] });
  assert.equal(beforeHandoff[0].state, "handoff-required");
  assert.match(beforeHandoff[0].instruction, /^HANDOFF submit\nworker-id: worker:test-01\npr: 171/);
});

test("release and expiry end stale ownership; later advisory cannot resurrect it", async () => {
  for (const body of [
    `CLAIM RELEASED — record\n<!-- agent-control-room-claim:v3 issue=170 request=2 actor=MarvinAi5 worker=${workerId} released=2000 -->`,
    `CLAIM EXPIRED — record\n<!-- agent-control-room-claim:v3 issue=170 expired=2000 action=ready reason=lease_expired_no_pr actor=MarvinAi5 worker=${workerId} -->`,
  ]) {
    const result = await read({ issues: [issue(["status:ready"])], comments: [claim(), { id: 3, user: bot, body }, legacy(workerId, "working", 4)] });
    assert.equal(result[0].disposition, "released");
    assert.match(result[0].action, /Do not continue/);
    const forged = await read({ issues: [issue(["status:working"])], comments: [claim(), { id: 3, user: { login: "worker", type: "User" }, body }] });
    assert.equal(forged[0].disposition, "action");
  }
});

test("discovery distinguishes new candidates, invalid packets and dependencies without authorizing work", async () => {
  const issues = [
    { ...issue(["status:ready", "platform:any"], 1), body: packet() },
    { ...issue(["status:ready"], 2), body: packet({ writeScopes: ["src/*.ts"] }) },
    { ...issue(["status:ready"], 3), body: packet({ dependencies: [4] }) },
    { ...issue(["status:waiting"], 4), state: "open" },
    { ...issue(["status:ready", "status:working"], 5), body: packet() },
  ];
  const result = await readWorkerInbox({ workerId, includeReady: true, fetchImpl: readyFetch({ issues }).fetchImpl });
  const offers = result.filter(action => action.disposition === "discovery");
  assert.deepEqual(offers.map(action => [action.issue, action.state, action.reason]), [
    [1, "ready-candidate", undefined], [2, "queue-blocked", "packet_invalid"],
    [3, "queue-blocked", "open_dependencies"], [5, "queue-blocked", "conflicting_ready_labels"],
  ]);
  assert.equal(offers[0].trust, "public-offer");
  assert.equal(offers[0].admission?.outcome, "admit");
  assert.equal(offers[0].admission?.locks, "checked");
  assert.match(offers[0].action, /wait for CLAIM ACCEPTED/);
  assert.match(renderWorkerInbox(workerId, offers), /platform:any/);
});

function readyFetch({ issues, commentsByIssue = {}, ref = "a".repeat(40), failRef = false,
  failComments = [], failSingles = [], workingIssues = [], headersSeen = [] } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (init?.headers?.authorization) headersSeen.push(init.headers.authorization);
    if (url.includes("/git/ref/heads/main")) {
      if (failRef) return { ok: false, status: 404 };
      return { ok: true, async json() { return { object: { sha: ref } }; } };
    }
    if (url.includes("labels=status%3Aworking") || url.includes("labels=status%3Ain-review")) {
      return { ok: true, async json() { return workingIssues; } };
    }
    const commentMatch = /\/issues\/(\d+)\/comments/.exec(url);
    if (commentMatch) {
      const number = Number(commentMatch[1]);
      if (failComments.includes(number)) throw new Error("offline history");
      return { ok: true, async json() { return commentsByIssue[number] ?? []; } };
    }
    const singleMatch = /\/issues\/(\d+)(?:\?|$)/.exec(url);
    if (singleMatch && !url.includes("/comments")) {
      const number = Number(singleMatch[1]);
      if (failSingles.includes(number)) throw new Error("offline single");
      return { ok: true, async json() { return issues.find(item => item.number === number) ?? null; } };
    }
    return { ok: true, async json() { return issues; } };
  };
  return { calls, fetchImpl };
}

const readyIssues = () => ([
  { ...issue(["status:ready", "platform:any"], 1), body: packet() },
  { ...issue(["status:waiting"], 4), state: "open" },
]);

test("evaluator or dependency API failure never advertises pickup", async () => {
  // Item 1: a failed observation stays unavailable/attention, never a default admit.
  const depIssues = [
    { ...issue(["status:ready", "platform:any"], 1), body: packet({ dependencies: [4] }) },
    { ...issue(["status:waiting"], 4), state: "open" },
  ];
  const failed = await readWorkerInbox({ workerId, includeReady: true,
    fetchImpl: readyFetch({ issues: depIssues, failSingles: [4] }).fetchImpl });
  const blocked = failed.filter(action => action.disposition === "discovery");
  assert.equal(blocked[0].state, "queue-blocked");
  assert.equal(blocked[0].reason, "admission_evaluator_unavailable");
  assert.ok(blocked[0].admissionError);
  const noBase = await readWorkerInbox({ workerId, includeReady: true,
    fetchImpl: readyFetch({ issues: readyIssues(), failRef: true }).fetchImpl });
  const unobserved = noBase.filter(action => action.disposition === "discovery");
  assert.equal(unobserved[0].state, "queue-blocked");
  assert.equal(unobserved[0].reason, "admission_observation_unavailable");
});

test("complete fetched history gates admission; accepted history refuses", async () => {
  // Item 2: the evaluator sees the complete issue history, not comments:[].
  const accepted = [{ id: 50, user: bot,
    body: `CLAIM ACCEPTED — record\n<!-- agent-control-room-claim:v2 issue=1 request=2 actor=MarvinAi5 worker=worker:other -->` }];
  const refused = await readWorkerInbox({ workerId, includeReady: true,
    fetchImpl: readyFetch({ issues: readyIssues(), commentsByIssue: { 1: accepted } }).fetchImpl });
  const offer = refused.filter(action => action.disposition === "discovery")[0];
  assert.equal(offer.state, "queue-blocked");
  assert.equal(offer.admission?.reason, "accepted_history_requires_release");
  const unreadable = await readWorkerInbox({ workerId, includeReady: true,
    fetchImpl: readyFetch({ issues: readyIssues(), failComments: [1] }).fetchImpl });
  const incomplete = unreadable.filter(action => action.disposition === "discovery")[0];
  assert.equal(incomplete.state, "queue-blocked");
  assert.equal(incomplete.reason, "admission_history_incomplete");
});

test("verified scope locks refuse overlapping offers; legacy locks fail closed", async () => {
  // Item 3: knownLocks populated from verified Working/In-review scopes.
  const { parseClaimPacket, packetHash } = await import("../scripts/automatic-claim-controller.mjs");
  const workingPacket = packet({ writeScopes: ["src/example/**"] });
  const parsed = parseClaimPacket(workingPacket);
  const marker = { id: 60, user: bot,
    body: `CLAIM ACCEPTED — record\n<!-- agent-control-room-claim:v3 issue=170 request=2 actor=MarvinAi5 worker=worker:other packet=${packetHash(parsed)} accepted=1000 -->` };
  const working = { ...issue(["status:working"], 170), body: workingPacket };
  const overlapped = await readWorkerInbox({ workerId, includeReady: true,
    fetchImpl: readyFetch({ issues: [...readyIssues(), working], workingIssues: [working],
      commentsByIssue: { 170: [marker] } }).fetchImpl });
  const offer = overlapped.filter(action => action.disposition === "discovery")[0];
  assert.equal(offer.state, "queue-blocked");
  assert.equal(offer.admission?.reason, "scope_overlap");
  assert.equal(offer.admission?.locks, "checked");
  // A packetless legacy lock cannot prove scopes: every offer stays blocked.
  const legacyWorking = { ...issue(["status:working"], 171), body: "no packet here" };
  const legacy = await readWorkerInbox({ workerId, includeReady: true,
    fetchImpl: readyFetch({ issues: [...readyIssues(), legacyWorking], workingIssues: [legacyWorking] }).fetchImpl });
  const legacyOffer = legacy.filter(action => action.disposition === "discovery")[0];
  assert.equal(legacyOffer.state, "queue-blocked");
  assert.equal(legacyOffer.reason, "admission_locks_unverifiable");
});

test("the inbox token is preserved for observation requests and never logged", async () => {
  // Item 4: observation requests carry the supplied token; errors stay generic.
  const headersSeen = [];
  const result = await readWorkerInbox({ workerId, includeReady: true, token: "sentinel-token-abc",
    fetchImpl: readyFetch({ issues: readyIssues(), headersSeen }).fetchImpl });
  assert.ok(headersSeen.length > 0);
  assert.ok(headersSeen.every(value => value === "Bearer sentinel-token-abc"));
  assert.equal(result.filter(action => action.disposition === "discovery")[0].state, "ready-candidate");
  assert.ok(!JSON.stringify(result).includes("sentinel-token-abc"));
});
test("bounded marker parsing", () => {
  assert.equal(parseActionMarker(legacy().body).workerId, workerId);
  assert.equal(parseActionMarker("ACTION REQUIRED"), undefined);
  assert.equal(parseHandoffMarker(handoff().body).phase, "complete");
  assert.equal(parseHandoffMarker(handoff({ state: "blocked" }).body), undefined);
  assert.equal(parseHandoffMarker("<!-- agent-control-room-handoff:v1 {broken} -->"), undefined);
});
test("accepted claims remain visible without action labels and all open issues are fetched", async () => {
  const api = fakeFetch({ issues: [issue(["status:working"])] });
  const result = await readWorkerInbox({ workerId, fetchImpl: api.fetchImpl });
  assert.equal(result[0].trust, "controller-record");
  assert.equal(result[0].disposition, "action");
  assert.ok(!api.calls[0].includes("labels="));
});
test("revocation is STOP even with a newer handoff", async () => {
  const result = await read({ comments: [claim("REVOKED"), handoff()] });
  assert.equal(result[0].disposition, "stop");
  assert.match(result[0].action, /STOP/);
});
test("legacy requests are advisory regardless of login or association", async () => {
  for (const author_association of ["OWNER", "MEMBER", "COLLABORATOR", "NONE"]) {
    const result = await read({ comments: [{ ...legacy(), author_association }] });
    assert.equal(result[0].trust, "advisory");
    assert.match(renderWorkerInbox(workerId, result), /ADVISORY/);
  }
});
test("spoofed authors cannot create or override controller records", async () => {
  for (const user of [{ login: "github-actions[bot]", type: "User" }, { login: "maintainer", type: "Bot" }]) {
    assert.deepEqual(await read({ comments: [{ ...handoff(), user }] }), []);
    assert.equal((await read({ comments: [claim(), { ...handoff({ workerId: "worker:other" }), user }] }))[0].markerCommentId, 1);
  }
});
test("latest assignment supersedes stale markers by comment creation id", async () => {
  assert.deepEqual(await read({ comments: [legacy(), claim("ACCEPTED", "worker:other", 3)] }), []);
  assert.deepEqual(await read({ comments: [handoff({ workerId: "worker:other" }, 4), handoff({}, 2)] }), []);
  assert.deepEqual(await read({ comments: [claim("ACCEPTED", "worker:other", 4), claim("REVOKED", workerId, 1)] }), []);
});
test("label conflicts, mismatches, blocked and pending surface attention", async () => {
  for (const options of [
    { issues: [issue(["status:working", "status:paused"])] },
    { issues: [issue(["status:working", "action:worker", "action:reviewer"])] },
    { issues: [issue(["status:paused"])] },
    { comments: [legacy(workerId, "blocked")], issues: [issue(["status:blocked", "action:worker"])] },
    { comments: [handoff({ phase: "pending" })] }, { comments: [claim("PENDING")] },
    { comments: [{ user: bot, body: "<!-- agent-control-room-handoff:v1 {broken} -->" }] },
  ]) assert.equal((await read(options))[0].disposition, "attention");
});
test("reviews wait without irrelevant acknowledgment hints", async () => {
  for (const state of ["in-review", "re-review"]) {
    const result = await read({ issues: [issue([`status:${state}`, "action:reviewer"])], comments: [handoff({ state, action: "reviewer" }, 41)] });
    assert.equal(result[0].disposition, "waiting");
    assert.equal(result[0].acknowledgment, undefined);
    assert.match(renderWorkerInbox(workerId, result), /do not grant execution authority/);
  }
});
test("completed paused worker handoffs require STOP and cannot be overridden by advisory", async () => {
  const result = await read({ issues: [issue(["status:paused", "action:worker"])],
    comments: [handoff({ state: "paused" }, 41), legacy(workerId, "working", 42)] });
  assert.equal(result[0].disposition, "stop");
  assert.equal(result[0].trust, "controller-record");
  assert.match(result[0].action, /STOP.*HANDOFF stopped/);
  assert.match(result[0].acknowledgment, /HANDOFF stopped.*comment 41/);
});
test("advisory cannot erase earlier worker advice or authorize continuing", async () => {
  const result = await read({ comments: [legacy(), legacy("worker:other", "working", 2)] });
  assert.equal(result[0].disposition, "attention");
  assert.match(result[0].action, /verify the current controller assignment/);
  assert.doesNotMatch(result[0].action, /Continue/);
});
test("correction acknowledgment and health metadata identify the request", async () => {
  const created_at = "2026-09-14T10:00:00Z";
  const result = await read({ issues: [issue(["status:changes-required", "action:worker"])],
    comments: [{ ...handoff({ state: "changes-required", instruction: "Fix the four recorded production failures." }, 41), created_at }] });
  assert.equal(result[0].requestedAt, created_at);
  assert.equal(result[0].workerId, workerId);
  assert.equal(result[0].head, "a".repeat(40));
  assert.equal(result[0].pr, 171);
  assert.equal(result[0].instruction, "Fix the four recorded production failures.");
  assert.match(result[0].acknowledgment, /comment 41/);
  const rendered = renderWorkerInbox(workerId, result);
  assert.match(rendered, /pull\/171/);
  assert.match(rendered, /Reviewed\/submitted commit: a{40}/);
  assert.match(rendered, /Fix the four recorded production failures/);
  for (const values of [{ state: "working" }, { state: "changes-required", acknowledged: true }, { state: "paused", action: "reviewer" }]) {
    const item = (await read({ comments: [handoff(values)] }))[0];
    assert.equal(item.acknowledgment, undefined);
  }
});
test("later advisory corrections stay visible without reassigning controller work", async () => {
  const result = await read({ comments: [claim(), legacy(workerId, "changes-required", 4)] });
  assert.equal(result[0].trust, "advisory");
  assert.equal(result[0].markerState, "changes-required");
  assert.match(renderWorkerInbox(workerId, result), /Requested state: changes-required/);
  assert.deepEqual(await read({ comments: [claim("ACCEPTED", "worker:other"), legacy(workerId, "working", 4)] }), []);
  assert.equal((await read({ comments: [handoff({ issue: 999 })] }))[0].disposition, "attention");
});
test("per-issue offline failure preserves unrelated results and hides raw error", async () => {
  const result = await read({ issues: [issue(), issue([], 180)], failIssue: 180 });
  assert.equal(result.length, 2);
  assert.equal(result[0].disposition, "action");
  assert.equal(result[1].disposition, "attention");
  assert.ok(!JSON.stringify(result).includes("private details"));
});
test("history cap surfaces attention", async () => {
  assert.equal((await read({ full: true }))[0].reason, "worker_inbox_history_ambiguous");
});
test("global offline errors and invalid input fail visibly", async () => {
  await assert.rejects(readWorkerInbox({ workerId: "x" }), /worker_id_invalid/);
  await assert.rejects(readWorkerInbox({ workerId, repository: "bad" }), /repository_invalid/);
  await assert.rejects(readWorkerInbox({ workerId, fetchImpl: async () => ({ ok: false, status: 403,
    headers: { get: name => name === "x-ratelimit-remaining" ? "0" : null } }) }), /rate_limited/);
});

test("a per-issue rate limit fails the whole read instead of fabricating attention for every issue", async () => {
  const fetchImpl = async url => url.includes("/comments?")
    ? { ok: false, status: 403, headers: { get: name => name === "retry-after" ? "60" : null } }
    : { ok: true, async json() { return [issue()]; } };
  await assert.rejects(readWorkerInbox({ workerId, fetchImpl }), /worker_inbox_rate_limited/);
});

test("a policy-rejected fine-grained token is not misreported as a rate limit", async () => {
  await assert.rejects(readWorkerInbox({ workerId, token: "sentinel-token",
    fetchImpl: async () => ({ ok: false, status: 403, headers: { get: () => null },
      text: async () => "Fine-grained personal access tokens are forbidden when their lifetime is greater than 366 days." }) }),
  /worker_inbox_credential_rejected/);
});

test("direct inbox token resolution is explicit and never invents a credential", () => {
  const sentinel = "ghp_in_memory_only_0123456789";
  assert.equal(resolveInboxToken({ environment: { GITHUB_TOKEN: sentinel } }), sentinel);
  assert.equal(resolveInboxToken({ environment: {} }), undefined);
  assert.equal(resolveInboxToken({ environment: {}, tokenFromGh: true,
    runCommand: () => ({ status: 0, stdout: `${sentinel}\n` }) }), sentinel);
  assert.throws(() => resolveInboxToken({ environment: {}, tokenFromGh: true,
    runCommand: () => ({ status: 1, stdout: "" }) }), /gh_token_unavailable/);
});
