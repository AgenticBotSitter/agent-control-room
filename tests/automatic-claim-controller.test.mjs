import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isValidScope, packetHash, packetsOverlap, parseClaimCommand, parseClaimMarker, parseClaimPacket, parseClaimRequest, runClaimController, runClaimRelease, runClaimRenew, runClaimSubmit, runClaimSweep, scopeCovers, scopesOverlap } from "../scripts/automatic-claim-controller.mjs";

const repository = "AgenticBotSitter/agent-control-room";
const sha = "a".repeat(40);
const packetBody = (overrides = {}) => {
  const packet = { target: "main", base: "b".repeat(40), writeScopes: ["scripts/owned-scope.mjs"],
    dependencies: [], checks: ["node --test tests/owned-scope.test.mjs"], risk: "boundary", effects: "none",
    leaseHours: 72, ...overrides };
  return `Work packet.\n\n<!-- acr-public-work:v1 ${JSON.stringify(packet)}\n-->`;
};
const event = (body = "CLAIM REQUEST\nworker-id: worker:test-01", actor = "shared-account", id = 501) => ({ action: "created", comment: { body, id, user: { login: actor, type: "User" } },
  issue: { number: 125 } });

function fakeApi(options = {}) {
  let issue = { number: 125, title: "Mac and Linux worker rehearsal", state: "open", body: packetBody(),
    labels: [{ name: "status:ready" }, { name: "help wanted" }, { name: "platform:macos" }] };
  const comments = [];
  const calls = [];
  let ordinal = 0;
  const request = async (method, path, body) => {
    ordinal++; calls.push({ method, path, body });
    const decision = options.failure?.({ method, path, ordinal, issue, comments });
    const fail = options.failAt === ordinal || decision === "before";
    const failAfter = options.failAfter === ordinal || decision === "after";
    if (fail) throw new Error("synthetic_api_failure");
    let result;
    if (method === "GET" && path.endsWith("/issues/125")) result = structuredClone(issue);
    else if (method === "GET" && path.includes("/issues?state=open&labels=status%3Aworking"))
      result = [...(issue.labels.some(value => value.name === "status:working") ? [structuredClone(issue)] : []),
        ...structuredClone(options.otherWorking ?? [])];
    else if (method === "GET" && path.includes("/issues?state=open&labels=status%3Ain-review"))
      result = [...(issue.labels.some(value => value.name === "status:in-review") ? [structuredClone(issue)] : []),
        ...structuredClone(options.otherInReview ?? [])];
    else if (method === "GET" && path.includes("/issues/125/comments?")) result = structuredClone(comments);
    else if (method === "GET" && /\/issues\/\d+\/comments\?/.test(path)) {
      const number = Number(path.match(/\/issues\/(\d+)\/comments/)[1]);
      result = structuredClone(options.otherComments?.[number] ?? []);
    }
    else if (method === "GET" && path.endsWith("/git/ref/heads/main")) result = { object: { sha } };
    else if (method === "POST" && path.endsWith("/issues/125/comments")) {
      const comment = { id: 900 + comments.length, body: body.body,
        user: { login: "github-actions[bot]", type: "Bot" } }; comments.push(comment); result = structuredClone(comment);
    } else if (method === "DELETE" && path.includes("/issues/125/labels/")) {
      const label = decodeURIComponent(path.split("/labels/")[1]);
      issue = { ...issue, labels: issue.labels.filter(value => value.name !== label) };
      result = structuredClone(issue.labels);
    } else if (method === "POST" && path.endsWith("/issues/125/labels")) {
      for (const label of body.labels) if (!issue.labels.some(value => value.name === label)) issue.labels.push({ name: label });
      result = structuredClone(issue.labels);
    } else if (method === "PATCH" && path.includes("/issues/comments/")) {
      const id = Number(path.split("/").at(-1)); const comment = comments.find(value => value.id === id);
      if (!comment) throw new Error("synthetic_missing_comment"); comment.body = body.body; result = structuredClone(comment);
    } else if (method === "GET" && path.includes("/issues/comments/")) {
      const id = Number(path.split("/").at(-1)); result = structuredClone(comments.find(value => value.id === id));
    } else if (method === "DELETE" && path.includes("/issues/comments/")) {
      const id = Number(path.split("/").at(-1)); const index = comments.findIndex(value => value.id === id);
      if (index >= 0) comments.splice(index, 1); result = undefined;
    } else throw new Error(`synthetic_unhandled_api:${method}:${path}`);
    if (failAfter) throw new Error("synthetic_lost_api_response");
    return result;
  };
  return { request, calls, comments, issue: () => structuredClone(issue) };
}

test("strict claim request format rejects ambiguity and shell-shaped input without API work", async () => {
  assert.deepEqual(parseClaimRequest("CLAIM REQUEST\nworker-id: worker:test-01"), { workerId: "worker:test-01" });
  for (const body of ["claim request\nworker-id: x", "CLAIM REQUEST\nworker-id: x", "CLAIM REQUEST\nworker-id: ok\nextra: value",
    "CLAIM REQUEST\nworker-id: $(touch /tmp/no)", "CLAIM REQUEST\nworker-id: worker one", "CLAIM REQUEST\rworker-id: worker:test"])
    assert.equal(parseClaimRequest(body), undefined);
  const api = fakeApi();
  assert.deepEqual(await runClaimController({ event: event("CLAIM REQUEST\nworker-id: $(false)"), repository, api }), { status: "ignored" });
  assert.equal(api.calls.length, 0);
});

test("the workflow serializes claims repository-wide with only repository-read and issue-write access", async () => {
  const workflow = await readFile(new URL("../.github/workflows/automatic-job-claim.yml", import.meta.url), "utf8");
  assert.match(workflow, /issue_comment:\n\s+types: \[created\]/);
  assert.match(workflow, /contents: read\n\s+issues: write/);
  assert.ok(workflow.includes("group: automatic-job-claim-${{ github.repository_id }}"));
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.ok(!workflow.includes("github.event.comment.body }}"));
});

