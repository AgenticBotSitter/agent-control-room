import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { formatClaimResult, isValidScope, packetHash, packetsOverlap, parseClaimCommand, parseClaimMarker, parseClaimPacket, parseClaimRequest, runClaimController, runClaimRelease, runClaimRenew, runClaimSubmit, runClaimSweep, scopeCovers, scopesOverlap } from "../scripts/automatic-claim-controller.mjs";
import { readWorkerInbox } from "../scripts/public-worker-inbox.mjs";
import { readQueueHealth } from "../scripts/public-queue-health.mjs";

const repository = "AgenticBotSitter/agent-control-room";
const sha = "a".repeat(40);
const packetBody = (overrides = {}) => {
  const packet = { target: "main", base: sha, writeScopes: ["scripts/owned-scope.mjs"],
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
    else if (method === "GET" && path.includes("/issues?state=open&labels=status%3A")) {
      const status = decodeURIComponent(path.match(/status%3A([a-z-]+)/)[1]);
      result = issue.labels.some(value => value.name === `status:${status}`) ? [structuredClone(issue)] : [];
    }
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
  assert.match(workflow, /queue: max/);
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
  assert.equal(api.comments[0].body.match(/agent-control-room-claim:v2 issue=125 request=501 actor=shared-account worker=worker:test-01 -->/g)?.length, 1);
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
  const lockPacket = parseClaimPacket(packetBody({ writeScopes: ["docs/other/**"] }));
  const other = { number: 77, state: "open", labels: [{ name: "status:working" }],
    body: packetBody({ writeScopes: ["docs/other/**"] }) };
  const body = "CLAIM ACCEPTED — `@shared-account` using worker identity `worker:test-01`.\n"
    + `<!-- agent-control-room-claim:v3 issue=77 request=400 actor=shared-account worker=worker:test-01 packet=${packetHash(lockPacket)} accepted=1700000000000 -->`;
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
  assert.ok(parseClaimPacket(packetBody({ risk: "standard" })));
  for (const body of ["no packet here",
    "<!-- acr-public-work:v1 {oops} -->",
    `${packetBody()}\n${packetBody({ writeScopes: ["docs/conflict/**"] })}`,
    `${packetBody()}\n<!-- acr-public-work:v1 no-json-here -->`,
    `<!-- acr-public-work:v1 no-json-here -->\n${packetBody()}`,
    packetBody().replace('"effects":"none"', '"effects":"network","effects":"none"'),
    packetBody().replace('"writeScopes":["scripts/owned-scope.mjs"]', '"writeScopes":["secrets/**"],"writeScopes":["scripts/owned-scope.mjs"]'),
    packetBody().replace(/"base":"[a-f0-9]{40}"/, '"base":"1111111111111111111111111111111111111111","base":"0123456789abcdef0123456789abcdef01234567"'),
    packetBody().replace('"effects":"none"', '"eff\\u0065cts":"network","effects":"none"'),
    packetBody().replace('"dependencies":[]', `"dependencies":${"[".repeat(8000)}0${"]".repeat(8000)}`),
    packetBody({ writeScopez: ["docs/typo/**"] }),
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
    packetBody({ risk: "" }),
    packetBody({ risk: "x".repeat(33)}),
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
      labels: (item.labels ?? ["status:ready"]).map(name => ({ name })),
      ...(item.pull_request ? { pull_request: {} } : {}) });
  const comments = new Map();
  const pulls = options.pulls ?? [];
  const commentUrl = (number, id) => ({
    html_url: `https://github.com/${repository}/issues/${number}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/${repository}/issues/${number}`,
    created_at: "2026-09-14T00:00:00.000Z" });
  const closed = new Map((options.closed ?? []).map(entry => typeof entry === "number"
    ? [entry, { labels: ["status:done"], state_reason: "completed" }]
    : [entry.number, { labels: entry.labels ?? ["status:done"], state_reason: entry.state_reason ?? "completed",
      pull_request: entry.pull_request }]));
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
      if (closed.has(number)) {
        const done = closed.get(number);
        result = { number, state: "closed", state_reason: done.state_reason,
          labels: done.labels.map(name => ({ name })),
          ...(done.pull_request ? { pull_request: {} } : {}) };
      } else if (store.has(number)) result = structuredClone(issueState(number));
      else result = { number, state: "open", labels: [] };
    } else if (method === "GET" && path.includes("/issues?state=open&labels=status%3A")) {
      const status = decodeURIComponent(path.match(/status%3A([a-z-]+)/)[1]);
      result = [...store.values()].filter(issue => issue.state === "open"
        && issue.labels.some(label => label.name === `status:${status}`)).map(issue => structuredClone(issue));
    } else if (method === "GET" && path.endsWith("/git/ref/heads/main")) {
      result = { object: { sha } };
    } else if (method === "POST" && /\/issues\/\d+\/comments$/.test(path)) {
      const number = Number(path.match(/\/issues\/(\d+)\/comments$/)[1]);
      const comment = { id: ++nextId, body: body.body, user: { login: "github-actions[bot]", type: "Bot" },
        ...commentUrl(number, nextId) };
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
    if (options.observe) options.observe({ method, path,
      setLabels: (number, names) => { issueState(number).labels = names.map(name => ({ name })); } });
    return result;
  };
  return { request, calls,
    labels: number => issueState(number).labels.map(value => value.name).sort(),
    body: number => issueState(number).body,
    comments: number => structuredClone(comments.get(number) ?? []),
    issues: () => [...store.values()].map(issue => structuredClone(issue)),
    seedComment: (number, comment) => {
      const id = ++nextId;
      const full = { id, user: { login: "github-actions[bot]", type: "Bot" },
        ...commentUrl(number, id), ...comment };
      comments.set(number, [...(comments.get(number) ?? []), full]);
      return structuredClone(full);
    },
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

/** Seed a live v3 accepted marker whose packet matches the issue's current body. */
async function seedAccepted(api, number, worker = "worker:test-01", actor = "shared-account", at = 1_700_000_000_000) {
  const parsed = parseClaimPacket(api.body(number));
  assert.ok(parsed, `seed needs a valid packet on issue ${number}`);
  await api.request("POST", `/repos/${repository}/issues/${number}/comments`, { body:
    `CLAIM ACCEPTED — \`@${actor}\` using worker identity \`${worker}\`.\n\nOutcome: public issue #${number} as currently defined\n\nBase: \`${sha}\`\n\nTarget: \`main\`\n\nThis reservation grants no repository authority.\n<!-- agent-control-room-claim:v3 issue=${number} request=500 actor=${actor} worker=${worker} packet=${packetHash(parsed)} accepted=${at} -->` });
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
  const staleBase = fakeQueue({ issues: [{ number: 125, packet: { base: "c".repeat(40) } }] });
  assert.deepEqual(await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: w:x-01"), repository, api: staleBase }),
    { status: "refused", reason: "packet_base_stale" });
  assert.deepEqual(staleBase.labels(125), ["status:ready"]);
  const overlap = fakeQueue({ issues: [{ number: 125 }, { number: 126, labels: ["status:working"],
    packet: { writeScopes: ["scripts/owned-scope.mjs"] } }] });
  await seedAccepted(overlap, 126, "worker:other-01");
  assert.deepEqual((await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: w:x-01"), repository, api: overlap })).reason, "scope_overlap");
  const disjoint = fakeQueue({ issues: [{ number: 125 }, { number: 126, labels: ["status:working"],
    packet: { writeScopes: ["docs/other/**"] } }] });
  await seedAccepted(disjoint, 126, "worker:other-01");
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

test("submit verifies the open pull request binding and records readiness without moving labels", async () => {
  const head = "c".repeat(40);
  const now = 1_700_000_100_000;
  const boundPull = {
    number: 42, state: "open", title: "Do it (#125)", body: `Closes #125\nControl-Room-Issue: 125`,
    base: { ref: "main", repo: { full_name: repository } },
    head: { sha: head }, user: { login: "shared-account" } };
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:working", "platform:macos", "priority:maintainer"] }],
    pulls: [boundPull] });
  // Seed an accepted marker first through the working issue.
  const ready = fakeQueue({ issues: [{ number: 125, labels: ["status:ready", "platform:macos", "priority:maintainer"] }] });
  assert.equal((await acceptHelper(ready, 125, "worker:submit-01")).status, "accepted");
  const marker = ready.comments(125).at(-1).body;
  const working = fakeQueue({ issues: [{ number: 125, labels: ["status:working", "platform:macos", "priority:maintainer"] }],
    pulls: [boundPull] });
  working.request("POST", `/repos/${repository}/issues/125/comments`, { body: marker });
  const submitted = await runClaimSubmit({ event: lifecycleEvent(
    `CLAIM SUBMIT\nworker-id: worker:submit-01\npr: 42\nsha: ${head}`), repository, api: working, now });
  assert.equal(submitted.status, "submitted");
  // No labels move: the HANDOFF submit command performs the both-sides
  // transition, so the issue stays working and the PR stays unlabelled.
  assert.deepEqual(working.labels(125), ["platform:macos", "priority:maintainer", "status:working"]);
  assert.match(working.comments(125).at(-1).body, /^CLAIM SUBMITTED —/);
  assert.match(working.comments(125).at(-1).body, new RegExp(`pr=42 sha=${head}`));
  const wrongHead = await runClaimSubmit({ event: lifecycleEvent(
    `CLAIM SUBMIT\nworker-id: worker:submit-01\npr: 42\nsha: ${"d".repeat(40)}`), repository, api: working, now });
  assert.deepEqual(wrongHead, { status: "refused", reason: "pr_binding_invalid" });
});

test("submit refuses a mismatched pull request without moving labels", async () => {
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:working"] }],
    pulls: [{ number: 42, state: "open", title: "Other work (#126)", body: "Closes #126", base: { ref: "main" },
      head: { sha: "c".repeat(40) }, user: { login: "shared-account" } }] });
  const ready = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"] }] });
  assert.equal((await acceptHelper(ready, 125, "worker:bind-01")).status, "accepted");
  api.request("POST", `/repos/${repository}/issues/125/comments`, { body: ready.comments(125).at(-1).body });
  const refused = await runClaimSubmit({ event: lifecycleEvent(
    `CLAIM SUBMIT\nworker-id: worker:bind-01\npr: 42\nsha: ${"c".repeat(40)}`), repository, api, now: 1_700_000_100_000 });
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
  assert.deepEqual(again, { status: "released", reconciled: true,
    workerId: "worker:rel-01", actor: "shared-account", issueNumber: 125 });
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
  const renewed = await runClaimRenew({ event: lifecycleEvent("CLAIM RENEW\nworker-id: worker:cyc-01"), repository, api, now: Date.now() + 100_000 });
  assert.equal(renewed.status, "renewed");
});

test("an in-review path lock still blocks an overlapping request", async () => {
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"], packet: { writeScopes: ["skills/locked/**"] } },
    { number: 126, labels: ["status:in-review"], packet: { writeScopes: ["skills/locked/SKILL.md"] } }] });
  await seedAccepted(api, 126, "worker:other-01");
  const refused = await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: worker:late-01"), repository, api });
  assert.deepEqual(refused, { status: "refused", reason: "scope_overlap" });
  assert.deepEqual(api.labels(125), ["status:ready"]);
});

/* ---- Maintainer review corrections: packet identity, lease-first lifecycle,
 * recoverable mutations, actor-bound expiry PRs, completed dependencies. ---- */

const issue181Packet = () => packetBody({
  base: sha,
  writeScopes: ["scripts/private-accessibility-browser-acceptance.mjs", "tests/private-accessibility-product.test.mjs",
    "private-app/app/private.css", "private-app/app/home-workspace.tsx", "private-app/app/needs-me/workspace.tsx",
    "private-app/app/settings/workspace.tsx", "private-app/app/connections/workspace.tsx",
    "private-app/app/project-files-workspace.tsx", "private-app/app/task-workspace.tsx",
    "app/components/project-catalog-navigation.tsx", "app/components/project-catalog.tsx",
    "app/components/connection-center.tsx"],
  checks: ["pnpm build:vps", "node scripts/private-accessibility-browser-acceptance.mjs", "pnpm check"],
  risk: "standard",
});

test("the published #181-style packet is accepted, then any packet change blocks submit", async () => {
  const ready = fakeQueue({ issues: [{ number: 125, body: issue181Packet() }] });
  assert.equal((await acceptHelper(ready)).status, "accepted");
  const marker = ready.comments(125).at(-1).body;
  assert.match(marker, /agent-control-room-claim:v3/);
  const working = fakeQueue({ issues: [{ number: 125, labels: ["status:working"], body: issue181Packet() }],
    pulls: [{ number: 42, state: "open", title: "Access (#125)", body: "Closes #125", base: { ref: "main" },
      head: { sha: "c".repeat(40) }, user: { login: "shared-account" } }] });
  working.request("POST", `/repos/${repository}/issues/125/comments`, { body: marker });
  working.setBody(125, issue181Packet().replace("private-app/app/private.css", "private-app/app/other.css"));
  const refused = await runClaimSubmit({ event: lifecycleEvent(
    `CLAIM SUBMIT\nworker-id: worker:test-01\npr: 42\nsha: ${"c".repeat(40)}`), repository, api: working, now: 1_700_000_100_000 });
  assert.deepEqual(refused, { status: "refused", reason: "packet_changed" });
  assert.deepEqual(working.labels(125), ["status:working"]);
});

test("a packet-less legacy lock fails closed instead of being ignored", async () => {
  const api = fakeQueue({ issues: [{ number: 125 },
    { number: 126, labels: ["status:working"], body: "legacy assignment without a machine packet" }] });
  const refused = await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: worker:new-01"), repository, api });
  assert.deepEqual(refused, { status: "refused", reason: "legacy_lock_manual", issues: [126] });
  assert.deepEqual(api.labels(125), ["status:ready"]);
});

test("claim outcomes make ignored and refused commands unambiguous", () => {
  const malformed = formatClaimResult({ status: "ignored" }, "CLAIM REQUEST\nWorker-ID: worker:test-01");
  assert.match(malformed, /NOT APPLIED/);
  assert.match(malformed, /worker-id: YOUR-STABLE-WORKER-ID/);
  assert.match(malformed, /green Actions run means only/);
  const refused = formatClaimResult({ status: "refused", reason: "legacy_lock_manual", issues: [8, 27] },
    "CLAIM REQUEST\nworker-id: worker:second-01");
  assert.match(refused, /NOT ACCEPTED/);
  assert.match(refused, /legacy_lock_manual/);
  assert.match(refused, /#8, #27/);
  assert.match(refused, /concerns only this command using worker identity `worker:second-01`/);
  assert.match(refused, /does not cancel or replace any existing accepted claim/);
  assert.equal(formatClaimResult({ status: "accepted" }, "CLAIM REQUEST"), undefined);
});

test("a lock whose packet drifted from its accepted marker fails closed", async () => {
  const api = fakeQueue({ issues: [{ number: 125 },
    { number: 126, labels: ["status:working"], packet: { writeScopes: ["docs/drift/**"] } }] });
  await seedAccepted(api, 126, "worker:other-01");
  api.setBody(126, packetBody({ writeScopes: ["docs/drift/**"], checks: ["changed check"] }));
  const refused = await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: worker:new-01"), repository, api });
  assert.deepEqual(refused, { status: "refused", reason: "lock_packet_changed", issues: [126] });
  assert.deepEqual(api.labels(125), ["status:ready"]);
});

test("an expired lease blocks renew and submit before any mutation", async () => {
  const old = 1_700_000_000_000;
  const api = fakeQueue({ issues: [{ number: 125 }] });
  assert.equal((await acceptHelper(api, 125, "worker:old-01", "shared-account", old)).status, "accepted");
  const renewed = await runClaimRenew({ event: lifecycleEvent("CLAIM RENEW\nworker-id: worker:old-01"),
    repository, api, now: old + 1000 * 3_600_000 });
  assert.deepEqual(renewed, { status: "refused", reason: "lease_expired" });
  const submitted = await runClaimSubmit({ event: lifecycleEvent(
    `CLAIM SUBMIT\nworker-id: worker:old-01\npr: 42\nsha: ${"c".repeat(40)}`),
    repository, api, now: old + 1000 * 3_600_000 });
  assert.deepEqual(submitted, { status: "refused", reason: "lease_expired" });
  assert.deepEqual(api.labels(125), ["status:working"]);
  assert.equal(api.comments(125).filter(comment => comment.body.startsWith("CLAIM SUBMIT PENDING —")).length, 0);
});

test("a renewal preserves the immutable accepted base in the public record", async () => {
  const api = fakeQueue({ issues: [{ number: 125 }] });
  assert.equal((await acceptHelper(api)).status, "accepted");
  const renewed = await runClaimRenew({ event: lifecycleEvent("CLAIM RENEW\nworker-id: worker:test-01"),
    repository, api, now: 1_700_000_100_000 });
  assert.equal(renewed.status, "renewed");
  assert.match(api.comments(125).at(-1).body, new RegExp(`Base: \`${sha}\` \\(immutable from acceptance\\)`));
});

test("a dependency is complete only when closed, done and not not-planned", async () => {
  const refused = async (closed, reason) => {
    const api = fakeQueue({ issues: [{ number: 125, packet: { dependencies: [124] } }], closed });
    assert.deepEqual((await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: w:x-01"), repository, api })).reason, reason);
  };
  await refused([{ number: 124, state_reason: "not_planned" }], "dependencies_incomplete");
  await refused([{ number: 124, labels: ["platform:any"] }], "dependencies_incomplete");
  await refused([{ number: 124, pull_request: true }], "dependencies_incomplete");
  const done = fakeQueue({ issues: [{ number: 125, packet: { dependencies: [124] } }], closed: [124] });
  assert.equal((await acceptHelper(done)).status, "accepted");
});

test("submit refuses a pull request owned by another actor", async () => {
  const ready = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"] }] });
  assert.equal((await acceptHelper(ready, 125, "worker:actor-01")).status, "accepted");
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:working"] }],
    pulls: [{ number: 42, state: "open", title: "Work (#125)", body: "Closes #125", base: { ref: "main" },
      head: { sha: "c".repeat(40) }, user: { login: "someone-else" } }] });
  api.request("POST", `/repos/${repository}/issues/125/comments`, { body: ready.comments(125).at(-1).body });
  const refused = await runClaimSubmit({ event: lifecycleEvent(
    `CLAIM SUBMIT\nworker-id: worker:actor-01\npr: 42\nsha: ${"c".repeat(40)}`), repository, api, now: 1_700_000_100_000 });
  assert.deepEqual(refused, { status: "refused", reason: "pr_binding_invalid" });
  assert.deepEqual(api.labels(125), ["status:working"]);
});

test("a pair holding two in-review submissions cannot submit a third", async () => {
  const head = "c".repeat(40);
  const now = 1_700_000_100_000;
  const api = fakeQueue({
    issues: [
      { number: 125, labels: ["status:working"], packet: { writeScopes: ["docs/r1/**"] } },
      { number: 126, labels: ["status:working"], packet: { writeScopes: ["docs/r2/**"] } },
      { number: 127, labels: ["status:working"], packet: { writeScopes: ["docs/r3/**"] } },
    ],
    pulls: [125, 126, 127].map((issue, index) => ({ number: 42 + index, state: "open",
      title: `Work (#${issue})`, body: `Closes #${issue}\nControl-Room-Issue: ${issue}`,
      base: { ref: "main", repo: { full_name: repository } },
      head: { sha: head }, user: { login: "shared-account" } })),
  });
  for (const number of [125, 126, 127]) await seedAccepted(api, number, "worker:cap-01", "shared-account");
  const submit = number => runClaimSubmit({ event: lifecycleEvent(
    `CLAIM SUBMIT\nworker-id: worker:cap-01\npr: ${number - 83}\nsha: ${head}`, number), repository, api, now });
  assert.equal((await submit(125)).status, "submitted");
  assert.equal((await submit(126)).status, "submitted");
  assert.deepEqual(await submit(127), { status: "refused", reason: "in_review_limit" });
  assert.deepEqual(api.labels(127), ["status:working"]);
  // Submissions record readiness only: both submitted issues stay working with
  // their SUBMITTED markers, and the cap counts those outstanding submissions.
  for (const number of [125, 126]) {
    assert.deepEqual(api.labels(number), ["status:working"]);
    assert.equal(api.comments(number).filter(comment => comment.body.startsWith("CLAIM SUBMITTED —")).length, 1);
  }
});

test("a lost submit response reconciles without duplicating the record", async () => {
  const head = "c".repeat(40);
  const boundPull = {
    number: 42, state: "open", title: "Work (#125)", body: `Closes #125\nControl-Room-Issue: 125`,
    base: { ref: "main", repo: { full_name: repository } },
    head: { sha: head }, user: { login: "shared-account" } };
  for (const step of ["pending", "marker"]) {
    const api = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"] }] });
    assert.equal((await acceptHelper(api, 125, "worker:lost-01")).status, "accepted");
    const working = fakeQueue({ issues: [{ number: 125, labels: ["status:working"] }],
      pulls: [boundPull],
      failAt: ({ method, path }) => undefined });
    working.request("POST", `/repos/${repository}/issues/125/comments`, { body: api.comments(125).at(-1).body });
    let fired = false;
    const flaky = { ...working, request: async (method, path, body) => {
      if (!fired && ((step === "pending" && method === "POST" && path.endsWith("/issues/125/comments"))
        || (step === "marker" && method === "PATCH" && path.includes("/issues/comments/")))) {
        fired = true;
        await working.request(method, path, body);
        throw new Error("synthetic_lost_api_response");
      }
      return working.request(method, path, body);
    } };
    const result = await runClaimSubmit({ event: lifecycleEvent(
      `CLAIM SUBMIT\nworker-id: worker:lost-01\npr: 42\nsha: ${head}`), repository, api: flaky, now: 1_700_000_100_000 });
    assert.equal(result.status, "submitted");
    assert.equal(fired, true);
    assert.deepEqual(working.labels(125), ["status:working"]);
    assert.equal(working.comments(125).filter(comment => comment.body.startsWith("CLAIM SUBMITTED —")).length, 1);
  }
});

test("a definite submit marker failure throws without recording submission", async () => {
  const head = "c".repeat(40);
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"] }] });
  assert.equal((await acceptHelper(api, 125, "worker:rb-01")).status, "accepted");
  const working = fakeQueue({ issues: [{ number: 125, labels: ["status:working"] }],
    pulls: [{ number: 42, state: "open", title: "Work (#125)", body: `Closes #125\nControl-Room-Issue: 125`,
      base: { ref: "main", repo: { full_name: repository } },
      head: { sha: head }, user: { login: "shared-account" } }] });
  working.request("POST", `/repos/${repository}/issues/125/comments`, { body: api.comments(125).at(-1).body });
  let fired = false;
  const flaky = { ...working, request: (method, path, body) => {
    if (!fired && method === "PATCH" && path.includes("/issues/comments/")) { fired = true; throw new Error("synthetic_api_failure"); }
    return working.request(method, path, body);
  } };
  await assert.rejects(runClaimSubmit({ event: lifecycleEvent(
    `CLAIM SUBMIT\nworker-id: worker:rb-01\npr: 42\nsha: ${head}`), repository, api: flaky, now: 1_700_000_100_000 }), /synthetic_api_failure/);
  assert.equal(fired, true);
  assert.deepEqual(working.labels(125), ["status:working"]);
  assert.equal(working.comments(125).filter(comment => comment.body.startsWith("CLAIM SUBMITTED —")).length, 0);
});

test("a lost release marker response reconciles and a label failure rolls back", async () => {
  const ready = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"] }] });
  assert.equal((await acceptHelper(ready, 125, "worker:rel-01")).status, "accepted");
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:working"] }] });
  api.request("POST", `/repos/${repository}/issues/125/comments`, { body: ready.comments(125).at(-1).body });
  let lost = false;
  const flaky = { ...api, request: async (method, path, body) => {
    if (!lost && method === "PATCH" && path.includes("/issues/comments/")) {
      lost = true;
      await api.request(method, path, body);
      throw new Error("synthetic_lost_api_response");
    }
    return api.request(method, path, body);
  } };
  const released = await runClaimRelease({ event: lifecycleEvent("CLAIM RELEASE\nworker-id: worker:rel-01"), repository, api: flaky });
  assert.equal(released.status, "released");
  assert.equal(lost, true);
  assert.deepEqual(api.labels(125), ["status:ready"]);

  const ready2 = fakeQueue({ issues: [{ number: 126, labels: ["status:ready"] }] });
  assert.equal((await acceptHelper(ready2, 126, "worker:rel-02")).status, "accepted");
  const working2 = fakeQueue({ issues: [{ number: 126, labels: ["status:working"] }] });
  working2.request("POST", `/repos/${repository}/issues/126/comments`, { body: ready2.comments(126).at(-1).body });
  let failed = false;
  const broken = { ...working2, request: (method, path, body) => {
    if (!failed && method === "POST" && path.endsWith("/issues/126/labels")) { failed = true; throw new Error("synthetic_api_failure"); }
    return working2.request(method, path, body);
  } };
  await assert.rejects(runClaimRelease({ event: lifecycleEvent("CLAIM RELEASE\nworker-id: worker:rel-02", 126), repository, api: broken }), /claim_controller_cleanup_uncertain/);
  assert.equal(failed, true);
  assert.deepEqual(working2.labels(126), ["status:working"]);
  assert.equal(working2.comments(126).filter(comment => comment.body.startsWith("CLAIM RELEASED —")).length, 0);
});

test("expiry ignores an unrelated mention but escalates multiple owned pull requests", async () => {
  const old = 1_700_000_000_000;
  const now = old + 73 * 3_600_000;
  const api = fakeQueue({
    issues: [
      { number: 125, labels: ["status:working"] },
      { number: 126, labels: ["status:working"], packet: { writeScopes: ["docs/multi/**"] } },
    ],
    pulls: [
      { number: 44, state: "open", title: "Drive-by (#125)", body: "Relates to #125", base: { ref: "main" },
        head: { sha: "f".repeat(40) }, user: { login: "someone-else" } },
      { number: 45, state: "open", title: "First (#126)", body: "Closes #126", base: { ref: "main" },
        head: { sha: "f".repeat(40) }, user: { login: "shared-account" } },
      { number: 46, state: "open", title: "Second (#126)", body: "Closes #126", base: { ref: "main" },
        head: { sha: "e".repeat(40) }, user: { login: "shared-account" } },
    ],
  });
  for (const [number, worker] of [[125, "worker:sweep-0125"], [126, "worker:sweep-0126"]]) {
    const seed = fakeQueue({ issues: [{ number, labels: ["status:ready"],
      packet: number === 126 ? { writeScopes: ["docs/multi/**"] } : {} }] });
    assert.equal((await acceptHelper(seed, number, worker, "shared-account", old)).status, "accepted");
    api.request("POST", `/repos/${repository}/issues/${number}/comments`, { body: seed.comments(number).at(-1).body });
  }
  const swept = await runClaimSweep({ repository, api, now });
  const byIssue = Object.fromEntries(swept.outcomes.map(entry => [entry.issue, entry]));
  assert.deepEqual(byIssue[125], { issue: 125, action: "ready", reason: "lease_expired_no_pr" });
  assert.deepEqual(byIssue[126], { issue: 126, action: "needs-decision", reason: "ambiguous_pr" });
  assert.deepEqual(api.labels(125), ["status:ready"]);
  assert.deepEqual(api.labels(126), ["status:needs-decision"]);
});

test("a truncated pull-request listing escalates expiry instead of guessing", async () => {
  const old = 1_700_000_000_000;
  const now = old + 73 * 3_600_000;
  const pulls = Array.from({ length: 100 }, (_, index) => ({ number: 100 + index, state: "open",
    title: `Bulk (${index})`, body: index === 0 ? "Closes #125" : "Unrelated", base: { ref: "main" },
    head: { sha: "f".repeat(40) }, user: { login: "someone-else" } }));
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:working"] }], pulls });
  const seed = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"] }] });
  assert.equal((await acceptHelper(seed, 125, "worker:trunc-01", "shared-account", old)).status, "accepted");
  api.request("POST", `/repos/${repository}/issues/125/comments`, { body: seed.comments(125).at(-1).body });
  const swept = await runClaimSweep({ repository, api, now });
  const outcome = swept.outcomes.find(entry => entry.issue === 125);
  assert.deepEqual(outcome, { issue: 125, action: "needs-decision", reason: "ambiguous_pr_list" });
  assert.deepEqual(api.labels(125), ["status:needs-decision"]);
});

test("a lost expiry marker response reconciles in the same sweep", async () => {
  const old = 1_700_000_000_000;
  const now = old + 73 * 3_600_000;
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:working"] }] });
  const seed = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"] }] });
  assert.equal((await acceptHelper(seed, 125, "worker:lost-01", "shared-account", old)).status, "accepted");
  api.request("POST", `/repos/${repository}/issues/125/comments`, { body: seed.comments(125).at(-1).body });
  let lost = false;
  const flaky = { ...api, request: async (method, path, body) => {
    if (!lost && method === "PATCH" && path.includes("/issues/comments/")) {
      lost = true;
      await api.request(method, path, body);
      throw new Error("synthetic_lost_api_response");
    }
    return api.request(method, path, body);
  } };
  const swept = await runClaimSweep({ repository, api: flaky, now });
  assert.equal(lost, true);
  assert.deepEqual(swept.outcomes, [{ issue: 125, action: "ready", reason: "lease_expired_no_pr" }]);
  assert.deepEqual(api.labels(125), ["status:ready"]);
  assert.ok(api.comments(125).some(comment => comment.body.startsWith("CLAIM EXPIRED —")));
});

test("a definite expiry marker failure recovers on the next sweep without relabeling", async () => {
  const old = 1_700_000_000_000;
  const now = old + 73 * 3_600_000;
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:working"] }] });
  const seed = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"] }] });
  assert.equal((await acceptHelper(seed, 125, "worker:crash-01", "shared-account", old)).status, "accepted");
  api.request("POST", `/repos/${repository}/issues/125/comments`, { body: seed.comments(125).at(-1).body });
  let failed = false;
  const broken = { ...api, request: (method, path, body) => {
    if (!failed && method === "PATCH" && path.includes("/issues/comments/")) { failed = true; throw new Error("synthetic_api_failure"); }
    return api.request(method, path, body);
  } };
  await assert.rejects(runClaimSweep({ repository, api: broken, now }), /synthetic_api_failure/);
  assert.equal(failed, true);
  assert.deepEqual(api.labels(125), ["status:ready"]);
  const resweep = await runClaimSweep({ repository, api, now });
  assert.ok(resweep.outcomes.some(entry => entry.issue === 125 && entry.recovered === true
    && entry.action === "ready" && entry.reason === "lease_expired_no_pr"));
  assert.deepEqual(api.labels(125), ["status:ready"]);
  assert.ok(api.comments(125).some(comment => comment.body.startsWith("CLAIM EXPIRED —")));
});

/* ---- Second maintainer review round: expiry locks, exact state, cycle-bound
 * caps, ambiguous-claim crash. ---- */

test("an expired open-PR claim keeps its path lock without blocking unrelated scopes", async () => {
  const old = 1_700_000_000_000;
  const now = old + 73 * 3_600_000;
  const api = fakeQueue({
    issues: [
      { number: 125, labels: ["status:ready"], packet: { writeScopes: ["docs/fresh/**"] } },
      { number: 126, labels: ["status:working"], packet: { writeScopes: ["docs/kept/**"] } },
    ],
    pulls: [{ number: 42, state: "open", title: "Work (#126)", body: "Closes #126", base: { ref: "main" },
      head: { sha: "c".repeat(40) }, user: { login: "shared-account" } }],
  });
  await seedAccepted(api, 126, "worker:kept-01", "shared-account", old);
  const swept = await runClaimSweep({ repository, api, now });
  assert.deepEqual(swept.outcomes, [{ issue: 126, action: "in-review", reason: "open_pr" }]);
  assert.deepEqual(api.labels(126), ["status:in-review"]);
  const expired = api.comments(126).find(comment => comment.body.startsWith("CLAIM EXPIRED —"));
  assert.ok(expired, "open-PR expiry leaves an expiry marker");
  assert.ok(expired.body.includes(`packet=${packetHash(parseClaimPacket(api.body(126)))}`),
    "expiry marker binds the accepted packet hash");
  api.setBody(125, packetBody({ writeScopes: ["docs/kept/overlap.md"] }));
  assert.deepEqual(
    await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: worker:late-01"), repository, api }),
    { status: "refused", reason: "scope_overlap" });
  api.setBody(125, packetBody({ writeScopes: ["docs/fresh/new.md"] }));
  assert.equal((await acceptHelper(api, 125, "worker:late-01")).status, "accepted");
});

test("a concurrent maintainer pause fails the expiry instead of reporting success", async () => {
  const old = 1_700_000_000_000;
  const now = old + 73 * 3_600_000;
  let api;
  api = fakeQueue({ issues: [{ number: 125, labels: ["status:working"] }],
    failAt: ({ method, path }) => {
      if (method === "DELETE" && path.includes("/labels/status%3Aworking"))
        api.request("POST", `/repos/${repository}/issues/125/labels`, { labels: ["status:paused"] });
      return undefined;
    } });
  await seedAccepted(api, 125, "worker:race-01", "shared-account", old);
  await assert.rejects(runClaimSweep({ repository, api, now }), /claim_controller_state_changed/);
  const labels = api.labels(125);
  assert.ok(labels.includes("status:paused"), "the newer maintainer decision is never overwritten");
  assert.ok(!labels.includes("status:working"), "the stale reservation is not restored over it");
  const resweep = await runClaimSweep({ repository, api, now });
  assert.deepEqual(resweep.outcomes, [], "no success is reported while the state is undecided");
});

test("a historical release does not hide a later cycle's in-review submission", async () => {
  const head = "c".repeat(40);
  const now = 1_700_000_100_000;
  const actor = "shared-account";
  const worker = "worker:cyc-01";
  const api = fakeQueue({
    issues: [
      { number: 125, labels: ["status:working"], packet: { writeScopes: ["docs/s1/**"] } },
      { number: 126, labels: ["status:in-review"], packet: { writeScopes: ["docs/s2/**"] } },
      { number: 127, labels: ["status:in-review"], packet: { writeScopes: ["docs/s3/**"] } },
    ],
    pulls: [125, 126, 127].map((issue, index) => ({ number: 42 + index, state: "open",
      title: `Work (#${issue})`, body: `Closes #${issue}`, base: { ref: "main" },
      head: { sha: head }, user: { login: actor } })),
  });
  const post = (number, body) => api.request("POST", `/repos/${repository}/issues/${number}/comments`, { body });
  const acceptedMark = (number, request) =>
    `CLAIM ACCEPTED — \`@${actor}\` using worker identity \`${worker}\`.\n\n<!-- agent-control-room-claim:v3 issue=${number} request=${request} actor=${actor} worker=${worker} packet=${"d".repeat(64)} accepted=${now - 1000} -->`;
  const submittedMark = (number, request, pr) =>
    `CLAIM SUBMITTED — \`@${actor}\` using worker identity \`${worker}\` submitted PR #${pr}.\n\n<!-- agent-control-room-claim:v3 issue=${number} request=${request} actor=${actor} worker=${worker} packet=${"d".repeat(64)} accepted=${now - 1000} pr=${pr} sha=${head} -->`;
  // Issue 126: an earlier cycle submitted and released, then a later cycle submitted again.
  await post(126, acceptedMark(126, 500));
  await post(126, submittedMark(126, 500, 43));
  await post(126, `CLAIM RELEASED — \`@${actor}\` using worker identity \`${worker}\`.\n\n<!-- agent-control-room-claim:v3 issue=126 request=500 actor=${actor} worker=${worker} released=${now - 500} -->`);
  await post(126, acceptedMark(126, 501));
  await post(126, submittedMark(126, 501, 43));
  await post(127, acceptedMark(127, 502));
  await post(127, submittedMark(127, 502, 44));
  await seedAccepted(api, 125, worker, actor);
  assert.deepEqual(await runClaimSubmit({ event: lifecycleEvent(
    `CLAIM SUBMIT\nworker-id: ${worker}\npr: 42\nsha: ${head}`, 125), repository, api, now }),
  { status: "refused", reason: "in_review_limit" });
  assert.deepEqual(api.labels(125), ["status:working"]);
});

test("an ambiguous claim expires to needs-decision without crashing", async () => {
  const old = 1_700_000_000_000;
  const now = old + 73 * 3_600_000;
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:working"] }] });
  await seedAccepted(api, 125, "worker:amb-01", "shared-account", old);
  await seedAccepted(api, 125, "worker:amb-02", "shared-account", old);
  const swept = await runClaimSweep({ repository, api, now });
  assert.deepEqual(swept.outcomes, [{ issue: 125, action: "needs-decision", reason: "ambiguous_claim" }]);
  assert.deepEqual(api.labels(125), ["status:needs-decision"]);
});

test("a dual-marker acceptance parses as the authoritative v3 record", async () => {
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:ready"] }] });
  assert.equal((await acceptHelper(api)).status, "accepted");
  const body = api.comments(125).at(-1).body;
  assert.match(body, /^CLAIM ACCEPTED —/);
  const parsed = parseClaimMarker(body);
  assert.equal(parsed.version, 3);
  assert.equal(parsed.issue, 125);
  assert.equal(parsed.actor, "shared-account");
  assert.equal(parsed.worker, "worker:test-01");
  assert.match(parsed.packet, /^[a-f0-9]{64}$/);
  assert.equal(parsed.accepted, 1_700_000_000_000);
  const v2only = "CLAIM ACCEPTED — x\n\n<!-- agent-control-room-claim:v2 issue=125 request=501 actor=shared-account worker=worker:test-01 -->";
  assert.equal(parseClaimMarker(v2only).version, 2);
});

test("a maintainer pause between removal and addition wins without a second workflow state", async () => {
  const old = 1_700_000_000_000;
  const now = old + 73 * 3_600_000;
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:working"] }],
    observe: ({ method, path, setLabels }) => {
      if (method === "DELETE" && path.includes("/labels/status%3Aworking"))
        setLabels(125, ["status:paused"]);
    } });
  await seedAccepted(api, 125, "worker:race-01", "shared-account", old);
  await assert.rejects(runClaimSweep({ repository, api, now }), /claim_controller_state_changed/);
  assert.deepEqual(api.labels(125), ["status:paused"]);
});

test("a maintainer pause between addition and verification removes only our addition", async () => {
  const old = 1_700_000_000_000;
  const now = old + 73 * 3_600_000;
  const api = fakeQueue({ issues: [{ number: 125, labels: ["status:working"] }],
    observe: ({ method, path, setLabels }) => {
      if (method === "POST" && path.endsWith("/issues/125/labels"))
        setLabels(125, ["status:ready", "status:paused"]);
    } });
  await seedAccepted(api, 125, "worker:race-02", "shared-account", old);
  await assert.rejects(runClaimSweep({ repository, api, now }), /claim_controller_state_changed/);
  assert.deepEqual(api.labels(125), ["status:paused"]);
  assert.ok(api.calls.some(call => call.method === "DELETE" && call.path.includes("/labels/status%3Aready")));
});

/** The accepted v2 record grammar readers on main rely on. Cf.
 * scripts/review-handoff-controller.mjs acceptedClaim and
 * scripts/public-worker-inbox.mjs CLAIM_MARKER plus the CLAIM outcome line. */
const ACCEPTED_V2_RECORD =
  /<!-- agent-control-room-claim:v2 issue=(\d+) request=(\d+) actor=([^\s]+) worker=([A-Za-z0-9][A-Za-z0-9._:-]{2,79}) -->/;

test("claim and submit records stay compatible with the accepted handoff and inbox interfaces", async () => {
  const head = "c".repeat(40);
  const actor = "shared-account";
  const worker = "worker:chain-01";
  const now = 1_700_000_100_000;
  const api = fakeQueue({
    issues: [
      { number: 125, labels: ["status:ready"] },
      { number: 184, labels: [], pull_request: true, title: "Chain (#125)", body: "Chain work" },
    ],
    pulls: [{ number: 184, state: "open", title: "Chain (#125)",
      body: `Chain work, closes #125.\n\nControl-Room-Issue: 125`,
      base: { ref: "main", repo: { full_name: repository } },
      head: { sha: head }, user: { login: actor } }],
  });
  assert.equal((await acceptHelper(api, 125, worker, actor)).status, "accepted");
  const accepted = api.comments(125).at(-1);
  assert.match(accepted.body, /^CLAIM ACCEPTED —/);
  const v2 = ACCEPTED_V2_RECORD.exec(accepted.body);
  assert.ok(v2, "the acceptance must carry the accepted v2 handoff/inbox record");
  assert.deepEqual([Number(v2[1]), v2[3], v2[4]], [125, actor, worker]);
  const submitted = await runClaimSubmit({ event: lifecycleEvent(
    `CLAIM SUBMIT\nworker-id: ${worker}\npr: 184\nsha: ${head}`, 125, actor), repository, api, now });
  assert.equal(submitted.status, "submitted");
  // The handoff submit preconditions still hold: a working issue, an
  // unlabelled pull request, one exact issue binding, and a recorded
  // SUBMITTED marker carrying the same pull request and head.
  assert.deepEqual(api.labels(125), ["status:working"]);
  assert.deepEqual(api.labels(184), []);
  const marker = api.comments(125).find(comment => comment.body.startsWith("CLAIM SUBMITTED —"));
  assert.ok(marker);
  assert.match(marker.body, new RegExp(`pr=184 sha=${head}`));
  // The handoff controller reads the latest v2 comment as the claim: no later
  // controller comment may carry a v2 marker, or the claim goes invisible.
  for (const comment of api.comments(125))
    if (comment.id !== accepted.id) assert.ok(!comment.body.includes("agent-control-room-claim:v2"));
});

/**
 * Joined chain across the accepted interfaces: this controller claims and
 * records submission readiness, the worker inbox reports the assignment, and
 * the accepted handoff controller moves both the issue and the pull request
 * through submit, correction, acknowledgment and resubmit with both linked
 * records consistent. The handoff and inbox modules are imported from a
 * current main checkout so the test exercises the real readers, not copies.
 */
const MAIN_ROOT = process.env.ACR_MAIN_CHECKOUT;
test("claim, inbox, submit, correction and resubmit stay consistent across both controllers",
  { skip: MAIN_ROOT ? false : "needs ACR_MAIN_CHECKOUT pointing at a current main checkout" }, async () => {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const { runHandoff, parseHandoff } = await import(pathToFileURL(join(MAIN_ROOT, "scripts/review-handoff-controller.mjs")).href);
    const { readWorkerInbox } = await import(pathToFileURL(join(MAIN_ROOT, "scripts/public-worker-inbox.mjs")).href);
    const head = "c".repeat(40);
    const actor = "shared-account";
    const maintainer = "lead-maintainer";
    const worker = "worker:chain-01";
    const now = 1_700_000_100_000;
    const api = fakeQueue({
      issues: [
        { number: 125, labels: ["status:ready"] },
        { number: 184, labels: [], pull_request: true, title: "Chain (#125)", body: "Chain work" },
      ],
      pulls: [{ number: 184, state: "open", title: "Chain (#125)",
        body: `Chain work, closes #125.\n\nControl-Room-Issue: 125`,
        base: { ref: "main", repo: { full_name: repository } },
        head: { sha: head }, user: { login: actor } }],
    });
    assert.equal((await acceptHelper(api, 125, worker, actor)).status, "accepted");
    const acceptedId = api.comments(125).at(-1).id;
    assert.equal((await runClaimSubmit({ event: lifecycleEvent(
      `CLAIM SUBMIT\nworker-id: ${worker}\npr: 184\nsha: ${head}`, 125, actor), repository, api, now })).status, "submitted");
    const handoffApi = (method, path, body) => api.request(method, path, body);
    const fetchImpl = async url => {
      const parsed = new URL(url);
      const json = async () => {
        const commentsMatch = parsed.pathname.match(/\/issues\/(\d+)\/comments$/);
        if (commentsMatch) return structuredClone(api.comments(Number(commentsMatch[1])));
        if (parsed.pathname.endsWith("/issues"))
          return api.issues().map(issue => ({ ...issue,
            html_url: `https://github.com/${repository}/issues/${issue.number}` }));
        throw new Error(`synthetic_unhandled_inbox:${url}`);
      };
      return { ok: true, json };
    };
    const inbox = () => readWorkerInbox({ workerId: worker, repository, fetchImpl });
    let entry = (await inbox()).find(action => action.issue === 125);
    assert.equal(entry?.state, "working");
    assert.equal(entry?.disposition, "action");
    assert.equal(entry?.trust, "controller-record");
    assert.ok(!(await inbox()).some(action => action.issue === 184));
    const handoffEvent = (command, login, previousId) => {
      const comment = api.seedComment(125, {
        body: `HANDOFF ${command}\nworker-id: ${worker}\npr: 184\nhead: ${head}\nprevious: ${previousId}`,
        user: { login, type: "User" } });
      return { action: "created", sender: { login }, issue: { number: 125 }, comment };
    };
    const run = event => runHandoff({ event, repository, api: handoffApi, maintainers: [maintainer] });
    let result = await run(handoffEvent("submit", actor, 0));
    assert.equal(result.status, "recorded");
    assert.equal(result.state, "in-review");
    assert.deepEqual(api.labels(125), ["action:reviewer", "status:in-review"]);
    assert.deepEqual(api.labels(184), ["action:reviewer", "status:in-review"]);
    entry = (await inbox()).find(action => action.issue === 125);
    assert.equal(entry?.disposition, "waiting");
    result = await run(handoffEvent("changes", maintainer, result.commentId));
    assert.equal(result.state, "changes-required");
    entry = (await inbox()).find(action => action.issue === 125);
    assert.equal(entry?.markerState, "changes-required");
    assert.equal(entry?.acknowledged, false);
    result = await run(handoffEvent("acknowledge", actor, result.commentId));
    assert.equal((await inbox()).find(action => action.issue === 125)?.acknowledged, true);
    result = await run(handoffEvent("resubmit", actor, result.commentId));
    assert.equal(result.state, "re-review");
    assert.deepEqual(api.labels(125), ["action:reviewer", "status:re-review"]);
    assert.deepEqual(api.labels(184), ["action:reviewer", "status:re-review"]);
    assert.equal((await inbox()).find(action => action.issue === 125)?.disposition, "waiting");
    // Both linked records agree on every step: the same issue, pull request,
    // head, worker and claim journal back the claim, the submission and the
    // handoff chain.
    const journals = api.comments(125).map(comment => parseHandoff(comment)).filter(Boolean);
    assert.ok(journals.length >= 4);
    for (const journal of journals)
      assert.deepEqual([journal.issue, journal.pr, journal.head, journal.workerId, journal.claimId],
        [125, 184, head, worker, acceptedId]);
    const submitted = api.comments(125).find(comment => comment.body.startsWith("CLAIM SUBMITTED —"));
    assert.ok(submitted?.body.includes(`pr=184 sha=${head}`));
  });

// Round: issue #259 — false-ready admission extraction regressions. The shared
// admission evaluator is the single source of truth for packet validity,
// dependencies, accepted-history and base SHA. These regressions cover the
// scenarios the maintainer asked for: stale-base after a main advance,
// repin after maintainer action, accepted-history retention, conflicting
// labels, malformed packets, legacy locks, permission/API errors and
// pagination limits. Worker capacity is exercised by `every operator missing
// dependency and mismatch class refuses before return`.

test("a Ready issue whose packet base is older than the current main is refused as stale", async () => {
  const packet = { base: "c".repeat(40), writeScopes: ["scripts/example/**"], dependencies: [], checks: ["pnpm check:demo"], risk: "ordinary", effects: "none", leaseHours: 24 };
  const api = fakeQueue({ issues: [{ number: 125, packet }] });
  // Simulate the post-merge reality: the live main has moved on.
  api.request = baseRequestWithMain(api, "b".repeat(40));
  const result = await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: w:x-01"), repository, api });
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "packet_base_stale");
  assert.equal(api.labels(125).includes("status:working"), false,
    "stale-base offer must not be transitioned to Working");
});

test("after the maintainer repins the packet base, the same offer is admitted", async () => {
  const mainSha = "d".repeat(40);
  const packet = { base: mainSha, writeScopes: ["scripts/example/**"], dependencies: [], checks: ["pnpm check:demo"], risk: "ordinary", effects: "none", leaseHours: 24 };
  const api = fakeQueue({ issues: [{ number: 125, packet }] });
  api.request = baseRequestWithMain(api, mainSha);
  const result = await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: w:x-01"), repository, api });
  assert.equal(result.status, "accepted");
  assert.equal(api.labels(125).includes("status:working"), true);
});

test("a Ready issue whose packet base matches the current main but carries conflicting labels is refused", async () => {
  const mainSha = "e".repeat(40);
  const packet = { base: mainSha, writeScopes: ["scripts/example/**"], dependencies: [], checks: ["pnpm check:demo"], risk: "ordinary", effects: "none", leaseHours: 24 };
  const api = fakeQueue({ issues: [{ number: 125, packet, labels: ["status:ready", "status:working"] }] });
  api.request = baseRequestWithMain(api, mainSha);
  const result = await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: w:x-01"), repository, api });
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "issue_not_ready");
});

