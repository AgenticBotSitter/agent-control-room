import assert from "node:assert/strict";
import test from "node:test";
import { createNativeConnector, type NativeConnectorSettings } from "../src/node-bridge/native-connector";
import type { NativeHttpClient } from "../src/node-bridge/native-http-host";
import type { NativeHttpRequest } from "../src/harness/v1/native-http-exchange";
import type { NativeSnapshot, NativeState } from "../src/harness/v1/native-run-contracts";
import { binding, instant, nativeRunId } from "./hermes-native-fixture";

type Runtime = Parameters<typeof createNativeConnector>[0];
type RuntimeTransport = Parameters<Runtime["openWire"]>[0];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accepted, denied) => { resolve = accepted; reject = denied; });
  return { promise, resolve, reject };
}

function snapshot(state: NativeState, availability: NativeSnapshot["availability"] = "current"): NativeSnapshot {
  return { binding, version: 1, state, nativeRunId, observedAt: instant, upstreamUpdatedAt: instant,
    availability, streamAttempted: false, stopAttempted: false, resultText: null, usage: null,
    lastActivity: "status_resnapshot", safeReason: "none" };
}

type FixtureOptions = {
  dispatchAtExchange?: number | false;
  accepted?: boolean;
  start?: readonly NativeSnapshot[];
  polls?: readonly NativeSnapshot[];
  failAtExchange?: number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  runtimeClose?: () => Promise<void>;
  clientClose?: () => Promise<void>;
  settings?: Partial<NativeConnectorSettings>;
};

function fixture(options: FixtureOptions = {}) {
  const calls = { runtime: [] as string[], native: [] as string[], commands: [] as NativeHttpRequest[],
    waits: [] as number[], runtimeCloses: 0, clientCloses: 0 };
  const connection = "connection:http:00000000-0000-4000-8000-000000000001";
  const dispatchAt = options.dispatchAtExchange === false ? -1 : (options.dispatchAtExchange ?? 2);
  let accepted = options.accepted ?? false, exchangeCount = 0, transport: RuntimeTransport | undefined;
  let startIndex = 0, pollIndex = 0;
  const startValues = [...(options.start ?? [snapshot("running")])];
  const pollValues = [...(options.polls ?? [snapshot("completed")])];
  const choose = (values: NativeSnapshot[], index: number) => structuredClone(values[Math.min(index, values.length - 1)]);
  const runtime = {
    nodeId: "node:test", queueId: "queue:test", grantsExecutionAuthority: false as const,
    hasAcceptedDispatch() { calls.runtime.push("ready"); return accepted; },
    async openWire(value: RuntimeTransport) { calls.runtime.push("openWire"); transport = value; },
    async receiveWire(packet: string | Uint8Array) {
      calls.runtime.push("receiveWire"); if (packet === "dispatch") accepted = true;
    },
    async disconnected() { calls.runtime.push("disconnected"); },
    async start() {
      calls.native.push("start"); await transport?.send("snapshot:start");
      return choose(startValues, startIndex++);
    },
    async poll() {
      calls.native.push("poll"); await transport?.send("snapshot:poll");
      return choose(pollValues, pollIndex++);
    },
    async observe() { calls.native.push("observe"); return snapshot("running"); },
    async stop() { calls.native.push("stop"); return snapshot("stopping"); },
    async report() { calls.native.push("report"); return { disposition: "duplicate" as const }; },
    readResult() { throw new Error("unexpected_result_read"); },
    async close() { calls.runtimeCloses++; await options.runtimeClose?.(); },
  };
  const client: NativeHttpClient = {
    async exchange(command) {
      calls.commands.push(structuredClone(command));
      if (command.operation === "exchange") {
        exchangeCount++;
        if (exchangeCount === options.failAtExchange) throw new Error("synthetic_http_failure");
      }
      const packets = command.operation === "exchange" && exchangeCount === dispatchAt
        ? ["dispatch"] : [];
      return { schema: "control-room.native-http/v1", connection, packets, more: false };
    },
    async close() { calls.clientCloses++; await options.clientClose?.(); },
  };
  const sources = {
    assertCurrent() { calls.runtime.push("current"); },
    async wait(milliseconds: number, signal: AbortSignal) {
      calls.waits.push(milliseconds);
      if (options.wait) await options.wait(milliseconds, signal);
    },
  };
  const settings: NativeConnectorSettings = { maxCycles: 3, intervalMs: 25, timeoutMs: 1000, ...options.settings };
  const connector = createNativeConnector(runtime as unknown as Runtime, client, settings, sources);
  return { connector, runtime, client, sources, settings, calls, connection };
}

