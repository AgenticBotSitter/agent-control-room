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
import type { DurableResultPublicationConfigurationV1 } from "../src/artifacts/v1/durable-result-publication";
import { resultBytesHash } from "../src/artifacts/v1/native-results";
import { createPersistentNeutralReservationPort,
  createPersistentNeutralReservationStore } from "../src/artifacts/v1/neutral-reservation-port";
import type { ArtifactReadPortV1, ArtifactStoragePortV1 } from "../src/node-executor/artifact-storage";
import { binding as nativeFixtureBinding } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { webNativeResultFixture } from "./helpers/web-native-result";

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
  for (;;) {
    const line = await wire.readLine(new AbortController().signal);
    if (line === undefined) break;
    const frame = decoder.accept(line);
    // The init observation is the retained expected identity. It is captured
    // here, before the terminal frame is decoded at all.
    if (frame.kind === "init") retainedSessionId = frame.sessionId;
    if (frame.kind === "result") terminal = frame;
  }
  assert.ok(retainedSessionId && terminal);
  session.recordTerminalResultObserved();
  await session.close();
  const disposition = session.disposition();
  assert.equal(disposition.reasonCode, "closed_with_decoded_terminal_result");
  return { processBinding, disposition, frame: terminal!, state: decoder.state(),
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

const bridgeInputFor = (evidence: Awaited<ReturnType<typeof terminalEvidence>>, runId: string,
  overrides: Partial<ClaudeTerminalResultPublicationInputV1> = {}): ClaudeTerminalResultPublicationInputV1 => ({
  retainedBinding: retainedBindingFor(runId),
  processBinding: evidence.processBinding,
  retainedSession: evidence.retainedSession,
  disposition: evidence.disposition,
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

  // A reconstructed bridge over the same database and the same reservation
  // store replays identically: this bridge holds no state of its own.
  const reconstructed = await publishClaudeTerminalResultV1(
    f.configWith(createPersistentNeutralReservationPort(f.store)), bridgeInputFor(evidence, runId));
  assert.equal(reconstructed.replayed, true);
  assert.deepEqual(reconstructed.receipt, first.receipt);

  assert.equal(f.storage.putCalls, 1, "a replay must not write bytes again");
  assert.equal(acquisitions, acquisitionsAfterEvidence,
    "publication retry over retained evidence must never start a new process");
  const receipts = (await f.db.query("SELECT artifact_id FROM control_native_artifact_receipts WHERE run_id=$1",
    [runId])).rows;
  assert.equal(receipts.length, 1);
});

test("changed content or changed identity over the same run is refused, not republished", async t => {
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

  // A changed identity field is refused by the publisher's recorded-identity
  // verification before any reservation or byte write.
  await assert.rejects(() => publishClaudeTerminalResultV1(f.config, bridgeInputFor(evidence, runId,
    { retainedBinding: { ...retainedBindingFor(runId), nodeId: "node:other" } })),
  /durable_result_identity_mismatch/);
  assert.equal(f.storage.putCalls, 1);
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