test("a Ready issue with an effects != none packet is refused without inspecting dependencies", async () => {
  const mainSha = "f".repeat(40);
  const packet = { base: mainSha, writeScopes: ["scripts/example/**"], dependencies: [], checks: ["pnpm check:demo"], risk: "ordinary", effects: "filesystem", leaseHours: 24 };
  const api = fakeQueue({ issues: [{ number: 125, packet }] });
  api.request = baseRequestWithMain(api, mainSha);
  const result = await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: w:x-01"), repository, api });
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "packet_effectful");
});

test("a Ready issue whose dependency is not closed + done + completed is refused", async () => {
  const mainSha = "a".repeat(40);
  const packet = { base: mainSha, writeScopes: ["scripts/example/**"], dependencies: [124], checks: ["pnpm check:demo"], risk: "ordinary", effects: "none", leaseHours: 24 };
  // dependency 124 is in the issues list (open, not closed) — the controller's
  // dependencyIssueComplete check returns false.
  const api = fakeQueue({ issues: [{ number: 125, packet }, { number: 124, labels: ["status:ready"] }] });
  api.request = baseRequestWithMain(api, mainSha);
  const result = await runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: w:x-01"), repository, api });
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "dependencies_incomplete");
});

test("a permission or API error during the base observation throws rather than returning an empty refusal", async () => {
  const packet = { base: "a".repeat(40), writeScopes: ["scripts/example/**"], dependencies: [], checks: ["pnpm check:demo"], risk: "ordinary", effects: "none", leaseHours: 24 };
  const api = fakeQueue({ issues: [{ number: 125, packet }] });
  const originalRequest = api.request.bind(api);
  api.request = async (method, path, body) => {
    if (method === "GET" && /git\/ref\/heads\/main$/.test(path)) throw new Error("claim_controller_api_invalid");
    return await originalRequest(method, path, body);
  };
  await assert.rejects(runClaimController({ event: lifecycleEvent("CLAIM REQUEST\nworker-id: w:x-01"), repository, api }),
    /claim_controller_api_invalid/);
});

