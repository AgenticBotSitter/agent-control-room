// Idea Lab fixture tests. Two layers:
//
// 1. Wire-shape guards: Zod-parse every synthetic GET response against
//    src/web/v1/idea-wire.ts (strict schemas + cross-field refinements).
// 2. Product-behavior guards: drive the REAL browser clients
//    (create/decision/stop) against the synthetic server as transport,
//    asserting receipt echo checks, retry-after-uncertainty, idempotent
//    replay, conflict/not-found mappings, and startsWork:false on every
//    receipt (promotion never executes here).
//
// Revert any enum, shape, or server semantic in response-builders.ts or
// fixture-data.ts and at least one subtest must fail.

import test from "node:test";
import assert from "node:assert/strict";

import { labs, digests } from "./browser/idealab/fixture-data.ts";
import { createIdeaLabServer } from "./browser/idealab/response-builders.ts";
import { ideaPageSchema, ideaDetailSchema, ideaCreationOptionsSchema } from "../src/web/v1/idea-wire.ts";
import { createIdeaCreationClient } from "../src/web/v1/idea-create-client.ts";
import { createIdeaDecisionClient } from "../src/web/v1/idea-decision-client.ts";
import { createIdeaStopClient } from "../src/web/v1/idea-stop-client.ts";
import { createIdeaStartClient } from "../src/web/v1/idea-start-client.ts";
import { createIdeaSynthesisClient } from "../src/web/v1/idea-synthesis-client.ts";
import { BrowserRequestError } from "../src/web/v1/browser-client.ts";

const NOW = new Date().toISOString();
const SESSION_IDS = Object.keys(labs);
const LAB_A = "idea:lab:completed-synthesis";
const LAB_B = "idea:lab:running-gap";
const LAB_C = "idea:lab:partial-failure";

// fetch-shaped adapter over the synthetic server. Unknown paths fail
// closed (503), mirroring the browser fixture interceptor.
function asTransport(server) {
  return async (url, init) => {
    const method = ((init && init.method) || "GET").toUpperCase();
    const path = url.includes("/api/v1/ideas") ? url.slice(url.indexOf("/api/v1/ideas")) : "";
    const headers = new Headers((init && init.headers) || {});
    const body = init && init.body ? JSON.parse(String(init.body)) : undefined;
    let result;
    if (method === "GET" && (path === "/api/v1/ideas" || path.startsWith("/api/v1/ideas?after="))) {
      result = { status: 200, json: server.buildIdeaPage() };
    } else if (method === "GET" && path === "/api/v1/ideas/options") {
      result = { status: 200, json: server.buildIdeaOptions() };
    } else if (method === "POST" && path === "/api/v1/ideas") {
      result = server.postCreate(body, headers.get("idempotency-key") || "");
    } else {
      const m = path.match(/^\/api\/v1\/ideas\/([^/]+)(\/(decision|start|stop|synthesis))?$/);
      if (!m) {
        result = { status: 503, json: { error: "synthetic_not_found" } };
      } else {
        const sessionId = decodeURIComponent(m[1]);
        const action = m[3];
        if (method === "GET" && !action) {
          try {
            result = { status: 200, json: server.buildIdeaDetail(sessionId) };
          } catch {
            result = { status: 404, json: { error: "synthetic" } };
          }
        } else if (method === "POST" && action === "decision") result = server.postDecision(sessionId, body);
        else if (method === "POST" && action === "start") result = server.postStart(sessionId);
        else if (method === "POST" && action === "stop") result = server.postStop(sessionId, body);
        else if (method === "POST" && action === "synthesis") result = server.postSynthesis(sessionId);
        else result = { status: 503, json: { error: "synthetic_not_found" } };
      }
    }
    return new Response(JSON.stringify(result.json), { status: result.status, headers: { "content-type": "application/json" } });
  };
}

const saveDraft = {
  sessionDigest: digests.sessionDigest,
  synthesisDigest: digests.synthesisDigest,
  intent: { decision: "save", safeReasonCode: "synthetic_review" },
};

// --- wire-shape guards ---

test("idealab-fixture: page parses and lists all labs newest-first", () => {
  const server = createIdeaLabServer(NOW);
  const page = ideaPageSchema.parse(server.buildIdeaPage());
  assert.equal(page.sessions.length, 3);
  assert.equal(page.nextCursor, null);
  assert.ok(page.sessions[0].sessionId >= page.sessions[1].sessionId);
  assert.ok(page.sessions[1].sessionId >= page.sessions[2].sessionId);
  assert.deepEqual(page.sessions.map(s => s.sessionId).sort(), [...SESSION_IDS].sort());
});

