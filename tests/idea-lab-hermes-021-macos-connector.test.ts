import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createHostCancellationControllerV1,
  createHostResultCollectorV1,
  exactHostCancellationSignalV1,
  hostCancellationAbortedV1,
  subscribeHostCancellationV1,
  type HostCancellationSignalV1,
  type HostResultCollectorV1,
} from "../src/security/host-value.ts";
import { sha256Digest } from "../src/security/index.ts";
import {
  IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1,
  IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1,
  IDEA_LAB_HERMES_021_MACOS_CONNECTOR_DISABLED_V1,
  IDEA_LAB_HERMES_021_REVISION_V1,
  IDEA_LAB_HERMES_021_VERSION_V1,
  IdeaLabErrorV1,
  IdeaLabHermes021MacosConnectorV1,
  type IdeaLabHermes021ConnectorPrivateRpcV1,
  type IdeaLabHermes021MacosPrivatePortV1,
} from "../src/idea-lab/v1/index.ts";

const id = (value: string) => `${value}-fixture`;
const digest = (value: string) => sha256Digest({ value });
const binding = {
  connectionIdentityDigest: digest("connection-identity"), transport: "local_loopback" as const,
  connectorRouteDigest: digest("route"), attemptId: id("attempt"), permitDigest: digest("permit"),
  profileIdentityDigest: digest("profile"), conversationIdentityDigest: digest("conversation"),
};
const routeLeaseDigest = digest("lease");
const sessionIdentityDigest = digest("session");
const epochDigest = digest("epoch");
function closeReceipt(input: { attemptId: string; permitDigest: string; connectorRouteDigest: string }) {
  return { contractVersion: "control-room-hermes-021-fixed-route-close/v1", attemptId: input.attemptId,
    permitDigest: input.permitDigest, connectorRouteDigest: input.connectorRouteDigest,
    nativeSessionClosed: true, routeLeaseReleased: true, disposableProfileRemoved: true,
    disposableWorkspaceRemoved: true, retainedNativeReferenceCount: 0 };
}

function openInput(signal: HostCancellationSignalV1 = createHostCancellationControllerV1().signal) {
  return Object.freeze({ contractVersion: IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1, ...binding,
    sourceManifestDigest: IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1, signal });
}

const parameters = {
  "session.create": Object.freeze({ conversationIdentityDigest: binding.conversationIdentityDigest,
    maximumOutputCharacters: 800 as const, toolsEnabled: false as const, mcpEnabled: false as const,
    pluginsEnabled: false as const, genericShellEnabled: false as const }),
  "prompt.submit": Object.freeze({ safeInstruction: "Return one bounded opinion.", markerDigest: digest("marker"),
    maximumOutputCharacters: 800 as const }),
  "session.events.since": Object.freeze({ lastSeenSequence: 0 as const, maximumEvents: 20 as const }),
  "session.status": Object.freeze({}), "session.usage": Object.freeze({}),
  "session.interrupt": Object.freeze({}), "session.close": Object.freeze({}),
};

type Operation = keyof typeof parameters;
function operationInput(operation: Operation,
  signal: HostCancellationSignalV1 = createHostCancellationControllerV1().signal) {
  return Object.freeze({ contractVersion: IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1,
    connectorRouteDigest: binding.connectorRouteDigest, routeLeaseDigest, attemptId: binding.attemptId,
    permitDigest: binding.permitDigest, operation, parameters: parameters[operation], signal });
}
function closeInput(signal: HostCancellationSignalV1 = createHostCancellationControllerV1().signal) {
  return Object.freeze({ contractVersion: IDEA_LAB_HERMES_021_FIXED_RPC_BRIDGE_V1,
    connectorRouteDigest: binding.connectorRouteDigest, routeLeaseDigest, attemptId: binding.attemptId,
    permitDigest: binding.permitDigest, signal });
}

async function collect(call: (collector: HostResultCollectorV1) => Promise<void>): Promise<unknown> {
  const handoff = createHostResultCollectorV1();
  await call(handoff.collector);
  return handoff.take();
}