test("one ready issue receives one accepted marker, current main base and a label-safe transition", async () => {
  const api = fakeApi();
  const result = await runClaimController({ event: event(), repository, api });
  assert.equal(result.status, "accepted");
  assert.deepEqual({ workerId: result.workerId, actor: result.actor, issueNumber: result.issueNumber, baseSha: result.baseSha },
    { workerId: "worker:test-01", actor: "shared-account", issueNumber: 125, baseSha: sha });
  assert.deepEqual(result.sweep, { status: "swept", outcomes: [{ issue: 125, action: "active" }] });
  assert.equal(api.comments.length, 1); assert.match(api.comments[0].body, /^CLAIM ACCEPTED —/);
  assert.ok(api.comments[0].body.includes(`Base: \`${sha}\``));
  assert.equal(api.comments[0].body.match(/agent-control-room-claim:v3/g)?.length, 1);
  assert.match(api.comments[0].body, /actor=shared-account worker=worker:test-01/);
  assert.deepEqual(api.issue().labels.map(value => value.name).sort(), ["platform:macos", "status:working"]);

  const duplicate = await runClaimController({ event: event("CLAIM REQUEST\nworker-id: worker:test-02"), repository, api });
  assert.deepEqual(duplicate, { status: "refused", reason: "issue_not_ready" });
  assert.equal(api.comments.length, 1);
});

test("a contributor cannot spoof the controller marker", async () => {
  const api = fakeApi();
  api.comments.push({ id: 12,
    body: "CLAIM ACCEPTED — worker identity `attacker`.\n<!-- agent-control-room-claim:v2 issue=125 request=1 actor=shared-account worker=worker:test-01 -->",
    user: { login: "someone", type: "User" } });
  const result = await runClaimController({ event: event(), repository, api });
  assert.equal(result.status, "accepted");
  assert.equal(api.comments.filter(comment => comment.user.login === "github-actions[bot]").length, 1);
});

test("a ready issue with unreleased controller acceptance history cannot be reclaimed", async () => {
  const api = fakeApi();
  api.comments.push({ id: 12,
    body: "CLAIM ACCEPTED — `@shared-account` using worker identity `worker:old-01`.\n"
      + "<!-- agent-control-room-claim:v2 issue=125 request=12 actor=shared-account worker=worker:old-01 -->",
    user: { login: "github-actions[bot]", type: "Bot" } });
  assert.deepEqual(await runClaimController({ event: event(), repository, api }),
    { status: "refused", reason: "accepted_history_requires_release" });
  assert.equal(api.calls.some(call => call.method !== "GET"), false);
});

test("closed, non-ready, needs-decision and pull-request comments never accept", async () => {
  for (const mutate of [
    issue => { issue.state = "closed"; },
    issue => { issue.labels = [{ name: "platform:any" }]; },
    issue => { issue.labels.push({ name: "status:needs-decision" }); },
    issue => { issue.labels.push({ name: "status:done" }); },
  ]) {
    const api = fakeApi(); const snapshot = api.issue(); mutate(snapshot);
    api.request = async (method, path, body) => {
      if (method === "GET" && path.endsWith("/issues/125")) return structuredClone(snapshot);
      throw new Error(`unexpected mutation:${method}:${path}:${body}`);
    };
    assert.deepEqual(await runClaimController({ event: event(), repository, api }), { status: "refused", reason: "issue_not_ready" });
  }
  const api = fakeApi();
  assert.deepEqual(await runClaimController({ event: { ...event(), issue: { number: 125, pull_request: {} } }, repository, api }), { status: "ignored" });
  assert.equal(api.calls.length, 0);
});

test("lost pending-comment response is found by its exact actor, worker and request binding", async () => {
  let lost = false;
  const api = fakeApi({ failure: ({ method, path }) => {
    if (!lost && method === "POST" && path.endsWith("/comments")) { lost = true; return "after"; }
  } });
  const result = await runClaimController({ event: event(), repository, api });
  assert.equal(result.status, "accepted");
  assert.equal(api.comments.length, 1);
  assert.match(api.comments[0].body, /request=501 actor=shared-account worker=worker:test-01/);
});

test("lost label-update response is reconciled forward and never leaves an unaccepted working claim", async () => {
  let lost = false;
  const api = fakeApi({ failure: ({ method, path }) => {
    if (!lost && method === "POST" && path.endsWith("/labels")) { lost = true; return "after"; }
  } });
  const result = await runClaimController({ event: event(), repository, api });
  assert.equal(result.status, "accepted");
  assert.match(api.comments[0].body, /^CLAIM ACCEPTED —/);
  assert.deepEqual(api.issue().labels.map(value => value.name).sort(), ["platform:macos", "status:working"]);
});

test("lost final response reconciles the exact accepted comment without duplicate mutation", async () => {
  let lost = false;
  const api = fakeApi({ failure: ({ method }) => {
    if (!lost && method === "PATCH") { lost = true; return "after"; }
  } });
  const result = await runClaimController({ event: event(), repository, api });
  assert.equal(result.status, "accepted"); assert.equal(result.reconciled, true);
  assert.equal(api.comments.length, 1); assert.match(api.comments[0].body, /^CLAIM ACCEPTED —/);
});

