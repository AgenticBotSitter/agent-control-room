import { sha256Digest } from "../../security";
import { CODEX_PINNED_MACOS_CDHASH_V1 } from "./manifest";
import {
  type CodexExecutorChannelChallengeV1,
  type CodexExecutorChannelProofV1,
  type CodexExecutorReplayGuardV1,
  type CodexExecutorTurnReceiptV1,
  type CodexNativeExecutionEvidenceV1,
  type CodexProviderOutputAuthorityEvidenceV1,
  type CodexRemoteCancellationEvidenceV1,
  verifyCodexExecutorChannelHandshakeV1,
  verifyCodexExecutorTurnReceiptV1,
  verifyCodexNativeExecutionEvidenceV1,
  verifyCodexProviderOutputAuthorityEvidenceV1,
  verifyCodexRemoteCancellationEvidenceV1,
} from "./isolated-executor-security";
import type { CodexExecutorTrustPinRegistryEvidenceV1, CodexResolvedExecutorTrustPinsV1 } from "./isolated-trust-pins";
import { verifyCodexOwnerTrustHighWaterCheckpointV1, type CodexOwnerTrustHighWaterCheckpointV1 } from "./isolated-trust-high-water";

export interface CodexQualificationBundleExpectedV1 {
  channel: { channelId: string; brokerKeyId: string; executorKeyId: string; brokerIdentityDigest: string; executorIdentityDigest: string; environmentIdDigest: string };
  native: Omit<CodexNativeExecutionEvidenceV1, "schema" | "evidenceId" | "observedAt" | "expiresAt" | "signature" | "childProcessObserved" | "childUidMatched" | "childImageMatched" | "argvMatched" | "cwdMatched" | "environmentMatched" | "pathOwnerMatched" | "pathModePrivate" | "pathDeviceInodeStable">;
  turn: Pick<CodexExecutorTurnReceiptV1, "executorKeyId" | "permitDigest" | "runId" | "requestIdDigest" | "ticketDigest" | "nativeThreadIdDigest" | "turnIdDigest">;
  output: Pick<CodexProviderOutputAuthorityEvidenceV1, "brokerKeyId" | "permitDigest" | "requestIdDigest" | "ticketDigest" | "model" | "maximumOutputTokens" | "providerRequestDigest">;
  cancellation: Omit<CodexRemoteCancellationEvidenceV1, "schema" | "evidenceId" | "descendantCount" | "interruptAcknowledged" | "descendantsAbsent" | "observedAt" | "expiresAt" | "signature"> | null;
}

export interface CodexQualificationEvidenceBundleV1 {
  schema: "control-room.codex-qualification-evidence-bundle/v1";
  challenge: CodexExecutorChannelChallengeV1; proof: CodexExecutorChannelProofV1;
  nativeEvidence: CodexNativeExecutionEvidenceV1; outputAuthority: CodexProviderOutputAuthorityEvidenceV1;
  turnReceipt: CodexExecutorTurnReceiptV1; cancellationEvidence: CodexRemoteCancellationEvidenceV1 | null;
}

export interface CodexQualificationBundleResultV1 {
  schema: "control-room.codex-qualification-bundle-result/v1";
  contractSatisfied: true; nativeQualificationAuthorized: false;
  bundleDigest: string; channelBindingDigest: string; nativeEvidenceDigest: string;
  outputAuthorityDigest: string; turnReceiptDigest: string;
  cancellationEvidenceDigest?: string;
  remoteCancellationConfirmed: boolean;
  remainingReason: "trusted_native_deployment_not_observed";
}

class BufferedReplayGuard implements CodexExecutorReplayGuardV1 {
  readonly values: string[] = [];
  consumeOnce(...values: string[]): void { this.values.push(...values); }
}

function assertTimeLineage(bundle: CodexQualificationEvidenceBundleV1): void {
  const authenticated = Date.parse(bundle.proof.issuedAt); const nativeObserved = Date.parse(bundle.nativeEvidence.observedAt);
  const nativeExpires = Date.parse(bundle.nativeEvidence.expiresAt); const outputIssued = Date.parse(bundle.outputAuthority.issuedAt);
  const outputExpires = Date.parse(bundle.outputAuthority.expiresAt); const started = Date.parse(bundle.turnReceipt.startedAt);
  const completed = Date.parse(bundle.turnReceipt.completedAt);
  if (![authenticated, nativeObserved, nativeExpires, outputIssued, outputExpires, started, completed].every(Number.isFinite)
    || authenticated > nativeObserved || nativeObserved > started || nativeExpires < completed
    || outputIssued < authenticated || outputIssued > started || outputExpires < completed) {
    throw new Error("Codex qualification evidence chronology invalid");
  }
}

