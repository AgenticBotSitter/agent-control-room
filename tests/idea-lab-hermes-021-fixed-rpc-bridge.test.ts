import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sha256Digest } from "../src/security/index.ts";
import {
  createHostCancellationControllerV1,
  createHostResultCollectorV1,
  type HostCancellationSignalV1,
} from "../src/security/host-value.ts";
import {
  IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1,
  IDEA_LAB_HERMES_021_FIXED_OPERATION_SET_V1,
  IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1,
  IDEA_LAB_HERMES_021_REVISION_V1,
  IDEA_LAB_HERMES_021_VERSION_V1,
  IdeaLabErrorV1,
  IdeaLabHermes021FixedRpcBridgeV1,
  type IdeaLabHermes021ConnectorPrivateRpcV1,
  type IdeaLabHermes021FixedOperationV1,
  type IdeaLabHermes021NativeBridgeV1,
} from "../src/idea-lab/v1/index.ts";

const digest = (label: string) => sha256Digest({ label });
const routeDigest = digest("opaque-route"), leaseDigest = digest("route-lease");
const sessionDigest = digest("safe-session-identity"), epochDigest = digest("gateway-epoch");

function executeInput(): Parameters<IdeaLabHermes021NativeBridgeV1["executeFixedSession"]>[0] {
  return {
    connectionContractVersion: IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1,
    connectionId: "connection:johnny5-mac", transport: "ssh_tunnel", connectorRouteDigest: routeDigest,
    attemptId: "attempt:fixed-rpc-once", permitDigest: digest("permit"), markerDigest: digest("marker"),
    participantId: "participant:market", participantIdentityDigest: digest("participant"), round: 1,
    safeInstruction: "Return only the bounded JSON opinion.", runtimeIdentityDigest: digest("runtime"),
    profileIdentityDigest: digest("profile"), conversationIdentityDigest: digest("conversation"),
    maximumOutputCharacters: 800, toolsEnabled: false, mcpEnabled: false, pluginsEnabled: false,
    genericShellEnabled: false, signal: createHostCancellationControllerV1().signal,
  };
}

function cleanupInput(input = executeInput(), sessionIdentityDigest?: string):
Parameters<IdeaLabHermes021NativeBridgeV1["cleanupFixedSession"]>[0] {
  return { connectionId: input.connectionId, connectorRouteDigest: input.connectorRouteDigest,
    attemptId: input.attemptId, permitDigest: input.permitDigest, markerDigest: input.markerDigest,
    ...(sessionIdentityDigest ? { sessionIdentityDigest } : {}),
    signal: createHostCancellationControllerV1().signal };
}

function operationResult(operation: IdeaLabHermes021FixedOperationV1, changes: Record<string, unknown> = {}) {
  const base = { contractVersion: "control-room-hermes-021-fixed-operation-result/v1" as const,
    operation, sessionIdentityDigest: sessionDigest, epochDigest };
  switch (operation) {
    case "session.create": return { ...base, status: "created", conversationIdentityDigest: digest("conversation"),
      providerCalls: 0, ...changes };
    case "prompt.submit": return { ...base, status: "accepted", providerCalls: 1, ...changes };
    case "session.events.since": {
      const finalText = JSON.stringify({ safeOpinion: "A small, testable market opportunity.",
        opportunityCode: "market_opening", primaryRiskCode: "demand_uncertain",
        suggestedExperiment: "Interview five likely buyers.", confidencePercent: 73 });
      return { ...base, status: "replayed", truncated: false, latestSequence: 4, events: [
        { sequence: 1, type: "message.start" }, { sequence: 2, type: "message.delta" },
        { sequence: 3, type: "reasoning.delta" }, { sequence: 4, type: "message.complete", finalText },
      ], ...changes };
    }
    case "session.status": return { ...base, status: "settled", providerCalls: 1, ...changes };
    case "session.usage": return { ...base, status: "settled", inputUnits: 20, outputUnits: 10,
      reasoningUnits: 5, totalUnits: 35, calls: 1, costUsd: 0.02, ...changes };
    case "session.interrupt": return { ...base, status: "already_settled", providerCalls: 1, ...changes };
    case "session.close": return { ...base, status: "closed", providerCalls: 1, ...changes };
  }
}