test("the admission evaluator is GET-only; an evaluation that requires a non-GET call is a contract violation", async () => {
  // The evaluator's only network dependency is the caller-supplied api. A test that
  // records every method the evaluator invokes is sufficient to enforce the
  // GET-only contract across both controller and discovery paths.
  const calls = [];
  const api = {
    request: async (method, path) => {
      calls.push({ method, path });
      if (method !== "GET") throw new Error("admission_evaluator_non_get_attempt");
      return { object: { sha: "a".repeat(40) } };
    },
  };
  const { evaluateAdmissionDecision, observeMainBase } = await import("../scripts/admission-evaluator.mjs");
  const observation = await observeMainBase({ api, repository });
  const admission = await evaluateAdmissionDecision({
    issue: { number: 1, state: "open", labels: [{ name: "status:ready" }] },
    comments: [], packet: { base: observation.baseSha, effects: "none", dependencies: [] },
    openNumbers: new Set(), baseSha: observation.baseSha, observedAt: observation.observedAt,
  });
  assert.equal(admission.outcome, "admit");
  assert.equal(calls.every(call => call.method === "GET"), true,
    `evaluator must not perform non-GET calls; saw: ${JSON.stringify(calls)}`);
});

function baseRequestWithMain(api, sha) {
  const original = api.request.bind(api);
  return async (method, path, body) => {
    if (method === "GET" && /git\/ref\/heads\/main$/.test(path))
      return { object: { sha } };
    return await original(method, path, body);
  };
}