class FixturePrivatePort implements IdeaLabHermes021MacosPrivatePortV1 {
  readonly calls: string[] = [];
  async openEnrolledRoute(input: Parameters<IdeaLabHermes021MacosPrivatePortV1["openEnrolledRoute"]>[0],
    collector: HostResultCollectorV1): Promise<void> {
    this.calls.push(`open:${input.transport}`);
    collector.submit({ contractVersion: "control-room-hermes-021-fixed-route-open/v1",
      attemptId: input.attemptId, permitDigest: input.permitDigest,
      connectorRouteDigest: input.connectorRouteDigest, routeLeaseDigest,
      runtimeVersion: IDEA_LAB_HERMES_021_VERSION_V1, runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
      sourceManifestDigest: IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1,
      profileIdentityDigest: input.profileIdentityDigest,
      conversationIdentityDigest: input.conversationIdentityDigest,
      endpointVisibility: "connector_private_loopback", nativeLocatorReturned: false,
      toolsDisabled: true, mcpDisabled: true, pluginsDisabled: true });
  }
  async requestEnrolledOperation(input: Parameters<IdeaLabHermes021MacosPrivatePortV1["requestEnrolledOperation"]>[0],
    collector: HostResultCollectorV1): Promise<void> {
    this.calls.push(input.operation);
    const base = { contractVersion: "control-room-hermes-021-fixed-operation-result/v1",
      sessionIdentityDigest, epochDigest, operation: input.operation };
    if (input.operation === "session.create") collector.submit({ ...base, status: "created",
      conversationIdentityDigest: binding.conversationIdentityDigest, providerCalls: 0 });
    else if (input.operation === "prompt.submit") collector.submit({ ...base, status: "accepted", providerCalls: 1 });
    else if (input.operation === "session.events.since") collector.submit({ ...base, status: "replayed",
      truncated: false, latestSequence: 2, events: [{ sequence: 1, type: "message.start" },
        { sequence: 2, type: "message.complete", finalText: "{}" }] });
    else if (input.operation === "session.status") collector.submit({ ...base, status: "settled", providerCalls: 1 });
    else if (input.operation === "session.usage") collector.submit({ ...base, status: "settled", inputUnits: 1,
      outputUnits: 1, reasoningUnits: 0, totalUnits: 2, calls: 1, costUsd: 0 });
    else if (input.operation === "session.interrupt") collector.submit({ ...base, status: "already_settled", providerCalls: 1 });
    else collector.submit({ ...base, status: "closed", providerCalls: 1 });
  }
  async closeEnrolledRoute(input: Parameters<IdeaLabHermes021MacosPrivatePortV1["closeEnrolledRoute"]>[0],
    collector: HostResultCollectorV1): Promise<void> {
    this.calls.push("route.close");
    collector.submit(closeReceipt(input));
  }
}

async function open(connector: IdeaLabHermes021ConnectorPrivateRpcV1,
  signal: HostCancellationSignalV1 = createHostCancellationControllerV1().signal): Promise<unknown> {
  return collect((collector) => connector.openFixedRoute(openInput(signal), collector));
}
async function request(connector: IdeaLabHermes021ConnectorPrivateRpcV1, operation: Operation): Promise<unknown> {
  return collect((collector) => connector.requestFixedOperation(operationInput(operation), collector));
}
async function close(connector: IdeaLabHermes021ConnectorPrivateRpcV1): Promise<unknown> {
  return collect((collector) => connector.closeFixedRoute(closeInput(), collector));
}

test("CR12B-IDEA-110H opaque cancellation is frozen, single-use, and Proxy rejecting", () => {
  const controller = createHostCancellationControllerV1();
  assert.equal(Object.isFrozen(controller.signal), true);
  assert.deepEqual(Reflect.ownKeys(controller.signal), []);
  assert.equal(exactHostCancellationSignalV1(controller.signal), true);
  assert.equal(exactHostCancellationSignalV1(new Proxy(controller.signal, {})), false);
  let calls = 0;
  const subscription = subscribeHostCancellationV1(controller.signal, () => { calls += 1; });
  assert.equal(subscription?.status, "subscribed");
  assert.equal(hostCancellationAbortedV1(controller.signal), false);
  controller.abort(); controller.abort();
  assert.deepEqual([calls, hostCancellationAbortedV1(controller.signal)], [1, true]);
  const late = subscribeHostCancellationV1(controller.signal, () => { calls += 1; });
  assert.equal(late?.status, "aborted");
  assert.equal(calls, 1);
});