function connector(options: { mutate?: (operation: IdeaLabHermes021FixedOperationV1,
  result: Record<string, unknown>) => unknown; failOpen?: boolean; proxyReplay?: boolean } = {}) {
  const calls: Array<{ kind: string; operation?: string; input: Record<string, unknown> }> = [];
  const value: IdeaLabHermes021ConnectorPrivateRpcV1 = {
    async openFixedRoute(input, collector) {
      calls.push({ kind: "open", input: { ...input, signal: "redacted" } });
      if (options.failOpen) throw new Error("opaque open uncertainty");
      collector.submit({ contractVersion: "control-room-hermes-021-fixed-route-open/v1",
        attemptId: input.attemptId, permitDigest: input.permitDigest,
        connectorRouteDigest: input.connectorRouteDigest, routeLeaseDigest: leaseDigest,
        runtimeVersion: IDEA_LAB_HERMES_021_VERSION_V1, runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
        sourceManifestDigest: IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1,
        profileIdentityDigest: input.profileIdentityDigest,
        conversationIdentityDigest: input.conversationIdentityDigest,
        endpointVisibility: "connector_private_loopback", nativeLocatorReturned: false,
        toolsDisabled: true, mcpDisabled: true, pluginsDisabled: true });
    },
    async requestFixedOperation(input, collector) {
      calls.push({ kind: "operation", operation: input.operation,
        input: { ...input, parameters: { ...input.parameters }, signal: "redacted" } });
      const base = operationResult(input.operation) as Record<string, unknown>;
      const result = options.mutate?.(input.operation, base) ?? base;
      if (options.proxyReplay && input.operation === "session.events.since") {
        collector.submit(new Proxy(base, { get() { throw new Error("must not run"); } })); return;
      }
      collector.submit(result);
    },
    async closeFixedRoute(input, collector) {
      calls.push({ kind: "close", input: { ...input, signal: "redacted" } });
      collector.submit({ contractVersion: "control-room-hermes-021-fixed-route-close/v1",
        attemptId: input.attemptId, permitDigest: input.permitDigest,
        connectorRouteDigest: input.connectorRouteDigest, nativeSessionClosed: true,
        routeLeaseReleased: true, disposableProfileRemoved: true, disposableWorkspaceRemoved: true,
        retainedNativeReferenceCount: 0 });
    },
  };
  return { value, calls };
}

test("CR12B-IDEA-110B runs only the fixed Hermes turn, discards deltas, and closes the enrolled route", async () => {
  const native = connector(), bridge = new IdeaLabHermes021FixedRpcBridgeV1(native.value), input = executeInput();
  const handoff = createHostResultCollectorV1();
  await bridge.executeFixedSession(input, handoff.collector);
  const result = handoff.take() as { frames: Array<Record<string, unknown>> };
  assert.deepEqual(native.calls.filter((item) => item.operation).map((item) => item.operation),
    ["session.create", "prompt.submit", "session.events.since", "session.status", "session.usage"]);
  assert.deepEqual(result.frames.map((frame) => frame.type),
    ["session.ready", "panel.result", "session.usage", "session.complete"]);
  const opened = native.calls.find((item) => item.kind === "open")?.input;
  assert.equal(opened?.connectionIdentityDigest, sha256Digest({
    contractVersion: "control-room-hermes-021-connection-identity/v1",
    connectionId: input.connectionId,
  }));
  assert.equal(Object.hasOwn(opened ?? {}, "connectionId"), false);
  assert.equal(JSON.stringify(result).includes("message.delta"), false);
  assert.equal(JSON.stringify(native.calls).match(/hostname|username|keyPath|nativeSessionId|authToken/g), null);

  const cleanup = createHostResultCollectorV1();
  await bridge.cleanupFixedSession(cleanupInput(input, sessionDigest), cleanup.collector);
  const cleanupResult = cleanup.take() as Record<string, unknown>;
  assert.deepEqual(native.calls.filter((item) => item.operation).slice(-3).map((item) => item.operation),
    ["session.interrupt", "session.status", "session.close"]);
  assert.deepEqual([native.calls.at(-1)?.kind, cleanupResult.outcome,
    cleanupResult.retainedNativeReferenceCount], ["close", "completed", 0]);
});

test("CR12B-IDEA-110D signs and executes only the exact seven fixed operations", () => {
  assert.deepEqual(IDEA_LAB_HERMES_021_FIXED_OPERATION_SET_V1, [
    "session.create", "prompt.submit", "session.events.since", "session.status", "session.usage",
    "session.interrupt", "session.close",
  ]);
  assert.equal(IDEA_LAB_HERMES_021_FIXED_OPERATION_SET_V1.includes("session.steer" as never), false);
  assert.equal(IDEA_LAB_HERMES_021_FIXED_OPERATION_SET_V1.includes("session.resume" as never), false);
});

