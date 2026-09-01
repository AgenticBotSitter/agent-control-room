import { z } from "zod";
import { sha256Digest } from "../../security";
import {
  createHostCancellationControllerV1,
  createHostResultCollectorV1,
  dataMethodV1,
  exactHostCancellationSignalV1,
  exactHostDataArrayV1,
  exactHostDataSnapshotV1,
  hostCancellationAbortedV1,
  isHostProxyV1,
  subscribeHostCancellationV1,
  type HostCancellationControllerV1,
  type HostCancellationSignalV1,
  type HostResultCollectorV1,
} from "../../security/host-value";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import { IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1 } from "./hermes-021-enrolled-connection";
import type { IdeaLabHermes021NativeBridgeV1 } from "./hermes-021-enrolled-gateway-port";
import type { IdeaLabHermes021FixedOperationV1 } from "./hermes-021-fixed-operation-set";
import {
  IDEA_LAB_HERMES_021_REVISION_V1,
  IDEA_LAB_HERMES_021_VERSION_V1,
} from "./hermes-021-panel-packet";
import { ideaCodeSchemaV1, ideaDigestSchemaV1, ideaIdSchemaV1, ideaTextSchemaV1 } from "./schemas";

export const IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1 =
  "control-room-hermes-021-fixed-rpc-bridge/v1" as const;
export const IDEA_LAB_HERMES_021_CONNECTION_IDENTITY_V1 =
  "control-room-hermes-021-connection-identity/v1" as const;

const nativeJsonParseV1 = JSON.parse, nativeNumberIsSafeIntegerV1 = Number.isSafeInteger;
const nativeObjectFreezeV1 = Object.freeze, nativePromiseV1 = Promise, nativeReflectApplyV1 = Reflect.apply;

export const IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_V1 = nativeObjectFreezeV1({
  runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
  files: nativeObjectFreezeV1([
    nativeObjectFreezeV1({ pathId: "desktop_json_rpc_gateway", sha256: "sha256:a18dbcffedae4772d082c38b3c58c2e59e74f2b4919ca99e45ad3492ebc4421b" }),
    nativeObjectFreezeV1({ pathId: "desktop_gateway_store", sha256: "sha256:b929060a9542b7271ef4c3a649752a499486cc34b54ddc6c6379e613278c8b89" }),
    nativeObjectFreezeV1({ pathId: "desktop_ssh_connection", sha256: "sha256:bde4d38d26dd1688b822189a118f69ad07a7ed8b3e058705b2f422ca40a4f304" }),
    nativeObjectFreezeV1({ pathId: "desktop_connection_registry", sha256: "sha256:1fd7ac3446a0fecb0e31189fe324eb8d8f0da376808c1a3749e757eeaec6f1cc" }),
    nativeObjectFreezeV1({ pathId: "gateway_session_methods", sha256: "sha256:c4c0b3355be3ecc7f7fdf8ebcbd46fb3f360f9dded5ca9908f96ed0ce7e561d0" }),
    nativeObjectFreezeV1({ pathId: "gateway_iso_certify", sha256: "sha256:d8919e69de6e02d03baecd819486ac6398d4b5a93c621d026e9589758e4c833b" }),
  ]),
});

export const IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1 =
  sha256Digest(IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_V1);

/**
 * Platform-owned adapter for an already enrolled Hermes Desktop route. The
 * adapter owns native session IDs and every local/SSH locator. Control Room
 * supplies only signed opaque digests and one fixed operation at a time.
 */
