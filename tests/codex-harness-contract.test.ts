import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import type { AuthorityEnvelope } from "../src/domain/v1/types";
import type { HarnessRunEventV1 } from "../src/harness/v1";
import { InMemoryArtifactStorage } from "../src/node-executor";
import { CODEX_PINNED_EXECUTABLE_V1, CODEX_PINNED_MACOS_CDHASH_V1, CodexBrokerPolicyErrorV1, CodexExecProcessV1, CodexWorkspaceManagerV1, InMemoryCodexCredentialBrokerLedgerV1, SqliteCodexCredentialBrokerLedgerV1, codexAdapterManifestV1, decodeCodexJsonLineV1, evaluateCodexBrokerTransportV1, evaluateCodexCompatibilityV1, issueCodexCredentialBoundaryPermitV1, planCodexExecV1, planCodexResumeV1, projectCodexRunResultV1, publishCodexPatchArtifactV1, type CodexBrokerCallRequestV1, type CodexCredentialBoundaryPermitV1, type CodexWorkspaceIdentityV1 } from "../src/harness/codex-v1";

function authority(overrides: Partial<AuthorityEnvelope> = {}): AuthorityEnvelope {
  const base: AuthorityEnvelope = {
    projectId: "project:1", allowedExecutor: codexAdapterManifestV1.adapterId, allowedOperations: ["codex:read"], credentialRefs: [],
    filesystemRoots: ["/work/project"], networkPolicy: "none", allowedNetworkDestinations: [], effectPolicy: "none", maxRisk: "low",
    maxDurationSeconds: 60, maxConcurrentEffects: 0, expiresAt: "2026-08-28T00:00:00.000Z", digest: "", ...overrides,
  };
  return { ...base, digest: computeAuthorityDigest(base) };
}

function workspaceLease(runId = "run:plan") {
  const lease = { runId, repositoryRealPath: "/repo", checkoutPath: "/node/workspaces/codex-plan", revision: "a".repeat(40), device: "1", inode: "30" };
  return { ...lease, leaseId: sha256Digest(lease) };
}

function credentialPermit(runId = "run:plan", now = "2026-08-27T23:00:00.000Z"): CodexCredentialBoundaryPermitV1 {
  const issued = issueCodexCredentialBoundaryPermitV1({ runId, now, evidence: {
    mode: "scoped_provider_broker", longLivedCredentialInWorker: false, credentialStoreReadableToCommands: "blocked",
    directProviderNetworkFromWorker: false, commandEnvironmentInheritsCredential: false,
    broker: { endpointIdentityDigest: `sha256:${"5".repeat(64)}`, runAudience: runId, expiresAt: "2026-08-27T23:04:00.000Z", maximumProviderCalls: 3, model: "gpt-5.6-sol", capabilityKind: "ephemeral_run_capability" },
  } });
  if (!issued.accepted) throw new Error("test permit rejected");
  return issued.permit;
}

test("CR7B Codex manifest is pinned to the signed installed Mac binary and honest about unsupported steer and approval", () => {
  assert.equal(codexAdapterManifestV1.harnessVersion, "0.150.0-alpha.8");
  assert.equal(codexAdapterManifestV1.harnessRevision, CODEX_PINNED_MACOS_CDHASH_V1);
  assert.deepEqual(codexAdapterManifestV1.runtime, { name: "native", minimumVersion: "0.150.0-alpha.8", supportedPlatforms: ["macos"] });
  assert.deepEqual(codexAdapterManifestV1.supportedVerbs, ["discover", "start", "stream", "cancel", "resume", "usage"]);
  assert.equal(codexAdapterManifestV1.approvalMode, "unsupported");
});

test("Codex compatibility fails closed on binary, version, JSON, resume, isolation, or sandbox drift", () => {
  const baseline = { version: "0.150.0-alpha.8", macosCodeDirectoryHash: CODEX_PINNED_MACOS_CDHASH_V1, execJson: true, execResume: true, ignoreUserConfig: true, ignoreRules: true, credentialIsolation: "blocked" as const, sandboxModes: ["read-only", "workspace-write"] };
  assert.deepEqual(evaluateCodexCompatibilityV1(baseline), { compatible: true, reasons: [] });
  assert.deepEqual(evaluateCodexCompatibilityV1({ ...baseline, version: "next", macosCodeDirectoryHash: "0".repeat(40), execJson: false, execResume: false, ignoreUserConfig: false, ignoreRules: false, credentialIsolation: "readable", sandboxModes: [] }).reasons,
    ["version_drift", "binary_drift", "json_events_missing", "resume_missing", "config_isolation_missing", "rules_isolation_missing", "credential_isolation_missing", "sandbox_mode_missing"]);
});