// Round 2 (issue #259): the controller and both reports must classify the SAME
// adversarial snapshot identically. One snapshot store serves the controller's
// api adapter and the injected fetch for discovery and queue health.
const snapshotPacket = (base, dependencies = []) => `Work packet.\n\n<!-- acr-public-work:v1 ${JSON.stringify({
  target: "main", base, writeScopes: ["scripts/owned-scope.mjs"], dependencies,
  checks: ["node --test tests/owned-scope.test.mjs"], risk: "boundary", effects: "none", leaseHours: 72,
})}\n-->`;
const snapshotIssue = (number, { base = "a".repeat(40), dependencies = [], labels = ["status:ready"], state = "open" } = {}) => ({
  number, title: `Snapshot ${number}`, state, body: snapshotPacket(base, dependencies),
  labels: labels.map(name => ({ name })),
});
const snapshotStore = ({ issues, commentsByIssue = {}, refSha }) => {
  const byNumber = new Map(issues.map(issue => [issue.number, issue]));
  const controllerApi = async (method, path) => {
    if (method !== "GET") throw new Error(`snapshot_unexpected_write:${method}:${path}`);
    if (/\/issues\/\d+\/comments\?/.test(path)) {
      const number = Number(path.match(/\/issues\/(\d+)\/comments/)[1]);
      return structuredClone(commentsByIssue[number] ?? []);
    }
    if (/\/issues\?state=open&labels=status%3A/.test(path)) return [];
    const single = path.match(/\/issues\/(\d+)$/);
    if (single) {
      const found = byNumber.get(Number(single[1]));
      if (!found) throw new Error(`snapshot_missing_issue:${single[1]}`);
      return structuredClone(found);
    }
    if (/\/git\/ref\/heads\/main$/.test(path)) return { object: { sha: refSha } };
    throw new Error(`snapshot_unhandled_api:${method}:${path}`);
  };
  const fetchImpl = async url => {
    if (url.includes("/git/ref/heads/main"))
      return { ok: true, status: 200, async json() { return { object: { sha: refSha } }; } };
    const cm = /\/issues\/(\d+)\/comments/.exec(url);
    if (cm) {
      const all = commentsByIssue[cm[1]] ?? [];
      const page = Number(/page=(\d+)/.exec(url)?.[1] ?? 1);
      return { ok: true, status: 200, async json() { return structuredClone(all.slice((page - 1) * 100, page * 100)); } };
    }
    const sm = /\/issues\/(\d+)(?:[?/]|$)/.exec(url);
    if (sm) return { ok: true, status: 200, async json() { return structuredClone(byNumber.get(Number(sm[1])) ?? null); } };
    if (url.includes("/pulls")) return { ok: true, status: 200, async json() { return []; } };
    if (url.includes("/issues")) return { ok: true, status: 200, async json() { return structuredClone(issues); } };
    return { ok: false, status: 404, async json() { return {}; } };
  };
  return { controllerApi: { request: controllerApi }, fetchImpl };
};