export interface IdeaLabHermes021ConnectorPrivateRpcV1 {
  openFixedRoute(input: Readonly<{
    contractVersion: typeof IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1;
    connectionIdentityDigest: string;
    transport: "local_loopback" | "ssh_tunnel";
    connectorRouteDigest: string;
    attemptId: string;
    permitDigest: string;
    profileIdentityDigest: string;
    conversationIdentityDigest: string;
    sourceManifestDigest: string;
    signal: HostCancellationSignalV1;
  }>, collector: HostResultCollectorV1): Promise<void>;
  requestFixedOperation(input: Readonly<{
    contractVersion: typeof IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1;
    connectorRouteDigest: string;
    routeLeaseDigest: string;
    attemptId: string;
    permitDigest: string;
    operation: IdeaLabHermes021FixedOperationV1;
    parameters: Readonly<Record<string, unknown>>;
    signal: HostCancellationSignalV1;
  }>, collector: HostResultCollectorV1): Promise<void>;
  closeFixedRoute(input: Readonly<{
    contractVersion: typeof IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1;
    connectorRouteDigest: string;
    routeLeaseDigest?: string;
    attemptId: string;
    permitDigest: string;
    signal: HostCancellationSignalV1;
  }>, collector: HostResultCollectorV1): Promise<void>;
}

const routeOpenSchema = z.object({
  contractVersion: z.literal("control-room-hermes-021-fixed-route-open/v1"),
  attemptId: ideaIdSchemaV1,
  permitDigest: ideaDigestSchemaV1,
  connectorRouteDigest: ideaDigestSchemaV1,
  routeLeaseDigest: ideaDigestSchemaV1,
  runtimeVersion: z.literal(IDEA_LAB_HERMES_021_VERSION_V1),
  runtimeRevision: z.literal(IDEA_LAB_HERMES_021_REVISION_V1),
  sourceManifestDigest: z.literal(IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1),
  profileIdentityDigest: ideaDigestSchemaV1,
  conversationIdentityDigest: ideaDigestSchemaV1,
  endpointVisibility: z.literal("connector_private_loopback"),
  nativeLocatorReturned: z.literal(false),
  toolsDisabled: z.literal(true),
  mcpDisabled: z.literal(true),
  pluginsDisabled: z.literal(true),
}).strict();

const operationBase = {
  contractVersion: z.literal("control-room-hermes-021-fixed-operation-result/v1"),
  sessionIdentityDigest: ideaDigestSchemaV1,
  epochDigest: ideaDigestSchemaV1,
} as const;

const createResultSchema = z.object({
  ...operationBase,
  operation: z.literal("session.create"),
  status: z.literal("created"),
  conversationIdentityDigest: ideaDigestSchemaV1,
  providerCalls: z.literal(0),
}).strict();

const promptResultSchema = z.object({
  ...operationBase,
  operation: z.literal("prompt.submit"),
  status: z.literal("accepted"),
  providerCalls: z.literal(1),
}).strict();

const eventSchema = z.discriminatedUnion("type", [
  z.object({ sequence: z.number().int().min(1).max(100_000), type: z.literal("message.start") }).strict(),
  z.object({ sequence: z.number().int().min(1).max(100_000), type: z.literal("message.delta") }).strict(),
  z.object({ sequence: z.number().int().min(1).max(100_000), type: z.literal("reasoning.delta") }).strict(),
  z.object({ sequence: z.number().int().min(1).max(100_000), type: z.literal("thinking.delta") }).strict(),
  z.object({ sequence: z.number().int().min(1).max(100_000), type: z.literal("message.complete"),
    finalText: z.string().min(2).max(800) }).strict(),
  z.object({ sequence: z.number().int().min(1).max(100_000), type: z.literal("error"),
    safeCode: ideaCodeSchemaV1 }).strict(),
]);

const replayResultSchema = z.object({
  ...operationBase,
  operation: z.literal("session.events.since"),
  status: z.literal("replayed"),
  truncated: z.literal(false),
  latestSequence: z.number().int().min(1).max(100_000),
  events: z.array(eventSchema).min(2).max(20),
}).strict();

const statusResultSchema = z.object({
  ...operationBase,
  operation: z.literal("session.status"),
  status: z.enum(["settled", "interrupted"]),
  providerCalls: z.literal(1),
}).strict();

