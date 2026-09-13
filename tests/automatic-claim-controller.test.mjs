import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseClaimRequest, runClaimController } from "../scripts/automatic-claim-controller.mjs";

const repository = "AgenticBotSitter/agent-control-room";
const sha = "a".repeat(40);
const event = (body = "CLAIM REQUEST\nworker-id: worker:test-01") => ({ action: "created", comment: { body },
  issue: { number: 125 } });

function fakeApi(options = {}) {
  let issue = { number: 125, title: "Mac and Linux worker rehearsal", state: "open",
    labels: [{ name: "status:ready" }, { name: "help wanted" }, { name: "platform:macos" }] };
  const comments = [];
  const calls = [];
  let ordinal = 0;
  const request = async (method, path, body) => {
    ordinal++; calls.push({ method, path, body });
    const fail = options.failAt === ordinal;
    const failAfter = options.failAfter === ordinal;
    if (fail) throw new Error("synthetic_api_failure");
    let result;
    if (method === "GET" && path.endsWith("/issues/125")) result = structuredClone(issue);
    else if (method === "GET" && path.includes("/issues/125/comments?")) result = structuredClone(comments);
    else if (method === "GET" && path.endsWith("/git/ref/heads/main")) result = { object: { sha } };
    else if (method === "POST" && path.endsWith("/issues/125/comments")) {
      const comment = { id: 900 + comments.length, body: body.body,
        user: { login: "github-actions[bot]", type: "Bot" } }; comments.push(comment); result = structuredClone(comment);
    } else if (method === "PUT" && path.endsWith("/issues/125/labels")) {
      issue = { ...issue, labels: body.labels.map(name => ({ name })) }; result = structuredClone(issue.labels);
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

test("the workflow serializes claims per issue with only repository-read and issue-write access", async () => {
  const workflow = await readFile(new URL("../.github/workflows/automatic-job-claim.yml", import.meta.url), "utf8");
  assert.match(workflow, /issue_comment:\n\s+types: \[created\]/);
  assert.match(workflow, /contents: read\n\s+issues: write/);
  assert.ok(workflow.includes("group: automatic-job-claim-${{ github.event.issue.number }}"));
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.ok(!workflow.includes("github.event.comment.body }}"));
});

test("one ready issue receives one accepted marker, current main base and atomic label set", async () => {
  const api = fakeApi();
  const result = await runClaimController({ event: event(), repository, api });
  assert.deepEqual(result, { status: "accepted", workerId: "worker:test-01", issueNumber: 125, baseSha: sha });
  assert.equal(api.comments.length, 1); assert.match(api.comments[0].body, /^CLAIM ACCEPTED —/);
  assert.ok(api.comments[0].body.includes(`Base: \`${sha}\``));
  assert.equal(api.comments[0].body.match(/agent-control-room-claim:v1/g)?.length, 1);
  assert.deepEqual(api.issue().labels.map(value => value.name).sort(), ["platform:macos", "status:working"]);

  const duplicate = await runClaimController({ event: event("CLAIM REQUEST\nworker-id: worker:test-02"), repository, api });
  assert.deepEqual(duplicate, { status: "refused", reason: "issue_not_ready" });
  assert.equal(api.comments.length, 1);
});

test("a contributor cannot spoof the controller marker", async () => {
  const api = fakeApi();
  api.comments.push({ id: 12,
    body: "CLAIM ACCEPTED — worker identity `attacker`.\n<!-- agent-control-room-claim:v1 issue=125 -->",
    user: { login: "someone", type: "User" } });
  const result = await runClaimController({ event: event(), repository, api });
  assert.equal(result.status, "accepted");
  assert.equal(api.comments.filter(comment => comment.user.login === "github-actions[bot]").length, 1);
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

test("API failures before acceptance leave no accepted marker and restore ready labels", async () => {
  for (const failAt of [1, 2, 3, 4, 5, 6, 7]) {
    const api = fakeApi({ failAt });
    await assert.rejects(runClaimController({ event: event(), repository, api }));
    assert.equal(api.comments.some(comment => comment.body.startsWith("CLAIM ACCEPTED —")), false, `failure ${failAt}`);
    assert.deepEqual(api.issue().labels.map(value => value.name).sort(), ["help wanted", "platform:macos", "status:ready"], `failure ${failAt}`);
  }
});

test("lost final response reconciles the exact accepted comment without duplicate mutation", async () => {
  const api = fakeApi({ failAfter: 7 });
  const result = await runClaimController({ event: event(), repository, api });
  assert.equal(result.status, "accepted"); assert.equal(result.reconciled, true);
  assert.equal(api.comments.length, 1); assert.match(api.comments[0].body, /^CLAIM ACCEPTED —/);
  assert.deepEqual(api.issue().labels.map(value => value.name).sort(), ["platform:macos", "status:working"]);
});