test("controller and reports classify the same stale-base snapshot identically", async () => {
  const mainSha = "f".repeat(40);
  const staleBase = "c".repeat(40);
  const issues = [snapshotIssue(125, { base: staleBase })];
  const { controllerApi, fetchImpl } = snapshotStore({ issues, refSha: mainSha });
  const decided = await runClaimController({ event: event(), repository, api: controllerApi });
  assert.equal(decided.status, "refused");
  assert.equal(decided.reason, "packet_base_stale");
  const offers = (await readWorkerInbox({ workerId: "worker:test-01", includeReady: true, fetchImpl }))
    .filter(action => action.disposition === "discovery");
  assert.equal(offers.length, 1);
  assert.equal(offers[0].state, "queue-blocked");
  assert.equal(offers[0].reason, "packet_base_stale");
  assert.equal(offers[0].admission.reason, "packet_base_stale");
  assert.equal(offers[0].admission.observedBase, mainSha);
  assert.equal(offers[0].admission.packetBase, staleBase);
  assert.equal(offers[0].admission.capacity, "unknown");
  const report = await readQueueHealth({ fetchImpl });
  assert.equal(report.blockedOffers.length, 1);
  assert.equal(report.blockedOffers[0].admission.reason, "packet_base_stale");
  assert.equal(report.blockedOffers[0].admission.observedBase, mainSha);
});

test("controller and reports classify the same open-dependency snapshot identically", async () => {
  const mainSha = "a".repeat(40);
  const issues = [
    snapshotIssue(125, { base: mainSha, dependencies: [126] }),
    snapshotIssue(126, { labels: [] }),
  ];
  const { controllerApi, fetchImpl } = snapshotStore({ issues, refSha: mainSha });
  const decided = await runClaimController({ event: event(), repository, api: controllerApi });
  assert.equal(decided.status, "refused");
  assert.equal(decided.reason, "dependencies_incomplete");
  const offers = (await readWorkerInbox({ workerId: "worker:test-01", includeReady: true, fetchImpl }))
    .filter(action => action.disposition === "discovery");
  const dep = offers.find(action => action.issue === 125);
  assert.equal(dep.state, "queue-blocked");
  assert.equal(dep.reason, "open_dependencies");
  assert.equal(dep.admission.reason, "dependencies_incomplete");
  const report = await readQueueHealth({ fetchImpl });
  const blocked = report.blockedOffers.find(offer => offer.issue === 125);
  assert.equal(blocked.admission.reason, "dependencies_incomplete");
});
