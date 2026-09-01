import { z } from "zod";
import {
  createHostResultCollectorV1,
  dataMethodV1,
  exactHostAbortSignalV1,
  exactHostDataSnapshotV1,
  isHostProxyV1,
  type ExactHostAbortSignalV1,
  type HostResultCollectorV1,
} from "../../security/host-value";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import type { IdeaLabHermes021ConnectorPrivateRpcV1 } from "./hermes-021-fixed-rpc-bridge";
import {
  IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1,
  IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1,
} from "./hermes-021-fixed-rpc-bridge";
import type { IdeaLabHermes021FixedOperationV1 } from "./hermes-021-fixed-operation-set";
import { IDEA_LAB_HERMES_021_REVISION_V1, IDEA_LAB_HERMES_021_VERSION_V1 } from "./hermes-021-panel-packet";
import { ideaDigestSchemaV1, ideaIdSchemaV1 } from "./schemas";

export const IDEA_LAB_HERMES_021_MACOS_CONNECTOR_V1 =
  "control-room-hermes-021-macos-connector/v1" as const;

type OpenInput = Parameters<IdeaLabHermes021ConnectorPrivateRpcV1["openFixedRoute"]>[0];
type OperationInput = Parameters<IdeaLabHermes021ConnectorPrivateRpcV1["requestFixedOperation"]>[0];
type CloseInput = Parameters<IdeaLabHermes021ConnectorPrivateRpcV1["closeFixedRoute"]>[0];

/**
 * Mac-resident private port. Its implementation lives beside Hermes Desktop
 * and owns the connection registry, SSH configuration, protected values,
 * gateway endpoint, profile path, and native session identifiers. None of
 * those values are members of this interface or may be returned through it.
 */
export interface IdeaLabHermes021MacosPrivatePortV1 {
  openEnrolledRoute(input: OpenInput, collector: HostResultCollectorV1): Promise<void>;
  requestEnrolledOperation(input: OperationInput, collector: HostResultCollectorV1): Promise<void>;
  closeEnrolledRoute(input: CloseInput, collector: HostResultCollectorV1): Promise<void>;
}

const openDataSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1),
  connectionIdentityDigest: ideaDigestSchemaV1,
  transport: z.enum(["local_loopback", "ssh_tunnel"]),
  connectorRouteDigest: ideaDigestSchemaV1,
  attemptId: ideaIdSchemaV1,
  permitDigest: ideaDigestSchemaV1,
  profileIdentityDigest: ideaDigestSchemaV1,
  conversationIdentityDigest: ideaDigestSchemaV1,
  sourceManifestDigest: z.literal(IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1),
}).strict();

const operationDataSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1),
  connectorRouteDigest: ideaDigestSchemaV1,
  routeLeaseDigest: ideaDigestSchemaV1,
  attemptId: ideaIdSchemaV1,
  permitDigest: ideaDigestSchemaV1,
  operation: z.enum(["session.create", "prompt.submit", "session.events.since", "session.status", "session.usage",
    "session.interrupt", "session.close"]),
}).strict();

const closeDataSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1),
  connectorRouteDigest: ideaDigestSchemaV1,
  routeLeaseDigest: ideaDigestSchemaV1.optional(),
  attemptId: ideaIdSchemaV1,
  permitDigest: ideaDigestSchemaV1,
}).strict();

const digest = ideaDigestSchemaV1;
const parameterSchemas: Record<IdeaLabHermes021FixedOperationV1, z.ZodType> = {
  "session.create": z.object({ conversationIdentityDigest: digest, maximumOutputCharacters: z.literal(800),
    toolsEnabled: z.literal(false), mcpEnabled: z.literal(false), pluginsEnabled: z.literal(false),
    genericShellEnabled: z.literal(false) }).strict(),
  "prompt.submit": z.object({ safeInstruction: z.string().min(1).max(800), markerDigest: digest,
    maximumOutputCharacters: z.literal(800) }).strict(),
  "session.events.since": z.object({ lastSeenSequence: z.literal(0), maximumEvents: z.literal(20) }).strict(),
  "session.status": z.object({}).strict(),
  "session.usage": z.object({}).strict(),
  "session.interrupt": z.object({}).strict(),
  "session.close": z.object({}).strict(),
};

