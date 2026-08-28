import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateHermesCompatibilityV1, HermesGatewayLifecycleClientV1, hermesAdapterManifestV1, HERMES_REQUIRED_GATEWAY_METHODS_V1, normalizeHermesGatewayEventV1, projectHermesServeSnapshotV1, readHermesServeProjectionV1, type HermesGatewayMethodV1 } from "../src/harness/hermes-v1";
import { harnessAdapterManifestSchemaV1, harnessRunSchemaV1 } from "../src/harness/v1";

const digest = `sha256:${"a".repeat(64)}`;

test("CR7 foundation manifest is pinned, honest about implemented verbs, and rejects ambiguous capabilities", () => {
  assert.equal(hermesAdapterManifestV1.harnessRevision, "5fc308a70719a83cccdbba4c0e39c23f5a8239d5");
  assert.equal(hermesAdapterManifestV1.harnessVersion, "0.20.6");
  assert.deepEqual(hermesAdapterManifestV1.supportedVerbs, ["discover", "start", "stream", "steer", "cancel", "resume", "usage"]);
  assert.equal(hermesAdapterManifestV1.approvalMode, "observe_only");
  assert.equal(harnessAdapterManifestSchemaV1.safeParse({ ...hermesAdapterManifestV1, supportedVerbs: ["discover", "discover"] }).success, false);
  assert.equal(harnessAdapterManifestSchemaV1.safeParse({ ...hermesAdapterManifestV1, harnessRevision: "main" }).success, false);
});

