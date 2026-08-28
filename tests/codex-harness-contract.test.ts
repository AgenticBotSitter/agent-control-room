import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { computeAuthorityDigest, sha256Digest } from "../src/security";
import type { AuthorityEnvelope } from "../src/domain/v1/types";
import type { HarnessRunEventV1 } from "../src/harness/v1";
import { InMemoryArtifactStorage } from "../src/node-executor";
import { CODEX_APP_SERVER_MAX_PENDING_REQUESTS_V1, CODEX_APP_SERVER_MAX_QUEUED_LINES_V1, CODEX_ISOLATED_CLIENT_METHODS_V1, CODEX_PINNED_EXECUTABLE_V1, CODEX_PINNED_MACOS_CDHASH_V1, CodexAppServerChildLineTransportV1, CodexAppServerJsonlSessionV1, CodexAppServerRuntimeErrorV1, CodexBrokerPolicyErrorV1, CodexExecProcessV1, CodexIsolatedQualificationRuntimeV1, CodexIsolatedTurnObserverV1, CodexMacIsolatedControllerV1, CodexWorkspaceManagerV1, InMemoryCodexCredentialBrokerLedgerV1, SqliteCodexCredentialBrokerLedgerV1, codexAdapterManifestV1, createCodexPinnedAppServerChildV1, decodeCodexJsonLineV1, digestCodexIsolatedTopologyAttestationV1, digestCodexPinnedAppServerSpawnSpecV1, evaluateCodexBrokerTransportV1, evaluateCodexCompatibilityV1, evaluateCodexIsolatedTopologyV1, issueCodexCredentialBoundaryPermitV1, planCodexExecV1, planCodexMacIsolatedLauncherV1, planCodexResumeV1, projectCodexRunResultV1, publishCodexPatchArtifactV1, verifyCodexMacIsolatedPackagesV1, type CodexAppServerChildPortV1, type CodexBrokerCallRequestV1, type CodexCredentialBoundaryPermitV1, type CodexIsolatedTopologyAttestationV1, type CodexMacIsolatedLauncherConfigV1, type CodexPinnedAppServerSpawnSpecV1, type CodexWorkspaceIdentityV1 } from "../src/harness/codex-v1";

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

function isolatedTopology(overrides: Partial<Omit<CodexIsolatedTopologyAttestationV1, "attestationDigest">> = {}): CodexIsolatedTopologyAttestationV1 {
  const unsigned = {
    schema: "control-room.codex-isolated-topology/v1" as const,
    brokerIdentityDigest: `sha256:${"1".repeat(64)}`, executorIdentityDigest: `sha256:${"2".repeat(64)}`,
    environmentIdDigest: `sha256:${"3".repeat(64)}`, executableVersion: codexAdapterManifestV1.harnessVersion,
    executableCodeDirectoryHash: CODEX_PINNED_MACOS_CDHASH_V1, appServerTransport: "parent_owned_stdio" as const,
    commandEnvironment: "remote_exec_server_only" as const, remoteDisconnectBehavior: "fail_closed" as const,
    brokerCanExecuteModelCommands: false, executorCanReadCredentialStore: "blocked" as const,
    executorCanReadBrokerLedger: "blocked" as const, executorProviderEgress: "blocked" as const,
    brokerProviderEgress: "exact_allowlist" as const, providerCallsMediatedByLedger: true,
    allowedClientMethods: [...CODEX_ISOLATED_CLIENT_METHODS_V1], experimentalSeamAcknowledged: true,
    useClass: "disposable_qualification" as const, ...overrides,
  };
  return { ...unsigned, attestationDigest: digestCodexIsolatedTopologyAttestationV1(unsigned) };
}

test("CR7B isolated topology is eligible only for disposable qualification and never for production", () => {
  assert.deepEqual(evaluateCodexIsolatedTopologyV1(isolatedTopology()), { eligibleForDisposableQualification: true, productionEligible: false, reasons: [] });
  assert.deepEqual(evaluateCodexIsolatedTopologyV1(isolatedTopology({ useClass: "production" })).reasons, ["production_use_forbidden"]);
});

test("CR7B isolated topology fails every credential, command, network, replay, identity, and transport bypass", () => {
  const unsafe = isolatedTopology({
    brokerIdentityDigest: `sha256:${"2".repeat(64)}`, environmentIdDigest: "raw-environment-id",
    executableVersion: "drift", executableCodeDirectoryHash: "0".repeat(40), appServerTransport: "websocket",
    commandEnvironment: "local_or_remote", remoteDisconnectBehavior: "local_fallback", brokerCanExecuteModelCommands: true,
    executorCanReadCredentialStore: "readable", executorCanReadBrokerLedger: "unknown", executorProviderEgress: "allowed",
    brokerProviderEgress: "unrestricted", providerCallsMediatedByLedger: false,
    allowedClientMethods: [...CODEX_ISOLATED_CLIENT_METHODS_V1, "process/spawn"], experimentalSeamAcknowledged: false,
  });
  assert.deepEqual(evaluateCodexIsolatedTopologyV1(unsafe).reasons, [
    "identity_not_separated", "environment_invalid", "binary_drift", "transport_not_parent_owned",
    "remote_execution_not_exclusive", "remote_disconnect_fallback", "broker_command_execution_enabled",
    "credential_store_exposed", "broker_ledger_exposed", "executor_provider_egress", "broker_egress_overbroad",
    "ledger_bypass", "client_method_overbroad", "experimental_seam_unacknowledged",
  ]);
  assert.deepEqual(evaluateCodexIsolatedTopologyV1({ ...isolatedTopology(), attestationDigest: `sha256:${"9".repeat(64)}` }).reasons, ["attestation_digest_invalid"]);
});

