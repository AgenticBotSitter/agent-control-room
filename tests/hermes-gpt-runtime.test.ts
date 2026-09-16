import assert from "node:assert/strict";
import test from "node:test";
import { HERMES_SESSION_MAX_RESULT_CHARS_V1,
  type HermesSessionToolNameV1 } from "../src/harness/hermes-gpt-v1/session-contract";
import type { HermesSessionToolPortV1 } from "../src/harness/hermes-gpt-v1/session-client";
import {
  HERMES_SESSION_RESULT_MAX_BYTES_V1, collectHermesSessionResultV1, pollHermesSessionJobV1,
  submitHermesSessionTurnV1, type HermesSessionBindingV1,
} from "../src/harness/hermes-gpt-v1/session-runtime";

/**
 * Recorded upstream transport, replayed from the pinned `asimons81/hermes-gpt`
 * revision `89cbfbe2…`. It starts no process and calls no provider.
 *
 * `SESSION_BUSY` is modelled the way upstream enforces it: `_active_sessions`
 * holds one job per session id, so a second continue for the same session is
 * refused while the first is running.
 */
class RecordedHermes implements HermesSessionToolPortV1 {
  readonly calls: { tool: HermesSessionToolNameV1; params: Record<string, unknown> }[] = [];
  closed = false;
  private readonly active = new Map<string, string>();
  private readonly jobs = new Map<string, Record<string, unknown>>();
  private readonly outputs = new Map<string, string>();
  constructor(private readonly options: {
    dropContinueReply?: boolean; resolvePrefixTo?: string; forceReplySessionId?: string;
    forceStatusJobId?: string; nullResultSessionId?: boolean;
  } = {}) {}

  /** Seed one already-known job, as a restarted server would have on disk. */
  seed(job: Record<string, unknown>, output = ""): void {
    this.jobs.set(String(job.job_id), job);
    this.outputs.set(String(job.job_id), output);
    if (job.status === "running") this.active.set(String(job.session_id), String(job.job_id));
  }

  finish(jobId: string, status: string, output: string, returnCode: number | null = 0): void {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("unknown job");
    const updated = { ...job, status, ended_at: "2026-09-15T10:20:00+00:00", return_code: returnCode };
    this.jobs.set(jobId, updated);
    this.outputs.set(jobId, output);
    if (this.active.get(String(job.session_id)) === jobId) this.active.delete(String(job.session_id));
  }

  private error(code: string, message: string) {
    return { success: false, ok: false, error: message, layer: "session_control", code,
      safe_message: message, suggested_action: "See the Hermes session docs.", trace_id: "trace-0002" };
  }

  async call(tool: HermesSessionToolNameV1, params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.closed) throw new Error("hermes_session_transport_closed");
    this.calls.push({ tool, params: { ...params } });
    if (tool === "hermes_session_continue") {
      const sessionId = String(params.session_id);
      const active = this.active.get(sessionId);
      if (active) {
        return this.error("SESSION_BUSY",
          `This Hermes session already has a running session-control job. Wait for job ${active} to finish.`);
      }
      // server.py resolves the id before delegating; model that faithfully.
      const resolved = this.options.resolvePrefixTo ?? this.options.forceReplySessionId ?? sessionId;
      const jobId = String(this.jobs.size + 1).padStart(32, "0");
      this.jobs.set(jobId, { job_id: jobId, session_id: resolved, status: "running",
        created_at: "2026-09-15T10:00:00+00:00", started_at: "2026-09-15T10:00:01+00:00",
        ended_at: null, pid: 9001, return_code: null, timeout: 900, prompt_len: 10 });
      this.outputs.set(jobId, "");
      this.active.set(sessionId, jobId);
      this.active.set(resolved, jobId);
      // A lost submit: upstream really started the turn, but the caller never
      // observes this reply.
      if (this.options.dropContinueReply) throw new Error("hermes_session_reply_lost");
      return { success: true, job_id: jobId, session_id: resolved, status: "running" };
    }
    const jobId = String(params.job_id);
    const job = this.jobs.get(jobId);
    if (!job) return this.error("JOB_NOT_FOUND", "Hermes session job was not found.");
    if (tool === "hermes_session_job_status") {
      return { success: true, job: this.options.forceStatusJobId
        ? { ...job, job_id: this.options.forceStatusJobId } : job };
    }
    const cap = Math.max(500, Math.min(Number(params.max_chars ?? HERMES_SESSION_MAX_RESULT_CHARS_V1),
      HERMES_SESSION_MAX_RESULT_CHARS_V1));
    const output = this.outputs.get(jobId) ?? "";
    // Upstream is Python: `len()` and slicing count codepoints, not UTF-16
    // units. Modelling that faithfully matters here, because an astral
    // character is one Python character but two JavaScript units — the exact
    // case where the upstream character cap and Control Room's byte ceiling
    // disagree.
    const codepoints = Array.from(output);
    return { success: true, job_id: jobId,
      session_id: this.options.nullResultSessionId ? null : job.session_id, status: job.status,
      return_code: job.return_code ?? null, response: codepoints.slice(0, cap).join(""),
      truncated: codepoints.length > cap };
  }
}

