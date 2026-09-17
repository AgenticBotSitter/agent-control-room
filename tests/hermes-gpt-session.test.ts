import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import {
  HERMES_SESSION_MAX_PROMPT_CHARS_V1, HERMES_SESSION_MAX_RESULT_CHARS_V1,
  HERMES_SESSION_MAX_TIMEOUT_SECONDS_V1, HERMES_SESSION_MIN_TIMEOUT_SECONDS_V1,
  hermesSessionJobIsTerminalV1, type HermesSessionToolNameV1,
} from "../src/harness/hermes-gpt-v1/session-contract";
import {
  hermesSessionContinueV1, hermesSessionJobResultV1, hermesSessionJobStatusV1,
  type HermesSessionToolPortV1,
} from "../src/harness/hermes-gpt-v1/session-client";
import { reconcileBotModeRoomV1 } from "../src/harness/hermes-bot-mode-v1/reconcile";
import { parseBotModeRoomV1 } from "../src/harness/hermes-bot-mode-v1/room-observations";
import type { BotModeEventV1 } from "../src/harness/hermes-bot-mode-v1/room-observations";
import { proposeBotModeResultV1 } from "../src/harness/hermes-bot-mode-v1/room-proposals";

/**
 * Recorded upstream transport.
 *
 * Replies are recorded from the pinned `asimons81/hermes-gpt` revision
 * `89cbfbe2…` `operator_session.py` and `operator_policy.make_error_envelope`.
 * Nothing here starts a process, opens a socket or calls a provider: the port
 * only replays a recorded reply and remembers what it was asked.
 */
class RecordedHermesTransport implements HermesSessionToolPortV1 {
  readonly calls: { tool: HermesSessionToolNameV1; params: Record<string, unknown> }[] = [];
  constructor(private readonly replies: Partial<Record<HermesSessionToolNameV1, unknown[]>> = {},
    private readonly failure?: Error) {}
  async call(tool: HermesSessionToolNameV1, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    this.calls.push({ tool, params: { ...params } });
    if (this.failure) throw this.failure;
    const queue = this.replies[tool];
    if (!queue || queue.length === 0) throw new Error(`no recorded reply for ${tool}`);
    return queue.shift();
  }
}

const JOB_ID = "a".repeat(32);
const SESSION_ID = "session-2026-09-15-alpha";

/** Exactly `operator_policy.make_error_envelope`. */
const envelope = (code: string, safeMessage: string, action = "Check the job ID.") => ({
  success: false, ok: false, error: safeMessage, layer: "session_control",
  code, safe_message: safeMessage, suggested_action: action, trace_id: "trace-0001",
});

const runningJob = (overrides: Record<string, unknown> = {}) => ({
  job_id: JOB_ID, session_id: SESSION_ID, status: "running", created_at: "2026-09-15T10:00:00+00:00",
  started_at: "2026-09-15T10:00:01+00:00", ended_at: null, pid: 4321, return_code: null,
  timeout: 900, prompt_len: 42, prompt_sha256: "b".repeat(64), ...overrides,
});

test("continue returns the upstream job identity and sends exactly the pinned parameter names", async () => {
  const transport = new RecordedHermesTransport({
    hermes_session_continue: [{ success: true, job_id: JOB_ID, session_id: SESSION_ID, status: "running" }],
  });
  const call = await hermesSessionContinueV1(transport,
    { sessionId: `  ${SESSION_ID}  `, prompt: "Continue the task.", timeoutSeconds: 120 });
  assert.equal(call.outcome, "ok");
  assert.equal(call.outcome === "ok" && call.value.job_id, JOB_ID);

  // Upstream's own parameter names, and the session id trimmed the way
  // `_validate_start` trims it before use.
  assert.deepEqual(transport.calls, [{ tool: "hermes_session_continue",
    params: { session_id: SESSION_ID, prompt: "Continue the task.", timeout: 120 } }]);
});

