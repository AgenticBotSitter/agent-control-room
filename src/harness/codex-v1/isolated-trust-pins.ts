import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson, sha256Digest } from "../../security";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/;
const MAX_MANIFEST_LIFETIME_MS = 60 * 60_000;

export interface CodexExecutorTrustPinV1 { keyId: string; publicKeySpki: string; keyFingerprint: string }

export interface CodexExecutorTrustPinManifestV1 {
  schema: "control-room.codex-executor-trust-pins/v1"; manifestId: string; qualificationId: string; revision: number;
  brokerIdentityDigest: string; executorIdentityDigest: string; collectorIdentityDigest: string; environmentIdDigest: string;
  broker: CodexExecutorTrustPinV1; executor: CodexExecutorTrustPinV1; collector: CodexExecutorTrustPinV1;
  state: "active" | "revoked"; validFrom: string; expiresAt: string; supersedesDigest: string | null; ownerSignature: string;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function ed25519PublicKey(spki: string): KeyObject {
  if (!/^[A-Za-z0-9_-]{40,180}$/.test(spki)) throw new Error("Codex trust pin key invalid");
  const supplied = Buffer.from(spki, "base64url");
  const key = createPublicKey({ key: supplied, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Codex trust pin key invalid");
  const canonical = key.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(canonical) || !supplied.equals(canonical) || spki !== canonical.toString("base64url")) {
    throw new Error("Codex trust pin key invalid");
  }
  return key;
}

export function fingerprintCodexExecutorTrustKeyV1(spki: string): string {
  const key = ed25519PublicKey(spki);
  const bytes = key.export({ format: "der", type: "spki" });
  if (!Buffer.isBuffer(bytes)) throw new Error("Codex trust pin key invalid");
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function signCodexExecutorTrustPinManifestV1(material: Omit<CodexExecutorTrustPinManifestV1, "ownerSignature">, ownerPrivateKey: KeyObject): CodexExecutorTrustPinManifestV1 {
  return { ...material, ownerSignature: sign(null, Buffer.from(canonicalJson(material)), ownerPrivateKey).toString("base64url") };
}

export function verifyCodexExecutorTrustPinManifestV1(manifest: CodexExecutorTrustPinManifestV1, ownerPublicKeySpki: string,
  qualificationId: string, now: string): void {
  const keys = ["schema", "manifestId", "qualificationId", "revision", "brokerIdentityDigest", "executorIdentityDigest", "collectorIdentityDigest", "environmentIdDigest", "broker", "executor", "collector", "state", "validFrom", "expiresAt", "supersedesDigest", "ownerSignature"];
  const pinKeys = ["keyId", "publicKeySpki", "keyFingerprint"];
  if (!exactKeys(manifest, keys) || ![manifest.broker, manifest.executor, manifest.collector].every((pin) => exactKeys(pin, pinKeys))) {
    throw new Error("Codex trust pin manifest invalid");
  }
  let observedFingerprints: string[];
  let ownerFingerprint: string;
  try {
    observedFingerprints = [manifest.broker, manifest.executor, manifest.collector]
      .map((pin) => fingerprintCodexExecutorTrustKeyV1(pin.publicKeySpki));
    ownerFingerprint = fingerprintCodexExecutorTrustKeyV1(ownerPublicKeySpki);
  } catch { throw new Error("Codex trust pin manifest invalid"); }
  if (manifest.schema !== "control-room.codex-executor-trust-pins/v1" || !IDENTIFIER.test(manifest.manifestId)
    || !IDENTIFIER.test(manifest.qualificationId) || !Number.isSafeInteger(manifest.revision) || manifest.revision < 1
    || ![manifest.brokerIdentityDigest, manifest.executorIdentityDigest, manifest.collectorIdentityDigest, manifest.environmentIdDigest].every((value) => DIGEST.test(value))
    || new Set([manifest.brokerIdentityDigest, manifest.executorIdentityDigest, manifest.collectorIdentityDigest]).size !== 3
    || new Set([manifest.broker.keyId, manifest.executor.keyId, manifest.collector.keyId]).size !== 3
    || ![manifest.broker, manifest.executor, manifest.collector].every((pin, index) => IDENTIFIER.test(pin.keyId) && DIGEST.test(pin.keyFingerprint)
      && observedFingerprints[index] === pin.keyFingerprint)
    || new Set(observedFingerprints).size !== 3
    || observedFingerprints.includes(ownerFingerprint)
    || !(["active", "revoked"] as unknown[]).includes(manifest.state)
    || (manifest.supersedesDigest !== null && !DIGEST.test(manifest.supersedesDigest))) throw new Error("Codex trust pin manifest invalid");
  const validFrom = Date.parse(manifest.validFrom); const expires = Date.parse(manifest.expiresAt); const observed = Date.parse(now);
  if (![validFrom, expires, observed].every(Number.isFinite) || validFrom > observed || expires <= observed
    || expires <= validFrom || expires - validFrom > MAX_MANIFEST_LIFETIME_MS) throw new Error("Codex trust pin manifest expired");
  const { ownerSignature, ...material } = manifest;
  let signatureValid = false;
  try { signatureValid = verify(null, Buffer.from(canonicalJson(material)), ed25519PublicKey(ownerPublicKeySpki), Buffer.from(ownerSignature, "base64url")); }
  catch { signatureValid = false; }
  if (!signatureValid) throw new Error("Codex trust pin owner signature invalid");
  if (manifest.qualificationId !== qualificationId) throw new Error("Codex trust pin qualification mismatch");
}

export function assertCodexExecutorTrustPinTransitionV1(prior: CodexExecutorTrustPinManifestV1 | undefined,
  manifest: CodexExecutorTrustPinManifestV1): void {
  if (!prior) {
    if (manifest.revision !== 1 || manifest.supersedesDigest !== null) throw new Error("Codex trust pin revision invalid");
    return;
  }
  if (prior.state === "revoked" || manifest.revision !== prior.revision + 1
    || manifest.supersedesDigest !== sha256Digest(prior)) throw new Error("Codex trust pin revision invalid");
  if (manifest.brokerIdentityDigest !== prior.brokerIdentityDigest || manifest.executorIdentityDigest !== prior.executorIdentityDigest
    || manifest.collectorIdentityDigest !== prior.collectorIdentityDigest || manifest.environmentIdDigest !== prior.environmentIdDigest) {
    throw new Error("Codex trust pin identity rotation forbidden");
  }
}

export interface CodexResolvedExecutorTrustPinsV1 {
  manifestDigest: string; qualificationId: string; revision: number; brokerIdentityDigest: string;
  executorIdentityDigest: string; collectorIdentityDigest: string; environmentIdDigest: string;
  brokerKeyId: string; executorKeyId: string; collectorKeyId: string;
  brokerPublicKeySpki: string; executorPublicKeySpki: string; collectorPublicKeySpki: string; expiresAt: string;
}

export interface CodexExecutorTrustPinRegistryEvidenceV1 {
  qualificationId: string; manifestCount: number; currentRevision: number | null;
  currentManifestDigest: string | null; resolvedPinsDigest: string | null;
  state: "active" | "revoked" | "empty"; ownerKeyFingerprint: string;
}

export function projectCodexResolvedExecutorTrustPinsV1(manifest: CodexExecutorTrustPinManifestV1): CodexResolvedExecutorTrustPinsV1 {
  return { manifestDigest: sha256Digest(manifest), qualificationId: manifest.qualificationId, revision: manifest.revision,
    brokerIdentityDigest: manifest.brokerIdentityDigest, executorIdentityDigest: manifest.executorIdentityDigest,
    collectorIdentityDigest: manifest.collectorIdentityDigest, environmentIdDigest: manifest.environmentIdDigest,
    brokerKeyId: manifest.broker.keyId, executorKeyId: manifest.executor.keyId, collectorKeyId: manifest.collector.keyId,
    brokerPublicKeySpki: manifest.broker.publicKeySpki, executorPublicKeySpki: manifest.executor.publicKeySpki,
    collectorPublicKeySpki: manifest.collector.publicKeySpki, expiresAt: manifest.expiresAt };
}

/** Owner-rooted reference registry. A native implementation must persist the same monotonic chain. */
export class InMemoryCodexExecutorTrustPinRegistryV1 {
  private currentManifest?: CodexExecutorTrustPinManifestV1;
  constructor(private readonly qualificationId: string, private readonly ownerPublicKeySpki: string) {
    if (!IDENTIFIER.test(qualificationId)) throw new Error("Codex trust pin qualification invalid");
    ed25519PublicKey(ownerPublicKeySpki);
  }

  apply(manifest: CodexExecutorTrustPinManifestV1, now: string): { manifestDigest: string; state: "active" | "revoked" } {
    verifyCodexExecutorTrustPinManifestV1(manifest, this.ownerPublicKeySpki, this.qualificationId, now);
    const prior = this.currentManifest;
    assertCodexExecutorTrustPinTransitionV1(prior, manifest);
    this.currentManifest = structuredClone(manifest);
    return { manifestDigest: sha256Digest(manifest), state: manifest.state };
  }

  resolve(now: string): CodexResolvedExecutorTrustPinsV1 {
    const manifest = this.currentManifest; const observed = Date.parse(now);
    if (!Number.isFinite(observed) || !manifest || manifest.state !== "active"
      || Date.parse(manifest.validFrom) > observed || Date.parse(manifest.expiresAt) <= observed) {
      throw new Error("Codex trust pins unavailable");
    }
    return projectCodexResolvedExecutorTrustPinsV1(manifest);
  }
}