test("CR7B native negative evidence is sanitized and cannot qualify the adapter", async () => {
  const evidence = JSON.parse(await readFile("tests/fixtures/codex-v1/native-readonly-negative.json", "utf8"));
  assert.deepEqual(evidence, { schema: "control-room.codex-native-qualification/v1", status: "failed", reasonCode: "credential_boundary_failed", calls: 1, profileRemoved: true, workspaceRemoved: true });
  const compatibility = evaluateCodexCompatibilityV1({ version: "0.150.0-alpha.8", macosCodeDirectoryHash: CODEX_PINNED_MACOS_CDHASH_V1, execJson: true, execResume: true, ignoreUserConfig: true, ignoreRules: true, credentialIsolation: "readable", sandboxModes: ["read-only", "workspace-write"] });
  assert.equal(compatibility.compatible, false);
  assert.deepEqual(compatibility.reasons, ["credential_isolation_missing"]);
});

test("Codex credential boundary rejects saved auth and issues only a short run-bound broker permit", () => {
  const rejected = issueCodexCredentialBoundaryPermitV1({ runId: "run:permit", now: "2026-08-27T23:00:00.000Z", evidence: {
    mode: "saved_auth_file", longLivedCredentialInWorker: true, credentialStoreReadableToCommands: "readable",
    directProviderNetworkFromWorker: true, commandEnvironmentInheritsCredential: true,
  } });
  assert.equal(rejected.accepted, false);
  if (rejected.accepted) assert.fail("saved auth unexpectedly accepted");
  assert.deepEqual(rejected.reasons, ["saved_auth_in_worker", "credential_store_exposed", "direct_provider_network", "credential_in_command_environment", "broker_missing"]);
  const permit = credentialPermit("run:permit");
  assert.equal(permit.runId, "run:permit");
  assert.equal(permit.maximumProviderCalls, 3);
  assert.match(permit.permitDigest, /^sha256:[a-f0-9]{64}$/);
});

function brokerRequest(permit: CodexCredentialBoundaryPermitV1, overrides: Partial<CodexBrokerCallRequestV1> = {}): CodexBrokerCallRequestV1 {
  return {
    schema: "control-room.codex-broker-call/v1", requestId: "request:codex:1", permitDigest: permit.permitDigest,
    runId: permit.runId, model: permit.model, operation: "start", input: "bounded prompt", maximumOutputTokens: 512, ...overrides,
  };
}

function policyCode(code: CodexBrokerPolicyErrorV1["safeCode"]): (error: unknown) => boolean {
  return (error) => error instanceof CodexBrokerPolicyErrorV1 && error.safeCode === code;
}

test("CR7B broker transport policy accepts only the credential-isolated Control Room boundary", () => {
  assert.deepEqual(evaluateCodexBrokerTransportV1("control_room_credential_broker"), { accepted: true });
  assert.deepEqual(evaluateCodexBrokerTransportV1("codex_app_server_websocket"), { accepted: false, reasonCode: "experimental_transport_not_security_boundary" });
  assert.deepEqual(evaluateCodexBrokerTransportV1("saved_auth_cli"), { accepted: false, reasonCode: "credential_inside_worker" });
});

test("CR7B broker atomically spends each call once and returns only sanitized replay evidence", () => {
  const endpoint = `sha256:${"5".repeat(64)}`;
  const permit = credentialPermit("run:broker");
  const ledger = new InMemoryCodexCredentialBrokerLedgerV1(endpoint);
  const limits = { maximumInputBytes: 1024, maximumOutputTokens: 1024 };
  assert.deepEqual(ledger.provision({ permit, limits, now: "2026-08-27T23:00:00.000Z" }), { replayed: false });
  assert.deepEqual(ledger.provision({ permit, limits, now: "2026-08-27T23:00:00.000Z" }), { replayed: true });
  const request = brokerRequest(permit, { input: "private broker prompt" });
  const claimed = ledger.claim(request, "2026-08-27T23:00:01.000Z");
  assert.equal(claimed.disposition, "dispatch_once");
  assert.equal(ledger.claim(request, "2026-08-27T23:00:02.000Z").disposition, "in_progress");
  if (!claimed.ticket) assert.fail("dispatch ticket missing");
  ledger.settle({ ticket: claimed.ticket, outcome: "completed", usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4, reasoningTokens: 1 } });
  assert.deepEqual(ledger.claim(request, "2026-08-27T23:00:03.000Z"), { disposition: "replay_completed", usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4, reasoningTokens: 1 } });
  const evidence = ledger.evidence(permit.permitDigest);
  assert.equal(evidence.consumedProviderCalls, 1);
  assert.equal(JSON.stringify(evidence).includes("private broker prompt"), false);
  assert.match(evidence.calls[0].requestIdDigest, /^sha256:[a-f0-9]{64}$/);
});