test("the client refuses out-of-range arguments before upstream can silently clamp them", async () => {
  const transport = new RecordedHermesTransport();
  const rejected = async (request: Parameters<typeof hermesSessionContinueV1>[1], reason: string) => {
    const call = await hermesSessionContinueV1(transport, request);
    assert.equal(call.outcome, "invalid_request");
    assert.equal(call.outcome === "invalid_request" && call.reason, reason);
  };

  // Upstream clamps timeout into [10, 3600] and max_chars into [500, 24000]
  // rather than refusing. A caller that sent a wider bound would otherwise
  // believe a deadline or cap it never received.
  await rejected({ sessionId: SESSION_ID, prompt: "p", timeoutSeconds: HERMES_SESSION_MIN_TIMEOUT_SECONDS_V1 - 1 },
    "hermes_session_timeout_out_of_range");
  await rejected({ sessionId: SESSION_ID, prompt: "p", timeoutSeconds: HERMES_SESSION_MAX_TIMEOUT_SECONDS_V1 + 1 },
    "hermes_session_timeout_out_of_range");
  await rejected({ sessionId: SESSION_ID, prompt: "p", timeoutSeconds: 1.5 }, "hermes_session_timeout_invalid");
  await rejected({ sessionId: "", prompt: "p" }, "hermes_session_id_invalid");
  await rejected({ sessionId: "x".repeat(257), prompt: "p" }, "hermes_session_id_invalid");
  await rejected({ sessionId: SESSION_ID, prompt: "   " }, "hermes_session_prompt_invalid");
  await rejected({ sessionId: SESSION_ID, prompt: "x".repeat(HERMES_SESSION_MAX_PROMPT_CHARS_V1 + 1) },
    "hermes_session_prompt_too_large");

  const badCap = await hermesSessionJobResultV1(transport, JOB_ID, { maxChars: HERMES_SESSION_MAX_RESULT_CHARS_V1 + 1 });
  assert.equal(badCap.outcome, "invalid_request");
  const badJob = await hermesSessionJobStatusV1(transport, "not-a-job-id");
  assert.equal(badJob.outcome, "invalid_request");

  // Nothing reached the transport: a refused request never becomes a call.
  assert.equal(transport.calls.length, 0);
});

test("every upstream refusal envelope is parsed as a decision, never thrown", async () => {
  for (const code of ["SESSION_CONTROL_DISABLED", "SESSION_BUSY", "HERMES_START_FAILED", "INVALID_PROMPT"]) {
    const transport = new RecordedHermesTransport({
      hermes_session_continue: [envelope(code, `${code} happened.`)],
    });
    const call = await hermesSessionContinueV1(transport, { sessionId: SESSION_ID, prompt: "go" });
    assert.equal(call.outcome, "refused");
    assert.equal(call.outcome === "refused" && call.code, code);
  }
  const missing = new RecordedHermesTransport({
    hermes_session_job_status: [envelope("JOB_NOT_FOUND", "Hermes session job was not found.")],
  });
  const status = await hermesSessionJobStatusV1(missing, JOB_ID);
  assert.equal(status.outcome === "refused" && status.code, "JOB_NOT_FOUND");
});

test("a transport fault is reported as unavailable, not as an upstream refusal", async () => {
  const transport = new RecordedHermesTransport({}, new Error("socket closed"));
  const call = await hermesSessionContinueV1(transport, { sessionId: SESSION_ID, prompt: "go" });
  assert.equal(call.outcome, "transport_unavailable");
  // The distinction matters: a refusal is an upstream decision a caller can
  // act on; an unavailable transport leaves the turn's fate unknown.
  assert.notEqual(call.outcome, "refused");
});

test("an unrecognized reply shape is reported rather than coerced", async () => {
  const transport = new RecordedHermesTransport({
    hermes_session_continue: [{ success: true, job_id: "not-hex", session_id: SESSION_ID, status: "running" }],
    hermes_session_job_status: [{ success: true }],
  });
  const started = await hermesSessionContinueV1(transport, { sessionId: SESSION_ID, prompt: "go" });
  assert.equal(started.outcome, "unrecognized");
  const status = await hermesSessionJobStatusV1(transport, JOB_ID);
  assert.equal(status.outcome, "unrecognized");
});

test("status accepts every upstream job state and classifies terminal ones", async () => {
  for (const state of ["starting", "running", "completed", "failed", "timed_out", "orphaned"] as const) {
    const transport = new RecordedHermesTransport({
      hermes_session_job_status: [{ success: true, job: runningJob({ status: state }) }],
    });
    const call = await hermesSessionJobStatusV1(transport, JOB_ID);
    assert.equal(call.outcome, "ok", state);
    assert.equal(call.outcome === "ok" && call.value.job.status, state);
  }
  assert.deepEqual(
    (["starting", "running", "completed", "failed", "timed_out", "orphaned"] as const).map(hermesSessionJobIsTerminalV1),
    [false, false, true, true, true, true]);
});

test("the orphaned record keeps upstream's reconciliation note", async () => {
  const transport = new RecordedHermesTransport({
    hermes_session_job_status: [{ success: true, job: runningJob({
      status: "orphaned", ended_at: "2026-09-15T10:30:00+00:00",
      reconciliation: "server restarted; process ownership could not be proven" }) }],
  });
  const call = await hermesSessionJobStatusV1(transport, JOB_ID);
  assert.equal(call.outcome === "ok" && call.value.job.reconciliation,
    "server restarted; process ownership could not be proven");
});