const binding: HermesSessionBindingV1 = {
  lineage: { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test",
    attemptId: "attempt:test", runId: "run:test", nodeId: "node:test" },
  sessionId: "session-2026-09-15-alpha",
};

test("one submit maps a Control Room task onto an upstream session turn", async () => {
  const hermes = new RecordedHermes();
  const started = await submitHermesSessionTurnV1(hermes, { binding, prompt: "Summarize the change." });
  assert.equal(started.kind, "started");
  assert.equal(started.kind === "started" && started.sessionId, binding.sessionId);
  assert.match(started.kind === "started" ? started.upstreamJobId : "", /^[0-9a-f]{32}$/);
  assert.equal(hermes.calls.length, 1);
});

test("a second turn for the same session is refused as busy, not as a failure", async () => {
  const hermes = new RecordedHermes();
  const first = await submitHermesSessionTurnV1(hermes, { binding, prompt: "First." });
  assert.equal(first.kind, "started");
  const second = await submitHermesSessionTurnV1(hermes, { binding, prompt: "Second." });
  // Busy is distinct from refused: upstream is protecting a running turn, so
  // the caller must reconcile that turn rather than report a failure.
  assert.equal(second.kind, "busy");
});

test("a lost submit is unrecoverable uncertainty and is never retried by the connector", async () => {
  // Upstream started the turn but the reply was lost in transit.
  const hermes = new RecordedHermes({ dropContinueReply: true });
  const lost = await submitHermesSessionTurnV1(hermes, { binding, prompt: "Do the work." });
  assert.equal(lost.kind, "uncertain");

  // The caller does not know the job id. Retrying is exactly what must not
  // start a second real turn — and upstream's own session lock prevents it.
  const retry = await submitHermesSessionTurnV1(new Proxy(hermes, {}) as RecordedHermes,
    { binding, prompt: "Do the work." });
  assert.equal(retry.kind, "busy");

  // Exactly one turn exists for this session across both attempts.
  assert.equal(hermes.calls.filter(call => call.tool === "hermes_session_continue").length, 2);
});

test("upstream's session lock narrows the duplicate window but does not close it", async () => {
  // The honest limit of the SESSION_BUSY protection. `_active_sessions` is
  // upstream process memory and `_watch` drops the entry when the turn's
  // process exits, so once the first turn has finished a retry is accepted
  // and starts a SECOND real turn. This is why a lost submit must never be
  // retried by any caller, and why this connector never retries internally.
  const hermes = new RecordedHermes();
  const first = await submitHermesSessionTurnV1(hermes, { binding, prompt: "Work." });
  assert.equal(first.kind, "started");
  const firstJob = first.kind === "started" ? first.upstreamJobId : "";

  // While it runs, the lock holds.
  assert.equal((await submitHermesSessionTurnV1(hermes, { binding, prompt: "Work." })).kind, "busy");

  // After it finishes, the lock is gone and a retry really does start again.
  hermes.finish(firstJob, "completed", "First output.");
  const second = await submitHermesSessionTurnV1(hermes, { binding, prompt: "Work." });
  assert.equal(second.kind, "started");
  assert.notEqual(second.kind === "started" ? second.upstreamJobId : firstJob, firstJob);
});