function isolatedLauncherConfig(overrides: Partial<CodexMacIsolatedLauncherConfigV1> = {}): CodexMacIsolatedLauncherConfigV1 {
  return {
    nodeRuntime: "/runtime/node",
    brokerControllerScript: "/release/broker/codex-broker-controller.js",
    brokerConfigPath: "/broker-config/config.json",
    brokerConfigRoot: "/broker-config",
    brokerReleaseRoot: "/release/broker",
    brokerCodexHome: "/broker/credentials",
    brokerStateRoot: "/broker/state",
    brokerLedgerPath: "/broker/state/ledger.sqlite",
    executorCodexHome: "/executor/home",
    executorWorkingDirectory: "/executor/work",
    workspacePath: "/executor/work/repo",
    executorEndpoint: "ws://127.0.0.1:45451",
    environmentId: "environment:codex:one",
    brokerIdentityDigest: `sha256:${"1".repeat(64)}`,
    executorIdentityDigest: `sha256:${"2".repeat(64)}`,
    ...overrides,
  };
}

test("CR7B macOS launcher plans parent-owned stdio and one credential-free loopback executor", () => {
  const config = isolatedLauncherConfig();
  const plan = planCodexMacIsolatedLauncherV1(config);
  assert.deepEqual(plan.appServerChild, {
    executable: CODEX_PINNED_EXECUTABLE_V1,
    args: ["app-server", "--stdio", "--strict-config"],
    cwd: config.brokerReleaseRoot,
    env: { CODEX_HOME: config.brokerCodexHome },
  });
  assert.deepEqual(plan.remoteExecutor, {
    executable: CODEX_PINNED_EXECUTABLE_V1,
    args: ["exec-server", "--strict-config", "--concurrent-requests", "1", "--listen", config.executorEndpoint],
    cwd: config.executorWorkingDirectory,
    env: { CODEX_HOME: config.executorCodexHome },
  });
  assert.deepEqual(plan.environmentAdd, { method: "environment/add", params: {
    environmentId: config.environmentId, execServerUrl: config.executorEndpoint, connectTimeoutMs: 5_000,
  } });
  assert.deepEqual(plan.environmentStatus, { method: "environment/status", params: { environmentId: config.environmentId } });
  assert.deepEqual(plan.threadEnvironment, { environmentId: config.environmentId, cwd: config.workspacePath, runtimeWorkspaceRoots: [config.workspacePath] });
  assert.deepEqual(plan.allowedClientMethods, CODEX_ISOLATED_CLIENT_METHODS_V1);
  for (const forbidden of ["process/spawn", "command/exec", "config/write", "mcpServer/start", "plugin/install"])
    assert.equal(plan.allowedClientMethods.includes(forbidden as never), false);
  const safeSummary = JSON.stringify(plan.summary);
  for (const raw of [config.brokerCodexHome, config.brokerStateRoot, config.executorCodexHome, config.environmentId, config.executorEndpoint])
    assert.equal(safeSummary.includes(raw), false, raw);
});

test("CR7B macOS launcher rejects identity reuse, non-loopback execution, and ownership overlap", () => {
  assert.throws(() => planCodexMacIsolatedLauncherV1(isolatedLauncherConfig({ executorEndpoint: "ws://0.0.0.0:45451" })), /endpoint invalid/);
  assert.throws(() => planCodexMacIsolatedLauncherV1(isolatedLauncherConfig({ executorEndpoint: "ws://127.0.0.1:80" })), /endpoint invalid/);
  assert.throws(() => planCodexMacIsolatedLauncherV1(isolatedLauncherConfig({ executorIdentityDigest: `sha256:${"1".repeat(64)}` })), /identity invalid/);
  assert.throws(() => planCodexMacIsolatedLauncherV1(isolatedLauncherConfig({ brokerStateRoot: "/broker/credentials/state", brokerLedgerPath: "/broker/credentials/state/ledger.sqlite" })), /roots overlap/);
  assert.throws(() => planCodexMacIsolatedLauncherV1(isolatedLauncherConfig({ brokerLedgerPath: "/broker/credentials/ledger.sqlite" })), /roots overlap/);
  assert.throws(() => planCodexMacIsolatedLauncherV1(isolatedLauncherConfig({ brokerConfigPath: "/executor/work/config.json" })), /roots overlap/);
  assert.throws(() => planCodexMacIsolatedLauncherV1(isolatedLauncherConfig({ brokerReleaseRoot: "/executor/work/release", brokerControllerScript: "/executor/work/release/controller.js" })), /roots overlap/);
  assert.throws(() => planCodexMacIsolatedLauncherV1(isolatedLauncherConfig({ executorCodexHome: "/executor/work/repo/home" })), /roots overlap/);
});