test("an exact GitHub-actor and worker pair cannot hold two active issue claims", async () => {
  const other = { number: 77, state: "open", labels: [{ name: "status:working" }] };
  const body = "CLAIM ACCEPTED — `@shared-account` using worker identity `worker:test-01`.\n"
    + "<!-- agent-control-room-claim:v2 issue=77 request=400 actor=shared-account worker=worker:test-01 -->";
  const api = fakeApi({ otherWorking: [other], otherComments: { 77: [
    { id: 800, body, user: { login: "github-actions[bot]", type: "Bot" } },
  ] } });
  assert.deepEqual(await runClaimController({ event: event(), repository, api }),
    { status: "refused", reason: "actor_worker_pair_active" });
  assert.equal(api.comments.length, 0);
  const otherWorker = await runClaimController({ event: event("CLAIM REQUEST\nworker-id: worker:test-02"), repository, api });
  assert.equal(otherWorker.status, "accepted");

  const secondApi = fakeApi({ otherWorking: [other], otherComments: { 77: [
    { id: 800, body, user: { login: "github-actions[bot]", type: "Bot" } },
  ] } });
  const otherActor = await runClaimController({ event: event(undefined, "other-account"), repository, api: secondApi });
  assert.equal(otherActor.status, "accepted");
});

test("a definite acceptance failure rolls back only an unchanged controller transition", async () => {
  let failed = false;
  const api = fakeApi({ failure: ({ method }) => {
    if (!failed && method === "PATCH") { failed = true; return "before"; }
  } });
  await assert.rejects(runClaimController({ event: event(), repository, api }), /synthetic_api_failure/);
  assert.deepEqual(api.issue().labels.map(value => value.name).sort(), ["help wanted", "platform:macos", "status:ready"]);
  assert.equal(api.comments.length, 0);
});

test("fresh-state comparison refuses a maintainer label change without overwriting it", async () => {
  const api = fakeApi();
  const original = api.request;
  let issueReads = 0;
  api.request = async (method, path, body) => {
    if (method === "GET" && path.endsWith("/issues/125") && ++issueReads === 2) {
      const issue = api.issue();
      issue.labels.push({ name: "status:needs-decision" });
      return issue;
    }
    return original(method, path, body);
  };
  await assert.rejects(runClaimController({ event: event(), repository, api }), /claim_controller_state_changed/);
  assert.equal(api.calls.some(call => call.path.includes("/labels/")), false);
});

test("an unrelated maintainer label added after the transition is preserved through acceptance", async () => {
  let issueReads = 0;
  const api = fakeApi({ failure: context => {
    if (context.method === "GET" && context.path.endsWith("/issues/125") && ++issueReads === 3)
      context.issue.labels.push({ name: "priority:maintainer" });
  } });
  const result = await runClaimController({ event: event(), repository, api });
  assert.equal(result.status, "accepted");
  assert.deepEqual(api.issue().labels.map(value => value.name).sort(),
    ["platform:macos", "priority:maintainer", "status:working"]);
});

test("a newer maintainer status after the transition is preserved and never rolled back", async () => {
  let issueReads = 0;
  const api = fakeApi({ failure: context => {
    if (context.method === "GET" && context.path.endsWith("/issues/125") && ++issueReads === 3)
      context.issue.labels.push({ name: "status:needs-decision" });
  } });
  await assert.rejects(runClaimController({ event: event(), repository, api }), /claim_controller_state_changed/);
  assert.deepEqual(api.issue().labels.map(value => value.name).sort(),
    ["platform:macos", "status:needs-decision"]);
  assert.equal(api.calls.some(call => call.method === "PUT"), false);
  assert.equal(api.comments.length, 0);
});

test("the final fresh-state check refuses a maintainer decision made just before acceptance", async () => {
  let issueReads = 0;
  const api = fakeApi({ failure: context => {
    if (context.method === "GET" && context.path.endsWith("/issues/125") && ++issueReads === 7)
      context.issue.labels.push({ name: "status:needs-decision" });
  } });
  await assert.rejects(runClaimController({ event: event(), repository, api }), /claim_controller_state_changed/);
  assert.equal(api.comments.some(comment => comment.body.startsWith("CLAIM ACCEPTED —")), false);
  assert.deepEqual(api.issue().labels.map(value => value.name).sort(),
    ["platform:macos", "status:needs-decision"]);
  assert.equal(api.calls.some(call => call.method === "PUT"), false);
});

test("rollback preserves a newer unrelated maintainer label", async () => {
  let issueReads = 0; let failed = false;
  const api = fakeApi({ failure: context => {
    if (context.method === "GET" && context.path.endsWith("/issues/125") && ++issueReads === 3)
      context.issue.labels.push({ name: "priority:maintainer" });
    if (!failed && context.method === "PATCH") { failed = true; return "before"; }
  } });
  await assert.rejects(runClaimController({ event: event(), repository, api }), /synthetic_api_failure/);
  assert.deepEqual(api.issue().labels.map(value => value.name).sort(),
    ["help wanted", "platform:macos", "priority:maintainer", "status:ready"]);
  assert.equal(api.comments.length, 0);
});

test("every granular label step restores a before-failure and reconciles a lost response", async () => {
  const steps = [["DELETE", "/labels/status%3Aready"], ["DELETE", "/labels/help%20wanted"],
    ["POST", "/issues/125/labels"]];
  for (const [method, suffix] of steps) {
    let fired = false;
    const before = fakeApi({ failure: context => {
      if (!fired && context.method === method && context.path.endsWith(suffix)) { fired = true; return "before"; }
    } });
    await assert.rejects(runClaimController({ event: event(), repository, api: before }));
    assert.deepEqual(before.issue().labels.map(value => value.name).sort(),
      ["help wanted", "platform:macos", "status:ready"]);
    assert.equal(before.comments.length, 0);

    fired = false;
    const after = fakeApi({ failure: context => {
      if (!fired && context.method === method && context.path.endsWith(suffix)) { fired = true; return "after"; }
    } });
    assert.equal((await runClaimController({ event: event(), repository, api: after })).status, "accepted");
    assert.deepEqual(after.issue().labels.map(value => value.name).sort(), ["platform:macos", "status:working"]);
  }
});