const usageResultSchema = z.object({
  ...operationBase,
  operation: z.literal("session.usage"),
  status: z.literal("settled"),
  inputUnits: z.number().int().min(0).max(10_000_000),
  outputUnits: z.number().int().min(0).max(10_000_000),
  reasoningUnits: z.number().int().min(0).max(10_000_000),
  totalUnits: z.number().int().min(0).max(30_000_000),
  calls: z.literal(1),
  costUsd: z.number().min(0).max(25),
}).strict();

const interruptResultSchema = z.object({
  ...operationBase,
  operation: z.literal("session.interrupt"),
  status: z.enum(["interrupted", "already_settled"]),
  providerCalls: z.literal(1),
}).strict();

const closeResultSchema = z.object({
  ...operationBase,
  operation: z.literal("session.close"),
  status: z.literal("closed"),
  providerCalls: z.literal(1),
}).strict();

const routeCloseSchema = z.object({
  contractVersion: z.literal("control-room-hermes-021-fixed-route-close/v1"),
  attemptId: ideaIdSchemaV1,
  permitDigest: ideaDigestSchemaV1,
  connectorRouteDigest: ideaDigestSchemaV1,
  nativeSessionClosed: z.literal(true),
  routeLeaseReleased: z.literal(true),
  disposableProfileRemoved: z.literal(true),
  disposableWorkspaceRemoved: z.literal(true),
  retainedNativeReferenceCount: z.literal(0),
}).strict();

const panelResultSchema = z.object({
  safeOpinion: ideaTextSchemaV1,
  opportunityCode: ideaCodeSchemaV1,
  primaryRiskCode: ideaCodeSchemaV1,
  suggestedExperiment: z.string().min(1).max(500),
  confidencePercent: z.number().int().min(0).max(100),
}).strict();

type ExecuteInput = Parameters<IdeaLabHermes021NativeBridgeV1["executeFixedSession"]>[0];
type CleanupInput = Parameters<IdeaLabHermes021NativeBridgeV1["cleanupFixedSession"]>[0];

function exactBridgeExecuteInputV1(value: unknown): ExecuteInput | undefined {
  const snapshot = exactHostDataSnapshotV1(value, ["connectionContractVersion", "connectionId", "transport",
    "connectorRouteDigest", "attemptId", "permitDigest", "markerDigest", "participantId",
    "participantIdentityDigest", "round", "safeInstruction", "runtimeIdentityDigest", "profileIdentityDigest",
    "conversationIdentityDigest", "maximumOutputCharacters", "toolsEnabled", "mcpEnabled", "pluginsEnabled",
    "genericShellEnabled", "signal"]);
  return snapshot && exactHostCancellationSignalV1(snapshot.signal) ? snapshot as unknown as ExecuteInput : undefined;
}

function exactBridgeCleanupInputV1(value: unknown): CleanupInput | undefined {
  const snapshot = exactHostDataSnapshotV1(value, ["connectionId", "connectorRouteDigest", "attemptId", "permitDigest",
    "markerDigest", "signal"], ["sessionIdentityDigest"]);
  return snapshot && exactHostCancellationSignalV1(snapshot.signal) ? snapshot as unknown as CleanupInput : undefined;
}

function sameOperationBinding(value: { sessionIdentityDigest: string; epochDigest: string },
  sessionIdentityDigest: string, epochDigest: string): void {
  if (value.sessionIdentityDigest !== sessionIdentityDigest || value.epochDigest !== epochDigest) {
    throw new IdeaLabErrorV1("integrity_failed");
  }
}