/**
 * Verifies a complete evidence graph without partial replay consumption.
 * Success proves the repository contract only; owner-installed trust pins and
 * native deployment evidence remain external and this function cannot authorize
 * a native attempt.
 */
export function verifyCodexQualificationEvidenceBundleV1(input: {
  bundle: CodexQualificationEvidenceBundleV1; expected: CodexQualificationBundleExpectedV1;
  brokerPublicKeySpki: string; executorPublicKeySpki: string; collectorPublicKeySpki: string;
  now: string; replay: CodexExecutorReplayGuardV1;
}): CodexQualificationBundleResultV1 {
  if (!input.bundle || typeof input.bundle !== "object" || Array.isArray(input.bundle)
    || Object.keys(input.bundle).sort().join(",") !== ["cancellationEvidence", "challenge", "nativeEvidence", "outputAuthority", "proof", "schema", "turnReceipt"].sort().join(",")
    || input.bundle.schema !== "control-room.codex-qualification-evidence-bundle/v1") throw new Error("Codex qualification bundle malformed");
  const buffered = new BufferedReplayGuard();
  const session = verifyCodexExecutorChannelHandshakeV1({ challenge: input.bundle.challenge, proof: input.bundle.proof,
    expected: input.expected.channel, brokerPublicKeySpki: input.brokerPublicKeySpki,
    executorPublicKeySpki: input.executorPublicKeySpki, now: input.now, replay: buffered });
  if (input.expected.native.executorIdentityDigest !== session.executorIdentityDigest
    || input.expected.native.environmentIdDigest !== session.environmentIdDigest
    || input.expected.native.executableCodeDirectoryHash !== CODEX_PINNED_MACOS_CDHASH_V1) {
    throw new Error("Codex qualification native scope invalid");
  }
  const native = verifyCodexNativeExecutionEvidenceV1({ evidence: input.bundle.nativeEvidence, expected: input.expected.native,
    collectorPublicKeySpki: input.collectorPublicKeySpki, now: input.now, replay: buffered });
  const outputExpected = { ...input.expected.output, channelBindingDigest: session.channelBindingDigest };
  const output = verifyCodexProviderOutputAuthorityEvidenceV1({ evidence: input.bundle.outputAuthority, expected: outputExpected,
    brokerPublicKeySpki: input.brokerPublicKeySpki, now: input.now, replay: buffered });
  const turnExpected = { ...input.expected.turn, nativeEvidenceDigest: native.evidenceDigest };
  const turn = verifyCodexExecutorTurnReceiptV1({ receipt: input.bundle.turnReceipt, session, expected: turnExpected,
    executorPublicKeySpki: input.executorPublicKeySpki, now: input.now, replay: buffered });
  let cancellationEvidenceDigest: string | undefined;
  if (input.bundle.turnReceipt.terminal === "interrupted") {
    if (!input.expected.cancellation || !input.bundle.cancellationEvidence) throw new Error("Codex qualification cancellation evidence missing");
    if (input.expected.cancellation.collectorKeyId !== input.expected.native.collectorKeyId
      || input.expected.cancellation.channelBindingDigest !== session.channelBindingDigest
      || input.expected.cancellation.executorIdentityDigest !== session.executorIdentityDigest
      || input.expected.cancellation.environmentIdDigest !== session.environmentIdDigest
      || input.expected.cancellation.collectorIdentityDigest !== input.expected.native.collectorIdentityDigest
      || input.expected.cancellation.nativeThreadIdDigest !== input.bundle.turnReceipt.nativeThreadIdDigest
      || input.expected.cancellation.turnIdDigest !== input.bundle.turnReceipt.turnIdDigest) {
      throw new Error("Codex qualification cancellation scope invalid");
    }
    const cancellation = verifyCodexRemoteCancellationEvidenceV1({ evidence: input.bundle.cancellationEvidence,
      expected: input.expected.cancellation, collectorPublicKeySpki: input.collectorPublicKeySpki, now: input.now, replay: buffered });
    if (Date.parse(input.bundle.cancellationEvidence.observedAt) < Date.parse(input.bundle.turnReceipt.completedAt)) {
      throw new Error("Codex qualification cancellation chronology invalid");
    }
    cancellationEvidenceDigest = cancellation.evidenceDigest;
  } else if (input.expected.cancellation !== null || input.bundle.cancellationEvidence !== null) {
    throw new Error("Codex qualification unexpected cancellation evidence");
  }
  if (input.bundle.outputAuthority.permitDigest !== input.bundle.turnReceipt.permitDigest
    || input.bundle.outputAuthority.requestIdDigest !== input.bundle.turnReceipt.requestIdDigest
    || input.bundle.outputAuthority.ticketDigest !== input.bundle.turnReceipt.ticketDigest
    || input.bundle.outputAuthority.channelBindingDigest !== input.bundle.turnReceipt.channelBindingDigest) {
    throw new Error("Codex qualification evidence lineage invalid");
  }
  assertTimeLineage(input.bundle);
  input.replay.consumeOnce(...buffered.values);
  return { schema: "control-room.codex-qualification-bundle-result/v1", contractSatisfied: true,
    nativeQualificationAuthorized: false, bundleDigest: sha256Digest(input.bundle), channelBindingDigest: session.channelBindingDigest,
    nativeEvidenceDigest: native.evidenceDigest, outputAuthorityDigest: output.evidenceDigest, turnReceiptDigest: turn.receiptDigest,
    ...(cancellationEvidenceDigest ? { cancellationEvidenceDigest } : {}),
    remoteCancellationConfirmed: cancellationEvidenceDigest !== undefined, remainingReason: "trusted_native_deployment_not_observed" };
}

