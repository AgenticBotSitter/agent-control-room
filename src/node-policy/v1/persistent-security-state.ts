import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertNoSecretMaterial } from "../../security";
import { type Clock } from "./clock";
import { verifyArtifactSignature, verifyTrustBundleShrinkAuthorization } from "./crypto";
import { PinnedOwnerTrust } from "./owner-pins";
import { ownerSignedTrustBundleSchema, signedNodeAuthorityCeilingSchema } from "./schemas";
import { ProtectedStoreError, type ServerTrustStore } from "./stores";
import type { OwnerSignedTrustBundleV1, SignedNodeAuthorityCeilingV1 } from "./types";

export interface NodeSecurityStatePaths {
  artifactDatabasePath: string;
  highWaterDatabasePath: string;
}

export interface NodeSecurityStateBinding {
  tenantId: string;
  nodeId: string;
  nodeClass: string;
}

export type SecurityStateFaultPoint =
  | "ceiling_after_prepare"
  | "ceiling_after_artifact"
  | "ceiling_after_commit"
  | "trust_after_prepare"
  | "trust_after_artifact"
  | "trust_after_commit";

export type SecurityStateFaultInjector = (point: SecurityStateFaultPoint) => void;
export type SecurityArtifactAdoption = "provisioned" | "adopted" | "duplicate" | "recovered";

interface CeilingRow {
  version: number;
  body_digest: string;
  artifact_json: string;
}

interface TrustRow {
  epoch: number;
  body_digest: string;
  bundle_json: string;
}

interface HighWaterRow {
  sequence: number;
  body_digest: string;
  phase: "prepared" | "committed";
}

interface TrustHistoryRow {
  key_id: string;
  spki: string;
  spki_digest: string;
  state: "active" | "retired" | "revoked";
  last_seen_epoch: number;
}

