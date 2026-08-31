import { closeSync, lstatSync, openSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Digest } from "../../security";
import {
  assertCodexExecutorTrustPinTransitionV1,
  fingerprintCodexExecutorTrustKeyV1,
  projectCodexResolvedExecutorTrustPinsV1,
  verifyCodexExecutorTrustPinManifestV1,
  type CodexExecutorTrustPinManifestV1,
  type CodexExecutorTrustPinRegistryEvidenceV1,
  type CodexResolvedExecutorTrustPinsV1,
} from "./isolated-trust-pins";
import { assertPrivateSqliteSchemaV1 } from "./private-sqlite-schema";

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/;

function preparePrivatePath(path: string): void {
  if (!isAbsolute(path) || !process.getuid) throw new Error("Codex trust pin database path invalid");
  const uid = process.getuid(); const parent = statSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) throw new Error("Codex trust pin database path invalid");
  try {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== uid || existing.nlink !== 1 || (existing.mode & 0o077) !== 0) {
      throw new Error("Codex trust pin database path invalid");
    }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    closeSync(openSync(path, "wx", 0o600));
  }
}

interface ManifestRow { revision: number; manifest_digest: string; manifest_json: string; state: "active" | "revoked" }

/**
 * Broker-private, restart-safe owner trust-pin chain. This stores public keys,
 * digests, and owner signatures only. Rollback resistance across replacement of
 * the complete database still requires an owner-controlled external high-water mark.
 */
export class SqliteCodexExecutorTrustPinRegistryV1 {
  private readonly db: DatabaseSync;
  private readonly ownerKeyFingerprint: string;

