import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { fleetSignalEnvelopeSchema, type FleetSignalEnvelope } from "./schemas";

export class FleetSignalStoreError extends Error {
  constructor(readonly safeCode: "invalid_signal" | "identity_mismatch" | "sequence_conflict") { super(safeCode); }
}

export class FleetSignalStore {
  constructor(private readonly db: DatabaseClient) {}

  /** Caller authentication is required before this persistence boundary. */
  async ingestAuthenticated(signalInput: FleetSignalEnvelope, recordedAt: string): Promise<{ replayed: boolean }> {
    const signal = fleetSignalEnvelopeSchema.safeParse(signalInput);
    if (!signal.success) throw new FleetSignalStoreError("invalid_signal");
    assertNoSecretMaterial(signal.data, "fleet signal");
    return this.db.transaction((tx) => this.persist(tx, signal.data, recordedAt));
  }

  private async persist(tx: DatabaseSession, signal: FleetSignalEnvelope, recordedAt: string): Promise<{ replayed: boolean }> {
    const node = await tx.query<{ id: string }>(`SELECT id FROM control_nodes WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [signal.tenantId, signal.nodeId]);
    if (!node.rows[0]) throw new FleetSignalStoreError("identity_mismatch");
    const payloadDigest = sha256Digest(signal);
    const prior = await tx.query<{ payload_digest: string }>(
      `SELECT payload_digest FROM control_node_fleet_signals WHERE tenant_id=$1 AND node_id=$2 AND signal_kind=$3 AND signal_sequence=$4 FOR UPDATE`,
      [signal.tenantId, signal.nodeId, signal.kind, signal.sequence],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].payload_digest !== payloadDigest) throw new FleetSignalStoreError("sequence_conflict");
      return { replayed: true };
    }
    const last = await tx.query<{ signal_sequence: number }>(
      `SELECT signal_sequence FROM control_node_fleet_signals WHERE tenant_id=$1 AND node_id=$2 AND signal_kind=$3 ORDER BY signal_sequence DESC LIMIT 1 FOR UPDATE`,
      [signal.tenantId, signal.nodeId, signal.kind],
    );
    if (signal.sequence !== (last.rows[0]?.signal_sequence ?? 0) + 1) throw new FleetSignalStoreError("sequence_conflict");
    await tx.query(
      `INSERT INTO control_node_fleet_signals (tenant_id,node_id,signal_kind,signal_sequence,payload_digest,fingerprint,trust,observed_at,expires_at,payload,recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
      [signal.tenantId,signal.nodeId,signal.kind,signal.sequence,payloadDigest,signal.fingerprint,signal.trust,signal.observedAt,signal.expiresAt,JSON.stringify(signal),recordedAt],
    );
    await tx.query(
      `INSERT INTO control_node_fleet_current (tenant_id,node_id,signal_kind,signal_sequence,fingerprint,trust,observed_at,expires_at,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (tenant_id,node_id,signal_kind) DO UPDATE SET signal_sequence=EXCLUDED.signal_sequence,fingerprint=EXCLUDED.fingerprint,trust=EXCLUDED.trust,observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at,payload=EXCLUDED.payload`,
      [signal.tenantId,signal.nodeId,signal.kind,signal.sequence,signal.fingerprint,signal.trust,signal.observedAt,signal.expiresAt,JSON.stringify(signal)],
    );
    return { replayed: false };
  }
}
