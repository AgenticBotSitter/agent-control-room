import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  createClaudeCodeOwnedProcessSessionV1,
  resetClaudeCodeProcessBindingRegistryV1,
  type ClaudeCodeProcessBindingV1,
  type ClaudeCodeProcessBytePortV1,
  type OwnedClaudeCodeProcessV1,
} from "../src/harness/claude-code-v1/owned-process-session";

// Synthetic placeholder identities only; nothing here is captured from a real host.
const digestOf = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

let bindingCounter = 0;
function freshBinding(overrides: Partial<ClaudeCodeProcessBindingV1> = {}): ClaudeCodeProcessBindingV1 {
  bindingCounter += 1;
  return {
    processAttemptId: `attempt.process.${bindingCounter}`,
    runId: "run.placeholder.0001",
    attemptId: "attempt.placeholder.0001",
    invocationDigest: digestOf(`placeholder-invocation-${bindingCounter}`),
    ...overrides,
  };
}

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

class FakeClaudeProcess {
  readonly stdout: (Uint8Array | undefined)[] = [];
  ended = false;
  closeStdinCalls = 0;
  terminateCalls = 0;
  private pendingStdout: Deferred<Uint8Array | undefined> | undefined;
  private readonly exitGate = deferred<Readonly<{ code: number | null; signal: string | null }>>();

  constructor(private readonly options: {
    hangTerminate?: boolean;
    hangCloseStdin?: boolean;
    exitValue?: unknown;
  } = {}) {}

  push(line: string): void {
    const bytes = new TextEncoder().encode(line);
    if (this.pendingStdout) {
      const waiter = this.pendingStdout;
      this.pendingStdout = undefined;
      waiter.resolve(bytes);
      return;
    }
    this.stdout.push(bytes);
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.pendingStdout) {
      const waiter = this.pendingStdout;
      this.pendingStdout = undefined;
      waiter.resolve(undefined);
    }
    this.exitGate.resolve((this.options.exitValue ?? { code: 0, signal: null }) as
      Readonly<{ code: number | null; signal: string | null }>);
  }

  port(): ClaudeCodeProcessBytePortV1 {
    return {
      readStdout: async () => {
        const next = this.stdout.shift();
        if (next !== undefined) return next;
        if (this.ended) return undefined;
        this.pendingStdout = deferred<Uint8Array | undefined>();
        return this.pendingStdout.promise;
      },
      readStderr: async () => {
        if (this.ended) return undefined;
        await this.exitGate.promise;
        return undefined;
      },
      closeStdin: async () => {
        this.closeStdinCalls += 1;
        if (this.options.hangCloseStdin) await new Promise(() => {});
      },
      terminate: async () => {
        this.terminateCalls += 1;
        if (this.options.hangTerminate) await new Promise(() => {});
        this.end();
      },
      exited: this.exitGate.promise,
    };
  }

  acquire(): OwnedClaudeCodeProcessV1 {
    return { ready: Promise.resolve(this.port()), close: async () => { this.end(); } };
  }
}

test.beforeEach(() => resetClaudeCodeProcessBindingRegistryV1());

test("stdout is framed into lines and a clean close reports a certain disposition", async () => {
  const process = new FakeClaudeProcess();
  process.push('{"type":"system"}\n{"type":"assistant"}\n');
  const controller = new AbortController();
  const session = createClaudeCodeOwnedProcessSessionV1({
    binding: freshBinding(), signal: controller.signal, acquire: () => process.acquire(), cleanupMs: 500,
  });
  const wire = await session.ready;
  assert.equal(await wire.readLine(new AbortController().signal), '{"type":"system"}');
  assert.equal(await wire.readLine(new AbortController().signal), '{"type":"assistant"}');
  session.recordTerminalResultObserved();
  await session.close();
  const disposition = session.disposition();
  assert.equal(disposition.closed, true);
  assert.equal(disposition.cleanupUncertain, false);
  assert.equal(disposition.exitObserved, true);
  assert.equal(disposition.reasonCode, "closed_with_decoded_terminal_result");
  assert.equal(disposition.resubmissionSafe, false);
  assert.equal(disposition.grantsExecutionAuthority, false);
  assert.equal(process.closeStdinCalls, 1);
  assert.equal(process.terminateCalls, 1);
});

test("the same binding cannot be started twice", async () => {
  const binding = freshBinding();
  const first = new FakeClaudeProcess();
  const controller = new AbortController();
  const session = createClaudeCodeOwnedProcessSessionV1({
    binding, signal: controller.signal, acquire: () => first.acquire(), cleanupMs: 200,
  });
  await session.ready;
  const second = new FakeClaudeProcess();
  let acquiredAgain = false;
  assert.throws(() => createClaudeCodeOwnedProcessSessionV1({
    binding: { ...binding }, signal: new AbortController().signal,
    acquire: () => { acquiredAgain = true; return second.acquire(); }, cleanupMs: 200,
  }), /claude_code_process_session_duplicate_binding/);
  assert.equal(acquiredAgain, false, "a refused duplicate must never reach acquire");
  await session.close().catch(() => {});
});

