import assert from "node:assert/strict";
import test from "node:test";

import { issueMarkers, jobberTitle, parseJobberCommand, processJobberEvent, producerBranch, pullNumber } from "../scripts/agent-jobber-queue.mjs";
import { renderJobber } from "../scripts/render-agent-jobber.mjs";

const capsule = {
  capsuleId: "CR5D-W1-001",
  block: "CR-5D",
  summary: "Add synthetic executor fixtures",
  platform: "windows",
  taskClass: "T0-mechanical"
};

test("parses the four exact worker queue commands", () => {
  assert.deepEqual(parseJobberCommand("/claim ziggy-windows"), { action: "claim", route: "ziggy-windows" });
  assert.deepEqual(parseJobberCommand("/release ziggy-windows --no-work-started missing tool"), { action: "release", route: "ziggy-windows", reason: "missing tool" });
  assert.deepEqual(parseJobberCommand("/blocked ziggy-windows tests still fail after repair"), { action: "blocked", route: "ziggy-windows", reason: "tests still fail after repair" });
  assert.deepEqual(parseJobberCommand("/submitted ziggy-windows https://github.com/MarvinAi5/control-room/pull/200"), { action: "submitted", route: "ziggy-windows", pullUrl: "https://github.com/MarvinAi5/control-room/pull/200" });
  assert.equal(parseJobberCommand("please claim ziggy-windows"), null);
});

test("issue markers require canonical capsule and integration paths", () => {
  assert.deepEqual(issueMarkers("Capsule: `coordination/agent-build/capsules/CR5D-W1-001.json`\nIntegration: `integration/cr5d-w1`"), {
    capsule: "coordination/agent-build/capsules/CR5D-W1-001.json",
    integration: "integration/cr5d-w1"
  });
  assert.equal(issueMarkers("Capsule: `../escape.json`\nIntegration: `main`"), null);
});

test("titles expose state, platform, tier, block, and capsule before claim", () => {
  assert.equal(jobberTitle("READY", capsule), "[READY][WINDOWS][T0][CR-5D][CR5D-W1-001] Add synthetic executor fixtures");
  assert.equal(jobberTitle("CLAIMED", capsule, "ziggy-windows"), "[CLAIMED:ziggy-windows][WINDOWS][T0][CR-5D][CR5D-W1-001] Add synthetic executor fixtures");
});

test("producer branch is deterministic per route and capsule", () => {
  assert.equal(producerBranch("CR5D-W1-001", "ziggy-windows"), "agent/ziggy-windows/cr5d-w1-001");
});

test("submission URL must belong to the current repository", () => {
  assert.equal(pullNumber("https://github.com/MarvinAi5/control-room/pull/200", "MarvinAi5/control-room"), 200);
  assert.equal(pullNumber("https://github.com/someone-else/control-room/pull/200", "MarvinAi5/control-room"), 0);
});

test("jobber renderer exposes eligibility and canonical queue markers", () => {
  const rendered = renderJobber({
    ...capsule,
    integrationBranch: "integration/cr5d-w1",
    mode: "standard-work",
    risk: "low",
    eligibleRoutes: ["ziggy-windows"],
    maxConcurrentClaimsPerRoute: 3,
    requiredTools: ["node >=22.13.0"],
    dependencies: [],
    objective: "Add exact fixtures.",
    allowedPaths: ["tests/fixtures/example.json"],
    acceptanceCommands: ["node --test tests/example.test.mjs"],
    limits: { maxRepairIterations: 1 },
    effects: { level: "none", maxCount: 0 },
    verification: { required: true, independence: "route" },
    stopConditions: ["Stop on scope ambiguity."]
  }, "coordination/agent-build/capsules/CR5D-W1-001.json");
  assert.equal(rendered.title, "[READY][WINDOWS][T0][CR-5D][CR5D-W1-001] Add synthetic executor fixtures");
  assert.ok(rendered.body.includes("Capsule: `coordination/agent-build/capsules/CR5D-W1-001.json`"));
  assert.ok(rendered.body.includes("Integration: `integration/cr5d-w1`"));
  assert.ok(rendered.body.includes("Required tools:\n- node >=22.13.0"));
});