test("CR12B-IDEA-110F binds one Mac-owned route to the exact fixed lifecycle", async () => {
  const port = new FixturePrivatePort(), connector = new IdeaLabHermes021MacosConnectorV1(port);
  const opened = await open(connector) as { nativeLocatorReturned: boolean };
  assert.equal(opened.nativeLocatorReturned, false);
  for (const operation of ["session.create", "prompt.submit", "session.events.since", "session.status",
    "session.usage", "session.interrupt", "session.status", "session.close"] as Operation[]) {
    assert.equal((await request(connector, operation) as { operation: string }).operation, operation);
  }
  const closed = await close(connector) as { retainedNativeReferenceCount: number };
  assert.equal(closed.retainedNativeReferenceCount, 0);
  assert.deepEqual(port.calls, ["open:local_loopback", "session.create", "prompt.submit", "session.events.since",
    "session.status", "session.usage", "session.interrupt", "session.status", "session.close", "route.close"]);
});

test("CR12B-IDEA-110F rejects order, binding, parameter, and cleanup bypass before private dispatch", async () => {
  const port = new FixturePrivatePort(), connector = new IdeaLabHermes021MacosConnectorV1(port);
  await open(connector);
  await assert.rejects(() => request(connector, "prompt.submit"), IdeaLabErrorV1);
  const wrong = { ...operationInput("session.create"), permitDigest: digest("wrong") };
  await assert.rejects(() => collect((collector) => connector.requestFixedOperation(wrong, collector)), IdeaLabErrorV1);
  const extra = { ...operationInput("session.create"), parameters: { ...parameters["session.create"], extra: true } };
  await assert.rejects(() => collect((collector) => connector.requestFixedOperation(extra, collector)), IdeaLabErrorV1);
  await request(connector, "session.create");
  await assert.rejects(() => close(connector), IdeaLabErrorV1);
  assert.deepEqual(port.calls, ["open:local_loopback", "session.create"]);
});

test("CR12B-IDEA-110F makes an uncertain open close-only and never retries it", async () => {
  let opens = 0, closes = 0;
  const port: IdeaLabHermes021MacosPrivatePortV1 = {
    async openEnrolledRoute() { opens += 1; throw new Error("outcome unknown"); },
    async requestEnrolledOperation() { throw new Error("must not run"); },
    async closeEnrolledRoute(input, collector) { closes += 1; collector.submit(closeReceipt(input)); },
  };
  const connector = new IdeaLabHermes021MacosConnectorV1(port);
  await assert.rejects(() => open(connector));
  await assert.rejects(() => open(connector), IdeaLabErrorV1);
  const withoutLease = { ...closeInput() }; delete (withoutLease as { routeLeaseDigest?: string }).routeLeaseDigest;
  await collect((collector) => connector.closeFixedRoute(withoutLease, collector));
  await assert.rejects(() => collect((collector) => connector.closeFixedRoute(withoutLease, collector)), IdeaLabErrorV1);
  assert.deepEqual([opens, closes], [1, 1]);
});

test("CR12B-IDEA-110G aborts and settles an in-flight call but refuses route close before session cleanup", async () => {
  const events: string[] = [];
  class SlowPort extends FixturePrivatePort {
    override async requestEnrolledOperation(input: Parameters<IdeaLabHermes021MacosPrivatePortV1["requestEnrolledOperation"]>[0],
      collector: HostResultCollectorV1): Promise<void> {
      if (input.operation !== "session.create") return super.requestEnrolledOperation(input, collector);
      events.push("request.started");
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => {
        events.push("request.aborted"); resolve();
      }, { once: true }));
      collector.submit({ contractVersion: "control-room-hermes-021-fixed-operation-result/v1",
        sessionIdentityDigest, epochDigest, operation: input.operation, status: "created",
        conversationIdentityDigest: binding.conversationIdentityDigest, providerCalls: 0 });
      events.push("request.returned");
    }
    override async closeEnrolledRoute(input: Parameters<IdeaLabHermes021MacosPrivatePortV1["closeEnrolledRoute"]>[0],
      collector: HostResultCollectorV1): Promise<void> {
      events.push("close.started"); collector.submit(closeReceipt(input));
    }
  }
  const connector = new IdeaLabHermes021MacosConnectorV1(new SlowPort());
  await open(connector);
  const pending = request(connector, "session.create");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const closing = close(connector);
  await assert.rejects(() => pending, IdeaLabErrorV1);
  await assert.rejects(() => closing, IdeaLabErrorV1);
  for (const operation of ["session.interrupt", "session.status", "session.close"] as Operation[]) {
    await request(connector, operation);
  }
  await close(connector);
  assert.deepEqual(events, ["request.started", "request.aborted", "request.returned", "close.started"]);
});

