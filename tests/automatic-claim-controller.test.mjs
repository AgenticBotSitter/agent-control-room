import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseClaimRequest, runClaimController } from "../scripts/automatic-claim-controller.mjs";

const repository = "AgenticBotSitter/agent-control-room";
const sha = "a".repeat(40);
const event = (body = "CLAIM REQUEST\nworker-id: worker:test-01", actor = "shared-account", id = 501) => ({ action: "created", comment: { body, id, user: { login: actor, type: "User" } },
  issue: { number: 125 } });

function fakeApi(options = {}) {
  let issue = { number: 125, title: "Mac and Linux worker rehearsal", state: "open",
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
  assert.deepEqual(result, { status: "accepted", workerId: "worker:test-01", actor: "shared-account", issueNumber: 125, baseSha: sha });
  assert.equal(api.comments.length, 1); assert.match(api.comments[0].body, /^CLAIM ACCEPTED —/);
  assert.ok(api.comments[0].body.includes(`Base: \`${sha}\``));
  assert.equal(api.comments[0].body.match(/agent-control-room-claim:v2/g)?.length, 1);
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