test("queue controller atomically claims a ready jobber through the GitHub API", async () => {
  const fullCapsule = {
    ...capsule,
    schema: "control-room.agent-build-capsule/v2",
    status: "ready",
    integrationBranch: "integration/cr5d-w1",
    eligibleRoutes: ["ziggy-windows"],
    routeClaimants: { "ziggy-windows": ["MarvinAi5"] },
    dependencies: [],
    maxConcurrentClaimsPerRoute: 3
  };
  const updatedIssues = [];
  const comments = [];
  const event = {
    issue: {
      number: 201,
      title: jobberTitle("READY", fullCapsule),
      body: "Capsule: `coordination/agent-build/capsules/CR5D-W1-001.json`\nIntegration: `integration/cr5d-w1`",
      labels: [{ name: "jobber-ready" }],
      assignees: []
    },
    comment: { body: "/claim ziggy-windows", author_association: "OWNER" },
    sender: { login: "MarvinAi5" }
  };
  const api = async (method, endpoint, body, allow404 = false) => {
    if (method === "GET" && endpoint.startsWith("/contents/coordination/agent-build/capsules/")) {
      return { type: "file", encoding: "base64", content: Buffer.from(JSON.stringify(fullCapsule)).toString("base64") };
    }
    if (method === "GET" && endpoint.startsWith("/labels/")) return allow404 ? null : {};
    if (method === "POST" && endpoint === "/labels") return body;
    if (method === "GET" && endpoint.startsWith("/git/ref/heads/")) return allow404 ? null : {};
    if (method === "GET" && endpoint.startsWith("/issues?")) return [];
    if (method === "PATCH" && endpoint === "/issues/201") {
      updatedIssues.push(body);
      return { number: 201, ...body };
    }
    if (method === "POST" && endpoint === "/issues/201/comments") {
      comments.push(body.body);
      return { id: 1, body: body.body };
    }
    throw new Error(`unexpected ${method} ${endpoint}`);
  };
  const outcome = await processJobberEvent({ event, api, repository: "MarvinAi5/control-room" });
  assert.equal(outcome.action, "claimed");
  assert.equal(updatedIssues.length, 1);
  assert.deepEqual(updatedIssues[0].assignees, ["MarvinAi5"]);
  assert.ok(updatedIssues[0].labels.includes("jobber-claimed"));
  assert.ok(updatedIssues[0].labels.includes("route:ziggy-windows"));
  assert.ok(!updatedIssues[0].labels.includes("jobber-ready"));
  assert.equal(updatedIssues[0].title, jobberTitle("CLAIMED", fullCapsule, "ziggy-windows"));
  assert.equal(comments.length, 1);
  assert.ok(comments[0].includes("CLAIM ACCEPTED"));
});

test("release, blocked, and submitted transitions free route capacity safely", async () => {
  const fullCapsule = {
    ...capsule,
    schema: "control-room.agent-build-capsule/v2",
    status: "ready",
    integrationBranch: "integration/cr5d-w1",
    eligibleRoutes: ["ziggy-windows"],
    routeClaimants: { "ziggy-windows": ["MarvinAi5"] },
    dependencies: [],
    maxConcurrentClaimsPerRoute: 3
  };
  async function run(command) {
    const updates = [];
    const event = {
      issue: {
        number: 202,
        title: jobberTitle("CLAIMED", fullCapsule, "ziggy-windows"),
        body: "Capsule: `coordination/agent-build/capsules/CR5D-W1-001.json`\nIntegration: `integration/cr5d-w1`",
        labels: [{ name: "jobber-claimed" }, { name: "route:ziggy-windows" }],
        assignees: [{ login: "MarvinAi5" }]
      },
      comment: { body: command, author_association: "OWNER" },
      sender: { login: "MarvinAi5" }
    };
    const api = async (method, endpoint, body, allow404 = false) => {
      if (method === "GET" && endpoint.startsWith("/contents/coordination/agent-build/capsules/")) {
        return { type: "file", encoding: "base64", content: Buffer.from(JSON.stringify(fullCapsule)).toString("base64") };
      }
      if (method === "GET" && endpoint.startsWith("/labels/")) return allow404 ? null : {};
      if (method === "POST" && endpoint === "/labels") return body;
      if (method === "GET" && endpoint.startsWith("/git/ref/heads/")) return allow404 ? null : {};
      if (method === "GET" && endpoint === "/pulls/200") return { state: "open", head: { ref: "agent/ziggy-windows/cr5d-w1-001" }, base: { ref: "integration/cr5d-w1" } };
      if (method === "PATCH" && endpoint === "/issues/202") {
        updates.push(body);
        return { number: 202, ...body };
      }
      if (method === "POST" && endpoint === "/issues/202/comments") return { id: 2, body: body.body };
      throw new Error(`unexpected ${method} ${endpoint}`);
    };
    const outcome = await processJobberEvent({ event, api, repository: "MarvinAi5/control-room" });
    return { outcome, update: updates[0] };
  }

  const released = await run("/release ziggy-windows --no-work-started required tool unavailable");
  assert.equal(released.outcome.action, "released");
  assert.ok(released.update.labels.includes("jobber-ready"));
  assert.ok(!released.update.labels.includes("jobber-claimed"));

  const blockedResult = await run("/blocked ziggy-windows test still fails after allowed repair");
  assert.equal(blockedResult.outcome.action, "blocked");
  assert.ok(blockedResult.update.labels.includes("jobber-needs-help"));
  assert.ok(!blockedResult.update.labels.includes("route:ziggy-windows"));

  const submittedResult = await run("/submitted ziggy-windows https://github.com/MarvinAi5/control-room/pull/200");
  assert.equal(submittedResult.outcome.action, "submitted");
  assert.ok(submittedResult.update.labels.includes("jobber-review"));
  assert.deepEqual(submittedResult.update.assignees, []);
});