test("CR12B-IDEA-110I contains private native-signal poisoning and still completes mandatory cleanup", async () => {
  let entered!: () => void, release!: () => void, traps = 0;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  class PoisoningPort extends FixturePrivatePort {
    override async requestEnrolledOperation(
      input: Parameters<IdeaLabHermes021MacosPrivatePortV1["requestEnrolledOperation"]>[0],
      collector: HostResultCollectorV1,
    ): Promise<void> {
      if (input.operation !== "session.create") return super.requestEnrolledOperation(input, collector);
      const eventMapKey = Reflect.ownKeys(input.signal).find((key) => String(key) === "Symbol(kEvents)");
      assert.ok(eventMapKey);
      Object.defineProperty(input.signal, eventMapKey, { ...Object.getOwnPropertyDescriptor(input.signal, eventMapKey),
        value: new Proxy(new Map(), { get(target, property, receiver) {
          traps += 1; return Reflect.get(target, property, receiver);
        } }) });
      entered(); await gate;
      collector.submit({ contractVersion: "control-room-hermes-021-fixed-operation-result/v1",
        sessionIdentityDigest, epochDigest, operation: input.operation, status: "created",
        conversationIdentityDigest: binding.conversationIdentityDigest, providerCalls: 0 });
    }
  }
  const port = new PoisoningPort(), connector = new IdeaLabHermes021MacosConnectorV1(port);
  await open(connector);
  const pending = request(connector, "session.create"); await started;
  const closing = close(connector); await Promise.resolve(); release();
  await assert.rejects(() => pending, (error) => error instanceof IdeaLabErrorV1);
  await assert.rejects(() => closing, (error) => error instanceof IdeaLabErrorV1);
  assert.ok(traps >= 1);
  for (const operation of ["session.interrupt", "session.status", "session.close"] as Operation[]) {
    await request(connector, operation);
  }
  const receipt = await close(connector) as { retainedNativeReferenceCount: number };
  assert.equal(receipt.retainedNativeReferenceCount, 0);
  assert.equal(port.calls.at(-1), "route.close");
});

test("CR12B-IDEA-110I ignores post-import native global and prototype substitution", async () => {
  const nativePrototype = AbortController.prototype,
    original = Object.getOwnPropertyDescriptor(globalThis, "AbortController"),
    abortDescriptor = Object.getOwnPropertyDescriptor(nativePrototype, "abort"),
    signalDescriptor = Object.getOwnPropertyDescriptor(nativePrototype, "signal");
  assert.ok(original); assert.ok(abortDescriptor); assert.ok(signalDescriptor);
  const sentinel = new Error("hostile ambient constructor"); let behavior = 0, entered!: () => void;
  class HostileAbortController { constructor() { behavior += 1; throw sentinel; } }
  Object.defineProperty(globalThis, "AbortController", { ...original, value: HostileAbortController });
  Object.defineProperty(nativePrototype, "abort", { ...abortDescriptor,
    value() { behavior += 1; throw sentinel; } });
  Object.defineProperty(nativePrototype, "signal", { ...signalDescriptor,
    get() { behavior += 1; throw sentinel; } });
  try {
    const started = new Promise<void>((resolve) => { entered = resolve; });
    class AwaitAbortPort extends FixturePrivatePort {
      override async openEnrolledRoute(
        input: Parameters<IdeaLabHermes021MacosPrivatePortV1["openEnrolledRoute"]>[0],
        collector: HostResultCollectorV1,
      ): Promise<void> {
        entered(); await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
        return super.openEnrolledRoute(input, collector);
      }
    }
    const port = new AwaitAbortPort(), connector = new IdeaLabHermes021MacosConnectorV1(port),
      cancellation = createHostCancellationControllerV1(), opening = open(connector, cancellation.signal);
    await started; cancellation.abort();
    await assert.rejects(() => opening, (error) => error instanceof IdeaLabErrorV1 && error !== sentinel);
    assert.deepEqual([behavior, port.calls], [0, ["open:local_loopback"]]);
  } finally {
    Object.defineProperty(globalThis, "AbortController", original);
    Object.defineProperty(nativePrototype, "abort", abortDescriptor);
    Object.defineProperty(nativePrototype, "signal", signalDescriptor);
  }
});