function inertPinnedPort(spec: CodexPinnedAppServerSpawnSpecV1, overrides: Partial<{ pid: number; spawnSpecDigest: string; state: "running" | "exited" }> = {}): CodexAppServerChildPortV1 & { pid: number; spawnSpecDigest: string; state: "running" | "exited"; closes: number; terminates: number } {
  return {
    pid: 4242, spawnSpecDigest: digestCodexPinnedAppServerSpawnSpecV1(spec), state: "running", closes: 0, terminates: 0, ...overrides,
    async writeStdin() {}, closeStdin() { this.closes += 1; }, terminate() { this.terminates += 1; }, discardStderr() {},
    onStdout() { return () => {}; }, onExit() { return () => {}; }, onError() { return () => {}; },
  };
}

test("CR7B pinned child factory passes only exact app-server process authority", () => {
  const launcher = planCodexMacIsolatedLauncherV1(isolatedLauncherConfig());
  let observed: CodexPinnedAppServerSpawnSpecV1 | undefined;
  const child = createCodexPinnedAppServerChildV1(launcher, { spawnPinnedAppServer(spec) { observed = spec; return inertPinnedPort(spec); } });
  assert.deepEqual(observed, {
    executable: CODEX_PINNED_EXECUTABLE_V1, args: ["app-server", "--stdio", "--strict-config"],
    cwd: "/release/broker", env: { CODEX_HOME: "/broker/credentials" }, shell: false, detached: false,
    stdio: ["pipe", "pipe", "ignore"],
  });
  assert.equal(Object.keys(observed?.env ?? {}).includes("PATH"), false);
  assert.deepEqual(child.identity, { pid: 4242, spawnSpecDigest: digestCodexPinnedAppServerSpawnSpecV1(observed!) });
});

test("CR7B pinned child factory rejects plan drift and kills identity-mismatched children", () => {
  const base = planCodexMacIsolatedLauncherV1(isolatedLauncherConfig());
  for (const appServerChild of [
    { ...base.appServerChild, executable: "/tmp/codex" },
    { ...base.appServerChild, args: ["app-server", "--stdio"] },
    { ...base.appServerChild, args: [...base.appServerChild.args, "--dangerously-bypass-approvals-and-sandbox"] },
    { ...base.appServerChild, cwd: "relative" },
    { ...base.appServerChild, env: { ...base.appServerChild.env, PATH: "/job/bin" } },
  ]) assert.throws(() => createCodexPinnedAppServerChildV1({ ...base, appServerChild }, { spawnPinnedAppServer() { assert.fail("invalid plan spawned"); } }), /plan invalid/);

  for (const overrides of [{ pid: 0 }, { spawnSpecDigest: `sha256:${"0".repeat(64)}` }, { state: "exited" as const }]) {
    let port: ReturnType<typeof inertPinnedPort> | undefined;
    assert.throws(() => createCodexPinnedAppServerChildV1(base, { spawnPinnedAppServer(spec) { port = inertPinnedPort(spec, overrides); return port; } }), /identity invalid/);
    assert.equal(port?.closes, 1);
    assert.equal(port?.terminates, 1);
  }
});

test("CR7B macOS isolated service templates pass static safety conformance", async () => {
  const result = await verifyCodexMacIsolatedPackagesV1();
  assert.deepEqual(result.map((entry) => entry.file), [
    "broker/com.control-room.codex-broker.plist.template",
    "executor/com.control-room.codex-executor.plist.template",
  ]);
  assert.ok(result.every((entry) => entry.checks.length >= 6));
  assert.equal(JSON.stringify(result).includes("/Users/"), false);
});

