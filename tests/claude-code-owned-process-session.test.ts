import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  createClaudeCodeOwnedProcessSessionV1,
  type ClaudeCodeProcessBindingV1,
  type ClaudeCodeProcessBytePortV1,
  type OwnedClaudeCodeProcessV1,
} from "../src/harness/claude-code-v1/owned-process-session";
import * as claudeCodeConnectorPackage from "../src/harness/claude-code-v1/index";
import { claudeCodeConnectorProfileV1 } from "../src/harness/claude-code-v1/connector-profile";
import {
  createClaudeCodeStreamDecoderV1,
  type ClaudeCodeResultFrameV1,
} from "../src/harness/claude-code-v1/stream-json-decode";
import {
  CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
  publishClaudeTerminalResultV1,
  type ClaudeTerminalResultPublicationInputV1,
} from "../src/harness/claude-code-v1/result-publication";
import { publishClaudeCodeOwnedAttemptResultV1 } from
  "../src/harness/claude-code-v1/local-worker-result";
import { createClaudeCodeTerminalResultStageV1 } from
  "../src/harness/claude-code-v1/terminal-result-staging";
import { recoverClaudeCodeTerminalResultV1 } from
  "../src/harness/claude-code-v1/terminal-result-recovery";
import type { DurableResultPublicationConfigurationV1 } from "../src/artifacts/v1/durable-result-publication";
import { terminalResultEvidenceSchemaV1 } from "../src/harness/v1/terminal-result-evidence";
import { resultBytesHash } from "../src/artifacts/v1/native-results";
import { createPersistentNeutralReservationPort,
  createPersistentNeutralReservationStore } from "../src/artifacts/v1/neutral-reservation-port";