test("Hermes lifecycle client starts only after zero-tool attestation and keeps native identifiers node-local", async () => {
  const calls: Array<{ method: HermesGatewayMethodV1; params: Readonly<Record<string, unknown>> }> = [];
  const responses: Record<HermesGatewayMethodV1, unknown> = {
    "session.create": { session_id: "native-live", stored_session_id: "native-stored", info: { tools: {}, mcp_servers: [] } },
    "prompt.submit": { status: "streaming" },
    "session.steer": { status: "queued" },
    "session.interrupt": { status: "interrupted" },
    "session.resume": { session_id: "native-resumed", resumed: "native-stored", status: "idle", info: { tools: {}, mcp_servers: [] } },
    "session.status": {},
    "session.usage": { input: 10, output: 4, reasoning: 2, total: 16, calls: 1 },
  };
  const client = new HermesGatewayLifecycleClientV1(
    { async call(method, params) { calls.push({ method, params }); return responses[method]; } },
    { harnessVersion: "0.20.6", harnessRevision: hermesAdapterManifestV1.harnessRevision, gatewayMethods: [...HERMES_REQUIRED_GATEWAY_METHODS_V1] },
    { disposableProfile: true, disposableWorkspace: true, ignoreContextFiles: true, enabledToolsets: ["context_engine"], callableToolCount: 0, mcpServerCount: 0 },
  );
  const reference = await client.start({ tenantId: "tenant:1", nodeId: "node:1", cwd: "/disposable", prompt: "bounded prompt" });
  await client.steer(reference, "bounded correction");
  await client.cancel(reference);
  assert.deepEqual(await client.usage(reference), { inputTokens: 10, outputTokens: 4, reasoningTokens: 2, totalTokens: 16, calls: 1 });
  const resumed = await client.resume({ tenantId: "tenant:1", nodeId: "node:1", storedSessionId: reference.storedSessionId });
  assert.match(reference.sessionKeyDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(resumed.liveSessionId, "native-resumed");
  assert.deepEqual(calls.map((entry) => entry.method), ["session.create", "prompt.submit", "session.steer", "session.interrupt", "session.usage", "session.resume"]);
});

test("Hermes lifecycle client fails closed before prompt submission when tools or launch isolation drift", async () => {
  const compatibility = { harnessVersion: "0.20.6", harnessRevision: hermesAdapterManifestV1.harnessRevision, gatewayMethods: [...HERMES_REQUIRED_GATEWAY_METHODS_V1] };
  assert.throws(() => new HermesGatewayLifecycleClientV1(
    { async call() { return {}; } }, compatibility,
    { disposableProfile: true, disposableWorkspace: true, ignoreContextFiles: true, enabledToolsets: ["context_engine"], callableToolCount: 1, mcpServerCount: 0 } as never,
  ));
  const methods: HermesGatewayMethodV1[] = [];
  const client = new HermesGatewayLifecycleClientV1(
    { async call(method) { methods.push(method); return { session_id: "native-live", stored_session_id: "native-stored", info: { tools: { terminal: {} }, mcp_servers: [] } }; } },
    compatibility,
    { disposableProfile: true, disposableWorkspace: true, ignoreContextFiles: true, enabledToolsets: ["context_engine"], callableToolCount: 0, mcpServerCount: 0 },
  );
  await assert.rejects(client.start({ tenantId: "tenant:1", nodeId: "node:1", cwd: "/disposable", prompt: "bounded prompt" }), /callable tools/);
  assert.deepEqual(methods, ["session.create"]);
});

test("sanitized live Hermes evidence records a provider-backed start, steer, cancel, usage, and resume without content", async () => {
  const evidence = JSON.parse(await readFile("tests/fixtures/hermes-v1/live-lifecycle-sanitized.json", "utf8"));
  assert.deepEqual(evidence.isolation, { disposableProfile: true, disposableWorkspace: true, ignoreContextFiles: true, enabledToolsets: ["context_engine"], callableToolCount: 0, mcpServerCount: 0 });
  assert.deepEqual({ start: evidence.observed.startStatus, steer: evidence.observed.steerStatus, cancel: evidence.observed.cancelStatus, resume: evidence.observed.resumeStatus }, { start: "streaming", steer: "queued", cancel: "interrupted", resume: "idle" });
  assert.equal(evidence.observed.providerBackedTurnObserved, true);
  assert.equal(evidence.observed.reportedCompletedCalls > 0, true);
  assert.equal(evidence.observed.totalTokens > 0, true);
  assert.deepEqual([evidence.containsRawIdentifiers, evidence.containsPromptOrTranscript, evidence.containsCredentials], [false, false, false]);
  const serialized = JSON.stringify(evidence);
  for (const forbidden of ["native-live", "native-stored", "provider_key", "Bearer ", "https://portal.nousresearch.com/orgs/"]) assert.equal(serialized.includes(forbidden), false, forbidden);
});

test("CR7 run contract binds attempt lineage, opaque native identity, timestamps, and terminal truth", () => {
  const run = { schemaVersion: "control-room-harness/v1" as const, id: "run:1", tenantId: "tenant:1", projectId: "project:1", jobId: "job:1", attemptId: "attempt:1", nodeId: "node:1", adapterId: hermesAdapterManifestV1.adapterId, adapterVersion: "1.0.0", harness: "hermes" as const, harnessVersion: "0.20.6", nativeSessionKeyDigest: digest, state: "discovered" as const, resumable: true, cancelState: "not_requested" as const, createdAt: "2026-08-27T20:00:00.000Z", updatedAt: "2026-08-27T20:00:00.000Z", lastObservedAt: "2026-08-27T20:00:00.000Z" };
  assert.equal(harnessRunSchemaV1.parse(run).state, "discovered");
  assert.equal(harnessRunSchemaV1.safeParse({ ...run, nativeSessionId: "raw-native-id" }).success, false);
  assert.equal(harnessRunSchemaV1.safeParse({ ...run, state: "succeeded", startedAt: run.createdAt }).success, false);
  assert.equal(harnessRunSchemaV1.safeParse({ ...run, parentRunId: run.id }).success, false);
});

test("Hermes gateway normalization drops transcript content and fails closed on session drift", async () => {
  const frames = JSON.parse(await readFile("tests/fixtures/hermes-v1/gateway-events.json", "utf8")) as unknown[];
  const normalized = frames.map((frame, index) => normalizeHermesGatewayEventV1(frame, { tenantId: "tenant:1", runId: "run:1", sequence: index + 1, occurredAt: `2026-08-27T20:00:0${index}.000Z`, nativeSessionId: "native-session-a" }));
  assert.deepEqual(normalized.map((event) => event?.payload.category), ["transport", "activity", "usage", "lifecycle"]);
  const text = JSON.stringify(normalized);
  assert.equal(text.includes("private"), false);
  assert.equal(text.includes("native-session-a"), false);
  assert.deepEqual(normalized[2]?.payload, { category: "usage", inputTokens: 12, outputTokens: 7, cachedInputTokens: 3, reasoningTokens: 2, estimatedCostUsd: "0.0042" });
  assert.throws(() => normalizeHermesGatewayEventV1(frames[0], { tenantId: "tenant:1", runId: "run:1", sequence: 1, occurredAt: "2026-08-27T20:00:00.000Z", nativeSessionId: "different" }));
  assert.equal(normalizeHermesGatewayEventV1({ jsonrpc: "2.0", method: "event", params: { type: "message.delta", session_id: "native-session-a", payload: { text: "secret" } } }, { tenantId: "tenant:1", runId: "run:1", sequence: 1, occurredAt: "2026-08-27T20:00:00.000Z", nativeSessionId: "native-session-a" }), undefined);
});

test("Hermes serve projection is read-only, bounded, and hashes native session and cron identities", async () => {
  const input = JSON.parse(await readFile("tests/fixtures/hermes-v1/serve-snapshot.json", "utf8"));
  const projected = projectHermesServeSnapshotV1(input, { tenantId: "tenant:1", nodeId: "node:1" });
  assert.deepEqual({ gateway: projected.gatewayState, active: projected.activeSessionCount, sessions: projected.sessions.length, cron: projected.cronJobs.length }, { gateway: "running", active: 1, sessions: 1, cron: 1 });
  assert.match(projected.sessions[0].sessionKeyDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(projected.cronJobs[0].jobKeyDigest, /^sha256:[a-f0-9]{64}$/);
  const text = JSON.stringify(projected);
  for (const forbidden of ["native-session-a", "native-cron-a", "private-profile", "private prompt", "provider_key"]) assert.equal(text.includes(forbidden), false, forbidden);
  assert.throws(() => projectHermesServeSnapshotV1({ ...input, sessions: Array.from({ length: 101 }, () => input.sessions[0]) }, { tenantId: "tenant:1", nodeId: "node:1" }));
});

test("Hermes compatibility fails closed on version, revision, method loss, or an ambiguous method set", () => {
  const baseline = { harnessVersion:"0.20.6",harnessRevision:hermesAdapterManifestV1.harnessRevision,gatewayMethods:[...HERMES_REQUIRED_GATEWAY_METHODS_V1] };
  assert.deepEqual(evaluateHermesCompatibilityV1(baseline),{compatible:true,reasons:[],missingMethods:[]});
  assert.deepEqual(evaluateHermesCompatibilityV1({ ...baseline,harnessVersion:"0.20.7",harnessRevision:"f".repeat(40),gatewayMethods:["session.create","session.create"] }).reasons,["version_drift","revision_drift","gateway_method_set_ambiguous","gateway_method_missing"]);
});

test("Hermes read client can call only the four frozen GET projections", async () => {
  const fixture = JSON.parse(await readFile("tests/fixtures/hermes-v1/serve-snapshot.json","utf8")); const calls:string[]=[];
  const values:Record<string,unknown>={"/api/status":fixture.status,"/api/sessions":{sessions:fixture.sessions},"/api/cron/jobs":{jobs:fixture.cronJobs},"/api/analytics/usage":fixture.usage};
  const projected = await readHermesServeProjectionV1({ async get(path){calls.push(path);return values[path];} },{tenantId:"tenant:1",nodeId:"node:1"});
  assert.deepEqual(calls.sort(),["/api/analytics/usage","/api/cron/jobs","/api/sessions","/api/status"]);
  assert.equal(projected.gatewayState,"running");
});