for (const sessionId of SESSION_IDS) {
  test(`idealab-fixture: ${sessionId} detail parses against ideaDetailSchema`, () => {
    const server = createIdeaLabServer(NOW);
    const detail = ideaDetailSchema.parse(server.buildIdeaDetail(sessionId));
    assert.equal(detail.session.sessionId, sessionId);
  });
}

test("idealab-fixture: completed lab is whole — six turns, synthesis, decision open", () => {
  const server = createIdeaLabServer(NOW);
  const detail = ideaDetailSchema.parse(server.buildIdeaDetail(LAB_A));
  const completedAttempts = detail.run.attempts.filter(a => a.state === "completed").length;
  assert.equal(detail.run.state, "completed");
  assert.equal(detail.run.messagesUsed, completedAttempts);
  assert.equal(detail.contributions.length, completedAttempts);
  assert.ok(detail.synthesis !== null);
  assert.equal(detail.canDecide, true);
  assert.equal(detail.canPromote, true);
});

test("idealab-fixture: failed lab keeps its gap visible with no synthesis or decision", () => {
  const server = createIdeaLabServer(NOW);
  const detail = ideaDetailSchema.parse(server.buildIdeaDetail(LAB_C));
  const completedAttempts = detail.run.attempts.filter(a => a.state === "completed").length;
  assert.equal(detail.run.state, "failed_definite");
  assert.equal(detail.run.messagesUsed, completedAttempts);
  assert.equal(detail.contributions.length, completedAttempts);
  assert.ok(detail.contributions.length < detail.run.attempts.length);
  assert.equal(detail.synthesis, null);
  assert.equal(detail.decision, null);
  assert.equal(detail.canDecide, false);
  assert.equal(detail.canSynthesize, false);
});

test("idealab-fixture: running lab shows its unsettled turn", () => {
  const server = createIdeaLabServer(NOW);
  const detail = ideaDetailSchema.parse(server.buildIdeaDetail(LAB_B));
  assert.equal(detail.run.state, "running");
  assert.ok(detail.run.attempts.some(a => a.state === "provider_marked"));
  assert.equal(detail.synthesis, null);
  assert.equal(detail.canStop, true);
});

test("idealab-fixture: creation options parse", () => {
  const server = createIdeaLabServer(NOW);
  const options = ideaCreationOptionsSchema.parse(server.buildIdeaOptions());
  assert.equal(options.startsWork, false);
  assert.ok(options.participants.some(p => p.perspective === "skeptic"));
});

test("idealab-fixture: unknown session id throws instead of emitting wire", () => {
  const server = createIdeaLabServer(NOW);
  assert.throws(() => server.buildIdeaDetail("idea:lab:does-not-exist"));
});

// --- product-behavior guards (real clients, synthetic transport) ---

const createDraft = {
  title: "Synthetic probe idea",
  ideaSummary: "A disposable draft used to prove create echo and replay.",
  targetCustomer: "Fixture reviewers",
  maxRounds: 1,
  maxDurationSeconds: 300,
  maxCostUsd: 5,
};

test("idealab-fixture: real create client gets echoed key and startsWork:false", async () => {
  const server = createIdeaLabServer(NOW);
  const client = createIdeaCreationClient(asTransport(server), () => "fixture-key-1");
  const receipt = await client.create(createDraft);
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.idempotencyKey, "fixture-key-1");
  assert.equal(receipt.startsWork, false);
  assert.equal(receipt.execution, "not_requested");
});

test("idealab-fixture: real create client replays the same idempotency key", async () => {
  const server = createIdeaLabServer(NOW);
  const client = createIdeaCreationClient(asTransport(server), () => "fixture-key-2");
  const first = await client.create(createDraft);
  assert.equal(first.replayed, false);
  const second = await client.create(createDraft);
  assert.equal(second.replayed, true);
  assert.equal(second.sessionId, first.sessionId);
});

test("idealab-fixture: real create client holds the exact request after uncertainty", async () => {
  const server = createIdeaLabServer(NOW);
  let calls = 0;
  const flaky = asTransport(server);
  const transport = async (url, init) => {
    calls += 1;
    if (calls === 1) throw new Error("synthetic transport cut");
    return flaky(url, init);
  };
  const client = createIdeaCreationClient(transport, () => "fixture-key-3");
  await assert.rejects(client.create(createDraft), BrowserRequestError);
  assert.equal(client.hasPending(), true);
  const receipt = await client.retry();
  assert.equal(receipt.idempotencyKey, "fixture-key-3");
  assert.equal(receipt.replayed, false);
});