test("CR12B-IDEA-110I ignores post-import collection and host-operation substitution", async () => {
  const port = new FixturePrivatePort(), connector = new IdeaLabHermes021MacosConnectorV1(port),
    input = openInput(), handoff = createHostResultCollectorV1();
  const setDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Set"),
    promiseDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Promise"),
    freezeDescriptor = Object.getOwnPropertyDescriptor(Object, "freeze"),
    applyDescriptor = Object.getOwnPropertyDescriptor(Reflect, "apply"),
    constructDescriptor = Object.getOwnPropertyDescriptor(Reflect, "construct");
  assert.ok(setDescriptor); assert.ok(promiseDescriptor); assert.ok(freezeDescriptor);
  assert.ok(applyDescriptor); assert.ok(constructDescriptor);
  const sentinel = new Error("hostile ambient host operation"); let behavior = 0, rejected: unknown;
  class HostileSet { constructor() { behavior += 1; throw sentinel; } }
  class HostilePromise { constructor() { behavior += 1; throw sentinel; } }
  const hostile = () => { behavior += 1; throw sentinel; };
  Object.defineProperty(globalThis, "Set", { ...setDescriptor, value: HostileSet });
  Object.defineProperty(globalThis, "Promise", { ...promiseDescriptor, value: HostilePromise });
  Object.defineProperty(Object, "freeze", { ...freezeDescriptor, value: hostile });
  Object.defineProperty(Reflect, "apply", { ...applyDescriptor, value: hostile });
  Object.defineProperty(Reflect, "construct", { ...constructDescriptor, value: hostile });
  try {
    await connector.openFixedRoute(input, handoff.collector);
  } catch (error) { rejected = error; }
  finally {
    Object.defineProperty(globalThis, "Set", setDescriptor);
    Object.defineProperty(globalThis, "Promise", promiseDescriptor);
    Object.defineProperty(Object, "freeze", freezeDescriptor);
    Object.defineProperty(Reflect, "apply", applyDescriptor);
    Object.defineProperty(Reflect, "construct", constructDescriptor);
  }
  assert.equal(rejected, undefined);
  assert.equal(behavior, 0);
  assert.deepEqual(port.calls, ["open:local_loopback"]);
  assert.equal((handoff.take() as { nativeLocatorReturned: boolean }).nativeLocatorReturned, false);
});

test("CR12B-IDEA-110L shared safety walkers reject secret input under post-import traversal substitution", async () => {
  const port = new FixturePrivatePort(), connector = new IdeaLabHermes021MacosConnectorV1(port);
  await open(connector); await request(connector, "session.create");
  const input = { ...operationInput("prompt.submit"), parameters: Object.freeze({
    ...parameters["prompt.submit"], safeInstruction: "api_key=unsafe-value-123",
  }) }, handoff = createHostResultCollectorV1();
  const entriesDescriptor = Object.getOwnPropertyDescriptor(Object, "entries"),
    forEachDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "forEach"),
    someDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, "some"),
    execDescriptor = Object.getOwnPropertyDescriptor(RegExp.prototype, "exec");
  assert.ok(entriesDescriptor); assert.ok(forEachDescriptor); assert.ok(someDescriptor); assert.ok(execDescriptor);
  const sentinel = new Error("hostile safety traversal"), behavior: string[] = [];
  const hostile = (label: string) => () => { behavior.push(label); throw sentinel; };
  let rejected: unknown;
  Object.defineProperty(Object, "entries", { ...entriesDescriptor, value: hostile("Object.entries") });
  Object.defineProperty(Array.prototype, "forEach", { ...forEachDescriptor, value: hostile("Array.forEach") });
  Object.defineProperty(Array.prototype, "some", { ...someDescriptor, value: hostile("Array.some") });
  Object.defineProperty(RegExp.prototype, "exec", { ...execDescriptor, value: hostile("RegExp.exec") });
  try { await connector.requestFixedOperation(input, handoff.collector); }
  catch (error) { rejected = error; }
  finally {
    Object.defineProperty(Object, "entries", entriesDescriptor);
    Object.defineProperty(Array.prototype, "forEach", forEachDescriptor);
    Object.defineProperty(Array.prototype, "some", someDescriptor);
    Object.defineProperty(RegExp.prototype, "exec", execDescriptor);
  }
  assert.deepEqual(behavior, []);
  assert.ok(rejected instanceof IdeaLabErrorV1);
  assert.equal(rejected.safeCode, "redaction_rejected");
  assert.notEqual(rejected, sentinel);
  assert.deepEqual(port.calls, ["open:local_loopback", "session.create"]);
});