  constructor(path: string, private readonly qualificationId: string, private readonly ownerPublicKeySpki: string,
    private readonly maximumRevisions = 1_024) {
    if (!IDENTIFIER.test(qualificationId) || !Number.isSafeInteger(maximumRevisions)
      || maximumRevisions < 1 || maximumRevisions > 10_000) throw new Error("Codex trust pin registry configuration invalid");
    this.ownerKeyFingerprint = fingerprintCodexExecutorTrustKeyV1(ownerPublicKeySpki);
    preparePrivatePath(path);
    this.db = new DatabaseSync(path);
    const schemaVersion = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (schemaVersion !== 0 && schemaVersion !== 1) { this.db.close(); throw new Error("Codex trust pin registry schema unsupported"); }
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS codex_executor_trust_pin_registry (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        qualification_id TEXT NOT NULL,
        owner_key_fingerprint TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS codex_executor_trust_pin_manifest (
        revision INTEGER PRIMARY KEY CHECK(revision >= 1),
        manifest_digest TEXT NOT NULL UNIQUE CHECK(length(manifest_digest)=71),
        manifest_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','revoked'))
      );`);
    if (schemaVersion === 0) this.db.exec("PRAGMA user_version=1");
    try { assertPrivateSqliteSchemaV1(this.db, ["table:codex_executor_trust_pin_manifest", "table:codex_executor_trust_pin_registry"], {
      codex_executor_trust_pin_registry: [
        { name: "singleton", type: "INTEGER", notnull: 0, pk: 1 },
        { name: "qualification_id", type: "TEXT", notnull: 1, pk: 0 },
        { name: "owner_key_fingerprint", type: "TEXT", notnull: 1, pk: 0 },
      ],
      codex_executor_trust_pin_manifest: [
        { name: "revision", type: "INTEGER", notnull: 0, pk: 1 },
        { name: "manifest_digest", type: "TEXT", notnull: 1, pk: 0 },
        { name: "manifest_json", type: "TEXT", notnull: 1, pk: 0 },
        { name: "state", type: "TEXT", notnull: 1, pk: 0 },
      ],
    }, {
      codex_executor_trust_pin_registry: "CREATE TABLE codex_executor_trust_pin_registry (singleton INTEGER PRIMARY KEY CHECK(singleton=1), qualification_id TEXT NOT NULL, owner_key_fingerprint TEXT NOT NULL)",
      codex_executor_trust_pin_manifest: "CREATE TABLE codex_executor_trust_pin_manifest (revision INTEGER PRIMARY KEY CHECK(revision >= 1), manifest_digest TEXT NOT NULL UNIQUE CHECK(length(manifest_digest)=71), manifest_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','revoked')))",
    }); } catch (error) { this.db.close(); throw error; }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const metadata = this.db.prepare("SELECT qualification_id,owner_key_fingerprint FROM codex_executor_trust_pin_registry WHERE singleton=1")
        .get() as { qualification_id: string; owner_key_fingerprint: string } | undefined;
      if (!metadata) this.db.prepare("INSERT INTO codex_executor_trust_pin_registry(singleton,qualification_id,owner_key_fingerprint) VALUES (1,?,?)")
        .run(qualificationId, this.ownerKeyFingerprint);
      else if (metadata.qualification_id !== qualificationId || metadata.owner_key_fingerprint !== this.ownerKeyFingerprint) {
        throw new Error("Codex trust pin registry identity mismatch");
      }
      this.readVerifiedChain();
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); this.db.close(); throw error; }
  }

  private readVerifiedChain(): CodexExecutorTrustPinManifestV1[] {
    const rows = this.db.prepare("SELECT revision,manifest_digest,manifest_json,state FROM codex_executor_trust_pin_manifest ORDER BY revision")
      .all() as unknown as ManifestRow[];
    const manifests: CodexExecutorTrustPinManifestV1[] = [];
    for (const row of rows) {
      let manifest: CodexExecutorTrustPinManifestV1;
      try { manifest = JSON.parse(row.manifest_json) as CodexExecutorTrustPinManifestV1; }
      catch { throw new Error("Codex trust pin registry integrity invalid"); }
      try {
        verifyCodexExecutorTrustPinManifestV1(manifest, this.ownerPublicKeySpki, this.qualificationId, manifest.validFrom);
        assertCodexExecutorTrustPinTransitionV1(manifests.at(-1), manifest);
      } catch { throw new Error("Codex trust pin registry integrity invalid"); }
      if (row.revision !== manifest.revision || row.manifest_digest !== sha256Digest(manifest) || row.state !== manifest.state) {
        throw new Error("Codex trust pin registry integrity invalid");
      }
      manifests.push(manifest);
    }
    return manifests;
  }

  apply(manifest: CodexExecutorTrustPinManifestV1, now: string): { manifestDigest: string; state: "active" | "revoked" } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const chain = this.readVerifiedChain();
      if (chain.length >= this.maximumRevisions) throw new Error("Codex trust pin registry capacity exhausted");
      verifyCodexExecutorTrustPinManifestV1(manifest, this.ownerPublicKeySpki, this.qualificationId, now);
      assertCodexExecutorTrustPinTransitionV1(chain.at(-1), manifest);
      const manifestDigest = sha256Digest(manifest);
      this.db.prepare("INSERT INTO codex_executor_trust_pin_manifest(revision,manifest_digest,manifest_json,state) VALUES (?,?,?,?)")
        .run(manifest.revision, manifestDigest, canonicalJson(manifest), manifest.state);
      const stored = this.db.prepare("SELECT manifest_digest,manifest_json,state FROM codex_executor_trust_pin_manifest WHERE revision=?")
        .get(manifest.revision) as { manifest_digest: string; manifest_json: string; state: string } | undefined;
      if (!stored || stored.manifest_digest !== manifestDigest || stored.manifest_json !== canonicalJson(manifest) || stored.state !== manifest.state) {
        throw new Error("Codex trust pin registry persistence invalid");
      }
      this.db.exec("COMMIT");
      return { manifestDigest, state: manifest.state };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  resolve(now: string): CodexResolvedExecutorTrustPinsV1 {
    const manifest = this.readVerifiedChain().at(-1); const observed = Date.parse(now);
    if (!manifest || manifest.state !== "active" || !Number.isFinite(observed)
      || Date.parse(manifest.validFrom) > observed || Date.parse(manifest.expiresAt) <= observed) {
      throw new Error("Codex trust pins unavailable");
    }
    return projectCodexResolvedExecutorTrustPinsV1(manifest);
  }

  evidence(): CodexExecutorTrustPinRegistryEvidenceV1 {
    const chain = this.readVerifiedChain(); const current = chain.at(-1);
    return { qualificationId: this.qualificationId, manifestCount: chain.length, currentRevision: current?.revision ?? null,
      currentManifestDigest: current ? sha256Digest(current) : null,
      resolvedPinsDigest: current?.state === "active" ? sha256Digest(projectCodexResolvedExecutorTrustPinsV1(current)) : null,
      state: current?.state ?? "empty",
      ownerKeyFingerprint: this.ownerKeyFingerprint };
  }

  closeDatabase(): void { this.db.close(); }
}
