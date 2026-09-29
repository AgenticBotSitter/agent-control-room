import { z } from "zod";
import type { ArtifactReadPortV1, ArtifactStoragePortV1 } from "../../node-executor/artifact-storage";
import { resultBytesHash } from "../../artifacts/v1/native-results";
import { sha256Digest } from "../../security/canonical-digest";
import { digestSchema, localId } from "../v1/native-run-identifiers";
import type { ClaudeCodeProcessBindingV1, ClaudeCodeSessionDispositionV1 } from "./owned-process-session";
import type { ClaudeRetainedPublicationBindingV1, ClaudeRetainedSessionEvidenceV1,
  ClaudeTerminalResultPublicationInputV1 } from "./result-publication";
import type { ClaudeCodeResultFrameV1, ClaudeCodeStreamDecoderStateV1 } from "./stream-json-decode";

const unavailable = (): never => { throw new Error("claude_code_terminal_stage_unavailable"); };
const instant = z.string().datetime().refine(value => new Date(value).toISOString() === value);

const retainedBindingSchema = z.object({
  tenantId: localId, projectId: localId, jobId: localId, attemptId: localId, runId: localId, nodeId: localId,
  workflowId: localId, acceptanceProfileId: localId, acceptanceProfileDigest: digestSchema,
}).strict();
const processBindingSchema = z.object({
  processAttemptId: localId, runId: localId, attemptId: localId, invocationDigest: digestSchema,
}).strict();
const retainedSessionSchema = z.object({
  processAttemptId: localId,
  sessionId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  terminalFrameDigest: digestSchema,
}).strict();

/** A deliberately data-only publication input: callbacks and authority are never staged. */
export type ClaudeCodeStagedTerminalResultV1 = Readonly<{
  retainedBinding: ClaudeRetainedPublicationBindingV1;
  processBinding: ClaudeCodeProcessBindingV1;
  retainedSession: ClaudeRetainedSessionEvidenceV1;
  disposition: ClaudeCodeSessionDispositionV1;
  terminalFrameRawLine: string;
  terminalFrame: ClaudeCodeResultFrameV1;
  decoderState: ClaudeCodeStreamDecoderStateV1;
  acceptedConnectorProfileDigest: string;
  receivedAt: string;
}>;

const stagedSchema = z.object({
  schema: z.literal("control-room.claude-code-terminal-stage/v1"),
  retainedBinding: retainedBindingSchema,
  processBinding: processBindingSchema,
  retainedSession: retainedSessionSchema,
  // The durable publisher is the authoritative semantic validator. These fields
  // are retained verbatim so recovery cannot reconstruct or improve evidence.
  disposition: z.object({}).passthrough(),
  terminalFrameRawLine: z.string().min(1).max(262_144),
  terminalFrame: z.object({}).passthrough(),
  decoderState: z.object({}).passthrough(),
  acceptedConnectorProfileDigest: digestSchema,
  receivedAt: instant,
}).strict();

export type ClaudeCodeTerminalResultStagePortV1 = Readonly<{
  /** Capture is called only after clean EOF and certain owned-session cleanup. */
  capture(value: ClaudeCodeStagedTerminalResultV1, signal?: AbortSignal): Promise<void>;
  /** Reads one exact retained record; it never acquires or contacts Claude. */
  recover(signal?: AbortSignal): Promise<ClaudeCodeStagedTerminalResultV1 | undefined>;
}>;

/**
 * Protected custody for a single already-admitted Claude terminal record.
 * Its identifier derives only from retained authority and process identity. It
 * is not a journal, scheduler, retry mechanism or process-resume interface.
 */
export function createClaudeCodeTerminalResultStageV1(input: Readonly<{
  storage: ArtifactStoragePortV1 & ArtifactReadPortV1;
  retainedBinding: ClaudeRetainedPublicationBindingV1;
  processBinding: ClaudeCodeProcessBindingV1;
  receivedAt: string;
}>): ClaudeCodeTerminalResultStagePortV1 {
  if (!input?.storage || typeof input.storage.put !== "function" || typeof input.storage.read !== "function") unavailable();
  const retainedBinding = Object.freeze(retainedBindingSchema.parse(input.retainedBinding));
  const processBinding = Object.freeze(processBindingSchema.parse(input.processBinding));
  const receivedAt = instant.parse(input.receivedAt);
  if (retainedBinding.runId !== processBinding.runId || retainedBinding.attemptId !== processBinding.attemptId) unavailable();
  const artifactId = `artifact:result:${sha256Digest({ purpose: "claude-code-terminal-stage/v1", retainedBinding, processBinding }).slice(7)}`;
  const expected = { retainedBinding, processBinding, receivedAt };
  const decode = (bytes: Uint8Array): ClaudeCodeStagedTerminalResultV1 => {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return unavailable(); }
    const staged = stagedSchema.parse(value);
    if (sha256Digest(staged.retainedBinding) !== sha256Digest(expected.retainedBinding)
      || sha256Digest(staged.processBinding) !== sha256Digest(expected.processBinding)
      || staged.receivedAt !== expected.receivedAt
      || staged.retainedSession.processAttemptId !== expected.processBinding.processAttemptId
      || staged.retainedSession.sessionId !== (staged.terminalFrame as { sessionId?: unknown }).sessionId) unavailable();
    return Object.freeze(staged as unknown as ClaudeCodeStagedTerminalResultV1);
  };
  return Object.freeze({
    async capture(value, signal) {
      const staged = decode(new TextEncoder().encode(JSON.stringify({ schema: "control-room.claude-code-terminal-stage/v1", ...value })));
      if (sha256Digest(staged.retainedBinding) !== sha256Digest(expected.retainedBinding)
        || sha256Digest(staged.processBinding) !== sha256Digest(expected.processBinding)
        || staged.receivedAt !== expected.receivedAt) unavailable();
      const bytes = new TextEncoder().encode(JSON.stringify({ schema: "control-room.claude-code-terminal-stage/v1", ...staged }));
      if (bytes.byteLength > 65_536) unavailable();
      const stored = await input.storage.put({ artifactId, bytes, signal });
      if (stored.artifactId !== artifactId || stored.contentHash !== resultBytesHash(bytes) || stored.sizeBytes !== bytes.byteLength) unavailable();
      const readback = await input.storage.read(artifactId, signal);
      const verified: Uint8Array = readback ?? unavailable();
      if (resultBytesHash(verified) !== resultBytesHash(bytes)) unavailable();
      decode(verified);
    },
    async recover(signal) {
      const bytes = await input.storage.read(artifactId, signal);
      return bytes ? decode(bytes) : undefined;
    },
  });
}

/** Removes the only non-durable value from the ordinary publication input. */
export function stageClaudeCodeTerminalResultInputV1(input: ClaudeTerminalResultPublicationInputV1): ClaudeCodeStagedTerminalResultV1 {
  const { assertAuthority: _assertAuthority, ...staged } = input;
  return Object.freeze(staged);
}