test("CR7B isolated controller pins every start and turn to the remote read-only environment", () => {
  const launcher = planCodexMacIsolatedLauncherV1(isolatedLauncherConfig());
  const permit = credentialPermit("run:controller");
  const ledger = new InMemoryCodexCredentialBrokerLedgerV1(`sha256:${"5".repeat(64)}`);
  ledger.provision({ permit, limits: { maximumInputBytes: 1024, maximumOutputTokens: 1024 }, now: "2026-08-27T23:00:00.000Z" });
  const controller = new CodexMacIsolatedControllerV1(launcher, ledger);
  const request = brokerRequest(permit, { requestId: "request:controller:1", input: "private isolated prompt" });
  assert.deepEqual(controller.planInitialize(), {
    method: "initialize",
    params: {
      clientInfo: { name: "control-room", title: null, version: "1.0.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    },
  });
  assert.deepEqual(controller.planInitialized(), { method: "initialized", params: {} });
  assert.deepEqual(controller.planEnvironmentRegistration(), launcher.environmentAdd);
  assert.deepEqual(controller.planEnvironmentStatus(), launcher.environmentStatus);
  const thread = controller.planThreadBoundary(request);
  assert.equal(thread.method, "thread/start");
  assert.deepEqual(thread.params, {
    model: "gpt-5.6-sol", cwd: "/executor/work/repo", runtimeWorkspaceRoots: ["/executor/work/repo"],
    approvalPolicy: "never", sandbox: "read-only", ephemeral: true, environments: [launcher.threadEnvironment],
    dynamicTools: [], selectedCapabilityRoots: [], experimentalRawEvents: false,
  });
  const turn = controller.claimAndPlanTurn({ request, nativeThreadId: "thread:controller:one", environmentStatus: "ready", now: "2026-08-27T23:00:01.000Z" });
  assert.equal(turn.disposition, "dispatch_once");
  assert.deepEqual(turn.request, { method: "turn/start", params: {
    threadId: "thread:controller:one", input: [{ type: "text", text: "private isolated prompt", text_elements: [] }],
    environments: [launcher.threadEnvironment], cwd: "/executor/work/repo", runtimeWorkspaceRoots: ["/executor/work/repo"],
    approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false }, model: "gpt-5.6-sol",
  } });
  assert.equal(controller.claimAndPlanTurn({ request, nativeThreadId: "thread:controller:one", environmentStatus: "ready", now: "2026-08-27T23:00:02.000Z" }).disposition, "in_progress");
  assert.deepEqual(controller.planInterrupt("thread:controller:one", "turn:controller:one"), {
    method: "turn/interrupt", params: { threadId: "thread:controller:one", turnId: "turn:controller:one" },
  });
});

test("CR7B isolated controller refuses offline, local, replay-conflicting, and cross-thread dispatch", () => {
  const launcher = planCodexMacIsolatedLauncherV1(isolatedLauncherConfig());
  const permit = credentialPermit("run:controller-deny");
  const ledger = new InMemoryCodexCredentialBrokerLedgerV1(`sha256:${"5".repeat(64)}`);
  ledger.provision({ permit, limits: { maximumInputBytes: 1024, maximumOutputTokens: 1024 }, now: "2026-08-27T23:00:00.000Z" });
  const controller = new CodexMacIsolatedControllerV1(launcher, ledger);
  const start = brokerRequest(permit, { requestId: "request:controller:deny" });
  for (const status of ["pending", "disconnected", "unknown"] as const)
    assert.throws(() => controller.claimAndPlanTurn({ request: start, nativeThreadId: "thread:deny:one", environmentStatus: status, now: "2026-08-27T23:00:01.000Z" }), /not ready/);
  assert.equal(ledger.evidence(permit.permitDigest).consumedProviderCalls, 0);
  for (const method of ["process/spawn", "config/write", "plugin/install", "mcpServer/start"])
    assert.throws(() => controller.assertClientMethod(method), /method forbidden/);
  controller.assertClientMethod("environment/status");
  const resume = brokerRequest(permit, { requestId: "request:controller:resume", operation: "resume", nativeThreadId: "thread:resume:one" });
  assert.equal(controller.planThreadBoundary(resume).method, "thread/resume");
  assert.throws(() => controller.claimAndPlanTurn({ request: resume, nativeThreadId: "thread:resume:other", environmentStatus: "ready", now: "2026-08-27T23:00:01.000Z" }), /thread mismatch/);
  assert.equal(ledger.evidence(permit.permitDigest).consumedProviderCalls, 0);
  assert.throws(() => controller.planInterrupt("x", "turn:valid:one"), /identity invalid/);
});

function initializedJsonlSession(): CodexAppServerJsonlSessionV1 {
  const session = new CodexAppServerJsonlSessionV1();
  const initialize = session.request("initialize", { clientInfo: { name: "control-room", title: null, version: "1.0.0" } });
  assert.equal(initialize.id, 1);
  assert.deepEqual(session.receive('{"id":1,"result":{"userAgent":"pinned"}}'), {
    kind: "response", id: 1, method: "initialize", ok: true, result: { userAgent: "pinned" },
  });
  assert.equal(session.notification("initialized", {}), '{"method":"initialized","params":{}}\n');
  return session;
}

test("CR7B app-server JSONL session enforces handshake, correlation, framing, and safe errors", () => {
  const session = new CodexAppServerJsonlSessionV1();
  assert.throws(() => session.request("thread/start", {}), /not initialized/);
  const initialize = session.request("initialize", { clientInfo: { name: "control-room", title: null, version: "1.0.0" } });
  assert.equal(initialize.line, '{"method":"initialize","id":1,"params":{"clientInfo":{"name":"control-room","title":null,"version":"1.0.0"}}}\n');
  assert.throws(() => session.notification("initialized", {}), /notification order/);
  session.receive('{"id":1,"result":{"userAgent":"pinned"}}');
  session.notification("initialized", {});
  assert.throws(() => session.request("initialized", {}), /notification method/);
  assert.throws(() => session.request("process/spawn", {}), /method forbidden/);
  const status = session.request("environment/status", { environmentId: "environment:one" });
  assert.equal(status.id, 2);
  assert.deepEqual(session.receive('{"id":2,"result":{"status":"ready"}}'), {
    kind: "response", id: 2, method: "environment/status", ok: true, result: { status: "ready" },
  });
  assert.deepEqual(session.receive('{"method":"turn/started","params":{"private":"discard downstream"}}'), {
    kind: "notification", method: "turn/started", params: { private: "discard downstream" },
  });
  const failed = session.request("environment/status", { environmentId: "environment:one" });
  const safeError = session.receive(`{"id":${failed.id},"error":{"code":500,"message":"private provider failure"}}`);
  assert.deepEqual(safeError, { kind: "response", id: failed.id, method: "environment/status", ok: false, safeErrorCode: "app_server_error" });
  assert.equal(JSON.stringify(safeError).includes("private provider failure"), false);
  const rejectedInitialize = new CodexAppServerJsonlSessionV1();
  rejectedInitialize.request("initialize", {});
  assert.deepEqual(rejectedInitialize.receive('{"id":1,"error":{"code":500,"message":"private auth failure"}}'), {
    kind: "response", id: 1, method: "initialize", ok: false, safeErrorCode: "app_server_error",
  });
  assert.throws(() => rejectedInitialize.notification("initialized", {}), /notification order|session closed/);
});

test("CR7B app-server JSONL session rejects malformed, oversized, unsolicited, and server-initiated traffic", () => {
  const session = initializedJsonlSession();
  assert.throws(() => session.receive("not-json"), /JSON invalid/);
  assert.throws(() => session.receive('{"jsonrpc":"2.0","method":"turn/started","params":{}}'), /message invalid/);
  assert.throws(() => session.receive('{"id":99,"result":{}}'), /correlation invalid/);
  assert.throws(() => session.receive('{"id":1,"result":{},"error":{"code":1,"message":"x"}}'), /correlation invalid|shape invalid/);
  assert.throws(() => session.receive(`${"x".repeat(262_145)}`), /frame invalid/);
  const forbidden = session.receive('{"id":"approval:private","method":"item/commandExecution/requestApproval","params":{"command":"private"}}');
  assert.equal(forbidden.kind, "server_request_forbidden");
  assert.equal(JSON.stringify(forbidden).includes("approval:private"), false);
  assert.equal(JSON.stringify(forbidden).includes("commandExecution"), false);
  const pending = Array.from({ length: CODEX_APP_SERVER_MAX_PENDING_REQUESTS_V1 }, () => session.request("environment/status", { environmentId: "environment:one" }));
  assert.equal(pending.length, 16);
  assert.throws(() => session.request("environment/status", { environmentId: "environment:one" }), /pending request limit/);
  const disconnected = session.disconnect();
  assert.equal(disconnected.pendingRequestCount, 16);
  assert.equal(disconnected.pendingMethodDigests.length, 16);
  assert.equal(JSON.stringify(disconnected).includes("environment/status"), false);
  assert.throws(() => session.receive('{"method":"turn/started","params":{}}'), /session closed/);
});

function claimedObserver(input: {
  ledger: InMemoryCodexCredentialBrokerLedgerV1;
  permit: CodexCredentialBoundaryPermitV1;
  requestId: string;
}): { observer: CodexIsolatedTurnObserverV1; request: CodexBrokerCallRequestV1 } {
  const request = brokerRequest(input.permit, { requestId: input.requestId });
  const claimed = input.ledger.claim(request, "2026-08-27T23:00:01.000Z");
  assert.equal(claimed.disposition, "dispatch_once");
  assert.ok(claimed.ticket);
  return { observer: new CodexIsolatedTurnObserverV1("thread:observer:one", claimed.ticket, input.ledger), request };
}

test("CR7B turn observer settles one completed call from scoped terminal and last-turn usage only", () => {
  const permit = credentialPermit("run:observer");
  const ledger = new InMemoryCodexCredentialBrokerLedgerV1(`sha256:${"5".repeat(64)}`);
  ledger.provision({ permit, limits: { maximumInputBytes: 1024, maximumOutputTokens: 1024 }, now: "2026-08-27T23:00:00.000Z" });
  const { observer, request } = claimedObserver({ ledger, permit, requestId: "request:observer:complete" });
  assert.deepEqual(observer.observe({ method: "turn/started", params: { threadId: "thread:observer:one", turn: { id: "turn:observer:one", status: "inProgress", items: [] } } }),
    { category: "lifecycle", state: "started" });
  assert.deepEqual(observer.observe({ method: "thread/tokenUsage/updated", params: {
    threadId: "thread:observer:one", turnId: "turn:observer:one",
    tokenUsage: { total: { inputTokens: 9999 }, last: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4, reasoningOutputTokens: 1 } },
  } }), { category: "usage", usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4, reasoningTokens: 1 } });
  assert.throws(() => observer.observe({ method: "thread/tokenUsage/updated", params: {
    threadId: "thread:observer:one", turnId: "turn:observer:one",
    tokenUsage: { last: { inputTokens: 11, outputTokens: 3, cachedInputTokens: 4, reasoningOutputTokens: 1 } },
  } }), /usage regressed/);
  assert.deepEqual(observer.observe({ method: "item/agentMessage/delta", params: { private: "discard me" } }).category, "ignored");
  assert.deepEqual(observer.observe({ method: "turn/completed", params: {
    threadId: "thread:observer:one", turn: { id: "turn:observer:one", status: "completed", items: [{ private: "discard me" }] },
  } }), { category: "lifecycle", state: "completed" });
  assert.deepEqual(ledger.claim(request, "2026-08-27T23:00:02.000Z"), {
    disposition: "replay_completed", usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4, reasoningTokens: 1 },
  });
  assert.equal(observer.disconnect(), undefined);
  assert.throws(() => observer.observe({ method: "turn/completed", params: {} }), /already terminal/);
});