const ordinarySequence = ["session.create", "prompt.submit", "session.events.since", "session.status",
  "session.usage"] as const;
const cleanupSequence = ["session.interrupt", "session.status", "session.close"] as const;

function exactInput(value: unknown, keys: readonly string[], optionalKeys: readonly string[] = []): {
  snapshot: Record<string, unknown>;
  signal: ExactHostAbortSignalV1;
} {
  const snapshot = exactHostDataSnapshotV1(value, keys, optionalKeys);
  const signal = snapshot && exactHostAbortSignalV1(snapshot.signal);
  if (!snapshot || !signal) throw new IdeaLabErrorV1("invalid_input");
  return { snapshot, signal };
}

function distinct(values: readonly string[]): boolean { return new Set(values).size === values.length; }

function exactParameters(value: unknown, operation: IdeaLabHermes021FixedOperationV1): Readonly<Record<string, unknown>> {
  const keys = operation === "session.create"
    ? ["conversationIdentityDigest", "maximumOutputCharacters", "toolsEnabled", "mcpEnabled", "pluginsEnabled",
      "genericShellEnabled"]
    : operation === "prompt.submit"
      ? ["safeInstruction", "markerDigest", "maximumOutputCharacters"]
      : operation === "session.events.since" ? ["lastSeenSequence", "maximumEvents"] : [];
  const snapshot = exactHostDataSnapshotV1(value, keys);
  if (!snapshot) throw new IdeaLabErrorV1("invalid_input");
  return Object.freeze(parseExactIdeaLabV1(parameterSchemas[operation], snapshot) as Record<string, unknown>);
}

const operationResultKeys: Record<IdeaLabHermes021FixedOperationV1, readonly string[]> = {
  "session.create": ["contractVersion", "sessionIdentityDigest", "epochDigest", "operation", "status",
    "conversationIdentityDigest", "providerCalls"],
  "prompt.submit": ["contractVersion", "sessionIdentityDigest", "epochDigest", "operation", "status", "providerCalls"],
  "session.events.since": ["contractVersion", "sessionIdentityDigest", "epochDigest", "operation", "status",
    "truncated", "latestSequence", "events"],
  "session.status": ["contractVersion", "sessionIdentityDigest", "epochDigest", "operation", "status", "providerCalls"],
  "session.usage": ["contractVersion", "sessionIdentityDigest", "epochDigest", "operation", "status", "inputUnits",
    "outputUnits", "reasoningUnits", "totalUnits", "calls", "costUsd"],
  "session.interrupt": ["contractVersion", "sessionIdentityDigest", "epochDigest", "operation", "status", "providerCalls"],
  "session.close": ["contractVersion", "sessionIdentityDigest", "epochDigest", "operation", "status", "providerCalls"],
};

function captureOperationResult(value: unknown, operation: IdeaLabHermes021FixedOperationV1): Readonly<Record<string, unknown>> {
  const snapshot = exactHostDataSnapshotV1(value, operationResultKeys[operation]);
  if (!snapshot || snapshot.operation !== operation) throw new IdeaLabErrorV1("integrity_failed");
  return Object.freeze(snapshot);
}

function submitMethod(collector: HostResultCollectorV1): (value: unknown) => void {
  const submit = dataMethodV1(collector, "submit");
  if (!submit) throw new IdeaLabErrorV1("invalid_input");
  return submit.bind(collector) as (value: unknown) => void;
}