function verifyCodexQualificationBundleWithResolvedTrustPinsV1(input: {
  bundle: CodexQualificationEvidenceBundleV1; expected: CodexQualificationBundleExpectedV1;
  trustPins: CodexResolvedExecutorTrustPinsV1; now: string; replay: CodexExecutorReplayGuardV1;
}): CodexQualificationBundleResultV1 & { trustManifestDigest: string; trustPinsSatisfied: true } {
  const pins = input.trustPins;
  if (Date.parse(pins.expiresAt) <= Date.parse(input.now)
    || input.expected.channel.brokerKeyId !== pins.brokerKeyId || input.expected.channel.executorKeyId !== pins.executorKeyId
    || input.expected.channel.brokerIdentityDigest !== pins.brokerIdentityDigest
    || input.expected.channel.executorIdentityDigest !== pins.executorIdentityDigest
    || input.expected.channel.environmentIdDigest !== pins.environmentIdDigest
    || input.expected.native.collectorKeyId !== pins.collectorKeyId
    || input.expected.native.collectorIdentityDigest !== pins.collectorIdentityDigest
    || input.expected.native.executorIdentityDigest !== pins.executorIdentityDigest
    || input.expected.native.environmentIdDigest !== pins.environmentIdDigest
    || (input.expected.cancellation !== null && (input.expected.cancellation.collectorKeyId !== pins.collectorKeyId
      || input.expected.cancellation.collectorIdentityDigest !== pins.collectorIdentityDigest))
    || input.expected.turn.executorKeyId !== pins.executorKeyId || input.expected.output.brokerKeyId !== pins.brokerKeyId) {
    throw new Error("Codex qualification trust pin scope mismatch");
  }
  const result = verifyCodexQualificationEvidenceBundleV1({ bundle: input.bundle, expected: input.expected,
    brokerPublicKeySpki: pins.brokerPublicKeySpki, executorPublicKeySpki: pins.executorPublicKeySpki,
    collectorPublicKeySpki: pins.collectorPublicKeySpki, now: input.now, replay: input.replay });
  return { ...result, trustManifestDigest: pins.manifestDigest, trustPinsSatisfied: true };
}

export function verifyCodexQualificationBundleWithAnchoredTrustPinsV1(input: {
  bundle: CodexQualificationEvidenceBundleV1; expected: CodexQualificationBundleExpectedV1;
  trustPins: CodexResolvedExecutorTrustPinsV1; registryEvidence: CodexExecutorTrustPinRegistryEvidenceV1;
  highWaterCheckpoint: CodexOwnerTrustHighWaterCheckpointV1; ownerPublicKeySpki: string;
  expectedRegistryIdentityDigest: string; now: string; replay: CodexExecutorReplayGuardV1;
}): CodexQualificationBundleResultV1 & { trustManifestDigest: string; trustPinsSatisfied: true;
  trustHighWaterSatisfied: true; trustHighWaterCheckpointDigest: string } {
  const anchor = verifyCodexOwnerTrustHighWaterCheckpointV1({ checkpoint: input.highWaterCheckpoint,
    registryEvidence: input.registryEvidence, ownerPublicKeySpki: input.ownerPublicKeySpki,
    expectedRegistryIdentityDigest: input.expectedRegistryIdentityDigest, now: input.now });
  if (input.registryEvidence.state !== "active" || input.trustPins.qualificationId !== input.registryEvidence.qualificationId
    || input.trustPins.revision !== anchor.revision || input.trustPins.manifestDigest !== anchor.manifestDigest
    || input.highWaterCheckpoint.resolvedPinsDigest !== sha256Digest(input.trustPins)) {
    throw new Error("Codex qualification anchored trust mismatch");
  }
  const result = verifyCodexQualificationBundleWithResolvedTrustPinsV1({ bundle: input.bundle, expected: input.expected,
    trustPins: input.trustPins, now: input.now, replay: input.replay });
  return { ...result, trustHighWaterSatisfied: true, trustHighWaterCheckpointDigest: anchor.checkpointDigest };
}