import { InMemoryArtifactStorage, type ArtifactReadPortV1, type ArtifactStoragePortV1 } from "../src/node-executor/artifact-storage";
import { binding as nativeFixtureBinding } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { webNativeResultFixture } from "./helpers/web-native-result";
import { sha256Digest } from "../src/security/canonical-digest";

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

  /** The process finishes on its own: stdout reaches EOF and the process exits. */
  endNaturally(): void {
    this.end();
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

test("a natural stdout EOF leaves an already emitted result readable", async () => {
  const process = new FakeClaudeProcess();
  const session = createClaudeCodeOwnedProcessSessionV1({
    binding: freshBinding(), signal: new AbortController().signal,
    acquire: () => process.acquire(), cleanupMs: 500,
  });
  const wire = await session.ready;
  // init and the final result arrive, then the process ends on its own before the
  // consumer has read anything at all.
  process.push('{"type":"system","subtype":"init"}\n{"type":"result","subtype":"success"}\n');
  process.endNaturally();
  await process.port().exited;

  assert.equal(await wire.readLine(new AbortController().signal), '{"type":"system","subtype":"init"}');
  assert.equal(await wire.readLine(new AbortController().signal), '{"type":"result","subtype":"success"}',
    "a result emitted just before a natural EOF must still be readable");
  assert.equal(await wire.readLine(new AbortController().signal), undefined,
    "a drained natural EOF is end-of-stream, not a failure");

  session.recordTerminalResultObserved();
  await session.close();
  const disposition = session.disposition();
  assert.equal(disposition.closed, true);
  assert.equal(disposition.cleanupUncertain, false);
  assert.equal(disposition.exitObserved, true);
  assert.equal(disposition.reasonCode, "closed_with_decoded_terminal_result");
  assert.equal(disposition.resubmissionSafe, false);
});

test("a natural EOF resolves a consumer that was already waiting for a line", async () => {
  const process = new FakeClaudeProcess();
  const session = createClaudeCodeOwnedProcessSessionV1({
    binding: freshBinding(), signal: new AbortController().signal,
    acquire: () => process.acquire(), cleanupMs: 500,
  });
  const wire = await session.ready;
  const pending = wire.readLine(new AbortController().signal);
  process.push('{"type":"result","subtype":"success"}\n');
  process.endNaturally();
  assert.equal(await pending, '{"type":"result","subtype":"success"}');
  assert.equal(await wire.readLine(new AbortController().signal), undefined);
  await session.close();
  assert.equal(session.disposition().cleanupUncertain, false);
});

test("a truncated trailing line at stdout EOF is still fatal", async () => {
  const process = new FakeClaudeProcess();
  const session = createClaudeCodeOwnedProcessSessionV1({
    binding: freshBinding(), signal: new AbortController().signal,
    acquire: () => process.acquire(), cleanupMs: 200,
  });
  const wire = await session.ready;
  process.push('{"type":"result","subtype":"suc');
  process.endNaturally();
  await assert.rejects(wire.readLine(new AbortController().signal), /unavailable/,
    "a partial final line is truncated output, not a clean stream end");
  await session.close().catch(() => {});
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

test("the public package exposes no way to reset or reacquire an already-started binding", async () => {
  assert.equal(
    "resetClaudeCodeProcessBindingRegistryV1" in claudeCodeConnectorPackage,
    false,
    "the public barrel must not export a duplicate-start bypass",
  );

  const binding = freshBinding();
  const first = new FakeClaudeProcess();
  const session = await claudeCodeConnectorPackage.createClaudeCodeOwnedProcessSessionV1({
    binding, signal: new AbortController().signal, acquire: () => first.acquire(), cleanupMs: 200,
  });
  await session.ready;

  // Nothing in the public package can clear the registry, so the identical binding
  // is still refused as a duplicate even after the first session's own lifecycle.
  let acquiredAgain = false;
  assert.throws(() => claudeCodeConnectorPackage.createClaudeCodeOwnedProcessSessionV1({
    binding: { ...binding }, signal: new AbortController().signal,
    acquire: () => { acquiredAgain = true; return new FakeClaudeProcess().acquire(); }, cleanupMs: 200,
  }), /claude_code_process_session_duplicate_binding/);
  assert.equal(acquiredAgain, false, "a refused duplicate must never reach acquire, with or without a reset path");

  await session.close().catch(() => {});
});

test("the connector modules read no environment, file, process or network source", () => {
  const modules = [
    "stream-json-decode.ts",
    "owned-process-session.ts",
    "unsupported-operations.ts",
    "connector-profile.ts",
    "result-publication.ts",
    "local-worker-result.ts",
    "terminal-result-staging.ts",
    "terminal-result-recovery.ts",
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

/* ------------------------------------------------------------------ */
/* Durable result publication bridge: the real shared publisher.       */
/*                                                                     */
/* These cases run the EXISTING publishDurableResultV1 against         */
/* disposable in-memory database, storage and reservation fixtures     */
/* built the same way tests/durable-result-publication.test.ts builds  */
/* them. Nothing here substitutes a spy for the publisher: the receipt */
/* rows, manifest rows and review plan rows are the real ones.         */
/*                                                                     */
/* The evidence is real too. Each case drives an actual owned process  */
/* session over the injected fake byte port, decodes its stdout with   */
/* the actual stream decoder, and publishes that session's own         */
/* disposition and decoded terminal frame.                             */
/* ------------------------------------------------------------------ */

/** Counts every process acquisition in this file, so "no new process" is checkable. */
let acquisitions = 0;

class MemoryResultStorage implements ArtifactStoragePortV1, ArtifactReadPortV1 {
  readonly artifacts = new Map<string, Uint8Array>();
  putCalls = 0;
  readonly isStorageUncertain = false;
  async put(input: { artifactId: string; bytes: Uint8Array; signal?: AbortSignal }) {
    input.signal?.throwIfAborted();
    this.putCalls += 1;
    const bytes = Uint8Array.from(input.bytes);
    this.artifacts.set(input.artifactId, bytes);
    return { artifactId: input.artifactId, contentHash: resultBytesHash(bytes), sizeBytes: bytes.byteLength,
      opaqueLocator: `memory://claude-bridge/${encodeURIComponent(input.artifactId)}` };
  }
  async read(artifactId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const bytes = this.artifacts.get(artifactId);
    return bytes ? Uint8Array.from(bytes) : undefined;
  }
}

const bridgeSession = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

/**
 * One real owned session: real stdout framing, real decode, real disposition.
 * The retained session identity originates from the validated init observation
 * on this stream and is retained here; it is never read back out of the
 * terminal frame that it is later compared against.
 */
async function terminalEvidence(runId: string, sessionId: string, resultText: string) {
  const process = new FakeClaudeProcess();
  const processBinding = freshBinding({ runId, attemptId: `attempt:${runId}` });
  const session = createClaudeCodeOwnedProcessSessionV1({
    binding: processBinding, signal: new AbortController().signal,
    acquire: () => { acquisitions += 1; return process.acquire(); }, cleanupMs: 500,
  });
  const wire = await session.ready;
  process.push(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`);
  process.push(`${JSON.stringify({ type: "result", subtype: "success", is_error: false,
    session_id: sessionId, result: resultText, total_cost_usd: 0, usage: {} })}\n`);
  process.endNaturally();

  const decoder = createClaudeCodeStreamDecoderV1();
  let retainedSessionId: string | undefined;
  let terminal: ClaudeCodeResultFrameV1 | undefined;
  let terminalRawLine: string | undefined;
  for (;;) {
    const line = await wire.readLine(new AbortController().signal);
    if (line === undefined) break;
    const frame = decoder.accept(line);
    // The init observation is the retained expected identity. It is captured
    // here, before the terminal frame is decoded at all.
    if (frame.kind === "init") retainedSessionId = frame.sessionId;
    // The exact raw terminal line is retained alongside the decode; it is the
    // material the bridge re-derives the retained digest from.
    if (frame.kind === "result") { terminal = frame; terminalRawLine = line; }
  }
  assert.ok(retainedSessionId && terminal && terminalRawLine);
  session.recordTerminalResultObserved();
  await session.close();
  const disposition = session.disposition();
  assert.equal(disposition.reasonCode, "closed_with_decoded_terminal_result");
  return { processBinding, disposition, frame: terminal!, state: decoder.state(),
    terminalRawLine: terminalRawLine!,
    retainedSession: { processAttemptId: processBinding.processAttemptId, sessionId: retainedSessionId!,
      terminalFrameDigest: terminal!.frameDigest } };
}

function retainedBindingFor(runId: string) {
  return { tenantId: nativeFixtureBinding.tenantId, projectId: nativeFixtureBinding.projectId,
    jobId: `job:${runId}`, attemptId: `attempt:${runId}`, runId, nodeId: nativeFixtureBinding.nodeId,
    workflowId: "workflow:test", acceptanceProfileId: "profile:test",
    acceptanceProfileDigest: `sha256:${createHash("sha256").update("claude-bridge:acceptance").digest("hex")}` };
}

/**
 * Disposable database, storage and reservation fixtures. The harness-run row
 * is provisioned by the shared fixture and then carries exactly what a real
 * admission would have recorded for this connector: the accepted Claude
 * connector profile digest, and the observed terminal-frame digest as the
 * run's authority anchor.
 */
async function bridgeFixture(runId: string, terminalFrameDigest: string) {
  const f = await webNativeResultFixture();
  await f.provisionRun(runId, `job:${runId}`, `attempt:${runId}`, terminalFrameDigest);
  await f.db.query(
    "UPDATE control_harness_runs SET payload = payload || $3::jsonb WHERE tenant_id=$1 AND id=$2",
    [nativeFixtureBinding.tenantId, runId,
      JSON.stringify({ connectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1 })]);
  const store = createPersistentNeutralReservationStore();
  const storage = new MemoryResultStorage();
  const configWith = (reservations = createPersistentNeutralReservationPort(store)):
  DurableResultPublicationConfigurationV1 => ({ db: f.db, integrityKey: f.resultKey, reviewKey: f.reviewKey,
    storage, storageClass: "local", reservations });
  return { ...f, store, storage, configWith, config: configWith() };
}

test("the local Claude coordinator carries one owned stream into the shared review lifecycle", async t => {
  const runId = "run:claude-local-coordinator";
  const sessionId = bridgeSession(20);
  const resultText = "One bounded Claude result for owner review.";
  const terminalLine = JSON.stringify({ type: "result", subtype: "success", is_error: false,
    session_id: sessionId, result: resultText, total_cost_usd: 0, usage: {} });
  const terminalDigest = sha256Digest(JSON.parse(terminalLine));
  const f = await bridgeFixture(runId, terminalDigest); t.after(f.close);
  const process = new FakeClaudeProcess();
  const processBinding = freshBinding({ runId, attemptId: `attempt:${runId}` });
  let authorityChecks = 0;
  let coordinatorAcquisitions = 0;

  const running = publishClaudeCodeOwnedAttemptResultV1({
    publication: f.config,
    retainedBinding: retainedBindingFor(runId),
    processBinding,
    acceptedConnectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
    acquire: () => {
      coordinatorAcquisitions += 1;
      return process.acquire();
    },
    signal: new AbortController().signal,
    cleanupMs: 500,
    receivedAt: at(12_000),
    assertAuthority: () => { authorityChecks += 1; },
  });
  process.push(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`);
  process.push(`${terminalLine}\n`);
  process.endNaturally();

  const completed = await running;
  assert.equal(coordinatorAcquisitions, 1);
  assert.ok(authorityChecks >= 3, "authority is fenced before acquisition and by the shared publisher");
  assert.equal(completed.sessionId, sessionId);
  assert.equal(completed.processAttemptId, processBinding.processAttemptId);
  assert.equal(completed.disposition.reasonCode, "closed_with_decoded_terminal_result");
  assert.equal(completed.decoderState.terminalObserved, true);
  assert.equal(completed.publication.replayed, false);
  assert.equal(completed.publication.target.kind, "document");
  assert.equal(completed.publication.receipt.qualityAccepted, false);
  assert.equal(completed.qualityAccepted, false);
  assert.equal(completed.completionRecorded, false);
  assert.equal(completed.releasesCapacity, false);
  assert.equal(completed.permitsRetry, false);
  assert.equal(completed.permitsResume, false);
  assert.equal(f.storage.putCalls, 1);
  const stored = await f.storage.read(completed.publication.receipt.artifactId);
  assert.equal(new TextDecoder().decode(stored!), resultText);
});

test("a protected Claude terminal stage recovers one exact pending-review result without acquisition", async t => {
  const runId = "run:claude-terminal-stage";
  const sessionId = bridgeSession(90);
  const terminalLine = JSON.stringify({ type: "result", subtype: "success", is_error: false,
    session_id: sessionId, result: "Staged exactly once for owner review.", total_cost_usd: 0, usage: {} });
  const f = await bridgeFixture(runId, sha256Digest(JSON.parse(terminalLine))); t.after(f.close);
  const processBinding = freshBinding({ runId, attemptId: `attempt:${runId}` });
  const stage = createClaudeCodeTerminalResultStageV1({ storage: new InMemoryArtifactStorage(),
    retainedBinding: retainedBindingFor(runId), processBinding, receivedAt: at(12_400) });
  const process = new FakeClaudeProcess();
  let acquired = 0;
  const first = publishClaudeCodeOwnedAttemptResultV1({ publication: f.config, retainedBinding: retainedBindingFor(runId),
    processBinding, acceptedConnectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
    acquire: () => { acquired += 1; return process.acquire(); }, signal: new AbortController().signal, cleanupMs: 500,
    receivedAt: at(12_400), assertAuthority: () => {}, terminalStage: stage });
  process.push(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`);
  process.push(`${terminalLine}\n`); process.endNaturally();
  const published = await first;
  assert.equal(published.publication.replayed, false);
  assert.equal(acquired, 1);
  const recovered = await recoverClaudeCodeTerminalResultV1({ publication: f.config, stage, assertAuthority: () => {} });
  assert.equal(recovered.state, "recovered_pending_review");
  if (recovered.state === "recovered_pending_review") assert.equal(recovered.publication.replayed, true);
  assert.equal(acquired, 1, "recovery has no acquisition path");
  assert.equal((await f.db.query("SELECT plan FROM control_native_review_plans WHERE tenant_id=$1 AND run_id=$2",
    [nativeFixtureBinding.tenantId, runId])).rows.length, 1, "one ordinary pending-review plan remains");
});

test("missing or altered staged Claude evidence is explicit uncertainty and never acquires", async t => {
  const runId = "run:claude-terminal-stage-refusal";
  const f = await bridgeFixture(runId, digestOf("nothing-staged")); t.after(f.close);
  const processBinding = freshBinding({ runId, attemptId: `attempt:${runId}` });
  const missing = createClaudeCodeTerminalResultStageV1({ storage: new InMemoryArtifactStorage(),
    retainedBinding: retainedBindingFor(runId), processBinding, receivedAt: at(12_500) });
  const absent = await recoverClaudeCodeTerminalResultV1({ publication: f.config, stage: missing, assertAuthority: () => {} });
  assert.deepEqual(absent, { state: "terminal_result_uncertain", reasonCode: "staged_terminal_result_missing", permitsRetry: false, permitsResume: false });
  const altered = await recoverClaudeCodeTerminalResultV1({ publication: f.config, assertAuthority: () => {}, stage: {
    async capture() {}, async recover() { return {
      retainedBinding: retainedBindingFor(runId), processBinding,
      retainedSession: { processAttemptId: processBinding.processAttemptId, sessionId: bridgeSession(91), terminalFrameDigest: digestOf("forged") },
      disposition: { schema: "control-room.claude-code-session-disposition/v1", processAttemptId: processBinding.processAttemptId,
        runId, attemptId: `attempt:${runId}`, closed: true, cleanupUncertain: false, exitObserved: true, exitMalformed: false,
        terminalResultConfirmed: true, resubmissionSafe: false, reasonCode: "closed_with_decoded_terminal_result",
        grantsExecutionAuthority: false, canonicalPublicationAllowed: false, permitsRetry: false, permitsResume: false },
      terminalFrameRawLine: JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: bridgeSession(91), result: "altered", usage: {} }),
      terminalFrame: { schema: "control-room.claude-code-stream-frame/v1", kind: "result", sessionId: bridgeSession(91), outcome: "succeeded", isError: false,
        subtypeCode: "success", terminalReasonCode: "none", terminalReasonPresent: false, resultText: "altered", resultBytes: 7,
        resultTextDigest: digestOf("altered"), totalCostUsd: undefined, usageReported: true, frameDigest: digestOf("forged") },
      decoderState: { sessionId: bridgeSession(91), framesAccepted: 2, assistantTurns: 0, initObserved: true, terminalObserved: true, failed: false, reasonCode: undefined },
      acceptedConnectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1, receivedAt: at(12_500),
    }; },
  } });
  assert.equal(altered.state, "terminal_result_uncertain");
  if (altered.state === "terminal_result_uncertain") assert.equal(altered.reasonCode, "staged_terminal_result_altered");
  assert.equal(f.storage.putCalls, 0, "refused recovery does not publish bytes");
});

test("the local Claude coordinator refuses stale authority before process acquisition", async () => {
  let acquired = false;
  await assert.rejects(() => publishClaudeCodeOwnedAttemptResultV1({
    publication: {} as DurableResultPublicationConfigurationV1,
    retainedBinding: retainedBindingFor("run:claude-local-stale"),
    processBinding: freshBinding({ runId: "run:claude-local-stale",
      attemptId: "attempt:run:claude-local-stale" }),
    acceptedConnectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
    acquire: () => { acquired = true; return new FakeClaudeProcess().acquire(); },
    signal: new AbortController().signal,
    cleanupMs: 200,
    receivedAt: at(12_100),
    assertAuthority: () => { throw new Error("authority_revoked"); },
  }), /authority_revoked/);
  assert.equal(acquired, false);
});

test("the local Claude coordinator closes malformed streams without publishing", async t => {
  const runId = "run:claude-local-malformed";
  const f = await bridgeFixture(runId, digestOf("unused-malformed-terminal")); t.after(f.close);
  const process = new FakeClaudeProcess();
  const processBinding = freshBinding({ runId, attemptId: `attempt:${runId}` });
  const running = publishClaudeCodeOwnedAttemptResultV1({
    publication: f.config,
    retainedBinding: retainedBindingFor(runId),
    processBinding,
    acceptedConnectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
    acquire: () => process.acquire(),
    signal: new AbortController().signal,
    cleanupMs: 500,
    receivedAt: at(12_200),
    assertAuthority: () => {},
  });
  process.push(`${JSON.stringify({ type: "system", subtype: "init", session_id: bridgeSession(21) })}\n`);
  process.push("{not json}\n");
  process.endNaturally();

  await assert.rejects(running, /claude_code_local_worker_result_unavailable/);
  assert.equal(f.storage.putCalls, 0);
  assert.equal((await f.db.query("SELECT artifact_id FROM control_native_artifact_receipts WHERE run_id=$1",
    [runId])).rows.length, 0);
});

test("uncertain Claude cleanup blocks the shared publisher and never permits another attempt", async t => {
  const runId = "run:claude-local-cleanup-uncertain";
  const sessionId = bridgeSession(22);
  const terminalLine = JSON.stringify({ type: "result", subtype: "success", is_error: false,
    session_id: sessionId, result: "Result whose cleanup cannot be proven." });
  const f = await bridgeFixture(runId, sha256Digest(JSON.parse(terminalLine))); t.after(f.close);
  const process = new FakeClaudeProcess({ hangTerminate: true });
  const processBinding = freshBinding({ runId, attemptId: `attempt:${runId}` });
  const running = publishClaudeCodeOwnedAttemptResultV1({
    publication: f.config,
    retainedBinding: retainedBindingFor(runId),
    processBinding,
    acceptedConnectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
    acquire: () => process.acquire(),
    signal: new AbortController().signal,
    cleanupMs: 40,
    receivedAt: at(12_300),
    assertAuthority: () => {},
  });
  process.push(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId })}\n`);
  process.push(`${terminalLine}\n`);
  process.endNaturally();

  await assert.rejects(running, /claude_code_local_worker_result_cleanup_uncertain/);
  assert.equal(f.storage.putCalls, 0);
  assert.equal((await f.db.query("SELECT artifact_id FROM control_native_artifact_receipts WHERE run_id=$1",
    [runId])).rows.length, 0);
});

const bridgeInputFor = (evidence: Awaited<ReturnType<typeof terminalEvidence>>, runId: string,
  overrides: Partial<ClaudeTerminalResultPublicationInputV1> = {}): ClaudeTerminalResultPublicationInputV1 => ({
  retainedBinding: retainedBindingFor(runId),
  processBinding: evidence.processBinding,
  retainedSession: evidence.retainedSession,
  disposition: evidence.disposition,
  terminalFrameRawLine: evidence.terminalRawLine,
  terminalFrame: evidence.frame,
  decoderState: evidence.state,
  acceptedConnectorProfileDigest: CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1,
  receivedAt: at(11_000),
  assertAuthority: () => {},
  ...overrides,
});

test("an accepted Claude terminal result reaches the real shared durable publisher exactly once", async t => {
  const runId = "run:claude-bridge-success";
  const text = "Claude terminal result for the shared durable publisher.";
  const evidence = await terminalEvidence(runId, bridgeSession(1), text);
  const f = await bridgeFixture(runId, evidence.frame.frameDigest); t.after(f.close);

  const published = await publishClaudeTerminalResultV1(f.config, bridgeInputFor(evidence, runId));

  assert.equal(published.replayed, false);
  assert.equal(f.storage.putCalls, 1);
  // The receipt is the shared publisher's own, tagged with the accepted
  // connector profile and anchored to the observed terminal frame.
  assert.equal(published.receipt.harness, claudeCodeConnectorProfileV1.harness);
  assert.equal(published.receipt.connectorProfileDigest, CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1);
  assert.equal(published.receipt.terminalEvidenceDigest, evidence.frame.frameDigest);
  assert.match(published.receipt.artifactId, /^artifact:result:[a-f0-9]{64}$/);
  assert.equal(published.receipt.sizeBytes, Buffer.byteLength(text, "utf8"));
  // No approval, no completion, no capacity release, no execution authority.
  assert.equal(published.receipt.qualityAccepted, false);
  assert.equal(published.receipt.completionVerified, false);
  assert.equal(published.receipt.canonicalPublicationAllowed, false);
  assert.equal(published.receipt.releasesCapacity, false);
  assert.equal(published.receipt.grantsExecutionAuthority, false);
  assert.equal(published.qualityAccepted, false);
  assert.equal(published.releasesCapacity, false);
  assert.equal(published.permitsRetry, false);
  assert.equal(published.permitsRedispatch, false);
  // Exactly one ordinary pending review target, carrying no decision at all.
  assert.equal(published.target.kind, "document");
  assert.equal(published.target.revisionNumber, 0);
  assert.ok(!("qualityAccepted" in published.target) && !("completionVerified" in published.target));
  const plans = (await f.db.query("SELECT plan FROM control_native_review_plans WHERE tenant_id=$1 AND run_id=$2",
    [nativeFixtureBinding.tenantId, runId])).rows;
  assert.equal(plans.length, 1);
  const receipts = (await f.db.query("SELECT artifact_id FROM control_native_artifact_receipts WHERE run_id=$1",
    [runId])).rows;
  assert.equal(receipts.length, 1);
  // The stored bytes are the decoded terminal text and nothing else.
  const stored = await f.storage.read(published.receipt.artifactId);
  assert.equal(new TextDecoder().decode(stored!), text);

  // The publication carries the SHARED harness-neutral terminal evidence, not
  // a connector-local one: it is a member of the same discriminated union the
  // Hermes and Codex paths project into, and the union parses it back.
  assert.equal(published.evidence.kind, "claude_terminal_result");
  assert.equal(terminalResultEvidenceSchemaV1.parse(published.evidence).kind, "claude_terminal_result");
  // The evidence content is bound to the bytes that were actually published.
  assert.equal(published.evidence.content.sizeBytes, published.receipt.sizeBytes);
  assert.equal(published.evidence.content.contentHash,
    `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`);
  // Its source is the retained owned-session identity and the observed frame.
  assert.equal(published.evidence.source.sessionId, evidence.retainedSession.sessionId);
  assert.equal(published.evidence.source.processAttemptId, evidence.processBinding.processAttemptId);
  assert.equal(published.evidence.source.terminalFrameDigest, evidence.frame.frameDigest);
  assert.equal(published.evidence.source.connectorProfileDigest, CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1);
  assert.equal(published.evidence.lineage.runId, runId);
  // Evidence is inert and frozen: it approves, completes and releases nothing.
  assert.equal(published.evidence.canonicalPublicationAllowed, false);
  assert.equal(published.evidence.qualityAccepted, false);
  assert.equal(published.evidence.completionRecorded, false);
  assert.equal(published.evidence.grantsExecutionAuthority, false);
  assert.equal(published.evidence.permitsRetry, false);
  assert.equal(published.evidence.permitsResume, false);
  assert.ok(Object.isFrozen(published.evidence));
});

test("exact publication retry replays the same receipt and starts no new process", async t => {
  const runId = "run:claude-bridge-replay";
  const evidence = await terminalEvidence(runId, bridgeSession(2), "Replayed Claude terminal result.");
  const f = await bridgeFixture(runId, evidence.frame.frameDigest); t.after(f.close);
  const acquisitionsAfterEvidence = acquisitions;

  const first = await publishClaudeTerminalResultV1(f.config, bridgeInputFor(evidence, runId));
  assert.equal(first.replayed, false);

  // Same retained evidence, same bridge call: the shared publisher returns the
  // existing durable receipt rather than writing a second copy.
  const again = await publishClaudeTerminalResultV1(f.config, bridgeInputFor(evidence, runId));
  assert.equal(again.replayed, true);
  assert.deepEqual(again.receipt, first.receipt);
  assert.deepEqual(again.target, first.target);
  // The shared evidence is byte-identical across the replay too: the
  // projection is pinned to the caller's `receivedAt`, so it invents no clock.
  assert.deepEqual(again.evidence, first.evidence);
  assert.equal(again.evidence.evidenceDigest, first.evidence.evidenceDigest);

  // A reconstructed bridge over the same database and the same reservation
  // store replays identically: this bridge holds no state of its own.
  const reconstructed = await publishClaudeTerminalResultV1(
    f.configWith(createPersistentNeutralReservationPort(f.store)), bridgeInputFor(evidence, runId));
  assert.equal(reconstructed.replayed, true);
  assert.deepEqual(reconstructed.receipt, first.receipt);
  assert.deepEqual(reconstructed.evidence, first.evidence);

  assert.equal(f.storage.putCalls, 1, "a replay must not write bytes again");
  assert.equal(acquisitions, acquisitionsAfterEvidence,
    "publication retry over retained evidence must never start a new process");
  const receipts = (await f.db.query("SELECT artifact_id FROM control_native_artifact_receipts WHERE run_id=$1",
    [runId])).rows;
  assert.equal(receipts.length, 1);
});

test("changed content over the same run is refused, not republished", async t => {
  const runId = "run:claude-bridge-conflict";
  const evidence = await terminalEvidence(runId, bridgeSession(3), "Original Claude terminal result.");
  const f = await bridgeFixture(runId, evidence.frame.frameDigest); t.after(f.close);
  await publishClaudeTerminalResultV1(f.config, bridgeInputFor(evidence, runId));

  // Different content on the same run: the reservation identity no longer
  // matches, so the shared publisher refuses rather than overwriting.
  const changed = await terminalEvidence(runId, bridgeSession(4), "Different Claude terminal result.");
  await f.db.query("UPDATE control_harness_runs SET payload = payload || $3::jsonb WHERE tenant_id=$1 AND id=$2",
    [nativeFixtureBinding.tenantId, runId, JSON.stringify({ authorityDigest: changed.frame.frameDigest })]);
  await assert.rejects(() => publishClaudeTerminalResultV1(f.config, bridgeInputFor(changed, runId)),
    /durable_result_reservation_conflict/);
  assert.equal(f.storage.putCalls, 1);
});

test("a changed retained identity field is refused by the publisher's recorded identity", async t => {
  // Its own fixture, whose recorded authority anchor still matches this
  // evidence exactly. The only thing that differs from a publishable call is
  // the retained `nodeId`, so the refusal is load bearing for that field
  // rather than for a stale evidence anchor left behind by an earlier case.
  const runId = "run:claude-bridge-identity";
  const evidence = await terminalEvidence(runId, bridgeSession(8), "Claude result under a drifted node.");
  const f = await bridgeFixture(runId, evidence.frame.frameDigest); t.after(f.close);

  await assert.rejects(() => publishClaudeTerminalResultV1(f.config, bridgeInputFor(evidence, runId,
    { retainedBinding: { ...retainedBindingFor(runId), nodeId: "node:other" } })),
  /durable_result_identity_mismatch/);
  assert.equal(f.storage.putCalls, 0);
  assert.equal((await f.db.query("SELECT artifact_id FROM control_native_artifact_receipts WHERE run_id=$1",
    [runId])).rows.length, 0);

  // The identical call with the retained node restored publishes normally, so
  // nothing else about this fixture was refusing.
  const published = await publishClaudeTerminalResultV1(f.config, bridgeInputFor(evidence, runId));
  assert.equal(published.replayed, false);
  assert.equal(f.storage.putCalls, 1);
});

test("substituted result text under a preserved frame digest writes nothing to the real database", async t => {
  const runId = "run:claude-bridge-substitution";
  const text = "Genuine Claude terminal result.";
  const evidence = await terminalEvidence(runId, bridgeSession(9), text);
  const f = await bridgeFixture(runId, evidence.frame.frameDigest); t.after(f.close);

  // A hand-built frame object carrying the genuine frame digest of the real
  // terminal material, but different result text with a self-consistent byte
  // count and content digest. Nothing the decoder froze constrains this
  // object: it never came from the decoder.
  const substituted = "Substituted Claude terminal result that was never observed.";
  const forgedFrame: ClaudeCodeResultFrameV1 = { ...evidence.frame, resultText: substituted,
    resultBytes: Buffer.byteLength(substituted, "utf8"),
    resultTextDigest: digestOf(substituted) };
  assert.equal(forgedFrame.frameDigest, evidence.frame.frameDigest);

  await assert.rejects(() => publishClaudeTerminalResultV1(f.config,
    bridgeInputFor(evidence, runId, { terminalFrame: forgedFrame })),
  /claude_code_result_publication_result_unusable/);

  // And the same substitution made in the raw material itself, with the old
  // retained digest kept in place.
  const tamperedLine = JSON.stringify({ ...JSON.parse(evidence.terminalRawLine), result: substituted });
  await assert.rejects(() => publishClaudeTerminalResultV1(f.config,
    bridgeInputFor(evidence, runId, { terminalFrameRawLine: tamperedLine, terminalFrame: forgedFrame })),
  /claude_code_result_publication_evidence_digest_mismatch/);

  // Zero database, storage and reservation writes from either attempt.
  assert.equal(f.storage.putCalls, 0);
  assert.equal(f.storage.artifacts.size, 0);
  assert.ok(!createPersistentNeutralReservationPort(f.store).peek(nativeFixtureBinding.tenantId, runId),
    "a refused substitution may leave no reservation behind");
  assert.equal((await f.db.query("SELECT artifact_id FROM control_native_artifact_receipts WHERE run_id=$1",
    [runId])).rows.length, 0);
  assert.equal((await f.db.query("SELECT plan FROM control_native_review_plans WHERE run_id=$1",
    [runId])).rows.length, 0);

  // The honest call over the same evidence still publishes the REAL text, so
  // the refusals above are the substitution being caught, not the fixture
  // being unpublishable.
  const published = await publishClaudeTerminalResultV1(f.config, bridgeInputFor(evidence, runId));
  const stored = await f.storage.read(published.receipt.artifactId);
  assert.equal(new TextDecoder().decode(stored!), text);
});

test("stale authority refuses before any reservation, byte or metadata write", async t => {
  const runId = "run:claude-bridge-authority";
  const evidence = await terminalEvidence(runId, bridgeSession(5), "Claude result under revoked authority.");
  const f = await bridgeFixture(runId, evidence.frame.frameDigest); t.after(f.close);
  let fenceCalls = 0;
  await assert.rejects(() => publishClaudeTerminalResultV1(f.config, bridgeInputFor(evidence, runId,
    { assertAuthority: () => { fenceCalls += 1; throw new Error("authority_revoked"); } })),
  /authority_revoked/);
  assert.ok(fenceCalls >= 1);
  assert.equal(f.storage.putCalls, 0);
  assert.equal(f.storage.artifacts.size, 0);
  assert.ok(!createPersistentNeutralReservationPort(f.store).peek(nativeFixtureBinding.tenantId, runId),
    "no reservation may exist after a refused authority fence");
  assert.equal((await f.db.query("SELECT artifact_id FROM control_native_artifact_receipts WHERE run_id=$1",
    [runId])).rows.length, 0);
  assert.equal((await f.db.query("SELECT plan FROM control_native_review_plans WHERE run_id=$1",
    [runId])).rows.length, 0);
});

test("a binding or session mismatch writes nothing to the real database or storage", async t => {
  const runId = "run:claude-bridge-mismatch";
  const evidence = await terminalEvidence(runId, bridgeSession(6), "Claude result with drifted retained state.");
  const f = await bridgeFixture(runId, evidence.frame.frameDigest); t.after(f.close);

  // The accepted process binding no longer matches the retained publication
  // binding's run.
  await assert.rejects(() => publishClaudeTerminalResultV1(f.config, bridgeInputFor(evidence, runId,
    { retainedBinding: { ...retainedBindingFor(runId), runId: "run:claude-bridge-other" } })),
  /claude_code_result_publication_binding_mismatch/);
  // The retained expected session no longer matches the independently decoded
  // terminal session.
  await assert.rejects(() => publishClaudeTerminalResultV1(f.config, bridgeInputFor(evidence, runId,
    { retainedSession: { ...evidence.retainedSession, sessionId: bridgeSession(7) } })),
  /claude_code_result_publication_session_mismatch/);

  assert.equal(f.storage.putCalls, 0);
  assert.ok(!createPersistentNeutralReservationPort(f.store).peek(nativeFixtureBinding.tenantId, runId),
    "a refused mismatch may leave no reservation behind");
  assert.equal((await f.db.query("SELECT artifact_id FROM control_native_artifact_receipts WHERE run_id=$1",
    [runId])).rows.length, 0);
});

test("the bridge exposes no acquire, dispatch, retry or capacity capability", () => {
  // The only capability the bridge accepts is the shared publication
  // configuration, which carries a database, keys, a storage port and a
  // reservation port. There is no seam through which it could acquire a
  // process, redispatch work or release capacity.
  const source = readFileSync(
    fileURLToPath(new URL("../src/harness/claude-code-v1/result-publication.ts", import.meta.url)), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const forbidden of [/createClaudeCodeOwnedProcessSessionV1/, /\bacquire\b/, /\bdispatch/i,
    /releaseCapacity/i, /\bapprove/i, /\bretry\s*\(/i]) {
    assert.equal(forbidden.test(code), false, `the bridge must not reference ${forbidden}`);
  }
  // Exactly one call into the shared publisher, and no other publisher import.
  assert.equal((code.match(/publishDurableResultV1\(/g) ?? []).length, 1);
  assert.equal(/codex-result|native-result-publication|hermes/i.test(code), false,
    "no Codex, native or Hermes publisher may be copied or reused here");
});