test("CR7B turn observer converts failure, interruption, malformed scope, and disconnect to safe terminal truth", () => {
  const permit = credentialPermit("run:observer-negative");
  const ledger = new InMemoryCodexCredentialBrokerLedgerV1(`sha256:${"5".repeat(64)}`);
  ledger.provision({ permit, limits: { maximumInputBytes: 1024, maximumOutputTokens: 1024 }, now: "2026-08-27T23:00:00.000Z" });
  const failed = claimedObserver({ ledger, permit, requestId: "request:observer:failed" });
  failed.observer.observe({ method: "turn/started", params: { threadId: "thread:observer:one", turn: { id: "turn:observer:failed", status: "inProgress" } } });
  assert.throws(() => failed.observer.observe({ method: "thread/tokenUsage/updated", params: { threadId: "thread:other", turnId: "turn:observer:failed" } }), /usage scope/);
  assert.deepEqual(failed.observer.observe({ method: "turn/completed", params: {
    threadId: "thread:observer:one", turn: { id: "turn:observer:failed", status: "failed", error: { message: "private failure" } },
  } }), { category: "lifecycle", state: "failed" });
  assert.deepEqual(ledger.claim(failed.request, "2026-08-27T23:00:02.000Z"), { disposition: "replay_failed", safeResultCode: "codex_turn_failed" });

  const disconnected = claimedObserver({ ledger, permit, requestId: "request:observer:disconnect" });
  assert.deepEqual(disconnected.observer.disconnect(), { category: "lifecycle", state: "ambiguous" });
  assert.deepEqual(ledger.claim(disconnected.request, "2026-08-27T23:00:02.000Z"), { disposition: "ambiguous", safeResultCode: "app_server_disconnected" });

  const interrupted = claimedObserver({ ledger, permit, requestId: "request:observer:interrupt" });
  interrupted.observer.observe({ method: "turn/started", params: { threadId: "thread:observer:one", turn: { id: "turn:observer:interrupt", status: "inProgress" } } });
  assert.deepEqual(interrupted.observer.observe({ method: "turn/completed", params: {
    threadId: "thread:observer:one", turn: { id: "turn:observer:interrupt", status: "interrupted" },
  } }), { category: "lifecycle", state: "interrupted" });
  assert.deepEqual(ledger.claim(interrupted.request, "2026-08-27T23:00:02.000Z"), { disposition: "replay_failed", safeResultCode: "codex_turn_interrupted" });
});