test("CR12B-IDEA-110F retains private-port receivers and rejects behavioral constructor wrappers", async () => {
  const port = new FixturePrivatePort(), connector = new IdeaLabHermes021MacosConnectorV1(port);
  await open(connector);
  assert.deepEqual(port.calls, ["open:local_loopback"]);
  let behavior = 0;
  const accessor = {} as IdeaLabHermes021MacosPrivatePortV1;
  Object.defineProperty(accessor, "openEnrolledRoute", { get() { behavior += 1; return () => undefined; } });
  Object.defineProperties(accessor, {
    requestEnrolledOperation: { value: async () => undefined }, closeEnrolledRoute: { value: async () => undefined },
  });
  assert.throws(() => new IdeaLabHermes021MacosConnectorV1(accessor), IdeaLabErrorV1);
  assert.throws(() => new IdeaLabHermes021MacosConnectorV1(new Proxy(port, {
    get() { behavior += 1; return undefined; },
  })), IdeaLabErrorV1);
  assert.equal(behavior, 0);
});

test("CR12B-IDEA-110F rejects accessor and Proxy request inputs without behavior", async () => {
  const port = new FixturePrivatePort(), connector = new IdeaLabHermes021MacosConnectorV1(port);
  await open(connector);
  let behavior = 0;
  const accessor = { ...operationInput("session.create") };
  Object.defineProperty(accessor, "parameters", { enumerable: true, get() { behavior += 1; return {}; } });
  await assert.rejects(() => collect((collector) => connector.requestFixedOperation(accessor, collector)), IdeaLabErrorV1);
  await assert.rejects(() => collect((collector) => connector.requestFixedOperation(new Proxy(
    operationInput("session.create"), { ownKeys() { behavior += 1; return []; } }), collector)), IdeaLabErrorV1);
  assert.equal(behavior, 0);
  assert.deepEqual(port.calls, ["open:local_loopback"]);
});

test("CR12B-IDEA-110F rejects locator-shaped and behavioral private receipts before returning them", async () => {
  const leaky: IdeaLabHermes021MacosPrivatePortV1 = {
    async openEnrolledRoute(input, collector) {
      collector.submit({ contractVersion: "control-room-hermes-021-fixed-route-open/v1",
        attemptId: input.attemptId, permitDigest: input.permitDigest, connectorRouteDigest: input.connectorRouteDigest,
        routeLeaseDigest, runtimeVersion: IDEA_LAB_HERMES_021_VERSION_V1,
        runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
        sourceManifestDigest: IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1,
        profileIdentityDigest: input.profileIdentityDigest,
        conversationIdentityDigest: input.conversationIdentityDigest,
        endpointVisibility: "connector_private_loopback", nativeLocatorReturned: false,
        toolsDisabled: true, mcpDisabled: true, pluginsDisabled: true, hostname: "forbidden.example" });
    },
    async requestEnrolledOperation() { throw new Error("must not run"); },
    async closeEnrolledRoute(input, collector) { collector.submit(closeReceipt(input)); },
  };
  await assert.rejects(() => open(new IdeaLabHermes021MacosConnectorV1(leaky)), IdeaLabErrorV1);

  let behavior = 0;
  class BehavioralReceiptPort extends FixturePrivatePort {
    override async requestEnrolledOperation(input: Parameters<IdeaLabHermes021MacosPrivatePortV1["requestEnrolledOperation"]>[0],
      collector: HostResultCollectorV1): Promise<void> {
      const result = { contractVersion: "control-room-hermes-021-fixed-operation-result/v1",
        sessionIdentityDigest, epochDigest, operation: input.operation, status: "created",
        conversationIdentityDigest: binding.conversationIdentityDigest, providerCalls: 0 };
      Object.defineProperty(result, "providerCalls", { enumerable: true, get() { behavior += 1; return 0; } });
      collector.submit(result);
    }
  }
  const connector = new IdeaLabHermes021MacosConnectorV1(new BehavioralReceiptPort());
  await open(connector);
  await assert.rejects(() => request(connector, "session.create"), IdeaLabErrorV1);
  assert.equal(behavior, 0);
});