test("a maintainer status after comment acceptance revokes permission and removes only working", async () => {
  let issueReads = 0;
  const api = fakeApi({ failure: context => {
    if (context.method === "GET" && context.path.endsWith("/issues/125") && ++issueReads === 8)
      context.issue.labels.push({ name: "status:needs-decision" });
  } });
  await assert.rejects(runClaimController({ event: event(), repository, api }), /claim_controller_state_changed/);
  assert.deepEqual(api.issue().labels.map(value => value.name).sort(), ["platform:macos", "status:needs-decision"]);
  assert.equal(api.comments.length, 1);
  assert.match(api.comments[0].body, /^CLAIM REVOKED — STOP/);
  assert.doesNotMatch(api.comments[0].body, /^CLAIM ACCEPTED —/);
});

test("a lost cleanup response is reconciled without restoring working or removing maintainer status", async () => {
  let issueReads = 0; let lostCleanup = false;
  const api = fakeApi({ failure: context => {
    if (context.method === "GET" && context.path.endsWith("/issues/125") && ++issueReads === 7)
      context.issue.labels.push({ name: "status:needs-decision" });
    if (!lostCleanup && context.method === "DELETE" && context.path.endsWith("/labels/status%3Aworking")) {
      lostCleanup = true; return "after";
    }
  } });
  await assert.rejects(runClaimController({ event: event(), repository, api }), /claim_controller_state_changed/);
  assert.equal(lostCleanup, true);
  assert.deepEqual(api.issue().labels.map(value => value.name).sort(), ["platform:macos", "status:needs-decision"]);
  assert.equal(api.comments.length, 0);
});

/* ---- Self-service queue: packets, scopes, lifecycle commands, expiry. ---- */

test("malformed packets are refused without any state change", () => {
  assert.ok(parseClaimPacket(packetBody()));
  for (const body of ["no packet here",
    "<!-- acr-public-work:v1 {oops} -->",
    packetBody({ target: "develop" }),
    packetBody({ base: "short" }),
    packetBody({ writeScopes: [] }),
    packetBody({ writeScopes: ["scripts/*.mjs"] }),
    packetBody({ writeScopes: ["src/*/owned.mjs"] }),
    packetBody({ writeScopes: ["../escape.mjs"] }),
    packetBody({ writeScopes: ["/absolute.mjs"] }),
    packetBody({ writeScopes: ["back\\slash.mjs"] }),
    packetBody({ writeScopes: ["/**"] }),
    packetBody({ dependencies: ["not-a-number"] }),
    packetBody({ checks: [] }),
    packetBody({ risk: "critical" }),
    packetBody({ effects: "deploy" }),
    packetBody({ leaseHours: 0 }),
    packetBody({ leaseHours: -5 }),
    packetBody({ leaseHours: Number.NaN }),
    packetBody({ leaseHours: Number.POSITIVE_INFINITY }),
    packetBody({ leaseHours: 721 })])
    assert.equal(parseClaimPacket(body), undefined, body.slice(0, 80));
});

test("only literal paths and terminal /** prefixes are valid scopes", () => {
  for (const scope of ["CONTRIBUTING.md", "scripts/owned.mjs", "skills/worker/**", "a/b/c/**"])
    assert.equal(isValidScope(scope), true, scope);
  for (const scope of ["", "src/*.mjs", "src/**.mjs", "src/***/x", "**", "/**", "/abs.mjs", "../up.mjs",
    "a/../b.mjs", "a//b.mjs", "trail/.", "back\\slash.mjs", "x/"])
    assert.equal(isValidScope(scope), false, scope);
  assert.equal(scopeCovers("skills/worker/**", "skills/worker/SKILL.md"), true);
  assert.equal(scopeCovers("skills/worker/**", "skills/worker"), true);
  assert.equal(scopeCovers("skills/worker/**", "skills/other/SKILL.md"), false);
  assert.equal(scopeCovers("CONTRIBUTING.md", "CONTRIBUTING.md"), true);
  assert.equal(scopeCovers("CONTRIBUTING.md", "CONTRIBUTING.mdx"), false);
  assert.equal(scopesOverlap("skills/worker/**", "skills/worker/SKILL.md"), true);
  assert.equal(scopesOverlap("skills/a/**", "skills/b/**"), false);
  assert.equal(scopesOverlap("a/b.mjs", "a/b.mjs"), true);
  assert.equal(scopesOverlap("a/b.mjs", "a/c.mjs"), false);
  assert.ok(packetsOverlap(parseClaimPacket(packetBody({ writeScopes: ["skills/a/**"] })),
    parseClaimPacket(packetBody({ writeScopes: ["skills/a/SKILL.md"] }))));
  assert.equal(packetsOverlap(parseClaimPacket(packetBody({ writeScopes: ["skills/a/**"] })),
    parseClaimPacket(packetBody({ writeScopes: ["skills/b/**"] }))), false);
});

test("lifecycle commands parse strictly and ignore anything else without API work", async () => {
  const submit = `CLAIM SUBMIT\nworker-id: worker:test-01\npr: 42\nsha: ${"c".repeat(40)}`;
  assert.deepEqual(parseClaimCommand(submit),
    { command: "CLAIM SUBMIT", workerId: "worker:test-01", pr: 42, sha: "c".repeat(40) });
  assert.deepEqual(parseClaimCommand("CLAIM RENEW\nworker-id: worker:test-01"),
    { command: "CLAIM RENEW", workerId: "worker:test-01" });
  assert.deepEqual(parseClaimCommand("CLAIM RELEASE\nworker-id: worker:test-01"),
    { command: "CLAIM RELEASE", workerId: "worker:test-01" });
  for (const body of ["CLAIM RENEW\nworker-id: ok\nextra: x", "CLAIM SUBMIT\nworker-id: worker:test-01\npr: 42",
    "CLAIM SUBMIT\nworker-id: worker:test-01\npr: 0\nsha: " + "c".repeat(40),
    "CLAIM SUBMIT\nworker-id: worker:test-01\npr: 42\nsha: short",
    "CLAIM MERGE\nworker-id: worker:test-01", "CLAIM RENEW\nworker-id: has space"])
    assert.equal(parseClaimCommand(body), undefined, body.slice(0, 60));
  const api = fakeApi();
  for (const runner of [runClaimRenew, runClaimSubmit, runClaimRelease])
    assert.deepEqual(await runner({ event: event("hello"), repository, api }), { status: "ignored" });
  assert.equal(api.calls.length, 0);
});

