import type { NativeRunTransport, NativeWireResponse } from "./contracts";

const nativeRunId = `run_${"1".repeat(32)}`;
const instant = 1_800_000_000_000;
function response(value: unknown, status = 200): NativeWireResponse {
  return { status, contentType: "application/json; charset=utf-8", body: Buffer.from(JSON.stringify(value)) };
}
const capabilityBody = { object: "hermes.api_server.capabilities", platform: "hermes-agent",
  auth: { type: "bearer", required: true },
  runtime: { mode: "server_agent", tool_execution: "server", split_runtime: false },
  features: { run_submission: true, run_status: true, run_events_sse: true, run_stop: true,
    runs_idempotency: { supported: true, durable: true, retention_seconds: 86400 } },
  endpoints: { runs: { method: "POST", path: "/v1/runs" }, run_status: { method: "GET", path: "/v1/runs/{run_id}" },
    run_events: { method: "GET", path: "/v1/runs/{run_id}/events" }, run_stop: { method: "POST", path: "/v1/runs/{run_id}/stop" } } };
function statusBody(status: string, sessionId: string, extra: Record<string, unknown> = {}) {
  return { object: "hermes.run", run_id: nativeRunId, status, session_id: sessionId,
    created_at: instant / 1000, updated_at: instant / 1000 + 1, ...extra };
}

/** Recorded hermes-gpt session-job response shapes, mapped to the native contract.
 *
 * Upstream pin: `asimons81/hermes-gpt@11db8ac` (v0.10.0, MIT). Source module:
 * `operator_session.py` — `hermes_session_continue` (submit → `{success, job_id,
 * session_id, status:"running"}`), `hermes_session_job_status` (→
 * `{success, job}` with meta `{job_id, session_id, status, created_at,
 * started_at, ended_at, pid, return_code, timeout}`), `hermes_session_job_result`
 * (→ bounded stdout text, `MAX_RESULT_CHARS`). Upstream job statuses:
 * `starting | running | completed | failed | timed_out | orphaned`
 * (reconciled when the server restarts without process ownership).
 *
 * Mapping rule used here (partial, documented in
 * `docs/integration/hermes/upstream-inspection.md`): upstream
 * `completed` (returncode 0) → native `completed` with `output`;
 * `failed`/`timed_out` → native `failed` with NO output surfaced as result
 * (an upstream success string is never auto-accepted: `resultText` is set only
 * on `completed` + present `output`); `orphaned`/unknown → represented as a
 * 404 so the adapter reconciles to `ambiguous/run_unavailable` instead of
 * inventing an outcome. Upstream has no external stop API (only an internal
 * `_terminate` on timeout), so stop is recorded as the native `stopping` ack
 * the upstream must grow, followed by separate status confirmation.
 *
 * Every builder below is a pure recorded shape — no I/O, no subprocess, no
 * network. The fake transport consumes them to drive the already-hardened
 * `HermesNativeRunAdapter` offline (Path A of issue #8).
 */
export const HERMES_GPT_PIN = "asimons81/hermes-gpt@11db8ac" as const;

export function recordedCapabilities(): NativeWireResponse {
  return response(capabilityBody);
}

export function recordedStart202(): NativeWireResponse {
  return response({ run_id: nativeRunId, status: "started", replayed: false }, 202);
}

export type RecordedUpstreamTerminal = "completed" | "failed" | "timed_out" | "orphaned";

export function recordedStatus(sessionId: string, running: true): NativeWireResponse;
export function recordedStatus(sessionId: string, outcome: RecordedUpstreamTerminal, output?: string): NativeWireResponse;
export function recordedStatus(sessionId: string, first: true | RecordedUpstreamTerminal, output?: string): NativeWireResponse {
  if (first === true) return response(statusBody("running", sessionId));
  switch (first) {
    case "completed":
      return response(statusBody("completed", sessionId, output !== undefined ? { output } : {}));
    case "failed":
    case "timed_out":
      // Upstream failure text is NOT surfaced as output: the adapter must leave resultText null.
      return response(statusBody("failed", sessionId));
    case "orphaned":
      // A restart-orphaned upstream job has no provable outcome: 404 forces ambiguous quarantine.
      return response({ error: "job_orphaned" }, 404);
  }
}

export function recordedStopAck(): NativeWireResponse {
  return response({ run_id: nativeRunId, status: "stopping" });
}

const frame = (event: string, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ event, run_id: nativeRunId, ...extra })}\n\n`;

export function recordedEventStream(): Uint8Array[] {
  return [
    frame("tool.started"),
    frame("message.delta"),
    frame("tool.completed"),
  ].map(line => Buffer.from(line, "utf8"));
}

export function recordedApprovalEvent(): Uint8Array[] {
  return [frame("approval.request")].map(line => Buffer.from(line, "utf8"));
}

export type FakeBehavior = {
  capabilities?: "ok" | "offline";
  start?: "ok" | "uncertain";
  status?: "running" | RecordedUpstreamTerminal;
  output?: string;
  events?: "stream" | "approval" | "disconnect";
  stop?: "ack" | "terminal" | "unavailable";
  calls?: string[];
};

/** Fake `NativeRunTransport` serving recorded hermes-gpt-shaped responses.
 * `disconnect` on events models a dropped stream (adapter must resnapshot, not
 * replay). `uncertain` on start models a lost reply (adapter must quarantine
 * to ambiguous, never blindly redispatch — the fake records the single POST).
 */
export function recordedHermesGptTransport(behavior: FakeBehavior = {}): NativeRunTransport & { calls: string[] } {
  const calls = behavior.calls ?? [];
  let sessionId = `cr_${"0".repeat(64)}`;
  const fail = (operation: string): never => { calls.push(`${operation}:failed`); throw new Error("synthetic_transport_failure"); };
  return { calls,
    async json(wire) {
      await wire.authorize(); calls.push(wire.operation);
      switch (wire.operation) {
        case "capabilities":
          if (behavior.capabilities === "offline") return fail("capabilities");
          return recordedCapabilities();
        case "start":
          if (behavior.start === "uncertain") return fail("start");
          if (wire.body) sessionId = wire.body.session_id;
          return recordedStart202();
        case "status":
          if (behavior.status === undefined) return recordedStatus(sessionId, true);
          if (behavior.status === "running") return recordedStatus(sessionId, true);
          return recordedStatus(sessionId, behavior.status, behavior.output);
        case "stop":
          if (behavior.stop === "unavailable") return fail("stop");
          if (behavior.stop === "terminal") return recordedStatus(sessionId, "completed", behavior.output ?? "terminal output");
          return recordedStopAck();
        default:
          return fail(wire.operation);
      }
    },
    async events(wire, receive) {
      await wire.authorize(); calls.push("events");
      const mode = behavior.events ?? "stream";
      if (mode === "disconnect") { receive(recordedEventStream()[0]); return fail("events"); }
      for (const chunk of mode === "approval" ? recordedApprovalEvent() : recordedEventStream()) receive(chunk);
    },
  };
}