test("a prefix-resolved session id is recorded, not refused after work has started", async () => {
  // server.py resolves a unique-prefix id before delegating, so the started id
  // can differ from the requested one. Refusing would strand a real turn.
  const hermes = new RecordedHermes({ resolvePrefixTo: "session-2026-09-15-alpha-exact" });
  const started = await submitHermesSessionTurnV1(hermes, { binding, prompt: "Work." });
  assert.equal(started.kind, "started");
  if (started.kind !== "started") return;
  assert.equal(started.sessionId, "session-2026-09-15-alpha-exact");
  assert.equal(started.requestedSessionId, binding.sessionId);
  assert.equal(started.resolvedByUpstream, true);

  // The result path compares against the id upstream actually used.
  hermes.finish(started.upstreamJobId, "completed", "Resolved output.");
  const result = await collectHermesSessionResultV1(hermes,
    { binding, upstreamJobId: started.upstreamJobId, upstreamSessionId: started.sessionId });
  assert.equal(result.kind, "completed");
});

test("a differing submit session id is recorded as a resolution; a foreign status job id is refused", async () => {
  // Submit deliberately does NOT refuse a differing id: upstream may have
  // resolved a prefix, and refusing would strand a turn that already started
  // real work. The difference is recorded so the caller can see it.
  const foreignSubmit = new RecordedHermes({ forceReplySessionId: "session-someone-else" });
  const started = await submitHermesSessionTurnV1(foreignSubmit, { binding, prompt: "Work." });
  assert.equal(started.kind === "started" && started.resolvedByUpstream, true);
  assert.equal(started.kind === "started" && started.sessionId, "session-someone-else");

  const foreignStatus = new RecordedHermes({ forceStatusJobId: "7".repeat(32) });
  foreignStatus.seed({ job_id: "8".repeat(32), session_id: binding.sessionId, status: "running",
    created_at: "2026-09-15T10:00:00+00:00", return_code: null }, "");
  const polled = await pollHermesSessionJobV1(foreignStatus, "8".repeat(32));
  assert.equal(polled.kind, "uncertain");
  assert.equal(polled.kind === "uncertain" && polled.reason, "hermes_session_job_identity_mismatch");
});

test("a result with a null session id is accepted, as upstream can return one", async () => {
  // operator_session.py returns meta.get("session_id"), which is null on a
  // degraded record written by the _watch fallback.
  const hermes = new RecordedHermes({ nullResultSessionId: true });
  hermes.seed({ job_id: "2".repeat(32), session_id: binding.sessionId, status: "completed",
    created_at: "2026-09-15T10:00:00+00:00", return_code: 0 }, "Degraded but real.");
  const result = await collectHermesSessionResultV1(hermes, { binding, upstreamJobId: "2".repeat(32) });
  assert.equal(result.kind, "completed");
});

test("status reads are bounded, repeatable and start nothing", async () => {
  const hermes = new RecordedHermes();
  const started = await submitHermesSessionTurnV1(hermes, { binding, prompt: "Work." });
  assert.equal(started.kind, "started");
  const jobId = started.kind === "started" ? started.upstreamJobId : "";
  const before = hermes.calls.length;
  const running = await pollHermesSessionJobV1(hermes, jobId);
  assert.equal(running.kind, "running");
  await pollHermesSessionJobV1(hermes, jobId);
  // Two polls, two status calls, no additional continue.
  assert.equal(hermes.calls.length - before, 2);
  assert.equal(hermes.calls.filter(call => call.tool === "hermes_session_continue").length, 1);

  hermes.finish(jobId, "completed", "All done.");
  const done = await pollHermesSessionJobV1(hermes, jobId);
  assert.equal(done.kind, "terminal");
  assert.equal(done.kind === "terminal" && done.state, "completed");
});