test("current and legacy accepted markers stay readable during migration", () => {
  const v2 = `CLAIM ACCEPTED — \`@shared-account\` using worker identity \`worker:test-01\`.\n\n<!-- agent-control-room-claim:v2 issue=125 request=501 actor=shared-account worker=worker:test-01 -->`;
  const v2parsed = parseClaimMarker(v2);
  assert.deepEqual({ ...v2parsed }, { version: 2, issue: 125, request: 501, actor: "shared-account", worker: "worker:test-01" });
  const packet = parseClaimPacket(packetBody());
  const v3 = `CLAIM ACCEPTED — x\n\n<!-- agent-control-room-claim:v3 issue=125 request=501 actor=shared-account worker=worker:test-01 packet=${packetHash(packet)} accepted=1700000000000 -->`;
  const v3parsed = parseClaimMarker(v3);
  assert.equal(v3parsed.version, 3);
  assert.equal(v3parsed.packet, packetHash(packet));
  assert.equal(v3parsed.accepted, 1700000000000);
  assert.equal(parseClaimMarker("no marker"), undefined);
  assert.equal(parseClaimMarker(v3.replace("accepted=1700000000000", "accepted=-1")), undefined);
});

/** Multi-issue fake for lifecycle tests: per-issue bodies, labels, comments, pulls and deps. */
function fakeQueue(options = {}) {
  const store = new Map();
  for (const item of options.issues ?? [])
    store.set(item.number, { number: item.number, title: item.title ?? `issue ${item.number}`, state: "open",
      body: item.body ?? packetBody(item.packet ?? {}),
      labels: (item.labels ?? ["status:ready"]).map(name => ({ name })) });
  const comments = new Map();
  const pulls = options.pulls ?? [];
  const closed = new Set(options.closed ?? []);
  const calls = [];
  let nextId = 900;
  const issueState = number => {
    const issue = store.get(number);
    if (!issue) throw new Error(`synthetic_missing_issue:${number}`);
    return issue;
  };
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (options.failAt?.({ method, path }) === "before") throw new Error("synthetic_api_failure");
    let result;
    const issueMatch = path.match(/\/issues\/(\d+)(\/|$|\?)/);
    if (method === "GET" && /\/issues\/\d+\/comments\?/.test(path)) {
      result = structuredClone(comments.get(Number(path.match(/\/issues\/(\d+)\/comments/)[1])) ?? []);
    } else if (method === "GET" && /\/issues\/\d+$/.test(path)) {
      const number = Number(path.match(/\/issues\/(\d+)$/)[1]);
      if (closed.has(number)) result = { number, state: "closed" };
      else if (store.has(number)) result = structuredClone(issueState(number));
      else result = { number, state: "open", labels: [] };
    } else if (method === "GET" && path.includes("/issues?state=open&labels=status%3A")) {
      const status = decodeURIComponent(path.match(/status%3A([a-z-]+)/)[1]);
      result = [...store.values()].filter(issue => issue.state === "open"
        && issue.labels.some(label => label.name === `status:${status}`)).map(issue => structuredClone(issue));
    } else if (method === "GET" && path.endsWith("/git/ref/heads/main")) {
      result = { object: { sha } };
    } else if (method === "POST" && /\/issues\/\d+\/comments$/.test(path)) {
      const number = Number(path.match(/\/issues\/(\d+)\/comments$/)[1]);
      const comment = { id: ++nextId, body: body.body, user: { login: "github-actions[bot]", type: "Bot" } };
      comments.set(number, [...(comments.get(number) ?? []), comment]);
      result = structuredClone(comment);
    } else if (method === "GET" && /\/issues\/comments\/\d+$/.test(path)) {
      const id = Number(path.match(/\/issues\/comments\/(\d+)$/)[1]);
      result = structuredClone([...comments.values()].flat().find(comment => comment.id === id));
    } else if (method === "PATCH" && /\/issues\/comments\/\d+$/.test(path)) {
      const id = Number(path.match(/\/issues\/comments\/(\d+)$/)[1]);
      const comment = [...comments.values()].flat().find(entry => entry.id === id);
      if (!comment) throw new Error("synthetic_missing_comment");
      comment.body = body.body; result = structuredClone(comment);
    } else if (method === "DELETE" && /\/issues\/comments\/\d+$/.test(path)) {
      const id = Number(path.match(/\/issues\/comments\/(\d+)$/)[1]);
      for (const [number, list] of comments) comments.set(number, list.filter(entry => entry.id !== id));
      result = undefined;
    } else if (method === "DELETE" && path.includes("/labels/")) {
      const issue = issueState(Number(issueMatch[1]));
      const label = decodeURIComponent(path.split("/labels/")[1]);
      issue.labels = issue.labels.filter(value => value.name !== label);
      result = structuredClone(issue.labels);
    } else if (method === "POST" && /\/issues\/\d+\/labels$/.test(path)) {
      const issue = issueState(Number(path.match(/\/issues\/(\d+)\/labels$/)[1]));
      for (const label of body.labels) if (!issue.labels.some(value => value.name === label)) issue.labels.push({ name: label });
      result = structuredClone(issue.labels);
    } else if (method === "GET" && /\/pulls\/\d+$/.test(path)) {
      result = structuredClone(pulls.find(pr => pr.number === Number(path.match(/\/pulls\/(\d+)$/)[1])) ?? null);
    } else if (method === "GET" && path.includes("/pulls?state=open")) {
      result = structuredClone(pulls.filter(pr => pr.state === "open"));
    } else throw new Error(`synthetic_unhandled_api:${method}:${path}`);
    if (options.failAt?.({ method, path }) === "after") throw new Error("synthetic_lost_api_response");
    return result;
  };
  return { request, calls,
    labels: number => issueState(number).labels.map(value => value.name).sort(),
    comments: number => structuredClone(comments.get(number) ?? []),
    setBody: (number, body) => { issueState(number).body = body; } };
}