class FakeAppServerChild {
  readonly writes: string[] = [];
  closeStdinCalls = 0;
  terminateCalls = 0;
  discardStderrCalls = 0;
  private readonly stdoutListeners = new Set<(chunk: Uint8Array) => void>();
  private readonly exitListeners = new Set<() => void>();
  private readonly errorListeners = new Set<() => void>();

  async writeStdin(data: string): Promise<void> { this.writes.push(data); }
  closeStdin(): void { this.closeStdinCalls += 1; }
  terminate(): void { this.terminateCalls += 1; }
  discardStderr(): void { this.discardStderrCalls += 1; }
  onStdout(listener: (chunk: Uint8Array) => void): () => void { this.stdoutListeners.add(listener); return () => this.stdoutListeners.delete(listener); }
  onExit(listener: () => void): () => void { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }
  onError(listener: () => void): () => void { this.errorListeners.add(listener); return () => this.errorListeners.delete(listener); }
  stdout(text: string): void { this.stdoutBytes(new TextEncoder().encode(text)); }
  stdoutBytes(bytes: Uint8Array): void { for (const listener of this.stdoutListeners) listener(bytes); }
  exit(): void { for (const listener of this.exitListeners) listener(); }
  error(): void { for (const listener of this.errorListeners) listener(); }
}

test("CR7B child transport reassembles fragmented UTF-8 and drains multiple bounded JSONL frames", async () => {
  const child = new FakeAppServerChild();
  const transport = new CodexAppServerChildLineTransportV1(child);
  assert.equal(child.discardStderrCalls, 1);
  const first = transport.readLine();
  const encoded = new TextEncoder().encode('{"value":"café"}\n{"id":2}\n');
  const split = encoded.indexOf(0xc3) + 1;
  child.stdoutBytes(encoded.slice(0, split));
  child.stdoutBytes(encoded.slice(split));
  assert.equal(await first, '{"value":"café"}');
  assert.equal(await transport.readLine(), '{"id":2}');
  await transport.write('{"method":"initialized","params":{}}\n');
  assert.deepEqual(child.writes, ['{"method":"initialized","params":{}}\n']);
  await transport.close();
  await transport.close();
  assert.equal(child.closeStdinCalls, 1);
  assert.equal(child.terminateCalls, 1);
  assert.equal(await transport.readLine(), null);
});

test("CR7B child transport rejects partial exit, oversized frames, queue floods, and concurrent reads", async () => {
  const partialChild = new FakeAppServerChild();
  const partial = new CodexAppServerChildLineTransportV1(partialChild, 1_024);
  const partialRead = partial.readLine();
  partialChild.stdout('{"partial":true}');
  partialChild.exit();
  await assert.rejects(partialRead, /framing failed/);
  await partial.close();
  assert.equal(partialChild.terminateCalls, 0);

  const oversizedChild = new FakeAppServerChild();
  const oversized = new CodexAppServerChildLineTransportV1(oversizedChild, 1_024);
  oversizedChild.stdout("x".repeat(1_025));
  await assert.rejects(oversized.readLine(), /framing failed/);
  await oversized.close();

  const floodedChild = new FakeAppServerChild();
  const flooded = new CodexAppServerChildLineTransportV1(floodedChild);
  floodedChild.stdout(Array.from({ length: CODEX_APP_SERVER_MAX_QUEUED_LINES_V1 + 1 }, () => "{}").join("\n") + "\n");
  await assert.rejects(flooded.readLine(), /framing failed/);
  await flooded.close();

  const waitingChild = new FakeAppServerChild();
  const waiting = new CodexAppServerChildLineTransportV1(waitingChild);
  const pending = waiting.readLine();
  await assert.rejects(waiting.readLine(), /concurrent read/);
  waitingChild.error();
  await assert.rejects(pending, /framing failed/);
  await waiting.close();
});