test("a completed turn returns one bounded result bound to exact Control Room identity", async () => {
  const hermes = new RecordedHermes();
  const started = await submitHermesSessionTurnV1(hermes, { binding, prompt: "Work." });
  const jobId = started.kind === "started" ? started.upstreamJobId : "";
  hermes.finish(jobId, "completed", "The refactor is complete.");
  const result = await collectHermesSessionResultV1(hermes, { binding, upstreamJobId: jobId });
  assert.equal(result.kind, "completed");
  if (result.kind !== "completed") return;
  assert.equal(result.text, "The refactor is complete.");
  assert.deepEqual(result.binding.lineage, binding.lineage);
  assert.equal(result.upstreamJobId, jobId);
  assert.match(result.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.sizeBytes, Buffer.byteLength("The refactor is complete.", "utf8"));
  // The connector carries evidence; it accepts nothing and completes nothing.
  assert.equal(result.canonicalPublicationAllowed, false);
  assert.equal(result.qualityAccepted, false);
  assert.equal(result.completionRecorded, false);
  assert.equal(result.grantsExecutionAuthority, false);
  assert.equal(result.permitsRetry, false);
  assert.equal(result.permitsResume, false);
});

test("upstream's 24,000-character cap and Control Room's 65,536-byte ceiling are reported separately", async () => {
  // Upstream truncation: more characters than its own cap.
  const long = new RecordedHermes();
  const first = await submitHermesSessionTurnV1(long, { binding, prompt: "Work." });
  const longJob = first.kind === "started" ? first.upstreamJobId : "";
  long.finish(longJob, "completed", "x".repeat(HERMES_SESSION_MAX_RESULT_CHARS_V1 + 5_000));
  const capped = await collectHermesSessionResultV1(long, { binding, upstreamJobId: longJob });
  assert.equal(capped.kind, "completed");
  if (capped.kind !== "completed") return;
  assert.equal(capped.upstreamTruncated, true);
  assert.equal(capped.ceilingTruncated, false);
  assert.equal(capped.text.length, HERMES_SESSION_MAX_RESULT_CHARS_V1);

  // Byte ceiling: 24,000 four-byte characters satisfy the upstream character
  // cap while far exceeding Control Room's 65,536-byte limit.
  const wide = new RecordedHermes();
  const second = await submitHermesSessionTurnV1(wide, { binding, prompt: "Work." });
  const wideJob = second.kind === "started" ? second.upstreamJobId : "";
  // 24,000 four-byte codepoints: exactly upstream's character cap, but 96,000
  // bytes — well past Control Room's 65,536-byte ceiling.
  wide.finish(wideJob, "completed", "\u{1F600}".repeat(HERMES_SESSION_MAX_RESULT_CHARS_V1));
  const bounded = await collectHermesSessionResultV1(wide, { binding, upstreamJobId: wideJob });
  assert.equal(bounded.kind, "completed");
  if (bounded.kind !== "completed") return;
  assert.equal(bounded.upstreamTruncated, false);
  assert.equal(bounded.ceilingTruncated, true);
  assert.ok(bounded.sizeBytes <= HERMES_SESSION_RESULT_MAX_BYTES_V1);
  // The trim never splits a UTF-8 sequence.
  assert.equal(Buffer.byteLength(bounded.text, "utf8"), bounded.sizeBytes);
  assert.ok(!bounded.text.includes("�"));

  // A three-byte codepoint is the case that actually separates a correct trim
  // from a naive byte slice: 65,536 is an exact multiple of 4, so four-byte
  // characters land on the boundary either way and prove nothing.
  const cjk = new RecordedHermes();
  const third = await submitHermesSessionTurnV1(cjk, { binding, prompt: "Work." });
  const cjkJob = third.kind === "started" ? third.upstreamJobId : "";
  cjk.finish(cjkJob, "completed", "あ".repeat(HERMES_SESSION_MAX_RESULT_CHARS_V1));
  const trimmed = await collectHermesSessionResultV1(cjk, { binding, upstreamJobId: cjkJob });
  assert.equal(trimmed.kind, "completed");
  if (trimmed.kind !== "completed") return;
  assert.equal(trimmed.ceilingTruncated, true);
  // 65,535 bytes: the largest whole number of 3-byte characters that fits.
  assert.equal(trimmed.sizeBytes, 65_535);
  assert.ok(!trimmed.text.includes("�"));
  // Re-encoding must agree, which a mid-sequence cut would break.
  assert.equal(Buffer.byteLength(trimmed.text, "utf8"), trimmed.sizeBytes);
  assert.equal(trimmed.text.at(-1), "あ");
});

