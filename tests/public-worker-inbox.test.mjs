import assert from "node:assert/strict";
import test from "node:test";
import { parseActionMarker, readWorkerInbox, renderWorkerInbox } from "../scripts/public-worker-inbox.mjs";

const issue = (labels = ["action:worker", "status:changes-required"]) => ({
  number: 170, title: "Complete queue lifecycle", html_url: "https://github.example/issues/170",
  labels: labels.map(name => ({ name })),
});
const action = (association = "MEMBER", state = "changes-required", worker = "worker:test-01") => ({
  body: `ACTION REQUIRED\n<!-- agent-control-room-action:v1 worker=${worker} state=${state} issue=170 -->`,
  author_association: association, user: { login: "trusted-maintainer" }, html_url: "https://github.example/comment/1",
});

function fakeFetch({ issues = [issue()], comments = [action()] } = {}) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const value = url.includes("/issues/170/comments") ? comments : issues;
    return { ok: true, status: 200, async json() { return structuredClone(value); } };
  };
  return { fetchImpl, calls };
}

test("parses only the exact bounded action marker", () => {
  assert.deepEqual(parseActionMarker(action().body), { workerId: "worker:test-01", state: "changes-required", issue: 170 });
  for (const value of ["ACTION REQUIRED", "<!-- agent-control-room-action:v1 worker=x state=working issue=170 -->",
    "<!-- agent-control-room-action:v1 worker=worker test state=working issue=170 -->"])
    assert.equal(parseActionMarker(value), undefined);
});

test("returns a trusted, label-consistent correction handoff for the exact worker", async () => {
  const api = fakeFetch();
  const inbox = await readWorkerInbox({ workerId: "worker:test-01", fetchImpl: api.fetchImpl, trustedLogins: ["trusted-maintainer"] });
  assert.deepEqual(inbox, [{ issue: 170, title: "Complete queue lifecycle", state: "changes-required",
    action: "Correct the existing pull request and request re-review.", issueUrl: "https://github.example/issues/170",
    instructionUrl: "https://github.example/comment/1" }]);
  assert.equal(api.calls.length, 2);
  assert.match(renderWorkerInbox("worker:test-01", inbox), /ACTION REQUIRED[\s\S]*Correct the existing pull request/);
});

test("ignores public spoofing, another worker, and a stale marker-label mismatch", async () => {
  for (const options of [
    { comments: [{ ...action("CONTRIBUTOR"), user: { login: "untrusted" } }] },
    { comments: [action("MEMBER", "changes-required", "worker:other-01")] },
    { issues: [issue(["action:worker", "status:working"])], comments: [action()] },
  ]) assert.deepEqual(await readWorkerInbox({ workerId: "worker:test-01", fetchImpl: fakeFetch(options).fetchImpl,
    trustedLogins: ["trusted-maintainer"] }), []);
});

test("a newer trusted reassignment makes the older worker inbox empty", async () => {
  const comments = [action("MEMBER", "changes-required", "worker:test-01"),
    action("MEMBER", "changes-required", "worker:new-01")];
  assert.deepEqual(await readWorkerInbox({ workerId: "worker:test-01", fetchImpl: fakeFetch({ comments }).fetchImpl,
    trustedLogins: ["trusted-maintainer"] }), []);
  assert.equal((await readWorkerInbox({ workerId: "worker:new-01", fetchImpl: fakeFetch({ comments }).fetchImpl,
    trustedLogins: ["trusted-maintainer"] }))[0].issue, 170);
});

test("conflicting status or action labels fail closed", async () => {
  for (const labels of [
    ["action:worker", "action:decision", "status:changes-required"],
    ["action:worker", "status:changes-required", "status:paused"],
  ]) assert.deepEqual(await readWorkerInbox({ workerId: "worker:test-01",
    fetchImpl: fakeFetch({ issues: [issue(labels)] }).fetchImpl, trustedLogins: ["trusted-maintainer"] }), []);
});

test("refuses invalid identities, repositories and failed API reads", async () => {
  await assert.rejects(readWorkerInbox({ workerId: "x", fetchImpl: fakeFetch().fetchImpl }), /worker_id_invalid/);
  await assert.rejects(readWorkerInbox({ workerId: "worker:test-01", repository: "bad", fetchImpl: fakeFetch().fetchImpl }), /repository_invalid/);
  await assert.rejects(readWorkerInbox({ workerId: "worker:test-01", fetchImpl: async () => ({ ok: false, status: 403 }) }), /api_403/);
});