function operations(commands: readonly NativeHttpRequest[]) {
  return commands.map(command => command.operation);
}

test("construction is inert and captures supplied configuration and methods", async () => {
  const f = fixture({ dispatchAtExchange: false, settings: { maxCycles: 1 } });
  assert.deepEqual(f.calls, { runtime: [], native: [], commands: [], waits: [], runtimeCloses: 0, clientCloses: 0 });
  assert.equal(Object.isFrozen(f.connector), true);

  f.settings.maxCycles = 9;
  f.runtime.openWire = async () => { throw new Error("mutated_runtime_method"); };
  f.runtime.close = async () => { throw new Error("mutated_runtime_close"); };
  f.client.exchange = async () => { throw new Error("mutated_client_method"); };
  f.client.close = async () => { throw new Error("mutated_client_close"); };
  f.sources.assertCurrent = () => { throw new Error("mutated_current_check"); };
  f.sources.wait = async () => { throw new Error("mutated_wait"); };

  const result = await f.connector.run("initial", new AbortController().signal);
  assert.deepEqual(result, { disposition: "bounded", state: "waiting", cycles: 1 });
  assert.deepEqual(operations(f.calls.commands), ["open", "exchange", "exchange", "close"]);
  assert.equal(f.calls.runtimeCloses, 1); assert.equal(f.calls.clientCloses, 1);
  assert.deepEqual(f.calls.native, []); assert.deepEqual(f.calls.waits, []);
});

test("initial mode starts once, polls thereafter, and flushes each observation in FIFO order", async () => {
  const f = fixture({ start: [snapshot("running")], polls: [snapshot("completed")] });
  const result = await f.connector.run("initial", new AbortController().signal);
  assert.deepEqual(result, { disposition: "terminal", state: "completed", cycles: 2 });
  assert.deepEqual(f.calls.native, ["start", "poll"]);
  assert.deepEqual(f.calls.commands.flatMap(command => command.operation === "exchange" && command.packet
    ? [command.packet] : []), ["snapshot:start", "snapshot:poll"]);
  assert.equal(f.calls.commands.filter(command => command.operation === "open").length, 1);
  assert.equal(f.calls.commands.filter(command => command.operation === "close").length, 1);
  assert.deepEqual(f.calls.waits, [25]);
});

test("recover mode never starts and polls only after recorded dispatch is available", async () => {
  const f = fixture({ accepted: true, dispatchAtExchange: false, polls: [snapshot("completed")] });
  const result = await f.connector.run("recover", new AbortController().signal);
  assert.deepEqual(result, { disposition: "terminal", state: "completed", cycles: 1 });
  assert.deepEqual(f.calls.native, ["poll"]);
  assert.equal((f.calls.commands[0] as Extract<NativeHttpRequest, { operation: "open" }>).mode, "recover");
  assert.deepEqual(f.calls.commands.flatMap(command => command.operation === "exchange" && command.packet
    ? [command.packet] : []), ["snapshot:poll"]);
});

test("bounded waiting performs no native execution or stop", async () => {
  const f = fixture({ dispatchAtExchange: false, settings: { maxCycles: 3, intervalMs: 40 } });
  const result = await f.connector.run("initial", new AbortController().signal);
  assert.deepEqual(result, { disposition: "bounded", state: "waiting", cycles: 3 });
  assert.deepEqual(f.calls.waits, [40, 40]);
  assert.deepEqual(f.calls.native, []);
  assert.equal(f.calls.commands.filter(command => command.operation === "open").length, 1);
  assert.equal(f.calls.commands.filter(command => command.operation === "exchange").length, 4);
});

