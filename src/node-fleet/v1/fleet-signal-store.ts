import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { fleetSignalEnvelopeSchema, type FleetSignalEnvelope } from "./schemas";

export class FleetSignalStoreError extends Error {
  constructor(readonly safeCode: "invalid_signal" | "identity_mismatch" | "sequence_conflict") { super(safeCode); }
}

export class FleetSignalStore {
  constructor(private readonly db: DatabaseClient) {}

  /** Caller authentication is required before this persistence boundary. */
  async ingestAuthenticated(signalInput: FleetSignalEnvelope, recordedAt: string, binding?: { tenantId: string; nodeId: string }): Promise<{ replayed: boolean }> {
    const signal = fleetSignalEnvelopeSchema.safeParse(signalInput);
    if (!signal.success) throw new FleetSignalStoreError("invalid_signal");
    if (binding && (signal.data.tenantId !== binding.tenantId || signal.data.nodeId !== binding.nodeId)) throw new FleetSignalStoreError("identity_mismatch");
    assertNoSecretMaterial(signal.data, "fleet signal");
    return this.db.transaction((tx) => this.persist(tx, signal.data, recordedAt));
  }

  /** Returns only normalized, tenant-scoped current facts; never raw host reads. */
  async current(input: { tenantId: string; nodeId: string }): Promise<FleetSignalEnvelope[]> {
    const result = await this.db.query<{
      signal_kind: FleetSignalEnvelope["kind"]; signal_subject_id: string; signal_sequence: number; fingerprint: string; trust: FleetSignalEnvelope["trust"];
      observed_at: string | Date; expires_at: string | Date; payload: unknown;
    }>(`SELECT signal_kind,signal_subject_id,signal_sequence,fingerprint,trust,observed_at,expires_at,payload FROM control_node_fleet_current WHERE tenant_id=$1 AND node_id=$2 ORDER BY signal_kind,signal_subject_id`, [input.tenantId,input.nodeId]);
    const signals: FleetSignalEnvelope[] = [];
    for (const row of result.rows) {
      const parsed = fleetSignalEnvelopeSchema.safeParse(row.payload);
      if (!parsed.success || parsed.data.tenantId !== input.tenantId || parsed.data.nodeId !== input.nodeId
        || parsed.data.kind !== row.signal_kind || parsed.data.sequence !== Number(row.signal_sequence)
        || fleetSignalSubjectId(parsed.data) !== row.signal_subject_id
        || parsed.data.fingerprint !== row.fingerprint || parsed.data.trust !== row.trust
        || parsed.data.observedAt !== new Date(row.observed_at).toISOString() || parsed.data.expiresAt !== new Date(row.expires_at).toISOString()) {
        throw new FleetSignalStoreError("invalid_signal");
      }
      try { assertNoSecretMaterial(parsed.data, "fleet signal"); } catch { throw new FleetSignalStoreError("invalid_signal"); }
      signals.push(parsed.data);
    }
    return signals;
  }

  async history(input: { tenantId: string; nodeId: string; kind?: FleetSignalEnvelope["kind"]; limit: number }): Promise<FleetSignalEnvelope[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) throw new FleetSignalStoreError("invalid_signal");
    const result = input.kind
      ? await this.db.query<{ payload: unknown }>(
        `SELECT payload FROM control_node_fleet_signals WHERE tenant_id=$1 AND node_id=$2 AND signal_kind=$3 ORDER BY recorded_at DESC LIMIT $4`,
        [input.tenantId, input.nodeId, input.kind, input.limit],
      )
      : await this.db.query<{ payload: unknown }>(
        `SELECT payload FROM control_node_fleet_signals WHERE tenant_id=$1 AND node_id=$2 ORDER BY recorded_at DESC LIMIT $3`,
        [input.tenantId, input.nodeId, input.limit],
      );
    return result.rows.map((row) => {
      const parsed = fleetSignalEnvelopeSchema.safeParse(row.payload);
      if (!parsed.success || parsed.data.tenantId !== input.tenantId || parsed.data.nodeId !== input.nodeId) throw new FleetSignalStoreError("invalid_signal");
      try { assertNoSecretMaterial(parsed.data, "fleet signal"); } catch { throw new FleetSignalStoreError("invalid_signal"); }
      return parsed.data;
    });
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
      `INSERT INTO control_node_fleet_current (tenant_id,node_id,signal_kind,signal_subject_id,signal_sequence,fingerprint,trust,observed_at,expires_at,payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (tenant_id,node_id,signal_kind,signal_subject_id) DO UPDATE SET signal_sequence=EXCLUDED.signal_sequence,fingerprint=EXCLUDED.fingerprint,trust=EXCLUDED.trust,observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at,payload=EXCLUDED.payload`,
      [signal.tenantId,signal.nodeId,signal.kind,fleetSignalSubjectId(signal),signal.sequence,signal.fingerprint,signal.trust,signal.observedAt,signal.expiresAt,JSON.stringify(signal)],
    );
    return { replayed: false };
  }
}

/** Current rows must preserve each probe/benchmark, while node facts remain singleton subjects. */
export function fleetSignalSubjectId(signal: FleetSignalEnvelope): string {
  if (signal.kind === "capability") return signal.payload.probeId;
  if (signal.kind === "benchmark") return signal.payload.benchmarkId;
  return "node";
}