test("CR12B-IDEA-110H rejects native, poisoned, and pre-aborted signals before private dispatch", async () => {
  const behavioralPort = new FixturePrivatePort();
  const controller = new AbortController();
  let behavior = 0;
  Object.defineProperty(controller.signal, "aborted", {
    configurable: true, enumerable: true, get() { behavior += 1; return false; },
  });
  await assert.rejects(() => open(new IdeaLabHermes021MacosConnectorV1(behavioralPort),
    controller.signal as unknown as HostCancellationSignalV1),
    IdeaLabErrorV1);
  assert.equal(behavior, 0);
  assert.deepEqual(behavioralPort.calls, []);

  const poisonedPort = new FixturePrivatePort(), poisoned = new AbortController().signal;
  const eventMapKey = Reflect.ownKeys(poisoned).find((key) => String(key) === "Symbol(kEvents)");
  assert.ok(eventMapKey);
  let traps = 0;
  Object.defineProperty(poisoned, eventMapKey, { ...Object.getOwnPropertyDescriptor(poisoned, eventMapKey),
    value: new Proxy(new Map(), { get(target, property, receiver) {
      traps += 1; return Reflect.get(target, property, receiver);
    } }) });
  await assert.rejects(() => open(new IdeaLabHermes021MacosConnectorV1(poisonedPort),
    poisoned as unknown as HostCancellationSignalV1), IdeaLabErrorV1);
  assert.equal(traps, 0);
  assert.deepEqual(poisonedPort.calls, []);

  const preOpenPort = new FixturePrivatePort(), preOpen = createHostCancellationControllerV1();
  preOpen.abort();
  await assert.rejects(() => open(new IdeaLabHermes021MacosConnectorV1(preOpenPort), preOpen.signal),
    IdeaLabErrorV1);
  assert.deepEqual(preOpenPort.calls, []);

  const operationPort = new FixturePrivatePort(), connector = new IdeaLabHermes021MacosConnectorV1(operationPort);
  await open(connector);
  const preOperation = createHostCancellationControllerV1(); preOperation.abort();
  await assert.rejects(() => collect((collector) => connector.requestFixedOperation(
    operationInput("session.create", preOperation.signal), collector)), IdeaLabErrorV1);
  assert.deepEqual(operationPort.calls, ["open:local_loopback"]);
  await request(connector, "session.create");
});

test("CR12B-IDEA-110G replaces private errors at open, operation, and close boundaries", async () => {
  const sentinel = new Error("private hostname and credential detail");
  async function expectSafe(call: () => Promise<unknown>): Promise<void> {
    await assert.rejects(call, (error: unknown) => error instanceof IdeaLabErrorV1
      && error !== sentinel && error.message === "integrity_failed");
  }
  const openPort: IdeaLabHermes021MacosPrivatePortV1 = {
    async openEnrolledRoute() { throw sentinel; },
    async requestEnrolledOperation() { throw new Error("must not run"); },
    async closeEnrolledRoute() { throw new Error("must not run"); },
  };
  await expectSafe(() => open(new IdeaLabHermes021MacosConnectorV1(openPort)));

  class OperationErrorPort extends FixturePrivatePort {
    override async requestEnrolledOperation(): Promise<void> { throw sentinel; }
  }
  const operationConnector = new IdeaLabHermes021MacosConnectorV1(new OperationErrorPort());
  await open(operationConnector);
  await expectSafe(() => request(operationConnector, "session.create"));

  class CloseErrorPort extends FixturePrivatePort {
    override async closeEnrolledRoute(): Promise<void> { throw sentinel; }
  }
  const closeConnector = new IdeaLabHermes021MacosConnectorV1(new CloseErrorPort());
  await open(closeConnector);
  await expectSafe(() => close(closeConnector));
});