test("CR7B broker rejects replay conflicts, cross-scope requests, oversize work, expiry, and budget overflow", () => {
  const endpoint = `sha256:${"5".repeat(64)}`;
  const permit = credentialPermit("run:adversarial");
  const ledger = new InMemoryCodexCredentialBrokerLedgerV1(endpoint);
  ledger.provision({ permit, limits: { maximumInputBytes: 20, maximumOutputTokens: 512 }, now: "2026-08-27T23:00:00.000Z" });
  const first = brokerRequest(permit, { requestId: "request:adversarial:1" });
  ledger.claim(first, "2026-08-27T23:00:01.000Z");
  assert.throws(() => ledger.claim({ ...first, input: "changed prompt" }, "2026-08-27T23:00:02.000Z"), policyCode("request_replay_conflict"));
  assert.throws(() => ledger.claim(brokerRequest(permit, { requestId: "request:wrong:run", runId: "run:other" }), "2026-08-27T23:00:02.000Z"), policyCode("request_scope_mismatch"));
  assert.throws(() => ledger.claim(brokerRequest(permit, { requestId: "request:wrong:model", model: "other-model" }), "2026-08-27T23:00:02.000Z"), policyCode("request_scope_mismatch"));
  assert.throws(() => ledger.claim(brokerRequest(permit, { requestId: "request:large:input", input: "x".repeat(21) }), "2026-08-27T23:00:02.000Z"), policyCode("input_too_large"));
  assert.throws(() => ledger.claim(brokerRequest(permit, { requestId: "request:large:output", maximumOutputTokens: 513 }), "2026-08-27T23:00:02.000Z"), policyCode("output_limit_exceeded"));
  ledger.claim(brokerRequest(permit, { requestId: "request:adversarial:2" }), "2026-08-27T23:00:02.000Z");
  ledger.claim(brokerRequest(permit, { requestId: "request:adversarial:3" }), "2026-08-27T23:00:03.000Z");
  assert.throws(() => ledger.claim(brokerRequest(permit, { requestId: "request:adversarial:4" }), "2026-08-27T23:00:03.000Z"), policyCode("call_budget_exhausted"));
  assert.throws(() => ledger.claim(first, "2026-08-27T23:04:00.000Z"), policyCode("grant_expired"));
});

test("CR7B broker makes uncertain calls terminal and closes all unsettled work without redispatch", () => {
  const permit = credentialPermit("run:close");
  const ledger = new InMemoryCodexCredentialBrokerLedgerV1(`sha256:${"5".repeat(64)}`);
  ledger.provision({ permit, limits: { maximumInputBytes: 1024, maximumOutputTokens: 1024 }, now: "2026-08-27T23:00:00.000Z" });
  const firstRequest = brokerRequest(permit, { requestId: "request:close:1" });
  const first = ledger.claim(firstRequest, "2026-08-27T23:00:01.000Z");
  if (!first.ticket) assert.fail("dispatch ticket missing");
  ledger.settle({ ticket: first.ticket, outcome: "ambiguous", safeResultCode: "broker_transport_lost" });
  assert.deepEqual(ledger.claim(firstRequest, "2026-08-27T23:00:02.000Z"), { disposition: "ambiguous", safeResultCode: "broker_transport_lost" });
  ledger.claim(brokerRequest(permit, { requestId: "request:close:2" }), "2026-08-27T23:00:02.000Z");
  assert.deepEqual(ledger.close(permit.permitDigest, "broker_cancelled"), { replayed: false, ambiguousCalls: 2 });
  assert.deepEqual(ledger.close(permit.permitDigest, "broker_cancelled"), { replayed: true, ambiguousCalls: 2 });
  assert.throws(() => ledger.claim(brokerRequest(permit, { requestId: "request:close:3" }), "2026-08-27T23:00:03.000Z"), policyCode("grant_closed"));
  const evidence = ledger.evidence(permit.permitDigest);
  assert.deepEqual(evidence.calls.map((call) => call.state), ["ambiguous", "ambiguous"]);
});