test("idealab-fixture: real decision client saves without executing", async () => {
  const server = createIdeaLabServer(NOW);
  const client = createIdeaDecisionClient(asTransport(server));
  const receipt = await client.decide(LAB_A, saveDraft);
  assert.equal(receipt.decision, "save");
  assert.equal(receipt.projectId, null);
  assert.equal(receipt.startsWork, false);
  assert.equal(receipt.synthesisDigest, digests.synthesisDigest);
});

test("idealab-fixture: real decision client promotes to a project without executing", async () => {
  const server = createIdeaLabServer(NOW);
  const client = createIdeaDecisionClient(asTransport(server));
  const draft = {
    sessionDigest: digests.sessionDigest,
    synthesisDigest: digests.synthesisDigest,
    intent: {
      decision: "create_project",
      safeReasonCode: "synthetic_review",
      project: {
        projectId: "idea:lab:completed-synthesis:project1",
        workspaceName: "Synthetic build",
        title: "Synthetic build",
        summary: "Synthetic project from the fixture decision.",
        projectKind: "experiment",
        priority: 50,
      },
    },
  };
  const receipt = await client.decide(LAB_A, draft);
  assert.equal(receipt.decision, "create_project");
  assert.equal(receipt.projectId, "idea:lab:completed-synthesis:project1");
  assert.equal(receipt.startsWork, false);
});

test("idealab-fixture: real decision client repeats the same save as replayed", async () => {
  const server = createIdeaLabServer(NOW);
  const client = createIdeaDecisionClient(asTransport(server));
  const first = await client.decide(LAB_A, saveDraft);
  assert.equal(first.replayed, false);
  const second = await client.decide(LAB_A, saveDraft);
  assert.equal(second.replayed, true);
});

test("idealab-fixture: real decision client maps no-synthesis to conflict", async () => {
  const server = createIdeaLabServer(NOW);
  const client = createIdeaDecisionClient(asTransport(server));
  await assert.rejects(client.decide(LAB_B, saveDraft), (error) => {
    assert.ok(error instanceof BrowserRequestError);
    assert.equal(error.code, "conflict");
    return true;
  });
});

test("idealab-fixture: real decision client maps unknown session to not_found", async () => {
  const server = createIdeaLabServer(NOW);
  const client = createIdeaDecisionClient(asTransport(server));
  await assert.rejects(client.decide("idea:lab:does-not-exist", saveDraft), (error) => {
    assert.ok(error instanceof BrowserRequestError);
    assert.equal(error.code, "not_found");
    return true;
  });
});

test("idealab-fixture: real stop client cancels the running lab", async () => {
  const server = createIdeaLabServer(NOW);
  const client = createIdeaStopClient(asTransport(server));
  const detail = ideaDetailSchema.parse(server.buildIdeaDetail(LAB_B));
  const receipt = await client.stop(LAB_B, { runId: detail.run.runId, sessionDigest: digests.sessionDigest });
  assert.equal(receipt.state, "cancelled");
  assert.equal(receipt.runId, detail.run.runId);
  assert.equal(receipt.startsWork, false);
  const after = ideaDetailSchema.parse(server.buildIdeaDetail(LAB_B));
  assert.equal(after.run.state, "cancelled");
});

test("idealab-fixture: real stop client maps a finished lab to conflict", async () => {
  const server = createIdeaLabServer(NOW);
  const client = createIdeaStopClient(asTransport(server));
  const detail = ideaDetailSchema.parse(server.buildIdeaDetail(LAB_A));
  await assert.rejects(
    client.stop(LAB_A, { runId: detail.run.runId, sessionDigest: digests.sessionDigest }),
    (error) => {
      assert.ok(error instanceof BrowserRequestError);
      assert.equal(error.code, "conflict");
      return true;
    },
  );
});

test("idealab-fixture: real start client maps a non-startable lab to conflict", async () => {
  const server = createIdeaLabServer(NOW);
  const client = createIdeaStartClient(asTransport(server));
  await assert.rejects(
    client.start(LAB_B, { sessionDigest: digests.sessionDigest }),
    (error) => {
      assert.ok(error instanceof BrowserRequestError);
      assert.equal(error.code, "conflict");
      return true;
    },
  );
});

test("idealab-fixture: real synthesis client maps an unready lab to conflict", async () => {
  const server = createIdeaLabServer(NOW);
  const client = createIdeaSynthesisClient(asTransport(server));
  const detail = ideaDetailSchema.parse(server.buildIdeaDetail(LAB_B));
  await assert.rejects(
    client.synthesize(LAB_B, { sessionDigest: digests.sessionDigest, runId: detail.run.runId }),
    (error) => {
      assert.ok(error instanceof BrowserRequestError);
      assert.equal(error.code, "conflict");
      return true;
    },
  );
});