test("CR12B-IDEA-110G requires opaque and pairwise-distinct authority digests", async () => {
  const fields = ["connectionIdentityDigest", "connectorRouteDigest", "permitDigest",
    "profileIdentityDigest", "conversationIdentityDigest"] as const;
  for (let left = 0; left < fields.length; left += 1) {
    for (let right = left + 1; right < fields.length; right += 1) {
      const port = new FixturePrivatePort(), connector = new IdeaLabHermes021MacosConnectorV1(port);
      const aliased = { ...openInput(), [fields[right]!]: openInput()[fields[left]!] };
      await assert.rejects(() => collect((collector) => connector.openFixedRoute(aliased, collector)), IdeaLabErrorV1);
      assert.deepEqual(port.calls, []);
    }
  }
  const locatorPort = new FixturePrivatePort();
  await assert.rejects(() => collect((collector) => new IdeaLabHermes021MacosConnectorV1(locatorPort)
    .openFixedRoute({ ...openInput(), connectionIdentityDigest: "host.example:22" }, collector)), IdeaLabErrorV1);
  assert.deepEqual(locatorPort.calls, []);

  for (const field of fields) {
    const leaseAliasPort: IdeaLabHermes021MacosPrivatePortV1 = {
      async openEnrolledRoute(input, collector) {
        collector.submit({ contractVersion: "control-room-hermes-021-fixed-route-open/v1",
          attemptId: input.attemptId, permitDigest: input.permitDigest,
          connectorRouteDigest: input.connectorRouteDigest, routeLeaseDigest: input[field],
          runtimeVersion: IDEA_LAB_HERMES_021_VERSION_V1, runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1,
          sourceManifestDigest: IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1,
          profileIdentityDigest: input.profileIdentityDigest,
          conversationIdentityDigest: input.conversationIdentityDigest,
          endpointVisibility: "connector_private_loopback", nativeLocatorReturned: false,
          toolsDisabled: true, mcpDisabled: true, pluginsDisabled: true });
      },
      async requestEnrolledOperation() { throw new Error("must not run"); },
      async closeEnrolledRoute() { throw new Error("must not run"); },
    };
    await assert.rejects(() => open(new IdeaLabHermes021MacosConnectorV1(leaseAliasPort)), IdeaLabErrorV1);
  }
});

test("CR12B-IDEA-110G rejects aliased session and epoch receipt identities", async () => {
  for (const [session, epoch] of [[binding.connectorRouteDigest, epochDigest],
    [sessionIdentityDigest, sessionIdentityDigest]] as const) {
    class AliasedOperationPort extends FixturePrivatePort {
      override async requestEnrolledOperation(input: Parameters<IdeaLabHermes021MacosPrivatePortV1["requestEnrolledOperation"]>[0],
        collector: HostResultCollectorV1): Promise<void> {
        collector.submit({ contractVersion: "control-room-hermes-021-fixed-operation-result/v1",
          sessionIdentityDigest: session, epochDigest: epoch, operation: input.operation, status: "created",
          conversationIdentityDigest: binding.conversationIdentityDigest, providerCalls: 0 });
      }
    }
    const connector = new IdeaLabHermes021MacosConnectorV1(new AliasedOperationPort());
    await open(connector);
    await assert.rejects(() => request(connector, "session.create"), IdeaLabErrorV1);
  }
});

test("CR12B-IDEA-110F remains disabled until a reviewed private port, signer, and route are enrolled", () => {
  assert.deepEqual(IDEA_LAB_HERMES_021_MACOS_CONNECTOR_DISABLED_V1, {
    contractVersion: "control-room-hermes-021-macos-connector/v1", platform: "macos",
    privatePortConfigured: false, trustedNodeSignerEnrolled: false, signedRouteEnrolled: false,
    connectionAttemptsMade: 0, sshConnectionsMade: 0, nativeAttemptsMade: 0, providerCallsMade: 0,
    livePanelEligible: false, grantsExecutionAuthority: false,
  });
  assert.equal(Object.isFrozen(IDEA_LAB_HERMES_021_MACOS_CONNECTOR_DISABLED_V1), true);
});

test("CR12B-IDEA-110F source owns no process, filesystem, network, SSH, credential, or Hermes client", async () => {
  const source = await readFile("src/idea-lab/v1/hermes-021-macos-connector.ts", "utf8");
  for (const forbidden of ['from "node:child_process"', 'from "node:fs"', 'from "node:net"', "fetch(", "spawn(",
    "execFile(", "createPostgresClient(", "process.env", "auth.json", "Keychain", "privateKey", "gatewayUrl"])
    assert.equal(source.includes(forbidden), false, forbidden);
});