test("CR7B broker refuses endpoint substitution, malformed resume, forged settlement, and unsafe usage", () => {
  const permit = credentialPermit("run:forgery");
  const wrongEndpoint = new InMemoryCodexCredentialBrokerLedgerV1(`sha256:${"6".repeat(64)}`);
  assert.throws(() => wrongEndpoint.provision({ permit, limits: { maximumInputBytes: 1024, maximumOutputTokens: 1024 }, now: "2026-08-27T23:00:00.000Z" }), policyCode("grant_invalid"));
  const ledger = new InMemoryCodexCredentialBrokerLedgerV1(`sha256:${"5".repeat(64)}`);
  ledger.provision({ permit, limits: { maximumInputBytes: 1024, maximumOutputTokens: 1024 }, now: "2026-08-27T23:00:00.000Z" });
  assert.throws(() => ledger.claim(brokerRequest(permit, { requestId: "request:resume:bad", operation: "resume" }), "2026-08-27T23:00:01.000Z"), policyCode("request_invalid"));
  assert.throws(() => ledger.claim(brokerRequest(permit, { requestId: "request:operation:bad", operation: "delete" as "start" }), "2026-08-27T23:00:01.000Z"), policyCode("request_invalid"));
  const claimed = ledger.claim(brokerRequest(permit, { requestId: "request:forgery:1" }), "2026-08-27T23:00:01.000Z");
  const ticket = claimed.ticket;
  assert.ok(ticket);
  assert.throws(() => ledger.settle({ ticket: { ...ticket, callNumber: 2 }, outcome: "completed" }), policyCode("ticket_mismatch"));
  assert.throws(() => ledger.settle({ ticket, outcome: "completed", usage: { inputTokens: -1, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 } }), policyCode("settlement_invalid"));
  ledger.settle({ ticket, outcome: "failed", safeResultCode: "provider_rejected" });
  assert.throws(() => ledger.settle({ ticket, outcome: "failed", safeResultCode: "provider_rejected" }), policyCode("settlement_invalid"));
});