test("ambiguous or unavailable native state is uncertain without poll, stop, or retry", async () => {
  for (const value of [snapshot("ambiguous"), snapshot("running", "offline")]) {
    const f = fixture({ start: [value] });
    const result = await f.connector.run("initial", new AbortController().signal);
    assert.deepEqual(result, { disposition: "uncertain", state: value.state, cycles: 1 });
    assert.deepEqual(f.calls.native, ["start"]);
    assert.equal(f.calls.commands.filter(command => command.operation === "open").length, 1);
    assert.equal(f.calls.commands.filter(command => command.operation === "close").length, 1);
  }
});

test("HTTP uncertainty is not retried and never invents native cleanup", async () => {
  const f = fixture({ failAtExchange: 2 });
  await assert.rejects(f.connector.run("initial", new AbortController().signal), { message: "native_connector_unavailable" });
  assert.equal(f.calls.commands.filter(command => command.operation === "open").length, 1);
  assert.equal(f.calls.commands.filter(command => command.operation === "exchange").length, 2);
  assert.deepEqual(f.calls.native, []);
  assert.equal(f.calls.runtimeCloses, 1); assert.equal(f.calls.clientCloses, 1);
});

test("one run attempt owns overlap and caller abort invalidates and drains it", async () => {
  const entered = deferred(), waiting = deferred();
  const f = fixture({ dispatchAtExchange: false, settings: { maxCycles: 2 }, wait: async (_milliseconds, signal) => {
    entered.resolve();
    await Promise.race([waiting.promise, new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("synthetic_wait_aborted")), { once: true });
    })]);
  } });
  const controller = new AbortController(), running = f.connector.run("initial", controller.signal);
  await entered.promise;
  assert.throws(() => f.connector.run("recover", new AbortController().signal), { message: "native_connector_unavailable" });
  controller.abort();
  await assert.rejects(running, { message: "native_connector_unavailable" });
  assert.throws(() => f.connector.run("initial", new AbortController().signal), { message: "native_connector_unavailable" });
  assert.deepEqual(f.calls.native, []);
  assert.equal(f.calls.runtimeCloses, 1); assert.equal(f.calls.clientCloses, 1);
});

test("the wall deadline covers a wait and closes without native stop", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = deferred();
  const f = fixture({ dispatchAtExchange: false, settings: { maxCycles: 2, timeoutMs: 50 }, wait: async (_milliseconds, signal) => {
    entered.resolve();
    await new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("synthetic_deadline")), { once: true });
    });
  } });
  const running = f.connector.run("initial", new AbortController().signal);
  await entered.promise;
  const rejected = assert.rejects(running, { message: "native_connector_unavailable" });
  t.mock.timers.tick(50); await rejected;
  assert.deepEqual(f.calls.native, []);
  assert.equal(f.calls.runtimeCloses, 1); assert.equal(f.calls.clientCloses, 1);
});

test("a nonsettling queued wait leaves deadline cleanup uncertain and cannot revive the run", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = deferred(), waiting = deferred();
  const f = fixture({ dispatchAtExchange: false, settings: { maxCycles: 2, timeoutMs: 50 }, wait: async () => {
    entered.resolve(); await waiting.promise;
  } });
  const running = f.connector.run("initial", new AbortController().signal);
  await entered.promise;
  const rejected = assert.rejects(running, { message: "native_connector_close_uncertain" });
  t.mock.timers.tick(50); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(10_000); await rejected;
  waiting.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(f.calls.native, []);
  assert.equal(f.calls.runtimeCloses, 1); assert.equal(f.calls.clientCloses, 1);
  await assert.rejects(f.connector.close(), { message: "native_connector_close_uncertain" });
});

test("nonsettling raw close is memoized as uncertain after the bounded drain", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rawClose = deferred();
  const f = fixture({ clientClose: () => rawClose.promise });
  const closing = f.connector.close();
  assert.equal(f.connector.close(), closing);
  const rejected = assert.rejects(closing, { message: "native_connector_close_uncertain" });
  t.mock.timers.tick(10_000); await rejected;
  rawClose.resolve(); await Promise.resolve();
  assert.equal(f.calls.runtimeCloses, 1); assert.equal(f.calls.clientCloses, 1);
  assert.equal(f.connector.close(), closing);
  await assert.rejects(f.connector.close(), { message: "native_connector_close_uncertain" });
  assert.deepEqual(f.calls.native, []);
});