/**
 * One-attempt protocol guard between the reviewed fixed bridge and the
 * Mac-owned Hermes Desktop port. It adds exact input capture, lifecycle order,
 * binding checks, receiver preservation, abort-before-close serialization, and
 * no-retry behavior without acquiring any native locator itself.
 */
export class IdeaLabHermes021MacosConnectorV1 implements IdeaLabHermes021ConnectorPrivateRpcV1 {
  readonly #openPort: IdeaLabHermes021MacosPrivatePortV1["openEnrolledRoute"];
  readonly #requestPort: IdeaLabHermes021MacosPrivatePortV1["requestEnrolledOperation"];
  readonly #closePort: IdeaLabHermes021MacosPrivatePortV1["closeEnrolledRoute"];
  #binding?: { connectionIdentityDigest: string; transport: "local_loopback" | "ssh_tunnel"; connectorRouteDigest: string;
    attemptId: string; permitDigest: string; profileIdentityDigest: string; conversationIdentityDigest: string;
    routeLeaseDigest?: string };
  #sessionBinding?: { sessionIdentityDigest: string; epochDigest: string };
  #openStarted = false;
  #openReturned = false;
  #closed = false;
  #closing = false;
  #ordinaryIndex = 0;
  #cleanupIndex = 0;
  #cleanupOnly = false;
  #sessionCleanupRequired = false;
  #cleanupAttempted = false;
  #activeController?: AbortController;
  #activeSettled?: Promise<void>;
  #settleActive?: () => void;
  #activeParentSignal?: ExactHostAbortSignalV1;
  #activeAbort?: () => void;

  constructor(privatePort: IdeaLabHermes021MacosPrivatePortV1) {
    if (!privatePort || typeof privatePort !== "object" || isHostProxyV1(privatePort)) {
      throw new IdeaLabErrorV1("invalid_input");
    }
    const open = dataMethodV1(privatePort, "openEnrolledRoute");
    const request = dataMethodV1(privatePort, "requestEnrolledOperation");
    const close = dataMethodV1(privatePort, "closeEnrolledRoute");
    if (!open || !request || !close) throw new IdeaLabErrorV1("invalid_input");
    this.#openPort = open.bind(privatePort) as IdeaLabHermes021MacosPrivatePortV1["openEnrolledRoute"];
    this.#requestPort = request.bind(privatePort) as IdeaLabHermes021MacosPrivatePortV1["requestEnrolledOperation"];
    this.#closePort = close.bind(privatePort) as IdeaLabHermes021MacosPrivatePortV1["closeEnrolledRoute"];
  }

  async openFixedRoute(inputValue: OpenInput, collector: HostResultCollectorV1): Promise<void> {
    const submit = submitMethod(collector);
    if (this.#openStarted || this.#closing || this.#closed) throw new IdeaLabErrorV1("authorization_denied");
    const captured = exactInput(inputValue, ["contractVersion", "connectionIdentityDigest", "transport",
      "connectorRouteDigest", "attemptId", "permitDigest", "profileIdentityDigest", "conversationIdentityDigest",
      "sourceManifestDigest", "signal"]);
    const dataRecord = { ...captured.snapshot };
    delete dataRecord.signal;
    const data = parseExactIdeaLabV1(openDataSchema, dataRecord);
    if (!distinct([data.connectionIdentityDigest, data.connectorRouteDigest, data.permitDigest,
      data.profileIdentityDigest, data.conversationIdentityDigest])) throw new IdeaLabErrorV1("authorization_denied");
    const controller = this.#beginActive(captured.signal);
    this.#openStarted = true;
    this.#binding = { connectionIdentityDigest: data.connectionIdentityDigest, transport: data.transport,
      connectorRouteDigest: data.connectorRouteDigest, attemptId: data.attemptId, permitDigest: data.permitDigest,
      profileIdentityDigest: data.profileIdentityDigest, conversationIdentityDigest: data.conversationIdentityDigest };
    const handoff = createHostResultCollectorV1();
    try {
      await this.#callPrivate(() => this.#openPort(Object.freeze({ ...data, signal: controller.signal }), handoff.collector));
      const result = handoff.take();
      if (this.#closing || controller.signal.aborted) throw new IdeaLabErrorV1("integrity_failed");
      const resultSnapshot = exactHostDataSnapshotV1(result, ["contractVersion", "attemptId", "permitDigest",
        "connectorRouteDigest", "routeLeaseDigest", "runtimeVersion", "runtimeRevision", "sourceManifestDigest",
        "profileIdentityDigest", "conversationIdentityDigest", "endpointVisibility", "nativeLocatorReturned",
        "toolsDisabled", "mcpDisabled", "pluginsDisabled"]);
      if (!resultSnapshot) throw new IdeaLabErrorV1("integrity_failed");
      const routeLeaseDigest = resultSnapshot.routeLeaseDigest;
      if (typeof routeLeaseDigest !== "string" || !digest.safeParse(routeLeaseDigest).success) {
        throw new IdeaLabErrorV1("integrity_failed");
      }
      if (!distinct([data.connectionIdentityDigest, data.connectorRouteDigest, data.permitDigest,
        data.profileIdentityDigest, data.conversationIdentityDigest, routeLeaseDigest])) {
        throw new IdeaLabErrorV1("integrity_failed");
      }
      if (resultSnapshot.contractVersion !== "control-room-hermes-021-fixed-route-open/v1"
        || resultSnapshot.attemptId !== data.attemptId || resultSnapshot.permitDigest !== data.permitDigest
        || resultSnapshot.connectorRouteDigest !== data.connectorRouteDigest
        || resultSnapshot.runtimeVersion !== IDEA_LAB_HERMES_021_VERSION_V1
        || resultSnapshot.runtimeRevision !== IDEA_LAB_HERMES_021_REVISION_V1
        || resultSnapshot.sourceManifestDigest !== data.sourceManifestDigest
        || resultSnapshot.profileIdentityDigest !== data.profileIdentityDigest
        || resultSnapshot.conversationIdentityDigest !== data.conversationIdentityDigest
        || resultSnapshot.endpointVisibility !== "connector_private_loopback"
        || resultSnapshot.nativeLocatorReturned !== false || resultSnapshot.toolsDisabled !== true
        || resultSnapshot.mcpDisabled !== true || resultSnapshot.pluginsDisabled !== true) {
        throw new IdeaLabErrorV1("integrity_failed");
      }
      this.#binding.routeLeaseDigest = routeLeaseDigest;
      this.#openReturned = true;
      submit(Object.freeze(resultSnapshot));
    } catch (error) {
      handoff.abort(); this.#cleanupOnly = true;
      throw error instanceof IdeaLabErrorV1 ? error : new IdeaLabErrorV1("integrity_failed");
    } finally { this.#finishActive(); }
  }

  async requestFixedOperation(inputValue: OperationInput, collector: HostResultCollectorV1): Promise<void> {
    const submit = submitMethod(collector), binding = this.#binding;
    if (!binding || !this.#openReturned || this.#closing || this.#closed || this.#activeSettled) {
      throw new IdeaLabErrorV1("authorization_denied");
    }
    const captured = exactInput(inputValue, ["contractVersion", "connectorRouteDigest", "routeLeaseDigest", "attemptId",
      "permitDigest", "operation", "parameters", "signal"]);
    const parameters = captured.snapshot.parameters;
    const dataRecord = { ...captured.snapshot }; delete dataRecord.signal; delete dataRecord.parameters;
    const data = parseExactIdeaLabV1(operationDataSchema, dataRecord), exact = exactParameters(parameters, data.operation);
    if (data.connectorRouteDigest !== binding.connectorRouteDigest || data.routeLeaseDigest !== binding.routeLeaseDigest
      || data.attemptId !== binding.attemptId || data.permitDigest !== binding.permitDigest) {
      throw new IdeaLabErrorV1("authorization_denied");
    }
    const expectedOrdinary = ordinarySequence[this.#ordinaryIndex], expectedCleanup = cleanupSequence[this.#cleanupIndex];
    if (data.operation === "session.interrupt" && this.#ordinaryIndex >= 1) this.#cleanupOnly = true;
    const expected = this.#cleanupOnly ? expectedCleanup : expectedOrdinary;
    if (data.operation !== expected) throw new IdeaLabErrorV1("authorization_denied");
    const controller = this.#beginActive(captured.signal);
    if (data.operation === "session.create") this.#sessionCleanupRequired = true;
    if (this.#cleanupOnly) this.#cleanupAttempted = true;
    const handoff = createHostResultCollectorV1();
    try {
      await this.#callPrivate(() => this.#requestPort(
        Object.freeze({ ...data, parameters: exact, signal: controller.signal }), handoff.collector));
      const result = captureOperationResult(handoff.take(), data.operation);
      this.#bindOperationResult(result);
      if (this.#closing || controller.signal.aborted) throw new IdeaLabErrorV1("integrity_failed");
      if (this.#cleanupOnly) this.#cleanupIndex += 1; else this.#ordinaryIndex += 1;
      submit(result);
    } catch (error) {
      handoff.abort(); this.#cleanupOnly = true;
      throw error instanceof IdeaLabErrorV1 ? error : new IdeaLabErrorV1("integrity_failed");
    } finally { this.#finishActive(); }
  }

  async closeFixedRoute(inputValue: CloseInput, collector: HostResultCollectorV1): Promise<void> {
    const submit = submitMethod(collector), binding = this.#binding;
    if (!binding || !this.#openStarted || this.#closing || this.#closed) {
      throw new IdeaLabErrorV1("authorization_denied");
    }
    const captured = exactInput(inputValue, ["contractVersion", "connectorRouteDigest", "attemptId", "permitDigest",
      "signal"], ["routeLeaseDigest"]);
    const dataRecord = { ...captured.snapshot };
    delete dataRecord.signal;
    const data = parseExactIdeaLabV1(closeDataSchema, dataRecord);
    if (data.connectorRouteDigest !== binding.connectorRouteDigest || data.attemptId !== binding.attemptId
      || data.permitDigest !== binding.permitDigest || data.routeLeaseDigest !== binding.routeLeaseDigest) {
      throw new IdeaLabErrorV1("authorization_denied");
    }
    const initiallyAborted = captured.signal.readAborted();
    if (initiallyAborted === undefined) throw new IdeaLabErrorV1("invalid_input");
    if (initiallyAborted) throw new IdeaLabErrorV1("authorization_denied");
    this.#closing = true;
    this.#activeController?.abort();
    if (this.#activeSettled) await this.#activeSettled;
    if (this.#sessionCleanupRequired && !this.#cleanupAttempted) {
      this.#closing = false; this.#cleanupOnly = true;
      throw new IdeaLabErrorV1("authorization_denied");
    }
    let controller: AbortController;
    try { controller = this.#beginActive(captured.signal); }
    catch (error) { this.#closing = false; this.#cleanupOnly = true; throw error; }
    const handoff = createHostResultCollectorV1();
    try {
      await this.#callPrivate(() => this.#closePort(Object.freeze({ ...data, signal: controller.signal }), handoff.collector));
      const result = exactHostDataSnapshotV1(handoff.take(), ["contractVersion", "attemptId", "permitDigest",
        "connectorRouteDigest", "nativeSessionClosed", "routeLeaseReleased", "disposableProfileRemoved",
        "disposableWorkspaceRemoved", "retainedNativeReferenceCount"]);
      if (!result || result.contractVersion !== "control-room-hermes-021-fixed-route-close/v1"
        || result.attemptId !== data.attemptId || result.permitDigest !== data.permitDigest
        || result.connectorRouteDigest !== data.connectorRouteDigest || result.nativeSessionClosed !== true
        || result.routeLeaseReleased !== true || result.disposableProfileRemoved !== true
        || result.disposableWorkspaceRemoved !== true || result.retainedNativeReferenceCount !== 0) {
        throw new IdeaLabErrorV1("integrity_failed");
      }
      this.#closed = true;
      submit(Object.freeze(result));
    } catch (error) {
      handoff.abort();
      throw error instanceof IdeaLabErrorV1 ? error : new IdeaLabErrorV1("integrity_failed");
    }
    finally { this.#finishActive(); }
  }

  async #callPrivate(call: () => Promise<void>): Promise<void> {
    try { await call(); }
    catch { throw new IdeaLabErrorV1("integrity_failed"); }
  }

  #bindOperationResult(result: Readonly<Record<string, unknown>>): void {
    const binding = this.#binding, sessionIdentityDigest = result.sessionIdentityDigest,
      epochDigest = result.epochDigest;
    if (!binding || typeof sessionIdentityDigest !== "string" || typeof epochDigest !== "string"
      || !digest.safeParse(sessionIdentityDigest).success || !digest.safeParse(epochDigest).success
      || !distinct([binding.connectionIdentityDigest, binding.connectorRouteDigest, binding.permitDigest,
        binding.profileIdentityDigest, binding.conversationIdentityDigest,
        ...(binding.routeLeaseDigest ? [binding.routeLeaseDigest] : []), sessionIdentityDigest, epochDigest])) {
      throw new IdeaLabErrorV1("integrity_failed");
    }
    if (this.#sessionBinding && (this.#sessionBinding.sessionIdentityDigest !== sessionIdentityDigest
      || this.#sessionBinding.epochDigest !== epochDigest)) throw new IdeaLabErrorV1("integrity_failed");
    this.#sessionBinding ??= { sessionIdentityDigest, epochDigest };
  }

  #beginActive(signal: ExactHostAbortSignalV1): AbortController {
    if (this.#activeSettled) throw new IdeaLabErrorV1("authorization_denied");
    const controller = new AbortController();
    const abort = () => controller.abort();
    const before = signal.readAborted();
    if (before === undefined) throw new IdeaLabErrorV1("invalid_input");
    if (before) throw new IdeaLabErrorV1("authorization_denied");
    if (!signal.addAbortListener(abort)) throw new IdeaLabErrorV1("invalid_input");
    const after = signal.readAborted();
    if (after === undefined || after) {
      signal.removeAbortListener(abort); controller.abort();
      throw new IdeaLabErrorV1(after === undefined ? "invalid_input" : "authorization_denied");
    }
    this.#activeController = controller;
    this.#activeParentSignal = signal;
    this.#activeAbort = abort;
    this.#activeSettled = new Promise<void>((resolve) => { this.#settleActive = resolve; });
    return controller;
  }

  #finishActive(): void {
    if (this.#activeParentSignal && this.#activeAbort) {
      this.#activeParentSignal.removeAbortListener(this.#activeAbort);
    }
    this.#settleActive?.();
    this.#settleActive = undefined;
    this.#activeController = undefined;
    this.#activeParentSignal = undefined;
    this.#activeAbort = undefined;
    this.#activeSettled = undefined;
  }
}

export const IDEA_LAB_HERMES_021_MACOS_CONNECTOR_DISABLED_V1 = Object.freeze({
  contractVersion: IDEA_LAB_HERMES_021_MACOS_CONNECTOR_V1,
  platform: "macos" as const,
  privatePortConfigured: false as const,
  trustedNodeSignerEnrolled: false as const,
  signedRouteEnrolled: false as const,
  connectionAttemptsMade: 0 as const,
  sshConnectionsMade: 0 as const,
  nativeAttemptsMade: 0 as const,
  providerCallsMade: 0 as const,
  livePanelEligible: false as const,
  grantsExecutionAuthority: false as const,
});