export class IdeaLabHermes021FixedRpcBridgeV1 implements IdeaLabHermes021NativeBridgeV1 {
  readonly #open: IdeaLabHermes021ConnectorPrivateRpcV1["openFixedRoute"];
  readonly #request: IdeaLabHermes021ConnectorPrivateRpcV1["requestFixedOperation"];
  readonly #close: IdeaLabHermes021ConnectorPrivateRpcV1["closeFixedRoute"];
  #binding?: { connectionId: string; connectorRouteDigest: string; attemptId: string; permitDigest: string; markerDigest: string;
    routeLeaseDigest?: string; sessionIdentityDigest?: string; epochDigest?: string };
  #executeStarted = false;
  #cleanupStarted = false;
  #executeController?: HostCancellationControllerV1;
  #unsubscribeExecuteInput?: () => void;
  #executeSettled?: Promise<void>;
  #resolveExecuteSettled?: () => void;
  #sessionCleanupRequired = false;

  constructor(connector: IdeaLabHermes021ConnectorPrivateRpcV1) {
    if (!connector || typeof connector !== "object" || isHostProxyV1(connector)) {
      throw new IdeaLabErrorV1("invalid_input");
    }
    const open = dataMethodV1(connector, "openFixedRoute");
    const request = dataMethodV1(connector, "requestFixedOperation");
    const close = dataMethodV1(connector, "closeFixedRoute");
    if (!open || !request || !close) throw new IdeaLabErrorV1("invalid_input");
    this.#open = ((input, collector) => nativeReflectApplyV1(open, connector, [input, collector])) as
      IdeaLabHermes021ConnectorPrivateRpcV1["openFixedRoute"];
    this.#request = ((input, collector) => nativeReflectApplyV1(request, connector, [input, collector])) as
      IdeaLabHermes021ConnectorPrivateRpcV1["requestFixedOperation"];
    this.#close = ((input, collector) => nativeReflectApplyV1(close, connector, [input, collector])) as
      IdeaLabHermes021ConnectorPrivateRpcV1["closeFixedRoute"];
  }

  async executeFixedSession(inputValue: ExecuteInput, collector: HostResultCollectorV1): Promise<void> {
    const input = exactBridgeExecuteInputV1(inputValue);
    if (!input) throw new IdeaLabErrorV1("invalid_input");
    const submit = dataMethodV1(collector, "submit");
    if (this.#executeStarted || this.#cleanupStarted || !submit
      || input.connectionContractVersion !== IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1
      || typeof input.connectionId !== "string" || (input.transport !== "local_loopback" && input.transport !== "ssh_tunnel")
      || typeof input.connectorRouteDigest !== "string" || typeof input.attemptId !== "string"
      || typeof input.permitDigest !== "string" || typeof input.markerDigest !== "string"
      || typeof input.participantId !== "string" || typeof input.participantIdentityDigest !== "string"
      || typeof input.runtimeIdentityDigest !== "string" || typeof input.profileIdentityDigest !== "string"
      || typeof input.conversationIdentityDigest !== "string" || typeof input.round !== "number"
      || !nativeNumberIsSafeIntegerV1(input.round) || input.round < 1 || input.maximumOutputCharacters !== 800
      || input.toolsEnabled !== false || input.mcpEnabled !== false || input.pluginsEnabled !== false
      || input.genericShellEnabled !== false || typeof input.safeInstruction !== "string"
      || input.safeInstruction.length < 1 || input.safeInstruction.length > 800) {
      throw new IdeaLabErrorV1("authorization_denied");
    }
    this.#executeStarted = true;
    this.#executeController = createHostCancellationControllerV1();
    const inputAbort = () => this.#executeController?.abort();
    const inputSubscription = subscribeHostCancellationV1(input.signal, inputAbort);
    if (!inputSubscription) throw new IdeaLabErrorV1("invalid_input");
    if (inputSubscription.status === "aborted") inputAbort();
    else this.#unsubscribeExecuteInput = inputSubscription.unsubscribe;
    const executionInput = { ...input, signal: this.#executeController.signal };
    this.#executeSettled = new nativePromiseV1<void>((resolve) => { this.#resolveExecuteSettled = resolve; });
    this.#binding = { connectionId: input.connectionId, connectorRouteDigest: input.connectorRouteDigest, attemptId: input.attemptId,
      permitDigest: input.permitDigest, markerDigest: input.markerDigest };

    try {
    this.#assertExecutionActive();
    const opened = parseExactIdeaLabV1(routeOpenSchema, await this.#callOpen(executionInput));
    if (opened.attemptId !== input.attemptId || opened.permitDigest !== input.permitDigest
      || opened.connectorRouteDigest !== input.connectorRouteDigest
      || opened.profileIdentityDigest !== input.profileIdentityDigest
      || opened.conversationIdentityDigest !== input.conversationIdentityDigest) {
      throw new IdeaLabErrorV1("integrity_failed");
    }
    this.#binding.routeLeaseDigest = opened.routeLeaseDigest;

    const created = parseExactIdeaLabV1(createResultSchema, await this.#callOperation(executionInput, "session.create", {
      conversationIdentityDigest: input.conversationIdentityDigest,
      maximumOutputCharacters: 800,
      toolsEnabled: false,
      mcpEnabled: false,
      pluginsEnabled: false,
      genericShellEnabled: false,
    }));
    if (created.conversationIdentityDigest !== input.conversationIdentityDigest) {
      throw new IdeaLabErrorV1("integrity_failed");
    }
    this.#binding.sessionIdentityDigest = created.sessionIdentityDigest;
    this.#binding.epochDigest = created.epochDigest;

    const prompted = parseExactIdeaLabV1(promptResultSchema, await this.#callOperation(executionInput, "prompt.submit", {
      safeInstruction: input.safeInstruction,
      markerDigest: input.markerDigest,
      maximumOutputCharacters: 800,
    }));
    sameOperationBinding(prompted, created.sessionIdentityDigest, created.epochDigest);

    const replayed = parseExactIdeaLabV1(replayResultSchema, await this.#callOperation(executionInput,
      "session.events.since", { lastSeenSequence: 0, maximumEvents: 20 }));
    sameOperationBinding(replayed, created.sessionIdentityDigest, created.epochDigest);
    const events = exactHostDataArrayV1(replayed.events, 20);
    const lastEvent = replayed.events[replayed.events.length - 1];
    if (!events || replayed.latestSequence !== lastEvent?.sequence) {
      throw new IdeaLabErrorV1("integrity_failed");
    }
    let prior = 0, started = false, terminal: z.infer<typeof panelResultSchema> | { safeCode: string } | undefined;
    for (let eventIndex = 0; eventIndex < replayed.events.length; eventIndex += 1) {
      const event = replayed.events[eventIndex];
      if (!event) throw new IdeaLabErrorV1("integrity_failed");
      if (event.sequence !== prior + 1 || terminal) throw new IdeaLabErrorV1("integrity_failed");
      prior = event.sequence;
      if (event.type === "message.start") {
        if (started) throw new IdeaLabErrorV1("integrity_failed");
        started = true;
      } else if (event.type === "message.complete") {
        if (!started) throw new IdeaLabErrorV1("integrity_failed");
        let decoded: unknown;
        try { decoded = nativeJsonParseV1(event.finalText); } catch { throw new IdeaLabErrorV1("integrity_failed"); }
        terminal = parseExactIdeaLabV1(panelResultSchema, decoded);
      } else if (event.type === "error") {
        if (!started) throw new IdeaLabErrorV1("integrity_failed");
        terminal = { safeCode: event.safeCode };
      } else if (!started) throw new IdeaLabErrorV1("integrity_failed");
    }
    if (!terminal) throw new IdeaLabErrorV1("integrity_failed");

    const status = parseExactIdeaLabV1(statusResultSchema,
      await this.#callOperation(executionInput, "session.status", {}));
    sameOperationBinding(status, created.sessionIdentityDigest, created.epochDigest);
    if (status.status !== "settled") throw new IdeaLabErrorV1("integrity_failed");

    const usage = parseExactIdeaLabV1(usageResultSchema,
      await this.#callOperation(executionInput, "session.usage", {}));
    sameOperationBinding(usage, created.sessionIdentityDigest, created.epochDigest);
    if (usage.totalUnits !== usage.inputUnits + usage.outputUnits + usage.reasoningUnits) {
      throw new IdeaLabErrorV1("integrity_failed");
    }

    const base = { markerDigest: input.markerDigest, sessionIdentityDigest: created.sessionIdentityDigest };
    const terminalFrame = "safeCode" in terminal
      ? { ...base, sequence: 2, type: "panel.failed_definite", payload: { safeCode: terminal.safeCode } }
      : { ...base, sequence: 2, type: "panel.result", payload: terminal };
    this.#assertExecutionActive();
    nativeReflectApplyV1(submit, collector, [{ frames: [
      { ...base, sequence: 1, type: "session.ready", payload: { participantId: input.participantId,
        participantIdentityDigest: input.participantIdentityDigest, runtimeIdentityDigest: input.runtimeIdentityDigest,
        profileIdentityDigest: input.profileIdentityDigest, conversationIdentityDigest: input.conversationIdentityDigest,
        toolsDisabled: true, mcpDisabled: true } },
      terminalFrame,
      { ...base, sequence: 3, type: "session.usage", payload: { inputUnits: usage.inputUnits,
        outputUnits: usage.outputUnits, reasoningUnits: usage.reasoningUnits, totalUnits: usage.totalUnits,
        calls: 1, costUsd: usage.costUsd } },
      { ...base, sequence: 4, type: "session.complete", payload: { status: "settled" } },
    ] }]);
    } finally {
      this.#unsubscribeExecuteInput?.();
      this.#unsubscribeExecuteInput = undefined;
      this.#resolveExecuteSettled?.();
      this.#resolveExecuteSettled = undefined;
    }
  }

  async cleanupFixedSession(inputValue: CleanupInput, collector: HostResultCollectorV1): Promise<void> {
    const input = exactBridgeCleanupInputV1(inputValue);
    if (!input) throw new IdeaLabErrorV1("invalid_input");
    const submit = dataMethodV1(collector, "submit"), binding = this.#binding;
    if (!this.#executeStarted || this.#cleanupStarted || !submit || !binding
      || input.connectionId !== binding.connectionId || input.connectorRouteDigest !== binding.connectorRouteDigest
      || input.attemptId !== binding.attemptId
      || input.permitDigest !== binding.permitDigest || input.markerDigest !== binding.markerDigest
      || (input.sessionIdentityDigest !== undefined && (typeof input.sessionIdentityDigest !== "string"
        || input.sessionIdentityDigest !== binding.sessionIdentityDigest))) {
      throw new IdeaLabErrorV1("authorization_denied");
    }
    this.#cleanupStarted = true;
    this.#executeController?.abort();
    const executeSettled = this.#executeSettled;
    if (!executeSettled) throw new IdeaLabErrorV1("integrity_failed");
    await executeSettled;
    if (binding.routeLeaseDigest && this.#sessionCleanupRequired) {
      const interrupt = parseExactIdeaLabV1(interruptResultSchema,
        await this.#callCleanupOperation(input, "session.interrupt"));
      if (binding.sessionIdentityDigest && binding.epochDigest) {
        sameOperationBinding(interrupt, binding.sessionIdentityDigest, binding.epochDigest);
      } else {
        binding.sessionIdentityDigest = interrupt.sessionIdentityDigest;
        binding.epochDigest = interrupt.epochDigest;
      }
      const status = parseExactIdeaLabV1(statusResultSchema,
        await this.#callCleanupOperation(input, "session.status"));
      sameOperationBinding(status, binding.sessionIdentityDigest, binding.epochDigest);
      const closed = parseExactIdeaLabV1(closeResultSchema,
        await this.#callCleanupOperation(input, "session.close"));
      sameOperationBinding(closed, binding.sessionIdentityDigest, binding.epochDigest);
    }
    const closedRoute = parseExactIdeaLabV1(routeCloseSchema, await this.#callClose(input));
    if (closedRoute.attemptId !== input.attemptId || closedRoute.permitDigest !== input.permitDigest
      || closedRoute.connectorRouteDigest !== input.connectorRouteDigest) {
      throw new IdeaLabErrorV1("integrity_failed");
    }
    const material = { contractVersion: "control-room-hermes-021-panel-cleanup/v1" as const,
      markerDigest: input.markerDigest,
      ...(binding.sessionIdentityDigest ? { sessionIdentityDigest: binding.sessionIdentityDigest } : {}),
      outcome: "completed" as const, processStopped: true as const,
      disposableProfileRemoved: true as const, disposableWorkspaceRemoved: true as const,
      retainedNativeReferenceCount: 0 as const };
    nativeReflectApplyV1(submit, collector, [{ ...material, cleanupDigest: sha256Digest(material) }]);
  }

  async #callOpen(input: ExecuteInput): Promise<unknown> {
    this.#assertExecutionActive();
    const handoff = createHostResultCollectorV1();
    await this.#open({ contractVersion: IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1,
      connectionIdentityDigest: sha256Digest({ contractVersion: IDEA_LAB_HERMES_021_CONNECTION_IDENTITY_V1,
        connectionId: input.connectionId }), transport: input.transport,
      connectorRouteDigest: input.connectorRouteDigest, attemptId: input.attemptId,
      permitDigest: input.permitDigest, profileIdentityDigest: input.profileIdentityDigest,
      conversationIdentityDigest: input.conversationIdentityDigest,
      sourceManifestDigest: IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1,
      signal: input.signal }, handoff.collector);
    const value = handoff.take();
    this.#assertExecutionActive();
    return value;
  }

  async #callOperation(input: ExecuteInput, operation: IdeaLabHermes021FixedOperationV1,
    parameters: Record<string, unknown>): Promise<unknown> {
    const binding = this.#binding;
    this.#assertExecutionActive();
    if (!binding?.routeLeaseDigest) throw new IdeaLabErrorV1("integrity_failed");
    const handoff = createHostResultCollectorV1();
    if (operation === "session.create") this.#sessionCleanupRequired = true;
    await this.#request({ contractVersion: IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1,
      connectorRouteDigest: binding.connectorRouteDigest, routeLeaseDigest: binding.routeLeaseDigest,
      attemptId: binding.attemptId, permitDigest: binding.permitDigest, operation,
      parameters: nativeObjectFreezeV1({ ...parameters }), signal: input.signal }, handoff.collector);
    const value = handoff.take();
    this.#assertExecutionActive();
    return value;
  }

  async #callCleanupOperation(input: CleanupInput,
    operation: "session.interrupt" | "session.status" | "session.close"): Promise<unknown> {
    const binding = this.#binding;
    if (!binding?.routeLeaseDigest) throw new IdeaLabErrorV1("integrity_failed");
    const handoff = createHostResultCollectorV1();
    await this.#request({ contractVersion: IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1,
      connectorRouteDigest: binding.connectorRouteDigest, routeLeaseDigest: binding.routeLeaseDigest,
      attemptId: binding.attemptId, permitDigest: binding.permitDigest, operation,
      parameters: nativeObjectFreezeV1({}), signal: input.signal }, handoff.collector);
    return handoff.take();
  }

  async #callClose(input: CleanupInput): Promise<unknown> {
    const binding = this.#binding;
    if (!binding) throw new IdeaLabErrorV1("integrity_failed");
    const handoff = createHostResultCollectorV1();
    await this.#close({ contractVersion: IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1,
      connectorRouteDigest: binding.connectorRouteDigest,
      ...(binding.routeLeaseDigest ? { routeLeaseDigest: binding.routeLeaseDigest } : {}),
      attemptId: binding.attemptId, permitDigest: binding.permitDigest,
      signal: input.signal }, handoff.collector);
    return handoff.take();
  }

  #assertExecutionActive(): void {
    if (this.#cleanupStarted || hostCancellationAbortedV1(this.#executeController?.signal) !== false) {
      throw new IdeaLabErrorV1("integrity_failed");
    }
  }
}

export const IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_DISABLED_V1 = nativeObjectFreezeV1({
  contractVersion: IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1,
  connectorConfigured: false as const,
  enrolledRouteConfigured: false as const,
  providerCallsMade: 0 as const,
  nativeAttemptsMade: 0 as const,
  livePanelEligible: false as const,
  grantsExecutionAuthority: false as const,
});