class ScriptedAppServerTransport {
  readonly writes: string[] = [];
  readonly reads: string[] = [];
  closed = false;

  constructor(private readonly options: {
    environmentStatus?: "ready" | "pending" | "disconnected" | "unknown";
    turnMode?: "completed" | "server_request" | "missing_usage" | "disconnect" | "block";
  } = {}) {}

  private blockedRead?: (value: null) => void;

  async write(line: string): Promise<void> {
    this.writes.push(line);
    const message = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
    if (message.method === "initialized") return;
    if (message.method === "initialize") this.reads.push(JSON.stringify({ id: message.id, result: { userAgent: "pinned" } }));
    else if (message.method === "environment/add") this.reads.push(JSON.stringify({ id: message.id, result: {} }));
    else if (message.method === "environment/status") this.reads.push(JSON.stringify({ id: message.id, result: { status: this.options.environmentStatus ?? "ready" } }));
    else if (message.method === "thread/start" || message.method === "thread/resume") {
      const requested = message.method === "thread/resume" ? message.params?.threadId : undefined;
      this.reads.push(JSON.stringify({ id: message.id, result: { thread: { id: requested ?? "thread:runtime:one" } } }));
    } else if (message.method === "turn/start") {
      const mode = this.options.turnMode ?? "completed";
      if (mode === "server_request") {
        this.reads.push(JSON.stringify({ id: "approval:private", method: "item/commandExecution/requestApproval", params: { command: "private command" } }));
        return;
      }
      this.reads.push(JSON.stringify({ id: message.id, result: { turn: { id: "turn:runtime:one", status: "inProgress" } } }));
      this.reads.push(JSON.stringify({ method: "turn/started", params: { threadId: "thread:runtime:one", turn: { id: "turn:runtime:one", status: "inProgress" } } }));
      if (mode !== "missing_usage") this.reads.push(JSON.stringify({ method: "thread/tokenUsage/updated", params: {
        threadId: "thread:runtime:one", turnId: "turn:runtime:one",
        tokenUsage: { last: { inputTokens: 20, outputTokens: 4, cachedInputTokens: 8, reasoningOutputTokens: 2 } },
      } }));
      if (mode !== "disconnect" && mode !== "block") this.reads.push(JSON.stringify({ method: "turn/completed", params: {
        threadId: "thread:runtime:one", turn: { id: "turn:runtime:one", status: "completed", items: [{ private: "discard" }] },
      } }));
    }
  }

  async readLine(): Promise<string | null> {
    const line = this.reads.shift();
    if (line !== undefined) return line;
    if (this.options.turnMode !== "block") return null;
    return await new Promise<null>((resolve) => { this.blockedRead = resolve; });
  }
  async close(): Promise<void> { this.closed = true; this.blockedRead?.(null); this.blockedRead = undefined; }
}

test("CR7B qualification runtime completes one fake-transport turn and returns sanitized evidence", async () => {
  const permit = credentialPermit("run:runtime");
  const ledger = new InMemoryCodexCredentialBrokerLedgerV1(`sha256:${"5".repeat(64)}`);
  ledger.provision({ permit, limits: { maximumInputBytes: 1024, maximumOutputTokens: 1024 }, now: "2026-08-27T23:00:00.000Z" });
  const transport = new ScriptedAppServerTransport();
  const runtime = new CodexIsolatedQualificationRuntimeV1(planCodexMacIsolatedLauncherV1(isolatedLauncherConfig()), ledger, transport);
  const request = brokerRequest(permit, { requestId: "request:runtime:complete", input: "private runtime prompt" });
  const result = await runtime.execute(request, "2026-08-27T23:00:01.000Z");
  assert.equal(result.disposition, "completed");
  assert.equal(result.nodeLocalNativeThreadId, "thread:runtime:one");
  assert.match(result.nativeThreadIdDigest ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.events, [
    { category: "lifecycle", state: "started" },
    { category: "usage", usage: { inputTokens: 20, outputTokens: 4, cachedInputTokens: 8, reasoningTokens: 2 } },
    { category: "lifecycle", state: "completed" },
  ]);
  assert.equal(JSON.stringify(result.events).includes("private"), false);
  assert.equal(transport.closed, true);
  assert.deepEqual(ledger.claim(request, "2026-08-27T23:00:02.000Z"), {
    disposition: "replay_completed", usage: { inputTokens: 20, outputTokens: 4, cachedInputTokens: 8, reasoningTokens: 2 },
  });
  const methods = transport.writes.map((line) => (JSON.parse(line) as { method: string }).method);
  assert.deepEqual(methods, ["initialize", "initialized", "environment/add", "environment/status", "thread/start", "turn/start"]);
});