const lifecycleEvent = (body, number = 125, actor = "shared-account", id = 501) => ({ action: "created",
  comment: { body, id, user: { login: actor, type: "User" } }, issue: { number } });

async function acceptHelper(api, number = 125, worker = "worker:test-01", actor = "shared-account", at = 1_700_000_000_000) {
  const realNow = Date.now;
  Date.now = () => at;
  try {
    return await runClaimController({ event: lifecycleEvent(`CLAIM REQUEST\nworker-id: ${worker}`, number, actor), repository, api });
  } finally { Date.now = realNow; }
}

test("a request is refused for a bad packet, effectful work, open deps, overlap and the working cap", async () => {
  const bad = fakeQueue({ issues: [{ number: 125, body: "no packet" }] });
  assert.deepEqual((await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: w:x-01"), repository, api: bad })).reason, "packet_invalid");
  const effectful = fakeQueue({ issues: [{ number: 125, packet: { effects: "filesystem" } }] });
  assert.deepEqual((await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: w:x-01"), repository, api: effectful })).reason, "packet_effectful");
  const deps = fakeQueue({ issues: [{ number: 125, packet: { dependencies: [124] } }] });
  assert.deepEqual((await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: w:x-01"), repository, api: deps })).reason, "dependencies_incomplete");
  const depsClosed = fakeQueue({ issues: [{ number: 125, packet: { dependencies: [124] } }], closed: [124] });
  assert.equal((await acceptHelper(depsClosed)).status, "accepted");
  const overlap = fakeQueue({ issues: [{ number: 125 }, { number: 126, labels: ["status:working"] }] });
  assert.deepEqual((await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: w:x-01"), repository, api: overlap })).reason, "scope_overlap");
  const disjoint = fakeQueue({ issues: [{ number: 125 }, { number: 126, labels: ["status:working"],
    packet: { writeScopes: ["docs/other/**"] } }] });
  assert.equal((await acceptHelper(disjoint)).status, "accepted");
  const cap = fakeQueue({ issues: [{ number: 125 }, { number: 126, packet: { writeScopes: ["docs/cap/**"] } }] });
  assert.equal((await acceptHelper(cap, 125, "worker:cap-01")).status, "accepted");
  const second = await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: worker:cap-01", 126), repository, api: cap });
  assert.equal(second.status, "refused");
  assert.ok(["actor_worker_pair_active", "working_limit"].includes(second.reason), second.reason);
});

test("renew extends only the same pair with an unchanged packet", async () => {
  const api = fakeQueue({ issues: [{ number: 125 }] });
  assert.equal((await acceptHelper(api, 125, "worker:renew-01", "shared-account", 1_700_000_000_000)).status, "accepted");
  const renewed = await runClaimRenew({ event: lifecycleEvent("CLAIM RENEW\nworker-id: worker:renew-01"), repository, api, now: 1_700_000_100_000 });
  assert.equal(renewed.status, "renewed");
  assert.equal(renewed.accepted, 1_700_000_100_000);
  assert.match(api.comments(125).at(-1).body, /^CLAIM RENEWED —/);
  const wrongWorker = await runClaimRenew({ event: lifecycleEvent("CLAIM RENEW\nworker-id: worker:other-01"), repository, api });
  assert.deepEqual(wrongWorker, { status: "refused", reason: "no_accepted_claim_for_pair" });
  const wrongActor = await runClaimRenew({ event: lifecycleEvent("CLAIM RENEW\nworker-id: worker:renew-01", 125, "someone-else"), repository, api });
  assert.deepEqual(wrongActor, { status: "refused", reason: "no_accepted_claim_for_pair" });
  const changed = fakeQueue({ issues: [{ number: 125 }] });
  assert.equal((await acceptHelper(changed, 125, "worker:chg-01", "shared-account", 1_700_000_000_000)).status, "accepted");
  changed.setBody(125, packetBody({ writeScopes: ["docs/changed/**"] }));
  const stale = await runClaimRenew({ event: lifecycleEvent("CLAIM RENEW\nworker-id: worker:chg-01"), repository, api: changed });
  assert.deepEqual(stale, { status: "refused", reason: "packet_changed" });
  const legacyApi = fakeQueue({ issues: [{ number: 125, labels: ["status:working"] }] });
  legacyApi.request("POST", `/repos/${repository}/issues/125/comments`,
    { body: "CLAIM ACCEPTED — legacy\n\n<!-- agent-control-room-claim:v2 issue=125 request=500 actor=shared-account worker=worker:old-01 -->" });
  const legacy = await runClaimRenew({ event: lifecycleEvent("CLAIM RENEW\nworker-id: worker:old-01"), repository, api: legacyApi });
  assert.deepEqual(legacy, { status: "refused", reason: "legacy_claim_manual" });
});

test("submit verifies the open pull request binding and keeps maintainer labels", async () => {
  const head = "c".repeat(40);
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:working", "platform:macos", "priority:maintainer"] }],
    pulls: [{ number: 42, state: "open", title: "Do it (#125)", body: "Closes #125", base: { ref: "main" },
      head: { sha: head }, user: { login: "shared-account" } }] });
  // Seed an accepted marker first through the working issue.
  const ready = fakeQueue({ issues: [{ number: 125, labels: ["status:ready", "platform:macos", "priority:maintainer"] }] });
  assert.equal((await acceptHelper(ready, 125, "worker:submit-01")).status, "accepted");
  const marker = ready.comments(125).at(-1).body;
  const working = fakeQueue({ issues: [{ number: 125, labels: ["status:working", "platform:macos", "priority:maintainer"] }],
    pulls: [{ number: 42, state: "open", title: "Do it (#125)", body: "Closes #125", base: { ref: "main" },
      head: { sha: head }, user: { login: "shared-account" } }] });
  working.request("POST", `/repos/${repository}/issues/125/comments`, { body: marker });
  const submitted = await runClaimSubmit({ event: lifecycleEvent(
    `CLAIM SUBMIT\nworker-id: worker:submit-01\npr: 42\nsha: ${head}`), repository, api: working });
  assert.equal(submitted.status, "submitted");
  assert.deepEqual(submitted.preservedLabels, ["platform:macos", "priority:maintainer"]);
  assert.deepEqual(working.labels(125), ["platform:macos", "priority:maintainer", "status:in-review"]);
  assert.match(working.comments(125).at(-1).body, /^CLAIM SUBMITTED —/);
  const wrongHead = await runClaimSubmit({ event: lifecycleEvent(
    `CLAIM SUBMIT\nworker-id: worker:submit-01\npr: 42\nsha: ${"d".repeat(40)}`), repository, api: working });
  assert.deepEqual(wrongHead, { status: "refused", reason: "issue_not_working" });
});

test("submit refuses a mismatched pull request without moving labels", async () => {
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:working"] }],
    pulls: [{ number: 42, state: "open", title: "Other work (#126)", body: "Closes #126", base: { ref: "main" },
      head: { sha: "c".repeat(40) }, user: { login: "shared-account" } }] });
  const ready = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"] }] });
  assert.equal((await acceptHelper(ready, 125, "worker:bind-01")).status, "accepted");
  api.request("POST", `/repos/${repository}/issues/125/comments`, { body: ready.comments(125).at(-1).body });
  const refused = await runClaimSubmit({ event: lifecycleEvent(
    `CLAIM SUBMIT\nworker-id: worker:bind-01\npr: 42\nsha: ${"c".repeat(40)}`), repository, api });
  assert.deepEqual(refused, { status: "refused", reason: "pr_binding_invalid" });
  assert.deepEqual(api.labels(125), ["status:working"]);
});

test("release returns safe unsubmitted work to ready and refuses the rest", async () => {
  const ready = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"] }] });
  assert.equal((await acceptHelper(ready, 125, "worker:rel-01")).status, "accepted");
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:working"] }] });
  api.request("POST", `/repos/${repository}/issues/125/comments`, { body: ready.comments(125).at(-1).body });
  const released = await runClaimRelease({ event: lifecycleEvent("CLAIM RELEASE\nworker-id: worker:rel-01"), repository, api });
  assert.equal(released.status, "released");
  assert.deepEqual(api.labels(125), ["status:ready"]);
  const again = await runClaimRelease({ event: lifecycleEvent("CLAIM RELEASE\nworker-id: worker:rel-01"), repository, api });
  assert.deepEqual(again, { status: "refused", reason: "issue_not_working" });
  const withPr = fakeQueue({ issues: [{ number: 126, labels: ["status:working"] }],
    pulls: [{ number: 43, state: "open", title: "Work (#126)", body: "Fixes #126", base: { ref: "main" },
      head: { sha: "e".repeat(40) }, user: { login: "shared-account" } }] });
  const ready2 = fakeQueue({ issues: [{ number: 126, labels: ["status:ready"] }] });
  assert.equal((await acceptHelper(ready2, 126, "worker:rel-02")).status, "accepted");
  withPr.request("POST", `/repos/${repository}/issues/126/comments`, { body: ready2.comments(126).at(-1).body });
  const blocked = await runClaimRelease({ event: lifecycleEvent("CLAIM RELEASE\nworker-id: worker:rel-02", 126), repository, api: withPr });
  assert.deepEqual(blocked, { status: "refused", reason: "release_unsafe" });
});

test("expiry returns quiet work to ready, keeps open pull requests in review, and escalates the rest", async () => {
  const old = 1_700_000_000_000;
  const now = old + 73 * 3_600_000;
  const api = fakeQueue({
    issues: [
      { number: 125, labels: ["status:working"] },
      { number: 126, labels: ["status:working"], packet: { writeScopes: ["docs/pr/**"] } },
      { number: 127, labels: ["status:working"], packet: { writeScopes: ["docs/fx/**"], effects: "filesystem" } },
      { number: 128, labels: ["status:working"] },
    ],
    pulls: [{ number: 44, state: "open", title: "Keep (#126)", body: "Closes #126", base: { ref: "main" },
      head: { sha: "f".repeat(40) }, user: { login: "shared-account" } }],
  });
  for (const number of [125, 126]) {
    const seed = fakeQueue({ issues: [{ number, labels: ["status:ready"],
      packet: number === 126 ? { writeScopes: ["docs/pr/**"] } : {} }] });
    assert.equal((await acceptHelper(seed, number, `worker:sweep-0${number}`, "shared-account", old)).status, "accepted");
    api.request("POST", `/repos/${repository}/issues/${number}/comments`, { body: seed.comments(number).at(-1).body });
  }
  // An effectful reservation can only predate packet enforcement: craft its
  // v3 marker directly so the sweep must escalate it, never release it.
  const fxPacket = parseClaimPacket(packetBody({ writeScopes: ["docs/fx/**"], effects: "filesystem" }));
  api.request("POST", `/repos/${repository}/issues/127/comments`,
    { body: `CLAIM ACCEPTED — pre-enforcement\n\n<!-- agent-control-room-claim:v3 issue=127 request=500 actor=shared-account worker=worker:sweep-0127 packet=${packetHash(fxPacket)} accepted=${old} -->` });
  const legacySeed = `CLAIM ACCEPTED — legacy\n\n<!-- agent-control-room-claim:v2 issue=128 request=500 actor=shared-account worker=worker:legacy-01 -->`;
  api.request("POST", `/repos/${repository}/issues/128/comments`, { body: legacySeed });
  const swept = await runClaimSweep({ repository, api, now });
  assert.equal(swept.status, "swept");
  const byIssue = Object.fromEntries(swept.outcomes.map(entry => [entry.issue, entry]));
  assert.deepEqual(byIssue[125], { issue: 125, action: "ready", reason: "lease_expired_no_pr" });
  assert.deepEqual(byIssue[126], { issue: 126, action: "in-review", reason: "open_pr" });
  assert.deepEqual(byIssue[127], { issue: 127, action: "needs-decision", reason: "effectful_claim" });
  assert.deepEqual(byIssue[128], { issue: 128, action: "skipped_legacy", reason: "legacy_claim_manual" });
  assert.deepEqual(api.labels(125), ["status:ready"]);
  assert.deepEqual(api.labels(126), ["status:in-review"]);
  assert.deepEqual(api.labels(127), ["status:needs-decision"]);
  assert.deepEqual(api.labels(128), ["status:working"]);
  const resweep = await runClaimSweep({ repository, api, now });
  assert.ok(!resweep.outcomes.some(entry => entry.issue === 125));
});

test("a lost renew response reconciles from the exact saved comment", async () => {
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"] }] });
  assert.equal((await acceptHelper(api, 125, "worker:lost-01", "shared-account", 1_700_000_000_000)).status, "accepted");
  const accepted = api.comments(125).at(-1);
  let patched = false;
  const flaky = { ...api,
    request: async (method, path, body) => {
      if (!patched && method === "PATCH" && path.includes("/issues/comments/")) {
        patched = true;
        await api.request(method, path, body);
        throw new Error("synthetic_lost_api_response");
      }
      return api.request(method, path, body);
    } };
  await assert.rejects(runClaimRenew({ event: lifecycleEvent("CLAIM RENEW\nworker-id: worker:lost-01"), repository, api: flaky, now: 1_700_000_100_000 }), /synthetic_lost_api_response/);
  assert.equal(patched, true);
  const saved = api.comments(125).find(comment => comment.id === accepted.id);
  assert.match(saved.body, /^CLAIM RENEWED —/);
  const retry = await runClaimRenew({ event: lifecycleEvent("CLAIM RENEW\nworker-id: worker:lost-01"), repository, api, now: 1_700_000_200_000 });
  assert.equal(retry.status, "renewed");
});

test("the claim workflow routes every lifecycle command with least privilege and no secret access", async () => {
  const workflow = await readFile(new URL("../.github/workflows/automatic-job-claim.yml", import.meta.url), "utf8");
  for (const command of ["CLAIM REQUEST", "CLAIM RENEW", "CLAIM SUBMIT", "CLAIM RELEASE"])
    assert.ok(workflow.includes(`'${command}'`), command);
  assert.match(workflow, /contents: read\n\s+issues: write\n(\s+#[^\n]*\n\s+)*pull-requests: read/);
  assert.ok(!workflow.includes("secrets."));
  assert.ok(!workflow.includes("pull-requests: write"));
  assert.ok(!/^\s+(actions|checks|statuses|deployments|packages|pages|security-events|code-scanning-alerts|members|metadata|organization-projects|projects):/m.test(workflow.replace(/^\s+#[^\n]*$/gm, "")));
  assert.ok(!workflow.includes("actions/checkout@") || workflow.includes("persist-credentials: false"));
  assert.ok(workflow.includes("automatic-job-claim-${{ github.repository_id }}"));
  assert.match(workflow, /cancel-in-progress: false/);
  assert.ok(!workflow.includes("github.event.comment.body }}"));
  assert.ok(workflow.includes("--sweep"));
});

test("a released issue is reservable again by a new claim", async () => {
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"] }] });
  assert.equal((await acceptHelper(api, 125, "worker:first-01")).status, "accepted");
  assert.equal((await runClaimRelease({ event: lifecycleEvent("CLAIM RELEASE\nworker-id: worker:first-01"), repository, api })).status, "released");
  assert.deepEqual(api.labels(125), ["status:ready"]);
  const reclaim = await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: worker:second-01"), repository, api });
  assert.equal(reclaim.status, "accepted");
  assert.deepEqual(api.labels(125), ["status:working"]);
});

test("a swept-to-ready issue is reservable again by a new claim", async () => {
  const old = 1_700_000_000_000;
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"] }] });
  assert.equal((await acceptHelper(api, 125, "worker:old-01", "shared-account", old)).status, "accepted");
  const swept = await runClaimSweep({ repository, api, now: old + 73 * 3_600_000 });
  assert.deepEqual(swept.outcomes, [{ issue: 125, action: "ready", reason: "lease_expired_no_pr" }]);
  assert.ok(api.comments(125).some(comment => comment.body.startsWith("CLAIM EXPIRED —")));
  const reclaim = await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: worker:new-01"), repository, api });
  assert.equal(reclaim.status, "accepted");
});

test("a renewed claim survives an earlier cycle's expiry marker", async () => {
  const old = 1_700_000_000_000;
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"] }] });
  assert.equal((await acceptHelper(api, 125, "worker:cyc-01", "shared-account", old)).status, "accepted");
  const swept = await runClaimSweep({ repository, api, now: old + 73 * 3_600_000 });
  assert.equal(swept.outcomes[0].action, "ready");
  const reclaim = await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: worker:cyc-01"), repository, api });
  assert.equal(reclaim.status, "accepted");
  const renewed = await runClaimRenew({ event: lifecycleEvent("CLAIM RENEW\nworker-id: worker:cyc-01"), repository, api, now: old + 74 * 3_600_000 });
  assert.equal(renewed.status, "renewed");
});

test("an in-review path lock still blocks an overlapping request", async () => {
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"], packet: { writeScopes: ["skills/locked/**"] } },
    { number: 126, labels: ["status:in-review"], packet: { writeScopes: ["skills/locked/SKILL.md"] } }] });
  const refused = await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: worker:late-01"), repository, api });
  assert.deepEqual(refused, { status: "refused", reason: "scope_overlap" });
  assert.deepEqual(api.labels(125), ["status:ready"]);
});