test("a restart-orphaned job is uncertainty, never a completion or a failure", async () => {
  const hermes = new RecordedHermes();
  hermes.seed({ job_id: "c".repeat(32), session_id: binding.sessionId, status: "orphaned",
    created_at: "2026-09-15T10:00:00+00:00", ended_at: "2026-09-15T10:30:00+00:00", return_code: null,
    reconciliation: "server restarted; process ownership could not be proven" }, "partial output");
  const result = await collectHermesSessionResultV1(hermes, { binding, upstreamJobId: "c".repeat(32) });
  assert.equal(result.kind, "uncertain");
  assert.equal(result.kind === "uncertain" && result.state, "orphaned");
  assert.equal(result.kind === "uncertain" && result.reason, "hermes_session_process_ownership_unproven");
});

test("timed out, failed, pending, empty and unknown jobs each fail closed distinctly", async () => {
  const hermes = new RecordedHermes();
  hermes.seed({ job_id: "d".repeat(32), session_id: binding.sessionId, status: "timed_out",
    created_at: "2026-09-15T10:00:00+00:00", return_code: null }, "partial");
  const timedOut = await collectHermesSessionResultV1(hermes, { binding, upstreamJobId: "d".repeat(32) });
  assert.equal(timedOut.kind, "uncertain");

  hermes.seed({ job_id: "e".repeat(32), session_id: binding.sessionId, status: "failed",
    created_at: "2026-09-15T10:00:00+00:00", return_code: 2 }, "trace");
  const failed = await collectHermesSessionResultV1(hermes, { binding, upstreamJobId: "e".repeat(32) });
  assert.equal(failed.kind, "failed");
  assert.equal(failed.kind === "failed" && failed.returnCode, 2);

  hermes.seed({ job_id: "f".repeat(32), session_id: binding.sessionId, status: "running",
    created_at: "2026-09-15T10:00:00+00:00", return_code: null }, "");
  const pending = await collectHermesSessionResultV1(hermes, { binding, upstreamJobId: "f".repeat(32) });
  assert.equal(pending.kind, "pending");

  // A successful job with no output is not an empty accepted result.
  hermes.seed({ job_id: "0".repeat(32), session_id: binding.sessionId, status: "completed",
    created_at: "2026-09-15T10:00:00+00:00", return_code: 0 }, "");
  const empty = await collectHermesSessionResultV1(hermes, { binding, upstreamJobId: "0".repeat(32) });
  assert.equal(empty.kind, "uncertain");
  assert.equal(empty.kind === "uncertain" && empty.reason, "hermes_session_empty_response");

  const unknown = await collectHermesSessionResultV1(hermes, { binding, upstreamJobId: "9".repeat(32) });
  assert.equal(unknown.kind, "unknown_job");
});

test("a result carrying a foreign session or job identity is refused", async () => {
  const hermes = new RecordedHermes();
  hermes.seed({ job_id: "1".repeat(32), session_id: "session-someone-else", status: "completed",
    created_at: "2026-09-15T10:00:00+00:00", return_code: 0 }, "Not your output.");
  const foreign = await collectHermesSessionResultV1(hermes, { binding, upstreamJobId: "1".repeat(32) });
  assert.equal(foreign.kind, "uncertain");
  assert.equal(foreign.kind === "uncertain" && foreign.reason, "hermes_session_result_identity_mismatch");
});

test("a closed transport leaves every operation uncertain and starts nothing", async () => {
  const hermes = new RecordedHermes();
  const started = await submitHermesSessionTurnV1(hermes, { binding, prompt: "Work." });
  const jobId = started.kind === "started" ? started.upstreamJobId : "";
  hermes.closed = true;
  const after = hermes.calls.length;
  assert.equal((await pollHermesSessionJobV1(hermes, jobId)).kind, "uncertain");
  assert.equal((await collectHermesSessionResultV1(hermes, { binding, upstreamJobId: jobId })).kind, "uncertain");
  const resubmit = await submitHermesSessionTurnV1(hermes, { binding, prompt: "Work." });
  // A closed transport must never let a resubmit look like a fresh start.
  assert.equal(resubmit.kind, "uncertain");
  // The closed transport rejects before recording, so nothing reached upstream
  // after close — in particular no second continue.
  assert.equal(hermes.calls.length, after);
});