test("CR7B qualification runtime spends no call when the remote executor is not ready", async () => {
  const permit = credentialPermit("run:runtime-offline");
  const ledger = new InMemoryCodexCredentialBrokerLedgerV1(`sha256:${"5".repeat(64)}`);
  ledger.provision({ permit, limits: { maximumInputBytes: 1024, maximumOutputTokens: 1024 }, now: "2026-08-27T23:00:00.000Z" });
  const transport = new ScriptedAppServerTransport({ environmentStatus: "disconnected" });
  const runtime = new CodexIsolatedQualificationRuntimeV1(planCodexMacIsolatedLauncherV1(isolatedLauncherConfig()), ledger, transport);
  await assert.rejects(runtime.execute(brokerRequest(permit, { requestId: "request:runtime:offline" }), "2026-08-27T23:00:01.000Z"),
    (error) => error instanceof CodexAppServerRuntimeErrorV1 && error.safeCode === "remote_environment_not_ready");
  assert.equal(ledger.evidence(permit.permitDigest).consumedProviderCalls, 0);
  assert.equal(transport.writes.some((line) => line.includes("turn/start")), false);
  assert.equal(transport.closed, true);
});

test("CR7B qualification runtime makes forbidden requests, missing usage, and disconnect terminally ambiguous", async () => {
  for (const [mode, safeCode] of [
    ["server_request", "app_server_server_request_forbidden"],
    ["missing_usage", "app_server_protocol_invalid"],
    ["disconnect", "app_server_disconnected"],
  ] as const) {
    const permit = credentialPermit(`run:runtime-${mode}`);
    const ledger = new InMemoryCodexCredentialBrokerLedgerV1(`sha256:${"5".repeat(64)}`);
    ledger.provision({ permit, limits: { maximumInputBytes: 1024, maximumOutputTokens: 1024 }, now: "2026-08-27T23:00:00.000Z" });
    const transport = new ScriptedAppServerTransport({ turnMode: mode });
    const runtime = new CodexIsolatedQualificationRuntimeV1(planCodexMacIsolatedLauncherV1(isolatedLauncherConfig()), ledger, transport);
    const request = brokerRequest(permit, { requestId: `request:runtime:${mode}` });
    await assert.rejects(runtime.execute(request, "2026-08-27T23:00:01.000Z"),
      (error) => error instanceof CodexAppServerRuntimeErrorV1 && error.safeCode === safeCode);
    assert.deepEqual(ledger.claim(request, "2026-08-27T23:00:02.000Z"), {
      disposition: "ambiguous", safeResultCode: mode === "disconnect" ? "app_server_disconnected" : "app_server_protocol_invalid",
    });
    assert.equal(transport.closed, true);
  }
});

test("CR7B qualification runtime enforces deadline and cancellation before or after call claim", async () => {
  const deadlinePermit = credentialPermit("run:runtime-deadline");
  const deadlineLedger = new InMemoryCodexCredentialBrokerLedgerV1(`sha256:${"5".repeat(64)}`);
  deadlineLedger.provision({ permit: deadlinePermit, limits: { maximumInputBytes: 1024, maximumOutputTokens: 1024 }, now: "2026-08-27T23:00:00.000Z" });
  const deadlineTransport = new ScriptedAppServerTransport({ turnMode: "block" });
  const deadlineRuntime = new CodexIsolatedQualificationRuntimeV1(planCodexMacIsolatedLauncherV1(isolatedLauncherConfig()), deadlineLedger, deadlineTransport);
  const deadlineRequest = brokerRequest(deadlinePermit, { requestId: "request:runtime:deadline" });
  await assert.rejects(deadlineRuntime.execute(deadlineRequest, "2026-08-27T23:00:01.000Z", { timeoutMs: 5 }),
    (error) => error instanceof CodexAppServerRuntimeErrorV1 && error.safeCode === "app_server_deadline_exceeded");
  assert.deepEqual(deadlineLedger.claim(deadlineRequest, "2026-08-27T23:00:02.000Z"), {
    disposition: "ambiguous", safeResultCode: "app_server_deadline_exceeded",
  });

  const cancelPermit = credentialPermit("run:runtime-cancel");
  const cancelLedger = new InMemoryCodexCredentialBrokerLedgerV1(`sha256:${"5".repeat(64)}`);
  cancelLedger.provision({ permit: cancelPermit, limits: { maximumInputBytes: 1024, maximumOutputTokens: 1024 }, now: "2026-08-27T23:00:00.000Z" });
  const cancelTransport = new ScriptedAppServerTransport({ turnMode: "block" });
  const cancelRuntime = new CodexIsolatedQualificationRuntimeV1(planCodexMacIsolatedLauncherV1(isolatedLauncherConfig()), cancelLedger, cancelTransport);
  const cancelRequest = brokerRequest(cancelPermit, { requestId: "request:runtime:cancel" });
  const controller = new AbortController();
  const pending = cancelRuntime.execute(cancelRequest, "2026-08-27T23:00:01.000Z", { signal: controller.signal, timeoutMs: 1_000 });
  setTimeout(() => controller.abort("operator_cancelled"), 0);
  await assert.rejects(pending, (error) => error instanceof CodexAppServerRuntimeErrorV1 && error.safeCode === "app_server_cancelled");
  assert.deepEqual(cancelLedger.claim(cancelRequest, "2026-08-27T23:00:02.000Z"), {
    disposition: "ambiguous", safeResultCode: "app_server_cancelled",
  });
  assert.equal(cancelTransport.closed, true);
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
