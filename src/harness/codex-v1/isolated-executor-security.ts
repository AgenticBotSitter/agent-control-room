import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson, sha256Digest } from "../../security";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/;
const BASE64URL = /^[A-Za-z0-9_-]{40,180}$/;
const MAX_EVIDENCE_LIFETIME_MS = 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function publicKey(spki: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(spki, "base64url"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Codex executor authentication key invalid");
  return key;
}

function verifySignature(material: unknown, signature: string, spki: string): boolean {
  if (!BASE64URL.test(signature)) return false;
  try { return verify(null, Buffer.from(canonicalJson(material)), publicKey(spki), Buffer.from(signature, "base64url")); }
  catch { return false; }
}

function assertFresh(issuedAt: string, expiresAt: string, now: string): void {
  const issued = Date.parse(issuedAt); const expires = Date.parse(expiresAt); const observed = Date.parse(now);
  if (![issued, expires, observed].every(Number.isFinite) || issued > observed + MAX_CLOCK_SKEW_MS
    || expires <= observed || expires <= issued || expires - issued > MAX_EVIDENCE_LIFETIME_MS) {
    throw new Error("Codex executor evidence expired");
  }
}

export interface CodexExecutorChannelChallengeV1 {
  schema: "control-room.codex-executor-channel-challenge/v1";
  channelId: string; brokerKeyId: string; executorKeyId: string;
  brokerIdentityDigest: string; executorIdentityDigest: string; environmentIdDigest: string;
  nonce: string; issuedAt: string; expiresAt: string; signature: string;
}

export interface CodexExecutorChannelProofV1 {
  schema: "control-room.codex-executor-channel-proof/v1";
  channelId: string; challengeDigest: string; executorKeyId: string; proofNonce: string;
  issuedAt: string; expiresAt: string; signature: string;
}

export interface CodexAuthenticatedExecutorSessionV1 {
  schema: "control-room.codex-authenticated-executor-session/v1";
  channelId: string; channelBindingDigest: string; brokerIdentityDigest: string;
  executorIdentityDigest: string; environmentIdDigest: string; authenticatedAt: string; expiresAt: string;
}

type ChallengeMaterial = Omit<CodexExecutorChannelChallengeV1, "signature">;
type ProofMaterial = Omit<CodexExecutorChannelProofV1, "signature">;

export function signCodexExecutorChannelChallengeV1(material: ChallengeMaterial, privateKey: KeyObject): CodexExecutorChannelChallengeV1 {
  return { ...material, signature: sign(null, Buffer.from(canonicalJson(material)), privateKey).toString("base64url") };
}

export function signCodexExecutorChannelProofV1(material: ProofMaterial, privateKey: KeyObject): CodexExecutorChannelProofV1 {
  return { ...material, signature: sign(null, Buffer.from(canonicalJson(material)), privateKey).toString("base64url") };
}

export interface CodexExecutorReplayGuardV1 { consumeOnce(...values: string[]): void }

export class InMemoryCodexExecutorReplayGuardV1 implements CodexExecutorReplayGuardV1 {
  private readonly consumed = new Set<string>();
  consumeOnce(...values: string[]): void {
    const digests = values.map((value) => sha256Digest(value));
    if (new Set(digests).size !== digests.length || digests.some((digest) => this.consumed.has(digest))) throw new Error("Codex executor authentication replayed");
    for (const digest of digests) this.consumed.add(digest);
  }
}

export function verifyCodexExecutorChannelHandshakeV1(input: {
  challenge: CodexExecutorChannelChallengeV1; proof: CodexExecutorChannelProofV1;
  expected: { channelId: string; brokerKeyId: string; executorKeyId: string; brokerIdentityDigest: string; executorIdentityDigest: string; environmentIdDigest: string };
  brokerPublicKeySpki: string; executorPublicKeySpki: string; now: string; replay: CodexExecutorReplayGuardV1;
}): CodexAuthenticatedExecutorSessionV1 {
  const challengeKeys = ["schema", "channelId", "brokerKeyId", "executorKeyId", "brokerIdentityDigest", "executorIdentityDigest", "environmentIdDigest", "nonce", "issuedAt", "expiresAt", "signature"];
  const proofKeys = ["schema", "channelId", "challengeDigest", "executorKeyId", "proofNonce", "issuedAt", "expiresAt", "signature"];
  if (!exactKeys(input.challenge, challengeKeys) || !exactKeys(input.proof, proofKeys)) throw new Error("Codex executor authentication malformed");
  const { signature: challengeSignature, ...challengeMaterial } = input.challenge;
  const { signature: proofSignature, ...proofMaterial } = input.proof;
  if (input.challenge.schema !== "control-room.codex-executor-channel-challenge/v1"
    || input.proof.schema !== "control-room.codex-executor-channel-proof/v1"
    || !IDENTIFIER.test(input.challenge.channelId) || !IDENTIFIER.test(input.challenge.brokerKeyId)
    || !IDENTIFIER.test(input.challenge.executorKeyId) || !IDENTIFIER.test(input.challenge.nonce)
    || !IDENTIFIER.test(input.proof.proofNonce)
    || ![input.challenge.brokerIdentityDigest, input.challenge.executorIdentityDigest, input.challenge.environmentIdDigest, input.proof.challengeDigest].every((value) => DIGEST.test(value))) {
    throw new Error("Codex executor authentication malformed");
  }
  for (const [key, value] of Object.entries(input.expected)) {
    if (input.challenge[key as keyof CodexExecutorChannelChallengeV1] !== value
      && !(key === "channelId" && input.proof.channelId === value)) throw new Error("Codex executor authentication scope mismatch");
  }
  if (input.proof.channelId !== input.challenge.channelId || input.proof.executorKeyId !== input.challenge.executorKeyId
    || input.proof.challengeDigest !== sha256Digest(input.challenge)) throw new Error("Codex executor authentication scope mismatch");
  assertFresh(input.challenge.issuedAt, input.challenge.expiresAt, input.now);
  assertFresh(input.proof.issuedAt, input.proof.expiresAt, input.now);
  if (Date.parse(input.proof.issuedAt) < Date.parse(input.challenge.issuedAt)
    || Date.parse(input.proof.expiresAt) > Date.parse(input.challenge.expiresAt)) throw new Error("Codex executor authentication scope mismatch");
  if (!verifySignature(challengeMaterial, challengeSignature, input.brokerPublicKeySpki)
    || !verifySignature(proofMaterial, proofSignature, input.executorPublicKeySpki)) throw new Error("Codex executor authentication signature invalid");
  input.replay.consumeOnce(input.challenge.nonce, input.proof.proofNonce, input.proof.challengeDigest);
  return { schema: "control-room.codex-authenticated-executor-session/v1", channelId: input.challenge.channelId,
    channelBindingDigest: sha256Digest({ challenge: input.challenge, proof: input.proof }),
    brokerIdentityDigest: input.challenge.brokerIdentityDigest, executorIdentityDigest: input.challenge.executorIdentityDigest,
    environmentIdDigest: input.challenge.environmentIdDigest, authenticatedAt: input.proof.issuedAt, expiresAt: input.proof.expiresAt };
}

export interface CodexNativeExecutionEvidenceV1 {
  schema: "control-room.codex-native-execution-evidence/v1"; evidenceId: string; collectorKeyId: string;
  collectorIdentityDigest: string; executorIdentityDigest: string; environmentIdDigest: string;
  executableRealPathDigest: string; executableCodeDirectoryHash: string; spawnSpecDigest: string;
  executorUidDigest: string; argvDigest: string; cwdRealPathDigest: string; environmentDigest: string;
  childProcessObserved: boolean; childUidMatched: boolean; childImageMatched: boolean; argvMatched: boolean;
  cwdMatched: boolean; environmentMatched: boolean; pathOwnerMatched: boolean; pathModePrivate: boolean;
  pathDeviceInodeStable: boolean; observedAt: string; expiresAt: string; signature: string;
}

export interface CodexExecutorTurnReceiptV1 {
  schema: "control-room.codex-executor-turn-receipt/v1"; receiptId: string; executorKeyId: string;
  channelBindingDigest: string; permitDigest: string; runId: string; requestIdDigest: string; ticketDigest: string;
  nativeThreadIdDigest: string; turnIdDigest: string; environmentIdDigest: string; nativeEvidenceDigest: string;
  terminal: "completed" | "failed" | "interrupted";
  cancellationEvidence: "not_requested" | "executor_reported" | "unverified";
  startedAt: string; completedAt: string; signature: string;
}

export interface CodexRemoteCancellationEvidenceV1 {
  schema: "control-room.codex-remote-cancellation-evidence/v1"; evidenceId: string; collectorKeyId: string;
  collectorIdentityDigest: string; executorIdentityDigest: string; environmentIdDigest: string; channelBindingDigest: string;
  nativeThreadIdDigest: string; turnIdDigest: string; interruptRequestDigest: string; interruptAcknowledgementDigest: string;
  descendantSetDigest: string; descendantCount: number; interruptAcknowledged: boolean; descendantsAbsent: boolean;
  observedAt: string; expiresAt: string; signature: string;
}

export interface CodexProviderOutputAuthorityEvidenceV1 {
  schema: "control-room.codex-provider-output-authority/v1"; evidenceId: string; brokerKeyId: string;
  channelBindingDigest: string; permitDigest: string; requestIdDigest: string; ticketDigest: string;
  model: string; maximumOutputTokens: number; enforcement: "provider_request_hard_limit" | "accounting_only";
  providerRequestDigest: string; issuedAt: string; expiresAt: string; signature: string;
}

export function signCodexNativeExecutionEvidenceV1(material: Omit<CodexNativeExecutionEvidenceV1, "signature">, key: KeyObject): CodexNativeExecutionEvidenceV1 {
  return { ...material, signature: sign(null, Buffer.from(canonicalJson(material)), key).toString("base64url") };
}
export function signCodexExecutorTurnReceiptV1(material: Omit<CodexExecutorTurnReceiptV1, "signature">, key: KeyObject): CodexExecutorTurnReceiptV1 {
  return { ...material, signature: sign(null, Buffer.from(canonicalJson(material)), key).toString("base64url") };
}
export function signCodexProviderOutputAuthorityEvidenceV1(material: Omit<CodexProviderOutputAuthorityEvidenceV1, "signature">, key: KeyObject): CodexProviderOutputAuthorityEvidenceV1 {
  return { ...material, signature: sign(null, Buffer.from(canonicalJson(material)), key).toString("base64url") };
}
export function signCodexRemoteCancellationEvidenceV1(material: Omit<CodexRemoteCancellationEvidenceV1, "signature">, key: KeyObject): CodexRemoteCancellationEvidenceV1 {
  return { ...material, signature: sign(null, Buffer.from(canonicalJson(material)), key).toString("base64url") };
}

export function verifyCodexProviderOutputAuthorityEvidenceV1(input: {
  evidence: CodexProviderOutputAuthorityEvidenceV1;
  expected: Pick<CodexProviderOutputAuthorityEvidenceV1, "brokerKeyId" | "channelBindingDigest" | "permitDigest" | "requestIdDigest" | "ticketDigest" | "model" | "maximumOutputTokens" | "providerRequestDigest">;
  brokerPublicKeySpki: string; now: string; replay: CodexExecutorReplayGuardV1;
}): { evidenceDigest: string } {
  const keys = ["schema", "evidenceId", "brokerKeyId", "channelBindingDigest", "permitDigest", "requestIdDigest", "ticketDigest", "model", "maximumOutputTokens", "enforcement", "providerRequestDigest", "issuedAt", "expiresAt", "signature"];
  if (!exactKeys(input.evidence, keys) || input.evidence.schema !== "control-room.codex-provider-output-authority/v1"
    || !IDENTIFIER.test(input.evidence.evidenceId) || !IDENTIFIER.test(input.evidence.brokerKeyId) || !IDENTIFIER.test(input.evidence.model)
    || !Object.entries(input.expected).every(([key, value]) => input.evidence[key as keyof CodexProviderOutputAuthorityEvidenceV1] === value)
    || ![input.evidence.channelBindingDigest, input.evidence.permitDigest, input.evidence.requestIdDigest, input.evidence.ticketDigest,
      input.evidence.providerRequestDigest].every((value) => DIGEST.test(value))
    || !Number.isSafeInteger(input.evidence.maximumOutputTokens) || input.evidence.maximumOutputTokens < 1
    || input.evidence.maximumOutputTokens > 8_192 || input.evidence.enforcement !== "provider_request_hard_limit") {
    throw new Error("Codex provider output authority unverified");
  }
  assertFresh(input.evidence.issuedAt, input.evidence.expiresAt, input.now);
  const { signature, ...material } = input.evidence;
  if (!verifySignature(material, signature, input.brokerPublicKeySpki)) throw new Error("Codex provider output authority signature invalid");
  input.replay.consumeOnce(input.evidence.evidenceId);
  return { evidenceDigest: sha256Digest(input.evidence) };
}

export function verifyCodexNativeExecutionEvidenceV1(input: {
  evidence: CodexNativeExecutionEvidenceV1; expected: Omit<CodexNativeExecutionEvidenceV1, "schema" | "evidenceId" | "observedAt" | "expiresAt" | "signature" | "childProcessObserved" | "childUidMatched" | "childImageMatched" | "argvMatched" | "cwdMatched" | "environmentMatched" | "pathOwnerMatched" | "pathModePrivate" | "pathDeviceInodeStable">;
  collectorPublicKeySpki: string; now: string; replay: CodexExecutorReplayGuardV1;
}): { evidenceDigest: string } {
  const keys = ["schema", "evidenceId", "collectorKeyId", "collectorIdentityDigest", "executorIdentityDigest", "environmentIdDigest", "executableRealPathDigest", "executableCodeDirectoryHash", "spawnSpecDigest", "executorUidDigest", "argvDigest", "cwdRealPathDigest", "environmentDigest", "childProcessObserved", "childUidMatched", "childImageMatched", "argvMatched", "cwdMatched", "environmentMatched", "pathOwnerMatched", "pathModePrivate", "pathDeviceInodeStable", "observedAt", "expiresAt", "signature"];
  if (!exactKeys(input.evidence, keys) || input.evidence.schema !== "control-room.codex-native-execution-evidence/v1" || !IDENTIFIER.test(input.evidence.evidenceId)
    || !IDENTIFIER.test(input.evidence.collectorKeyId)
    || !Object.entries(input.expected).every(([key, value]) => input.evidence[key as keyof CodexNativeExecutionEvidenceV1] === value)
    || ![input.evidence.collectorIdentityDigest, input.evidence.executorIdentityDigest, input.evidence.environmentIdDigest, input.evidence.executableRealPathDigest,
      input.evidence.spawnSpecDigest, input.evidence.executorUidDigest, input.evidence.argvDigest, input.evidence.cwdRealPathDigest, input.evidence.environmentDigest].every((value) => DIGEST.test(value))
    || !/^[a-f0-9]{40,128}$/.test(input.evidence.executableCodeDirectoryHash)) throw new Error("Codex native evidence invalid");
  if (![input.evidence.childProcessObserved, input.evidence.childUidMatched, input.evidence.childImageMatched, input.evidence.argvMatched,
    input.evidence.cwdMatched, input.evidence.environmentMatched, input.evidence.pathOwnerMatched, input.evidence.pathModePrivate, input.evidence.pathDeviceInodeStable].every((value) => value === true)) {
    throw new Error("Codex native evidence incomplete");
  }
  assertFresh(input.evidence.observedAt, input.evidence.expiresAt, input.now);
  const { signature, ...material } = input.evidence;
  if (!verifySignature(material, signature, input.collectorPublicKeySpki)) throw new Error("Codex native evidence signature invalid");
  input.replay.consumeOnce(input.evidence.evidenceId);
  return { evidenceDigest: sha256Digest(input.evidence) };
}

export function verifyCodexRemoteCancellationEvidenceV1(input: {
  evidence: CodexRemoteCancellationEvidenceV1;
  expected: Omit<CodexRemoteCancellationEvidenceV1, "schema" | "evidenceId" | "descendantCount" | "interruptAcknowledged" | "descendantsAbsent" | "observedAt" | "expiresAt" | "signature">;
  collectorPublicKeySpki: string; now: string; replay: CodexExecutorReplayGuardV1;
}): { evidenceDigest: string } {
  const keys = ["schema", "evidenceId", "collectorKeyId", "collectorIdentityDigest", "executorIdentityDigest", "environmentIdDigest",
    "channelBindingDigest", "nativeThreadIdDigest", "turnIdDigest", "interruptRequestDigest", "interruptAcknowledgementDigest",
    "descendantSetDigest", "descendantCount", "interruptAcknowledged", "descendantsAbsent", "observedAt", "expiresAt", "signature"];
  if (!exactKeys(input.evidence, keys) || input.evidence.schema !== "control-room.codex-remote-cancellation-evidence/v1"
    || !IDENTIFIER.test(input.evidence.evidenceId) || !IDENTIFIER.test(input.evidence.collectorKeyId)
    || !Object.entries(input.expected).every(([key, value]) => input.evidence[key as keyof CodexRemoteCancellationEvidenceV1] === value)
    || ![input.evidence.collectorIdentityDigest, input.evidence.executorIdentityDigest, input.evidence.environmentIdDigest,
      input.evidence.channelBindingDigest, input.evidence.nativeThreadIdDigest, input.evidence.turnIdDigest,
      input.evidence.interruptRequestDigest, input.evidence.interruptAcknowledgementDigest, input.evidence.descendantSetDigest]
      .every((value) => DIGEST.test(value))
    || input.evidence.descendantCount !== 0 || input.evidence.interruptAcknowledged !== true || input.evidence.descendantsAbsent !== true) {
    throw new Error("Codex remote cancellation evidence invalid");
  }
  assertFresh(input.evidence.observedAt, input.evidence.expiresAt, input.now);
  const { signature, ...material } = input.evidence;
  if (!verifySignature(material, signature, input.collectorPublicKeySpki)) throw new Error("Codex remote cancellation evidence signature invalid");
  input.replay.consumeOnce(input.evidence.evidenceId);
  return { evidenceDigest: sha256Digest(input.evidence) };
}

export function verifyCodexExecutorTurnReceiptV1(input: {
  receipt: CodexExecutorTurnReceiptV1; session: CodexAuthenticatedExecutorSessionV1;
  expected: Pick<CodexExecutorTurnReceiptV1, "executorKeyId" | "permitDigest" | "runId" | "requestIdDigest" | "ticketDigest" | "nativeThreadIdDigest" | "turnIdDigest" | "nativeEvidenceDigest">;
  executorPublicKeySpki: string; now: string; replay: CodexExecutorReplayGuardV1;
}): { receiptDigest: string; executorReportedCancellation: boolean } {
  const keys = ["schema", "receiptId", "executorKeyId", "channelBindingDigest", "permitDigest", "runId", "requestIdDigest", "ticketDigest", "nativeThreadIdDigest", "turnIdDigest", "environmentIdDigest", "nativeEvidenceDigest", "terminal", "cancellationEvidence", "startedAt", "completedAt", "signature"];
  if (!exactKeys(input.receipt, keys) || input.receipt.schema !== "control-room.codex-executor-turn-receipt/v1" || !IDENTIFIER.test(input.receipt.receiptId)
    || !IDENTIFIER.test(input.receipt.executorKeyId) || !IDENTIFIER.test(input.receipt.runId)
    || !(["completed", "failed", "interrupted"] as unknown[]).includes(input.receipt.terminal)
    || !(["not_requested", "executor_reported", "unverified"] as unknown[]).includes(input.receipt.cancellationEvidence)
    || input.receipt.channelBindingDigest !== input.session.channelBindingDigest || input.receipt.environmentIdDigest !== input.session.environmentIdDigest
    || !Object.entries(input.expected).every(([key, value]) => input.receipt[key as keyof CodexExecutorTurnReceiptV1] === value)
    || ![input.receipt.channelBindingDigest, input.receipt.permitDigest, input.receipt.requestIdDigest, input.receipt.ticketDigest,
      input.receipt.nativeThreadIdDigest, input.receipt.turnIdDigest, input.receipt.environmentIdDigest, input.receipt.nativeEvidenceDigest].every((value) => DIGEST.test(value))) {
    throw new Error("Codex executor receipt scope mismatch");
  }
  const started = Date.parse(input.receipt.startedAt); const completed = Date.parse(input.receipt.completedAt); const observed = Date.parse(input.now);
  if (![started, completed, observed].every(Number.isFinite) || completed < started || completed > observed + MAX_CLOCK_SKEW_MS
    || started < Date.parse(input.session.authenticatedAt) || completed > Date.parse(input.session.expiresAt)
    || observed >= Date.parse(input.session.expiresAt)) throw new Error("Codex executor receipt time invalid");
  if (input.receipt.terminal === "interrupted" && input.receipt.cancellationEvidence !== "executor_reported") throw new Error("Codex remote cancellation unverified");
  if (input.receipt.terminal !== "interrupted" && input.receipt.cancellationEvidence !== "not_requested") throw new Error("Codex executor receipt cancellation invalid");
  const { signature, ...material } = input.receipt;
  if (!verifySignature(material, signature, input.executorPublicKeySpki)) throw new Error("Codex executor receipt signature invalid");
  input.replay.consumeOnce(input.receipt.receiptId);
  return { receiptDigest: sha256Digest(input.receipt), executorReportedCancellation: input.receipt.cancellationEvidence === "executor_reported" };
}