test("result defaults to upstream's own cap and passes the requested cap through", async () => {
  const reply = { success: true, job_id: JOB_ID, session_id: SESSION_ID, status: "completed",
    return_code: 0, response: "done", truncated: false };
  const transport = new RecordedHermesTransport({ hermes_session_job_result: [reply, reply] });
  await hermesSessionJobResultV1(transport, JOB_ID);
  assert.deepEqual(transport.calls[0].params, { job_id: JOB_ID });
  await hermesSessionJobResultV1(transport, JOB_ID, { maxChars: 1_000 });
  assert.deepEqual(transport.calls[1].params, { job_id: JOB_ID, max_chars: 1_000 });
});

test("an aborted signal stops the call before it reaches the transport", async () => {
  const transport = new RecordedHermesTransport();
  const call = await hermesSessionContinueV1(transport, { sessionId: SESSION_ID, prompt: "go" },
    AbortSignal.abort());
  assert.equal(call.outcome, "transport_unavailable");
  assert.equal(transport.calls.length, 0);
});

test("the degraded job record upstream can write is still a recognized reply", async () => {
  // `_watch` falls back to `_load(...) or {"job_id": job_id}` when the job file
  // cannot be read, then saves a record carrying neither session_id nor
  // created_at. Requiring those would turn a real upstream record into an
  // unrecognized reply and hide a job that genuinely exists.
  const transport = new RecordedHermesTransport({
    hermes_session_job_status: [{ success: true, job: { job_id: JOB_ID, status: "failed",
      return_code: null, ended_at: "2026-09-15T10:30:00+00:00" } }],
  });
  const call = await hermesSessionJobStatusV1(transport, JOB_ID);
  assert.equal(call.outcome, "ok");
  assert.equal(call.outcome === "ok" && call.value.job.status, "failed");
  assert.equal(call.outcome === "ok" && call.value.job.session_id, undefined);
});

test("prompt and session-id bounds count codepoints, as Python does", async () => {
  // 40,000 astral codepoints are 40,000 characters to upstream's len(), but
  // 80,000 UTF-16 units in JavaScript. Counting units would refuse a prompt
  // upstream accepts, so this must be sent.
  const transport = new RecordedHermesTransport({
    hermes_session_continue: [{ success: true, job_id: JOB_ID, session_id: SESSION_ID, status: "running" }],
  });
  const astral = "\u{1F600}".repeat(40_000);
  assert.equal(astral.length, 80_000);
  assert.ok(astral.length > HERMES_SESSION_MAX_PROMPT_CHARS_V1);
  const accepted = await hermesSessionContinueV1(transport, { sessionId: SESSION_ID, prompt: astral });
  assert.equal(accepted.outcome, "ok");

  // One codepoint past upstream's ceiling is still refused.
  const tooLarge = await hermesSessionContinueV1(transport,
    { sessionId: SESSION_ID, prompt: "\u{1F600}".repeat(HERMES_SESSION_MAX_PROMPT_CHARS_V1 + 1) });
  assert.equal(tooLarge.outcome, "invalid_request");
  assert.equal(tooLarge.outcome === "invalid_request" && tooLarge.reason, "hermes_session_prompt_too_large");

  // The session-id bound counts the same way: 256 astral codepoints are within
  // upstream's 256-character limit.
  const wideId = await hermesSessionContinueV1(
    new RecordedHermesTransport({ hermes_session_continue: [
      { success: true, job_id: JOB_ID, session_id: "\u{1F600}".repeat(256), status: "running" }] }),
    { sessionId: "\u{1F600}".repeat(256), prompt: "go" });
  assert.equal(wideId.outcome, "ok");
});