test("CR12B-IDEA-110I rejects non-opaque bridge cancellation before lifecycle change or connector dispatch", async () => {
  const native = connector(), bridge = new IdeaLabHermes021FixedRpcBridgeV1(native.value), input = executeInput();
  const nativeSignal = new AbortController().signal as unknown as HostCancellationSignalV1;
  let traps = 0;
  await assert.rejects(() => bridge.executeFixedSession(new Proxy(input, {
    ownKeys() { traps += 1; return []; },
  }), createHostResultCollectorV1().collector),
  (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "invalid_input");
  await assert.rejects(() => bridge.executeFixedSession({ ...input, signal: nativeSignal },
    createHostResultCollectorV1().collector),
  (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "invalid_input");
  assert.deepEqual([traps, native.calls.length], [0, 0]);

  await bridge.executeFixedSession(input, createHostResultCollectorV1().collector);
  const callsBeforeCleanup = native.calls.length;
  await assert.rejects(() => bridge.cleanupFixedSession({ ...cleanupInput(input, sessionDigest), signal: nativeSignal },
    createHostResultCollectorV1().collector),
  (error) => error instanceof IdeaLabErrorV1 && error.safeCode === "invalid_input");
  assert.equal(native.calls.length, callsBeforeCleanup);
  await bridge.cleanupFixedSession(cleanupInput(input, sessionDigest), createHostResultCollectorV1().collector);
  assert.equal(native.calls.at(-1)?.kind, "close");
});

test("CR12B-IDEA-110D cleanup waits for in-flight execution and prevents every later operation", async () => {
  for (const blockedAt of ["open", "session.create"] as const) {
    const native = connector(), originalOpen = native.value.openFixedRoute.bind(native.value);
    const originalRequest = native.value.requestFixedOperation.bind(native.value);
    let release!: () => void, entered!: () => void, cleanupCompleted = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    native.value.openFixedRoute = async (input, collector) => {
      if (blockedAt === "open") { entered(); await gate; }
      await originalOpen(input, collector);
    };
    native.value.requestFixedOperation = async (input, collector) => {
      if (blockedAt === "session.create" && input.operation === blockedAt) { entered(); await gate; }
      await originalRequest(input, collector);
    };
    const bridge = new IdeaLabHermes021FixedRpcBridgeV1(native.value), input = executeInput();
    const execution = bridge.executeFixedSession(input, createHostResultCollectorV1().collector);
    await reached;
    const cleanupCollector = createHostResultCollectorV1();
    const cleanup = bridge.cleanupFixedSession(cleanupInput(input), cleanupCollector.collector)
      .then(() => { cleanupCompleted = true; });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(cleanupCompleted, false, `${blockedAt} cleanup reported completion before execution settled`);
    release();
    await assert.rejects(execution, (error) => error instanceof IdeaLabErrorV1);
    await cleanup;
    assert.equal((cleanupCollector.take() as Record<string, unknown>).outcome, "completed");
    assert.equal(native.calls.at(-1)?.kind, "close");
    assert.deepEqual(native.calls.filter((item) => item.operation).map((item) => item.operation),
      blockedAt === "open" ? [] : ["session.create", "session.interrupt", "session.status", "session.close"]);
  }
});

test("CR12B-IDEA-110B preserves a proven definite failure without returning native text", async () => {
  const native = connector({ mutate(operation, result) {
    return operation === "session.events.since" ? { ...result, latestSequence: 2,
      events: [{ sequence: 1, type: "message.start" },
        { sequence: 2, type: "error", safeCode: "provider_access_blocked" }] } : result;
  } }), bridge = new IdeaLabHermes021FixedRpcBridgeV1(native.value), handoff = createHostResultCollectorV1();
  await bridge.executeFixedSession(executeInput(), handoff.collector);
  const frames = (handoff.take() as { frames: Array<Record<string, unknown>> }).frames;
  assert.deepEqual([frames[1]?.type, (frames[1]?.payload as Record<string, unknown>).safeCode],
    ["panel.failed_definite", "provider_access_blocked"]);
});

test("CR12B-IDEA-110B rejects replay gaps, epoch drift, malformed output, and usage drift without retry", async () => {
  const mutations: Array<(operation: IdeaLabHermes021FixedOperationV1,
  result: Record<string, unknown>) => unknown> = [
    (operation, result) => operation === "session.events.since" ? { ...result, latestSequence: 4,
      events: [{ sequence: 1, type: "message.start" },
        { sequence: 4, type: "message.complete", finalText: "{}" }] } : result,
    (operation, result) => operation === "session.status" ? { ...result, epochDigest: digest("restarted") } : result,
    (operation, result) => operation === "session.events.since" ? { ...result, latestSequence: 2,
      events: [{ sequence: 1, type: "message.start" },
        { sequence: 2, type: "message.complete", finalText: "not-json" }] } : result,
    (operation, result) => operation === "session.usage" ? { ...result, totalUnits: 999 } : result,
  ];
  for (const mutate of mutations) {
    const native = connector({ mutate }), bridge = new IdeaLabHermes021FixedRpcBridgeV1(native.value);
    await assert.rejects(bridge.executeFixedSession(executeInput(), createHostResultCollectorV1().collector),
      (error) => error instanceof IdeaLabErrorV1);
    const counts = new Map<string, number>();
    for (const call of native.calls) if (call.operation) counts.set(call.operation, (counts.get(call.operation) ?? 0) + 1);
    assert.equal([...counts.values()].every((count) => count === 1), true);
  }
});

test("CR12B-IDEA-110B rejects extra native locator fields and Proxy handoffs without executing traps", async () => {
  let traps = 0;
  const locator = connector({ mutate(operation, result) {
    return operation === "session.create" ? { ...result, nativeSessionId: "must-not-cross" } : result;
  } });
  await assert.rejects(new IdeaLabHermes021FixedRpcBridgeV1(locator.value)
    .executeFixedSession(executeInput(), createHostResultCollectorV1().collector),
  (error) => error instanceof IdeaLabErrorV1);

  const proxied = connector();
  proxied.value.requestFixedOperation = async (input, collector) => {
    const result = operationResult(input.operation);
    collector.submit(new Proxy(result as object, { get() { traps += 1; throw new Error("trap"); } }));
  };
  const bridge = new IdeaLabHermes021FixedRpcBridgeV1(proxied.value);
  await assert.rejects(bridge.executeFixedSession(executeInput(), createHostResultCollectorV1().collector));
  assert.equal(traps, 0);
});

test("CR12B-IDEA-110B reconciles an uncertain route open through attempt-bound cleanup", async () => {
  const native = connector({ failOpen: true }), bridge = new IdeaLabHermes021FixedRpcBridgeV1(native.value), input = executeInput();
  await assert.rejects(bridge.executeFixedSession(input, createHostResultCollectorV1().collector));
  const handoff = createHostResultCollectorV1();
  await bridge.cleanupFixedSession(cleanupInput(input), handoff.collector);
  const result = handoff.take() as Record<string, unknown>;
  assert.deepEqual(native.calls.map((item) => item.kind), ["open", "close"]);
  assert.equal(result.retainedNativeReferenceCount, 0);
});

test("CR12B-IDEA-110B rejects cleanup identity drift and cannot execute or clean up twice", async () => {
  const native = connector(), bridge = new IdeaLabHermes021FixedRpcBridgeV1(native.value), input = executeInput();
  await bridge.executeFixedSession(input, createHostResultCollectorV1().collector);
  await assert.rejects(bridge.cleanupFixedSession(cleanupInput(input, digest("wrong-session")),
    createHostResultCollectorV1().collector));
  await bridge.cleanupFixedSession(cleanupInput(input, sessionDigest), createHostResultCollectorV1().collector);
  await assert.rejects(bridge.cleanupFixedSession(cleanupInput(input, sessionDigest),
    createHostResultCollectorV1().collector));
  await assert.rejects(bridge.executeFixedSession(input, createHostResultCollectorV1().collector));
});

test("CR12B-IDEA-110B bridge contains no process, SSH, filesystem, network, credential, or Hermes modification client", async () => {
  const source = await readFile("src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts", "utf8");
  for (const forbidden of ['from "node:child_process"', 'from "node:fs"', 'from "node:net"', "WebSocket",
    "fetch(", "spawn(", "execFile(", "process.env", "auth.json", "known_hosts", "privateKey", "nativeSessionId"])
    assert.equal(source.includes(forbidden), false, forbidden);
  assert.equal(source.includes("requestFixedOperation"), true);
  assert.equal(source.includes("session.close"), true);
});
