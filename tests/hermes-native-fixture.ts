import { HERMES_NATIVE_ADAPTER, HERMES_NATIVE_REVISION, bindNativeStart, type NativeEnrollment, type NativeStart,
  type NativeWireResponse } from "../src/harness/hermes-native-v1/contracts.ts";
export const instant = 1_800_000_000_000;
export const digest = (digit = "a") => `sha256:${digit.repeat(64)}`;
export const enrollment: NativeEnrollment = { adapter: HERMES_NATIVE_ADAPTER, revision: HERMES_NATIVE_REVISION,
  tenantId: "tenant:test", nodeId: "node:test", connectionId: "connection:test", canonicalDestination: "https://agent.example.test:443",
  profile: "control_room", credentialRef: "credential:test", profilePolicyDigest: digest("b"), qualificationDigest: digest("c"),
  validUntil: instant + 600_000, model: "fixture-model", provider: "fixture" };
export const input: NativeStart = { tenantId: enrollment.tenantId, nodeId: enrollment.nodeId, projectId: "project:test", jobId: "job:test",
  attemptId: "attempt:test", runId: "run:test", effectClaimKey: digest(), operationDigest: digest("d"),
  prompt: "Summarize the supplied synthetic text.", instructions: "Return a short plain-text summary.", deadline: instant + 120_000 };
export const binding = bindNativeStart(enrollment, input).binding;
export const nativeRunId = `run_${"1".repeat(32)}`;
export function response(value: unknown, status = 200): NativeWireResponse {
  return { status, contentType: "application/json; charset=utf-8", body: Buffer.from(JSON.stringify(value)) };
}
export const capabilityBody = { object: "hermes.api_server.capabilities", platform: "hermes-agent", auth: { type: "bearer", required: true },
  runtime: { mode: "server_agent", tool_execution: "server", split_runtime: false },
  features: { run_submission: true, run_status: true, run_events_sse: true, run_stop: true,
    runs_idempotency: { supported: true, durable: true, retention_seconds: 86400 } },
  endpoints: { runs: { method: "POST", path: "/v1/runs" }, run_status: { method: "GET", path: "/v1/runs/{run_id}" },
    run_events: { method: "GET", path: "/v1/runs/{run_id}/events" }, run_stop: { method: "POST", path: "/v1/runs/{run_id}/stop" } } };
export function statusBody(status = "running", extra: Record<string, unknown> = {}) {
  return { object: "hermes.run", run_id: nativeRunId, status, session_id: binding.sessionId,
    created_at: instant / 1000, updated_at: instant / 1000 + 1, ...extra };
}