describe("hermes bot-mode room bridge", () => {
  const D = (char: string) => `sha256:${char.repeat(64)}`;
  const event = (overrides: Partial<BotModeEventV1> = {}): BotModeEventV1 => ({
    eventId: "evt-alpha-1",
    sequence: 1,
    round: 1,
    authorParticipantId: "participant:ann",
    kind: "message",
    text: "Should we rotate the garden beds?",
    digest: D("a"),
    ...overrides,
  });
  const room = (overrides: Record<string, unknown> = {}) => parseBotModeRoomV1({
    contractVersion: "control-room-hermes-bot-mode-bridge/v1",
    roomId: "room:alpha",
    version: "1.0",
    capabilities: { toolsEnabled: false, liveProviderCalls: 0, discussionOnly: true },
    participants: [
      { participantId: "participant:ann", identityDigest: D("1"), contributionDigest: D("2"), state: "selected" },
      { participantId: "participant:bob", identityDigest: D("3"), state: "selected" },
      { participantId: "participant:cat", identityDigest: D("4"), state: "missing" },
      { participantId: "participant:dan", identityDigest: D("5"), state: "failed" },
    ],
    rounds: [{ round: 1, messageLimit: 10, messagesUsed: 3 }],
    events: [],
    ...overrides,
  });

  it("refuses unsupported versions and capabilities fail-closed", () => {
    assert.throws(() => room({ version: "2.0" }), /bot_mode_version_unsupported/);
    assert.throws(
      () => room({ capabilities: { toolsEnabled: true, liveProviderCalls: 0, discussionOnly: true } }),
      /bot_mode_capability_unsupported/,
    );
    assert.throws(
      () => room({ capabilities: { toolsEnabled: false, liveProviderCalls: 2, discussionOnly: true } }),
      /bot_mode_capability_unsupported/,
    );
  });

  it("reconnect replays without repeating work; gaps stay visible across batches", () => {
    const base = room();
    const first = reconcileBotModeRoomV1(base, [
      event({ eventId: "evt-1", sequence: 1 }),
      event({ eventId: "evt-2", sequence: 2 }),
      event({ eventId: "evt-4", sequence: 4 }),
    ]);
    assert.equal(first.events.length, 3);
    assert.deepEqual([...first.missingSequences], [3]);
    assert.equal(first.duplicateCount, 0);
    assert.equal(first.cursor, 4);

    // Reconnect replay: seen ids drop as duplicates, the late gap-fill merges
    // without moving the cursor, and the gap resolves.
    const second = reconcileBotModeRoomV1(base, [
      event({ eventId: "evt-2", sequence: 2 }),
      event({ eventId: "evt-3", sequence: 3 }),
      event({ eventId: "evt-5", sequence: 5 }),
    ], first.nextCursor);
    assert.equal(second.duplicateCount, 1);
    assert.equal(second.lateCount, 1);
    assert.deepEqual([...second.missingSequences], []);
    assert.equal(second.cursor, 5);
    assert.ok(second.events.some((item) => item.eventId === "evt-3"));

    // An unfilled gap carries forward instead of vanishing.
    const gapped = reconcileBotModeRoomV1(base, [event({ eventId: "evt-9", sequence: 9 })], second.nextCursor);
    assert.ok(gapped.missingSequences.includes(6));
    assert.ok(gapped.missingSequences.includes(8));
  });

  it("absent, failed, and disagreement stay visible in the view", () => {
    const base = room();
    const view = reconcileBotModeRoomV1(base, [
      event({ eventId: "evt-1", sequence: 1 }),
      event({ eventId: "evt-d", sequence: 2, kind: "disagreement", text: "Rotation disturbs the soil." }),
    ]);
    assert.deepEqual(view.absentParticipants.map((item) => item.participantId), ["participant:cat"]);
    assert.deepEqual(view.failedParticipants.map((item) => item.participantId), ["participant:dan"]);
    assert.equal(view.disagreements.length, 1);
    // Rounds, limits, and contribution identities are preserved verbatim.
    assert.deepEqual(view.rounds, base.rounds);
    assert.ok(view.participants.some((item) => item.contributionDigest === D("2")));
  });

  it("a room result proposes with no approval surface", () => {
    const base = room();
    const view = reconcileBotModeRoomV1(base, [
      event({ eventId: "evt-1", sequence: 1 }),
      event({ eventId: "evt-d", sequence: 2, kind: "disagreement", text: "Rotation disturbs the soil." }),
      event({ eventId: "evt-r", sequence: 3, kind: "result", text: "Rotate beds B and C in spring." }),
    ]);
    const proposal = proposeBotModeResultV1(view, "evt-r", { kind: "decision", summary: "Spring rotation plan." });
    assert.equal(proposal.resultEventDigest, D("a"));
    assert.equal(proposal.contested, true);
    assert.equal(proposal.disagreementDigests.length, 1);
    assert.equal(proposal.grantsApproval, false);
    assert.equal(proposal.grantsDispatch, false);
    assert.equal(proposal.grantsPublish, false);
    const keys = new Set(Object.keys(proposal));
    for (const forbidden of ["approve", "dispatch", "publish", "execute", "authorize"]) {
      assert.ok(!keys.has(forbidden), forbidden);
    }
    assert.match(proposal.proposalDigest, /^sha256:[0-9a-f]{64}$/);
    assert.throws(() => proposeBotModeResultV1(view, "evt-unknown", { kind: "task", summary: "S" }), /bot_mode_result_unknown/);
  });
});