function spkiDigest(spki: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(spki, "base64url")).digest("hex")}`;
}

function durablePathIdentity(path: string): string {
  if (path === ":memory:" || path.startsWith("file:")) throw new ProtectedStoreError("invalid_configuration");
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    try {
      return join(realpathSync.native(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }
}

function sameExistingFile(left: string, right: string): boolean {
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

export class SqliteNodeSecurityStateRepository implements ServerTrustStore {
  private readonly artifacts: DatabaseSync;
  private readonly highWater: DatabaseSync;

  constructor(
    paths: NodeSecurityStatePaths,
    private readonly binding: NodeSecurityStateBinding,
    private readonly ownerPins: PinnedOwnerTrust,
    private readonly clock: Clock,
    private readonly faultInjector: SecurityStateFaultInjector = () => undefined,
  ) {
    if (durablePathIdentity(paths.artifactDatabasePath) === durablePathIdentity(paths.highWaterDatabasePath)
      || sameExistingFile(paths.artifactDatabasePath, paths.highWaterDatabasePath)) throw new ProtectedStoreError("invalid_configuration");
    let artifacts: DatabaseSync | undefined;
    let highWater: DatabaseSync | undefined;
    try {
      artifacts = new DatabaseSync(paths.artifactDatabasePath);
      highWater = new DatabaseSync(paths.highWaterDatabasePath);
      this.artifacts = artifacts;
      this.highWater = highWater;
      this.configure(this.artifacts);
      this.configure(this.highWater);
      this.migrate();
    } catch (error) {
      try { artifacts?.close(); } catch { /* fixed safe error below */ }
      try { highWater?.close(); } catch { /* fixed safe error below */ }
      if (error instanceof ProtectedStoreError) throw error;
      throw new ProtectedStoreError("invalid_configuration");
    }
  }

  close(): void {
    let failed = false;
    try { this.artifacts.close(); } catch { failed = true; }
    try { this.highWater.close(); } catch { failed = true; }
    if (failed) throw new ProtectedStoreError("corrupt");
  }

  async provisionInitialCeiling(artifact: SignedNodeAuthorityCeilingV1): Promise<SecurityArtifactAdoption> {
    const ceiling = this.verifyCeiling(artifact, "candidate");
    const currentRow = this.ceilingRow();
    const water = this.ceilingHighWater();
    if (water?.phase === "prepared") {
      if (water.sequence !== ceiling.body.version || water.body_digest !== ceiling.body.bodyDigest) throw new ProtectedStoreError("recovery_required");
      if (currentRow) {
        if (currentRow.version !== water.sequence || currentRow.body_digest !== water.body_digest) throw new ProtectedStoreError("rollback_detected");
        this.verifyCeilingRow(currentRow);
      } else {
        this.writeCeiling(ceiling);
        this.faultInjector("ceiling_after_artifact");
      }
      this.commitCeilingHighWater(water.sequence, water.body_digest);
      this.faultInjector("ceiling_after_commit");
      return "recovered";
    }
    if (water || currentRow) {
      if (water?.phase === "committed" && currentRow && water.sequence === ceiling.body.version && water.body_digest === ceiling.body.bodyDigest) {
        this.verifyCeilingRow(currentRow);
        return "duplicate";
      }
      throw new ProtectedStoreError(water && currentRow ? "invalid_configuration" : "rollback_detected");
    }
    this.insertCeilingHighWater(ceiling.body.version, ceiling.body.bodyDigest, "prepared");
    this.faultInjector("ceiling_after_prepare");
    this.writeCeiling(ceiling);
    this.faultInjector("ceiling_after_artifact");
    this.commitCeilingHighWater(ceiling.body.version, ceiling.body.bodyDigest);
    this.faultInjector("ceiling_after_commit");
    return "provisioned";
  }

  async adoptCeiling(artifact: SignedNodeAuthorityCeilingV1): Promise<SecurityArtifactAdoption> {
    const candidate = this.verifyCeiling(artifact, "candidate");
    const currentRow = this.ceilingRow();
    const water = this.ceilingHighWater();
    if (!water && !currentRow) throw new ProtectedStoreError("missing");
    if (!water) throw new ProtectedStoreError("rollback_detected");

    if (water.phase === "prepared") {
      if (water.sequence !== candidate.body.version || water.body_digest !== candidate.body.bodyDigest) throw new ProtectedStoreError("recovery_required");
      if (!currentRow) throw new ProtectedStoreError("recovery_required");
      if (currentRow && currentRow.version === water.sequence && currentRow.body_digest === water.body_digest) {
        this.verifyCeilingRow(currentRow);
        this.commitCeilingHighWater(water.sequence, water.body_digest);
        return "recovered";
      }
      if (currentRow && currentRow.version >= water.sequence) throw new ProtectedStoreError("rollback_detected");
      this.writeCeiling(candidate);
      this.faultInjector("ceiling_after_artifact");
      this.commitCeilingHighWater(water.sequence, water.body_digest);
      this.faultInjector("ceiling_after_commit");
      return "recovered";
    }
    if (!currentRow) throw new ProtectedStoreError("rollback_detected");

    const current = this.verifyCeilingRow(currentRow);
    if (water.sequence !== current.body.version || water.body_digest !== current.body.bodyDigest) throw new ProtectedStoreError("rollback_detected");
    if (candidate.body.version < current.body.version) throw new ProtectedStoreError("rollback_detected");
    if (candidate.body.version === current.body.version) {
      if (candidate.body.bodyDigest !== current.body.bodyDigest) throw new ProtectedStoreError("rollback_detected");
      return "duplicate";
    }

    this.updateCeilingHighWater(candidate.body.version, candidate.body.bodyDigest, current.body.version);
    this.faultInjector("ceiling_after_prepare");
    this.writeCeiling(candidate);
    this.faultInjector("ceiling_after_artifact");
    this.commitCeilingHighWater(candidate.body.version, candidate.body.bodyDigest);
    this.faultInjector("ceiling_after_commit");
    return "adopted";
  }

  /** Synchronous freshness fence; never repairs a partially committed update. */
  currentPolicyRevision(): string {
    const ceiling = this.ceilingRow(), ceilingWater = this.ceilingHighWater();
    if (!ceiling || !ceilingWater) throw new ProtectedStoreError("missing");
    if (ceilingWater.phase !== "committed" || ceiling.version !== ceilingWater.sequence
      || ceiling.body_digest !== ceilingWater.body_digest) throw new ProtectedStoreError("recovery_required");
    this.verifyCeilingRow(ceiling);
    return `${ceiling.version}:${ceiling.body_digest}:${this.currentServerTrustRevision()}`;
  }

  /** Recovery may need current owner trust after work authority has expired or become unavailable. */
  currentServerTrustRevision(): string {
    const trust = this.trustRow(), trustWater = this.trustHighWater();
    if (!trust || !trustWater) throw new ProtectedStoreError("missing");
    if (trustWater.phase !== "committed" || trust.epoch !== trustWater.sequence
      || trust.body_digest !== trustWater.body_digest) throw new ProtectedStoreError("recovery_required");
    this.verifyTrustRow(trust);
    return `${trust.epoch}:${trust.body_digest}`;
  }

  async loadCeiling(): Promise<SignedNodeAuthorityCeilingV1> {
    const row = this.ceilingRow();
    const water = this.ceilingHighWater();
    if (!row && !water) throw new ProtectedStoreError("missing");
    if (!row || !water) throw new ProtectedStoreError("rollback_detected");
    const ceiling = this.verifyCeilingRow(row);
    if (water.phase === "prepared") {
      if (row.version !== water.sequence || row.body_digest !== water.body_digest) throw new ProtectedStoreError("recovery_required");
      this.commitCeilingHighWater(water.sequence, water.body_digest);
      return ceiling;
    }
    if (row.version !== water.sequence || row.body_digest !== water.body_digest) throw new ProtectedStoreError("rollback_detected");
    return ceiling;
  }

  async provisionInitialTrustBundle(bundle: OwnerSignedTrustBundleV1): Promise<SecurityArtifactAdoption> {
    const validated = this.verifyTrustBundle(bundle, "candidate");
    const currentRow = this.trustRow();
    const water = this.trustHighWater();
    if (water?.phase === "prepared") {
      if (water.sequence !== validated.body.epoch || water.body_digest !== validated.body.bodyDigest) throw new ProtectedStoreError("recovery_required");
      if (currentRow) {
        if (currentRow.epoch !== water.sequence || currentRow.body_digest !== water.body_digest) throw new ProtectedStoreError("rollback_detected");
        this.verifyTrustRow(currentRow);
      } else {
        if (this.trustHistory().length !== 0) throw new ProtectedStoreError("corrupt");
        this.writeTrustBundle(validated);
        this.faultInjector("trust_after_artifact");
      }
      this.commitTrustHighWater(water.sequence, water.body_digest);
      this.faultInjector("trust_after_commit");
      return "recovered";
    }
    if (water || currentRow) {
      if (water?.phase === "committed" && currentRow && water.sequence === validated.body.epoch && water.body_digest === validated.body.bodyDigest) {
        this.verifyTrustRow(currentRow);
        return "duplicate";
      }
      throw new ProtectedStoreError(water && currentRow ? "invalid_configuration" : "rollback_detected");
    }
    if (this.trustHistory().length !== 0) throw new ProtectedStoreError("corrupt");
    this.insertTrustHighWater(validated.body.epoch, validated.body.bodyDigest, "prepared");
    this.faultInjector("trust_after_prepare");
    this.writeTrustBundle(validated);
    this.faultInjector("trust_after_artifact");
    this.commitTrustHighWater(validated.body.epoch, validated.body.bodyDigest);
    this.faultInjector("trust_after_commit");
    return "provisioned";
  }

  async applyOwnerSignedBundle(bundle: OwnerSignedTrustBundleV1): Promise<void> {
    const candidate = this.verifyTrustBundle(bundle, "candidate");
    const currentRow = this.trustRow();
    const water = this.trustHighWater();
    if (!water && !currentRow) throw new ProtectedStoreError("missing");
    if (!water) throw new ProtectedStoreError("rollback_detected");

    if (water.phase === "prepared") {
      if (water.sequence !== candidate.body.epoch || water.body_digest !== candidate.body.bodyDigest) throw new ProtectedStoreError("recovery_required");
      if (!currentRow) throw new ProtectedStoreError("recovery_required");
      if (currentRow && currentRow.epoch === water.sequence && currentRow.body_digest === water.body_digest) {
        this.verifyTrustRow(currentRow);
        this.commitTrustHighWater(water.sequence, water.body_digest);
        return;
      }
      if (currentRow && currentRow.epoch >= water.sequence) throw new ProtectedStoreError("rollback_detected");
      if (currentRow) this.validateTrustTransition(this.verifyTrustRow(currentRow), candidate);
      this.writeTrustBundle(candidate);
      this.faultInjector("trust_after_artifact");
      this.commitTrustHighWater(water.sequence, water.body_digest);
      this.faultInjector("trust_after_commit");
      return;
    }
    if (!currentRow) throw new ProtectedStoreError("rollback_detected");

    const current = this.verifyTrustRow(currentRow);
    if (water.sequence !== current.body.epoch || water.body_digest !== current.body.bodyDigest) throw new ProtectedStoreError("rollback_detected");
    if (candidate.body.epoch < current.body.epoch) throw new ProtectedStoreError("rollback_detected");
    if (candidate.body.epoch === current.body.epoch) {
      if (candidate.body.bodyDigest !== current.body.bodyDigest) throw new ProtectedStoreError("rollback_detected");
      return;
    }
    this.validateTrustTransition(current, candidate);
    this.updateTrustHighWater(candidate.body.epoch, candidate.body.bodyDigest, current.body.epoch);
    this.faultInjector("trust_after_prepare");
    this.writeTrustBundle(candidate);
    this.faultInjector("trust_after_artifact");
    this.commitTrustHighWater(candidate.body.epoch, candidate.body.bodyDigest);
    this.faultInjector("trust_after_commit");
  }

  async currentEpoch(): Promise<number> {
    return (await this.loadTrustBundle()).body.epoch;
  }

  async resolveServerKey(keyId: string): Promise<Uint8Array | undefined> {
    const bundle = await this.loadTrustBundle();
    const key = bundle.body.keys.find((candidate) => candidate.keyId === keyId && candidate.state === "active");
    return key ? new Uint8Array(Buffer.from(key.spki, "base64url")) : undefined;
  }

  async loadTrustBundle(): Promise<OwnerSignedTrustBundleV1> {
    const row = this.trustRow();
    const water = this.trustHighWater();
    if (!row && !water) throw new ProtectedStoreError("missing");
    if (!row || !water) throw new ProtectedStoreError("rollback_detected");
    const bundle = this.verifyTrustRow(row);
    if (water.phase === "prepared") {
      if (row.epoch !== water.sequence || row.body_digest !== water.body_digest) throw new ProtectedStoreError("recovery_required");
      this.commitTrustHighWater(water.sequence, water.body_digest);
      return bundle;
    }
    if (row.epoch !== water.sequence || row.body_digest !== water.body_digest) throw new ProtectedStoreError("rollback_detected");
    return bundle;
  }

  private verifyCeiling(artifact: SignedNodeAuthorityCeilingV1, source: "candidate" | "stored"): SignedNodeAuthorityCeilingV1 {
    const parsed = signedNodeAuthorityCeilingSchema.safeParse(artifact);
    if (!parsed.success) throw new ProtectedStoreError(source === "stored" ? "corrupt" : "invalid_bundle");
    const ceiling = parsed.data;
    if (ceiling.body.tenantId !== this.binding.tenantId || ceiling.body.nodeId !== this.binding.nodeId) throw new ProtectedStoreError(source === "stored" ? "corrupt" : "invalid_bundle");
    const pin = this.ownerPins.ceilingProvisioningKey(ceiling.body.issuerKeyId);
    if (!pin) throw new ProtectedStoreError(source === "stored" ? "corrupt" : "invalid_bundle");
    try {
      if (!verifyArtifactSignature(ceiling, pin.spki)) throw new Error("invalid signature");
    } catch {
      throw new ProtectedStoreError(source === "stored" ? "corrupt" : "invalid_bundle");
    }
    return ceiling;
  }

  private verifyTrustBundle(bundle: OwnerSignedTrustBundleV1, source: "candidate" | "stored"): OwnerSignedTrustBundleV1 {
    const parsed = ownerSignedTrustBundleSchema.safeParse(bundle);
    if (!parsed.success) throw new ProtectedStoreError(source === "stored" ? "corrupt" : "invalid_bundle");
    const trust = parsed.data;
    if (trust.body.tenantId !== this.binding.tenantId || trust.body.nodeClass !== this.binding.nodeClass) throw new ProtectedStoreError(source === "stored" ? "corrupt" : "invalid_bundle");
    const pin = this.ownerPins.serverTrustRootKey(trust.body.ownerRootKeyId);
    if (!pin) throw new ProtectedStoreError(source === "stored" ? "corrupt" : "invalid_bundle");
    try {
      if (!verifyArtifactSignature(trust, pin.spki)) throw new Error("invalid signature");
    } catch {
      throw new ProtectedStoreError(source === "stored" ? "corrupt" : "invalid_bundle");
    }
    return trust;
  }

  private verifyCeilingRow(row: CeilingRow): SignedNodeAuthorityCeilingV1 {
    let artifact: unknown;
    try {
      artifact = JSON.parse(row.artifact_json);
    } catch {
      throw new ProtectedStoreError("corrupt");
    }
    const ceiling = this.verifyCeiling(artifact as SignedNodeAuthorityCeilingV1, "stored");
    if (row.version !== ceiling.body.version || row.body_digest !== ceiling.body.bodyDigest) throw new ProtectedStoreError("corrupt");
    return ceiling;
  }

  private verifyTrustRow(row: TrustRow): OwnerSignedTrustBundleV1 {
    let artifact: unknown;
    try {
      artifact = JSON.parse(row.bundle_json);
    } catch {
      throw new ProtectedStoreError("corrupt");
    }
    const bundle = this.verifyTrustBundle(artifact as OwnerSignedTrustBundleV1, "stored");
    if (row.epoch !== bundle.body.epoch || row.body_digest !== bundle.body.bodyDigest) throw new ProtectedStoreError("corrupt");
    this.validateTrustHistory(bundle);
    return bundle;
  }

  private validateTrustTransition(current: OwnerSignedTrustBundleV1, candidate: OwnerSignedTrustBundleV1): void {
    const history = this.trustHistory();
    const candidateKeys = new Map(candidate.body.keys.map((key) => [key.keyId, key]));
    const historyBySpki = new Map(history.map((key) => [key.spki_digest, key.key_id]));
    for (const prior of history) {
      const next = candidateKeys.get(prior.key_id);
      if (!next || next.spki !== prior.spki) throw new ProtectedStoreError("invalid_bundle");
      if (prior.state === "revoked" && next.state !== "revoked") throw new ProtectedStoreError("invalid_bundle");
      if (prior.state === "retired" && next.state === "active") throw new ProtectedStoreError("invalid_bundle");
    }
    for (const next of candidate.body.keys) {
      const priorKeyId = historyBySpki.get(spkiDigest(next.spki));
      if (priorKeyId && priorKeyId !== next.keyId) throw new ProtectedStoreError("invalid_bundle");
    }

    const priorActive = new Set(current.body.keys.filter((key) => key.state === "active").map((key) => key.keyId));
    const hasActiveOverlap = candidate.body.keys.some((key) => key.state === "active" && priorActive.has(key.keyId));
    if (!hasActiveOverlap) {
      const authorization = candidate.shrinkAuthorization;
      if (!authorization) throw new ProtectedStoreError("invalid_bundle");
      const pin = this.ownerPins.trustShrinkKey(authorization.keyId);
      if (!pin || authorization.bundleBodyDigest !== candidate.body.bodyDigest) throw new ProtectedStoreError("invalid_bundle");
      try {
        if (!verifyTrustBundleShrinkAuthorization(authorization, pin.spki)) throw new Error("invalid signature");
      } catch {
        throw new ProtectedStoreError("invalid_bundle");
      }
    }
  }

  private validateTrustHistory(bundle: OwnerSignedTrustBundleV1): void {
    const history = this.trustHistory();
    if (history.length !== bundle.body.keys.length) throw new ProtectedStoreError("corrupt");
    const keys = new Map(bundle.body.keys.map((key) => [key.keyId, key]));
    for (const row of history) {
      const key = keys.get(row.key_id);
      if (!key || key.spki !== row.spki || spkiDigest(key.spki) !== row.spki_digest || key.state !== row.state || row.last_seen_epoch !== bundle.body.epoch) {
        throw new ProtectedStoreError("corrupt");
      }
    }
  }

  private writeCeiling(ceiling: SignedNodeAuthorityCeilingV1): void {
    try { assertNoSecretMaterial(ceiling, "node ceiling"); } catch { throw new ProtectedStoreError("invalid_bundle"); }
    this.transaction(this.artifacts, () => {
      this.artifacts.prepare(
        `INSERT INTO node_ceiling_current(tenant_id,node_id,version,body_digest,artifact_json,adopted_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(tenant_id,node_id) DO UPDATE SET version=excluded.version,body_digest=excluded.body_digest,artifact_json=excluded.artifact_json,adopted_at=excluded.adopted_at`,
      ).run(this.binding.tenantId,this.binding.nodeId,ceiling.body.version,ceiling.body.bodyDigest,JSON.stringify(ceiling),this.clock.now());
    });
  }

  private writeTrustBundle(bundle: OwnerSignedTrustBundleV1): void {
    try { assertNoSecretMaterial(bundle, "server trust bundle"); } catch { throw new ProtectedStoreError("invalid_bundle"); }
    this.transaction(this.artifacts, () => {
      this.artifacts.prepare(
        `INSERT INTO server_trust_current(tenant_id,node_class,epoch,body_digest,bundle_json,adopted_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(tenant_id,node_class) DO UPDATE SET epoch=excluded.epoch,body_digest=excluded.body_digest,bundle_json=excluded.bundle_json,adopted_at=excluded.adopted_at`,
      ).run(this.binding.tenantId,this.binding.nodeClass,bundle.body.epoch,bundle.body.bodyDigest,JSON.stringify(bundle),this.clock.now());
      const upsert = this.artifacts.prepare(
        `INSERT INTO server_trust_key_history(tenant_id,node_class,key_id,spki,spki_digest,state,first_seen_epoch,last_seen_epoch)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(tenant_id,node_class,key_id) DO UPDATE SET state=excluded.state,last_seen_epoch=excluded.last_seen_epoch`,
      );
      for (const key of bundle.body.keys) {
        upsert.run(this.binding.tenantId,this.binding.nodeClass,key.keyId,key.spki,spkiDigest(key.spki),key.state,bundle.body.epoch,bundle.body.epoch);
      }
    });
  }

  private ceilingRow(): CeilingRow | undefined {
    return this.storage(() => this.artifacts.prepare(
      `SELECT version,body_digest,artifact_json FROM node_ceiling_current WHERE tenant_id=? AND node_id=?`,
    ).get(this.binding.tenantId,this.binding.nodeId) as CeilingRow | undefined);
  }

  private trustRow(): TrustRow | undefined {
    return this.storage(() => this.artifacts.prepare(
      `SELECT epoch,body_digest,bundle_json FROM server_trust_current WHERE tenant_id=? AND node_class=?`,
    ).get(this.binding.tenantId,this.binding.nodeClass) as TrustRow | undefined);
  }

  private trustHistory(): TrustHistoryRow[] {
    return this.storage(() => this.artifacts.prepare(
      `SELECT key_id,spki,spki_digest,state,last_seen_epoch FROM server_trust_key_history WHERE tenant_id=? AND node_class=? ORDER BY key_id`,
    ).all(this.binding.tenantId,this.binding.nodeClass) as unknown as TrustHistoryRow[]);
  }

  private ceilingHighWater(): HighWaterRow | undefined {
    return this.storage(() => this.highWater.prepare(
      `SELECT version AS sequence,body_digest,phase FROM ceiling_high_water WHERE tenant_id=? AND node_id=?`,
    ).get(this.binding.tenantId,this.binding.nodeId) as HighWaterRow | undefined);
  }

  private trustHighWater(): HighWaterRow | undefined {
    return this.storage(() => this.highWater.prepare(
      `SELECT epoch AS sequence,body_digest,phase FROM trust_high_water WHERE tenant_id=? AND node_class=?`,
    ).get(this.binding.tenantId,this.binding.nodeClass) as HighWaterRow | undefined);
  }

  private insertCeilingHighWater(version: number, digest: string, phase: HighWaterRow["phase"]): void {
    this.storage(() => this.highWater.prepare(
      `INSERT INTO ceiling_high_water(tenant_id,node_id,version,body_digest,phase,updated_at) VALUES (?,?,?,?,?,?)`,
    ).run(this.binding.tenantId,this.binding.nodeId,version,digest,phase,this.clock.now()));
  }

  private updateCeilingHighWater(version: number, digest: string, expectedVersion: number): void {
    const result = this.storage(() => this.highWater.prepare(
      `UPDATE ceiling_high_water SET version=?,body_digest=?,phase='prepared',updated_at=?
       WHERE tenant_id=? AND node_id=? AND version=? AND phase='committed'`,
    ).run(version,digest,this.clock.now(),this.binding.tenantId,this.binding.nodeId,expectedVersion));
    if (result.changes !== 1) throw new ProtectedStoreError("rollback_detected");
  }

  private commitCeilingHighWater(version: number, digest: string): void {
    const result = this.storage(() => this.highWater.prepare(
      `UPDATE ceiling_high_water SET phase='committed',updated_at=?
       WHERE tenant_id=? AND node_id=? AND version=? AND body_digest=? AND phase='prepared'`,
    ).run(this.clock.now(),this.binding.tenantId,this.binding.nodeId,version,digest));
    if (result.changes !== 1) throw new ProtectedStoreError("rollback_detected");
  }

  private insertTrustHighWater(epoch: number, digest: string, phase: HighWaterRow["phase"]): void {
    this.storage(() => this.highWater.prepare(
      `INSERT INTO trust_high_water(tenant_id,node_class,epoch,body_digest,phase,updated_at) VALUES (?,?,?,?,?,?)`,
    ).run(this.binding.tenantId,this.binding.nodeClass,epoch,digest,phase,this.clock.now()));
  }

  private updateTrustHighWater(epoch: number, digest: string, expectedEpoch: number): void {
    const result = this.storage(() => this.highWater.prepare(
      `UPDATE trust_high_water SET epoch=?,body_digest=?,phase='prepared',updated_at=?
       WHERE tenant_id=? AND node_class=? AND epoch=? AND phase='committed'`,
    ).run(epoch,digest,this.clock.now(),this.binding.tenantId,this.binding.nodeClass,expectedEpoch));
    if (result.changes !== 1) throw new ProtectedStoreError("rollback_detected");
  }

  private commitTrustHighWater(epoch: number, digest: string): void {
    const result = this.storage(() => this.highWater.prepare(
      `UPDATE trust_high_water SET phase='committed',updated_at=?
       WHERE tenant_id=? AND node_class=? AND epoch=? AND body_digest=? AND phase='prepared'`,
    ).run(this.clock.now(),this.binding.tenantId,this.binding.nodeClass,epoch,digest));
    if (result.changes !== 1) throw new ProtectedStoreError("rollback_detected");
  }

  private configure(db: DatabaseSync): void {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  }

  private transaction<T>(db: DatabaseSync, operation: () => T): T {
    try {
      db.exec("BEGIN IMMEDIATE");
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* fixed safe error below */ }
      if (error instanceof ProtectedStoreError) throw error;
      throw new ProtectedStoreError("corrupt");
    }
  }

  private storage<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof ProtectedStoreError) throw error;
      throw new ProtectedStoreError("corrupt");
    }
  }

  private migrate(): void {
    this.artifacts.exec(`
      CREATE TABLE IF NOT EXISTS node_ceiling_current (
        tenant_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version>0),
        body_digest TEXT NOT NULL CHECK(length(body_digest)=71 AND substr(body_digest,1,7)='sha256:' AND substr(body_digest,8) NOT GLOB '*[^0-9a-f]*'),
        artifact_json TEXT NOT NULL,
        adopted_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,node_id)
      );
      CREATE TABLE IF NOT EXISTS server_trust_current (
        tenant_id TEXT NOT NULL,
        node_class TEXT NOT NULL,
        epoch INTEGER NOT NULL CHECK(epoch>0),
        body_digest TEXT NOT NULL CHECK(length(body_digest)=71 AND substr(body_digest,1,7)='sha256:' AND substr(body_digest,8) NOT GLOB '*[^0-9a-f]*'),
        bundle_json TEXT NOT NULL,
        adopted_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,node_class)
      );
      CREATE TABLE IF NOT EXISTS server_trust_key_history (
        tenant_id TEXT NOT NULL,
        node_class TEXT NOT NULL,
        key_id TEXT NOT NULL,
        spki TEXT NOT NULL,
        spki_digest TEXT NOT NULL CHECK(length(spki_digest)=71 AND substr(spki_digest,1,7)='sha256:' AND substr(spki_digest,8) NOT GLOB '*[^0-9a-f]*'),
        state TEXT NOT NULL CHECK(state IN ('active','retired','revoked')),
        first_seen_epoch INTEGER NOT NULL CHECK(first_seen_epoch>0),
        last_seen_epoch INTEGER NOT NULL CHECK(last_seen_epoch>=first_seen_epoch),
        PRIMARY KEY(tenant_id,node_class,key_id),
        UNIQUE(tenant_id,node_class,spki_digest)
      );
      PRAGMA user_version=1;
    `);
    this.highWater.exec(`
      CREATE TABLE IF NOT EXISTS ceiling_high_water (
        tenant_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version>0),
        body_digest TEXT NOT NULL CHECK(length(body_digest)=71 AND substr(body_digest,1,7)='sha256:' AND substr(body_digest,8) NOT GLOB '*[^0-9a-f]*'),
        phase TEXT NOT NULL CHECK(phase IN ('prepared','committed')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,node_id)
      );
      CREATE TABLE IF NOT EXISTS trust_high_water (
        tenant_id TEXT NOT NULL,
        node_class TEXT NOT NULL,
        epoch INTEGER NOT NULL CHECK(epoch>0),
        body_digest TEXT NOT NULL CHECK(length(body_digest)=71 AND substr(body_digest,1,7)='sha256:' AND substr(body_digest,8) NOT GLOB '*[^0-9a-f]*'),
        phase TEXT NOT NULL CHECK(phase IN ('prepared','committed')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(tenant_id,node_class)
      );
      PRAGMA user_version=1;
    `);
  }
}