test("CR7B durable broker survives restart without redispatch and stores no prompt content", async () => {
  const root = await mkdtemp(join(tmpdir(), "cr7b-broker-"));
  const path = join(root, "ledger.sqlite");
  const endpoint = `sha256:${"5".repeat(64)}`;
  const permit = credentialPermit("run:durable");
  const request = brokerRequest(permit, { requestId: "request:durable:1", input: "private durable prompt canary" });
  try {
    const first = new SqliteCodexCredentialBrokerLedgerV1(path, endpoint);
    first.provision({ permit, limits: { maximumInputBytes: 1024, maximumOutputTokens: 1024 }, now: "2026-08-27T23:00:00.000Z" });
    assert.equal(first.claim(request, "2026-08-27T23:00:01.000Z").disposition, "dispatch_once");
    first.closeDatabase();

    const restarted = new SqliteCodexCredentialBrokerLedgerV1(path, endpoint);
    assert.equal(restarted.recoverAfterRestart(), 1);
    assert.deepEqual(restarted.claim(request, "2026-08-27T23:00:02.000Z"), { disposition: "ambiguous", safeResultCode: "broker_restarted" });
    assert.equal(restarted.recoverAfterRestart(), 0);
    assert.equal(restarted.evidence(permit.permitDigest).consumedProviderCalls, 1);
    restarted.closeDatabase();

    assert.equal((await stat(path)).mode & 0o077, 0);
    assert.equal((await readFile(path)).includes(Buffer.from("private durable prompt canary")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CR7B durable broker rejects ephemeral production storage and conflicting close replay", () => {
  const endpoint = `sha256:${"5".repeat(64)}`;
  assert.throws(() => new SqliteCodexCredentialBrokerLedgerV1(":memory:", endpoint), policyCode("grant_invalid"));
  const ledger = new SqliteCodexCredentialBrokerLedgerV1(":memory:", endpoint, { testOnlyAllowEphemeral: true });
  const permit = credentialPermit("run:durable-close");
  ledger.provision({ permit, limits: { maximumInputBytes: 1024, maximumOutputTokens: 1024 }, now: "2026-08-27T23:00:00.000Z" });
  assert.throws(() => ledger.claim(brokerRequest(permit, { requestId: "request:durable:operation", operation: "delete" as "start" }), "2026-08-27T23:00:01.000Z"), policyCode("request_invalid"));
  assert.deepEqual(ledger.close(permit.permitDigest, "broker_cancelled"), { replayed: false, ambiguousCalls: 0 });
  assert.throws(() => ledger.close(permit.permitDigest, "different_reason"), policyCode("settlement_invalid"));
  ledger.closeDatabase();
});

test("Codex command planning maps exact authority to isolated read and write invocations", () => {
  const read = planCodexExecV1({ runId: "run:plan", credentialBoundaryPermit: credentialPermit(), executable: CODEX_PINNED_EXECUTABLE_V1, cwd: "/work/project", prompt: "inspect only", resumable: true, sandbox: "read-only", authority: authority(), now: "2026-08-27T23:00:00.000Z" });
  assert.deepEqual(read.args, ["exec", "--json", "--color", "never", "--strict-config", "--ignore-user-config", "--ignore-rules", "--sandbox", "read-only", "--cd", "/work/project", "--thread-source", "control-room-harness", "--model", "gpt-5.6-sol", "-"]);
  assert.equal(read.stdin, "inspect only");
  assert.equal(read.args.includes(read.stdin), false);
  const lease = workspaceLease();
  const writeAuthority = authority({ allowedOperations: ["codex:workspace-write"], filesystemRoots: [lease.checkoutPath] });
  const write = planCodexExecV1({ runId: lease.runId, credentialBoundaryPermit: credentialPermit(lease.runId), executable: CODEX_PINNED_EXECUTABLE_V1, cwd: lease.checkoutPath, prompt: "bounded edit", resumable: false, sandbox: "workspace-write", workspaceLease: lease, authority: writeAuthority, now: "2026-08-27T23:00:00.000Z" });
  assert.equal(write.args.includes("--ephemeral"), true);
  assert.throws(() => planCodexExecV1({ runId: lease.runId, credentialBoundaryPermit: credentialPermit(lease.runId), executable: CODEX_PINNED_EXECUTABLE_V1, cwd: "/other", prompt: "x", resumable: false, sandbox: "workspace-write", workspaceLease: lease, authority: writeAuthority, now: "2026-08-27T23:00:00.000Z" }), /outside authorized roots/);
  assert.throws(() => planCodexExecV1({ runId: "run:plan", credentialBoundaryPermit: credentialPermit(), executable: CODEX_PINNED_EXECUTABLE_V1, cwd: "/work/project", prompt: "x", resumable: false, sandbox: "workspace-write", authority: authority(), now: "2026-08-27T23:00:00.000Z" }), /write not authorized/);
  assert.throws(() => planCodexExecV1({ runId: "run:plan", credentialBoundaryPermit: credentialPermit(), executable: "/tmp/codex", cwd: "/work/project", prompt: "x", resumable: false, sandbox: "read-only", authority: authority(), now: "2026-08-27T23:00:00.000Z" }), /not the pinned binary/);
  const verify = planCodexExecV1({ runId: "run:plan", credentialBoundaryPermit: credentialPermit(), executable: CODEX_PINNED_EXECUTABLE_V1, cwd: "/work/project", prompt: "verify", resumable: false, sandbox: "read-only", verificationCommands: ["npm test"], authority: authority({ allowedOperations: ["codex:read", "codex:verify"] }), now: "2026-08-27T23:00:00.000Z" });
  assert.deepEqual(verify.verificationCommands, ["npm test"]);
  assert.throws(() => planCodexExecV1({ runId: "run:plan", credentialBoundaryPermit: credentialPermit(), executable: CODEX_PINNED_EXECUTABLE_V1, cwd: "/work/project", prompt: "verify", resumable: false, sandbox: "read-only", verificationCommands: ["npm test"], authority: authority(), now: "2026-08-27T23:00:00.000Z" }), /verification not authorized/);
});

test("Codex command planning rejects expired, networked, credentialed, effectful, or tampered authority", () => {
  const input = { runId: "run:plan", credentialBoundaryPermit: credentialPermit(), executable: CODEX_PINNED_EXECUTABLE_V1, cwd: "/work/project", prompt: "inspect", resumable: true, sandbox: "read-only" as const, now: "2026-08-27T23:00:00.000Z" };
  assert.throws(() => planCodexExecV1({ ...input, authority: authority({ expiresAt: input.now }) }), /expired/);
  assert.throws(() => planCodexExecV1({ ...input, authority: authority({ networkPolicy: "allowlist", allowedNetworkDestinations: ["api.example.test"] }) }), /no-network/);
  assert.throws(() => planCodexExecV1({ ...input, authority: authority({ credentialRefs: ["credential:one"] }) }), /credential references/);
  assert.throws(() => planCodexExecV1({ ...input, authority: authority({ effectPolicy: "approval_required", maxConcurrentEffects: 1 }) }), /effect authority/);
  assert.throws(() => planCodexExecV1({ ...input, authority: { ...authority(), maxDurationSeconds: 999 } }), /digest mismatch/);
});

test("Codex resume targets one explicit native thread without --last", () => {
  const plan = planCodexResumeV1({ runId: "run:plan", credentialBoundaryPermit: credentialPermit(), executable: CODEX_PINNED_EXECUTABLE_V1, cwd: "/work/project", prompt: "continue bounded work", sandbox: "read-only", authority: authority(), now: "2026-08-27T23:00:00.000Z", nativeThreadId: "0199a213-81c0-7800-8aa1-bbab2a035a53" });
  assert.deepEqual(plan.args.slice(-3), ["resume", "0199a213-81c0-7800-8aa1-bbab2a035a53", "-"]);
  assert.equal(plan.stdin, "continue bounded work");
  assert.equal(plan.args.includes("--last"), false);
});

test("Codex JSONL decoder emits bounded lifecycle evidence and discards commands, paths, output, and final text", async () => {
  const lines = (await readFile("tests/fixtures/codex-v1/exec-events.jsonl", "utf8")).trim().split("\n");
  const events = []; let nativeThreadId: string | undefined;
  for (const line of lines) {
    const decoded = decodeCodexJsonLineV1(line, { tenantId: "tenant:1", nodeId: "node:1", runId: "run:1", sequence: events.length + 1, occurredAt: "2026-08-27T23:00:00.000Z", verificationCommands: ["private command"] });
    nativeThreadId = decoded.nativeThreadId ?? nativeThreadId; events.push(...decoded.events);
    if (decoded.finalTextDigest) assert.match(decoded.finalTextDigest, /^sha256:[a-f0-9]{64}$/);
  }
  assert.equal(nativeThreadId, "0199a213-81c0-7800-8aa1-bbab2a035a53");
  assert.deepEqual(events.map((event) => event.payload.category), ["transport", "lifecycle", "activity", "activity", "activity", "usage", "lifecycle"]);
  assert.deepEqual(events[2].payload, { category: "activity", activity: "test", phase: "started" });
  assert.deepEqual(events[3].payload, { category: "activity", activity: "test", phase: "completed" });
  assert.deepEqual(events[4].payload, { category: "activity", activity: "file", phase: "completed", count: 1 });
  assert.equal(new Set(events.map((event) => event.sourceEventKeyDigest)).size, events.length);
  const serialized = JSON.stringify(events);
  for (const forbidden of ["private command", "private output", "/private/path", "private final response", nativeThreadId]) assert.equal(serialized.includes(forbidden), false, forbidden);
  assert.deepEqual(events.at(-2)?.payload, { category: "usage", inputTokens: 24763, outputTokens: 122, cachedInputTokens: 24448, reasoningTokens: 0 });
  const drift = decodeCodexJsonLineV1('{"type":"future.event","private":"discard me"}', { tenantId: "tenant:1", nodeId: "node:1", runId: "run:1", sequence: 8, occurredAt: "2026-08-27T23:00:00.000Z" });
  assert.deepEqual(drift.events[0].payload, { category: "transport", state: "drift", reasonCode: "codex_event_unknown" });
  assert.equal(JSON.stringify(drift).includes("discard me"), false);
});

test("Codex process wrapper preserves sequence and rejects missing or contradictory terminal truth", async () => {
  const lines = (await readFile("tests/fixtures/codex-v1/exec-events.jsonl", "utf8")).trim().split("\n");
  const wrapper = new CodexExecProcessV1({ async run(_plan, handlers) { for (const line of lines) handlers.stdoutLine(line); return { exitCode: 0 }; } });
  const plan = planCodexExecV1({ runId: "run:1", credentialBoundaryPermit: credentialPermit("run:1"), executable: CODEX_PINNED_EXECUTABLE_V1, cwd: "/work/project", prompt: "inspect", resumable: true, sandbox: "read-only", authority: authority(), now: "2026-08-27T23:00:00.000Z" });
  const result = await wrapper.run(plan, { tenantId: "tenant:1", nodeId: "node:1", runId: "run:1", sequence: 1, now: () => "2026-08-27T23:00:00.000Z" });
  assert.equal(result.exitCode, 0); assert.equal(result.events.length, 7); assert.deepEqual(result.events.map((event) => event.sequence), [1,2,3,4,5,6,7]); assert.match(result.finalTextDigest ?? "", /^sha256:[a-f0-9]{64}$/);
  const failed = new CodexExecProcessV1({ async run() { return { exitCode: 9 }; } });
  await assert.rejects(failed.run(plan, { tenantId: "tenant:1", nodeId: "node:1", runId: "run:2", sequence: 1, now: () => "2026-08-27T23:00:00.000Z" }), /exactly one final structured terminal/);
  const falseSuccess = new CodexExecProcessV1({ async run() { return { exitCode: 0 }; } });
  await assert.rejects(falseSuccess.run(plan, { tenantId: "tenant:1", nodeId: "node:1", runId: "run:3", sequence: 1, now: () => "2026-08-27T23:00:00.000Z" }), /exactly one final structured terminal/);
});

test("Codex process wrapper exposes one bounded cancellation channel", async () => {
  const wrapper = new CodexExecProcessV1({ async run(_plan, _handlers, signal) {
    return await new Promise((resolve) => signal.addEventListener("abort", () => resolve({ exitCode: 130 }), { once: true }));
  } });
  const plan = planCodexExecV1({ runId: "run:cancel", credentialBoundaryPermit: credentialPermit("run:cancel"), executable: CODEX_PINNED_EXECUTABLE_V1, cwd: "/work/project", prompt: "inspect", resumable: true, sandbox: "read-only", authority: authority(), now: "2026-08-27T23:00:00.000Z" });
  const pending = wrapper.run(plan, { tenantId: "tenant:1", nodeId: "node:1", runId: "run:cancel", sequence: 1, now: () => "2026-08-27T23:00:00.000Z" });
  assert.equal(wrapper.cancel(), true);
  assert.equal(wrapper.cancel(), false);
  const result = await pending;
  assert.equal(result.exitCode, 130);
  assert.deepEqual(result.events[0].payload, { category: "lifecycle", state: "cancelled", reasonCode: "codex_cancelled" });
});

test("Codex result projection binds terminal, usage, file, test, and final-message digest lineage without content", async () => {
  const lines = (await readFile("tests/fixtures/codex-v1/exec-events.jsonl", "utf8")).trim().split("\n");
  const events: HarnessRunEventV1[] = []; let finalTextDigest: string | undefined;
  for (const line of lines) {
    const decoded = decodeCodexJsonLineV1(line, { tenantId: "tenant:1", nodeId: "node:1", runId: "run:1", sequence: events.length + 1, occurredAt: "2026-08-27T23:00:00.000Z", verificationCommands: ["private command"] });
    events.push(...decoded.events); finalTextDigest = decoded.finalTextDigest ?? finalTextDigest;
  }
  const result = projectCodexRunResultV1({ tenantId: "tenant:1", runId: "run:1", events, finalTextDigest });
  assert.deepEqual({ terminal: result.terminalState, files: result.changedFileCount, verification: result.verification, usage: result.usage }, { terminal: "succeeded", files: 1, verification: { started: 1, completed: 1, failed: 0 }, usage: { inputTokens: 24763, outputTokens: 122, cachedInputTokens: 24448, reasoningTokens: 0 } });
  assert.match(result.finalTextDigest ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.throws(() => projectCodexRunResultV1({ tenantId: "tenant:foreign", runId: "run:1", events, finalTextDigest }), /scope mismatch/);
  assert.throws(() => projectCodexRunResultV1({ tenantId: "tenant:1", runId: "run:1", events: events.slice(0, -1), finalTextDigest }), /missing terminal/);
});

test("Codex result projection accepts an appended event slice and does not count progress as a new verification", () => {
  const events: HarnessRunEventV1[] = [
    {
      schemaVersion: "control-room-harness-event/v1", tenantId: "tenant:1", runId: "run:appended", source: "adapter",
      sequence: 41, occurredAt: "2026-08-27T23:00:00.000Z", sourceEventKeyDigest: `sha256:${"1".repeat(64)}`,
      payload: { category: "activity", activity: "test", phase: "progress" },
    },
    {
      schemaVersion: "control-room-harness-event/v1", tenantId: "tenant:1", runId: "run:appended", source: "adapter",
      sequence: 42, occurredAt: "2026-08-27T23:00:01.000Z", sourceEventKeyDigest: `sha256:${"2".repeat(64)}`,
      payload: { category: "activity", activity: "test", phase: "completed" },
    },
    {
      schemaVersion: "control-room-harness-event/v1", tenantId: "tenant:1", runId: "run:appended", source: "adapter",
      sequence: 43, occurredAt: "2026-08-27T23:00:02.000Z", sourceEventKeyDigest: `sha256:${"3".repeat(64)}`,
      payload: { category: "lifecycle", state: "succeeded" },
    },
  ];
  const result = projectCodexRunResultV1({ tenantId: "tenant:1", runId: "run:appended", events });
  assert.deepEqual(result.verification, { started: 0, completed: 1, failed: 0 });
  assert.throws(() => projectCodexRunResultV1({ tenantId: "tenant:1", runId: "run:appended", events: [events[0], events[2]] }), /sequence gap/);
});

test("Codex patch publication binds safe bytes to the succeeded run and durable artifact lineage", async () => {
  const run = {
    schemaVersion: "control-room-harness/v1" as const, id: "run:publish", tenantId: "tenant:1", projectId: "project:1",
    jobId: "job:1", attemptId: "attempt:1", nodeId: "node:1", adapterId: codexAdapterManifestV1.adapterId,
    adapterVersion: codexAdapterManifestV1.adapterVersion, harness: "codex" as const, harnessVersion: codexAdapterManifestV1.harnessVersion,
    nativeSessionKeyDigest: `sha256:${"4".repeat(64)}`, state: "succeeded" as const, resumable: true,
    cancelState: "not_requested" as const, createdAt: "2026-08-27T23:00:00.000Z", updatedAt: "2026-08-27T23:00:02.000Z",
    startedAt: "2026-08-27T23:00:00.000Z", finishedAt: "2026-08-27T23:00:02.000Z", lastObservedAt: "2026-08-27T23:00:02.000Z",
  };
  const result = { runId: run.id, terminalState: "succeeded" as const, changedFileCount: 1, verification: { started: 1, completed: 1, failed: 0 }, usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 5, reasoningTokens: 0 } };
  const storage = new InMemoryArtifactStorage();
  const lineage = await publishCodexPatchArtifactV1({ run, result, artifactId: "artifact:codex:1", claimId: "claim:codex:1", patch: "diff --git a/safe.ts b/safe.ts\n+export const safe = true;\n", createdAt: "2026-08-27T23:00:02.000Z", retentionClass: "build_evidence" }, storage);
  assert.equal(lineage.manifest.logicalRole, "codex_workspace_patch");
  assert.equal(lineage.manifest.producerId, run.nodeId);
  assert.equal(lineage.manifest.opaqueLocator, "memory://artifact/artifact%3Acodex%3A1");
  assert.equal(storage.count(), 1);
  await assert.rejects(publishCodexPatchArtifactV1({ run, result: { ...result, runId: "run:other" }, artifactId: "artifact:other", claimId: "claim:other", patch: "safe", createdAt: "2026-08-27T23:00:02.000Z", retentionClass: "build_evidence" }, storage), /does not match/);
  await assert.rejects(publishCodexPatchArtifactV1({ run, result, artifactId: "artifact:secret", claimId: "claim:secret", patch: "api_key='abcdefghijklmnopqrstuvwxyz123456'", createdAt: "2026-08-27T23:00:02.000Z", retentionClass: "build_evidence" }, storage), /secret material/i);
});

test("Codex workspace lifecycle uses a disjoint canonical root and refuses cleanup after identity replacement", async () => {
  const identities = new Map<string, CodexWorkspaceIdentityV1>([
    ["/repo", { realPath: "/repo", device: "1", inode: "10" }],
    ["/node/workspaces", { realPath: "/node/workspaces", device: "1", inode: "20" }],
  ]);
  const removed: string[] = [];
  const port = {
    async inspectExisting(path: string) { const found = identities.get(path); if (!found) throw new Error("missing path"); return { ...found }; },
    async createDetachedWorktree(input: { repositoryRealPath: string; checkoutPath: string; revision: string }) {
      const created = { realPath: input.checkoutPath, repositoryRealPath: input.repositoryRealPath, headRevision: input.revision, device: "1", inode: "30" };
      identities.set(input.checkoutPath, created); return created;
    },
    async removeWorktree(input: { checkoutPath: string }) { removed.push(input.checkoutPath); identities.delete(input.checkoutPath); },
  };
  const manager = new CodexWorkspaceManagerV1(port);
  const revision = "a".repeat(40);
  const first = await manager.prepare({ runId: "run:workspace:1", repositoryRoot: "/repo", workspaceRoot: "/node/workspaces", revision });
  assert.match(first.checkoutPath, /^\/node\/workspaces\/codex-[a-f0-9]{24}$/);
  identities.set(first.checkoutPath, { realPath: first.checkoutPath, device: "1", inode: "31" });
  await assert.rejects(manager.cleanup(first), /identity changed/);
  assert.deepEqual(removed, []);
  identities.set(first.checkoutPath, { realPath: first.checkoutPath, device: "1", inode: "30" });
  await manager.cleanup(first);
  assert.deepEqual(removed, [first.checkoutPath]);

  const symlinkPort = { ...port, async inspectExisting(path: string) { return path === "/alias" ? { realPath: "/repo", device: "1", inode: "10" } : port.inspectExisting(path); } };
  await assert.rejects(new CodexWorkspaceManagerV1(symlinkPort).prepare({ runId: "run:workspace:2", repositoryRoot: "/alias", workspaceRoot: "/node/workspaces", revision }), /must not traverse a symlink/);
  await assert.rejects(manager.prepare({ runId: "run:workspace:3", repositoryRoot: "/repo", workspaceRoot: "/repo/worktrees", revision }), /disjoint|missing path/);
});