test("a binding refused as a duplicate stays refused after the first session closes", async () => {
  const binding = freshBinding();
  const process = new FakeClaudeProcess();
  const session = createClaudeCodeOwnedProcessSessionV1({
    binding, signal: new AbortController().signal, acquire: () => process.acquire(), cleanupMs: 200,
  });
  await session.ready;
  await session.close();
  assert.throws(() => createClaudeCodeOwnedProcessSessionV1({
    binding, signal: new AbortController().signal,
    acquire: () => new FakeClaudeProcess().acquire(), cleanupMs: 200,
  }), /claude_code_process_session_duplicate_binding/);
  // A restart is only expressible as a fresh process attempt identity.
  const restart = createClaudeCodeOwnedProcessSessionV1({
    binding: { ...binding, processAttemptId: "attempt.process.restart" },
    signal: new AbortController().signal, acquire: () => new FakeClaudeProcess().acquire(), cleanupMs: 200,
  });
  await restart.ready;
  await restart.close();
});

test("a cancellation whose termination never confirms reports cleanup as uncertain", async () => {
  const process = new FakeClaudeProcess({ hangTerminate: true });
  const session = createClaudeCodeOwnedProcessSessionV1({
    binding: freshBinding(), signal: new AbortController().signal,
    acquire: () => process.acquire(), cleanupMs: 40,
  });
  await session.ready;
  await assert.rejects(session.close(), /claude_code_process_session_cleanup_uncertain/);
  const disposition = session.disposition();
  assert.equal(disposition.cleanupUncertain, true);
  assert.equal(disposition.reasonCode, "cleanup_uncertain_result_unproven");
  assert.equal(disposition.resubmissionSafe, false);
});

test("a restart after an uncertain close is never treated as safe to resubmit", async () => {
  const first = new FakeClaudeProcess({ hangCloseStdin: true, hangTerminate: true });
  const original = freshBinding();
  const session = createClaudeCodeOwnedProcessSessionV1({
    binding: original, signal: new AbortController().signal,
    acquire: () => first.acquire(), cleanupMs: 40,
  });
  await session.ready;
  await assert.rejects(session.close(), /cleanup_uncertain/);
  const before = session.disposition();
  assert.equal(before.terminalResultConfirmed, false);
  assert.equal(before.resubmissionSafe, false);

  const restart = createClaudeCodeOwnedProcessSessionV1({
    binding: { ...original, processAttemptId: "attempt.process.after-uncertain" },
    signal: new AbortController().signal, acquire: () => new FakeClaudeProcess().acquire(), cleanupMs: 200,
  });
  await restart.ready;
  await restart.close();
  const after = restart.disposition();
  assert.equal(after.terminalResultConfirmed, false, "a restart proves nothing about the earlier attempt");
  assert.equal(after.reasonCode, "closed_without_terminal_result");
  assert.equal(after.resubmissionSafe, false);
  assert.notEqual(after.processAttemptId, before.processAttemptId);
});

test("a malformed process exit shape makes cleanup uncertain", async () => {
  const process = new FakeClaudeProcess({ exitValue: { code: 0, signal: "SIGTERM" } });
  const session = createClaudeCodeOwnedProcessSessionV1({
    binding: freshBinding(), signal: new AbortController().signal,
    acquire: () => process.acquire(), cleanupMs: 200,
  });
  await session.ready;
  await assert.rejects(session.close(), /cleanup_uncertain/);
  assert.equal(session.disposition().exitMalformed, true);
});

test("a carriage return or an overlong line on stdout is fatal to the session", async () => {
  for (const chunk of ["{\"type\":\"system\"}\r\n", `${"x".repeat(300_000)}\n`]) {
    const process = new FakeClaudeProcess();
    const session = createClaudeCodeOwnedProcessSessionV1({
      binding: freshBinding(), signal: new AbortController().signal,
      acquire: () => process.acquire(), cleanupMs: 200,
    });
    const wire = await session.ready;
    process.push(chunk);
    await assert.rejects(wire.readLine(new AbortController().signal), /unavailable/);
    await session.close().catch(() => {});
  }
});

test("an aborted caller signal is refused before any acquisition", () => {
  const controller = new AbortController();
  controller.abort();
  let acquired = false;
  assert.throws(() => createClaudeCodeOwnedProcessSessionV1({
    binding: freshBinding(), signal: controller.signal,
    acquire: () => { acquired = true; return new FakeClaudeProcess().acquire(); }, cleanupMs: 200,
  }), /claude_code_process_session_unavailable/);
  assert.equal(acquired, false);
});

test("the connector modules read no environment, file, process or network source", () => {
  const modules = [
    "stream-json-decode.ts",
    "owned-process-session.ts",
    "result-identity.ts",
    "unsupported-operations.ts",
    "connector-profile.ts",
    "index.ts",
  ];
  const forbidden = [
    /process\s*\.\s*env/,
    /node:fs/,
    /node:child_process/,
    /node:os/,
    /node:net/,
    /node:http/,
    /\bspawn\b/,
    /\bexecFile\b/,
    /\bfetch\s*\(/,
    /ANTHROPIC_/,
    /api[_-]?key/i,
    /\bcredential\b(?!\w)/i,
  ];
  for (const name of modules) {
    const path = fileURLToPath(new URL(`../src/harness/claude-code-v1/${name}`, import.meta.url));
    const source = readFileSync(path, "utf8");
    // Comments may discuss what is not done; strip them before the structural check.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const pattern of forbidden) {
      assert.equal(pattern.test(code), false, `${name} must not reference ${pattern}`);
    }
  }
});
