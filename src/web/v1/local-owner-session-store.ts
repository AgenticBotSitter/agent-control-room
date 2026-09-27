import type { DatabaseClient } from "../../persistence/database";
import { sha256Digest } from "../../security";
import type { LocalOwnerSessionProfileV1, PersistedLocalOwnerSessionV1 } from "./local-owner-session";

export interface LocalOwnerSessionStoreV1 {
  load(nowMs: number): Promise<readonly PersistedLocalOwnerSessionV1[]>;
  save(session: PersistedLocalOwnerSessionV1): Promise<void>;
  revoke(tokenDigest: string, revokedAt: string): Promise<void>;
}

/** Database-backed persistence for the local owner's already-hashed session
 * assertions. It reuses the immutable/revocable control_web_sessions table;
 * neither this adapter nor the table ever receives the cookie token. */
export function createPostgresLocalOwnerSessionStoreV1(db: DatabaseClient, profile: LocalOwnerSessionProfileV1): LocalOwnerSessionStoreV1 {
  if (!db || typeof db.query !== "function") throw new Error("local_owner_session_store_invalid");
  const subjectDigest = sha256Digest({ provider: profile.provider, subject: profile.subject });
  const identity = async () => (await db.query<{ id: string }>(`SELECT id FROM control_identities
    WHERE tenant_id=$1 AND auth_provider=$2 AND auth_subject_digest=$3 AND actor_type='human' AND state='active'`,
  [profile.tenantId, profile.provider, subjectDigest])).rows[0]?.id;
  return Object.freeze({
    async load(nowMs: number) {
      const rows = (await db.query<{ token_digest: string; issued_at: string | Date; expires_at: string | Date }>(`
        SELECT s.token_digest,s.issued_at,s.expires_at FROM control_web_sessions s
        JOIN control_identities i ON i.tenant_id=s.tenant_id AND i.id=s.identity_id
        WHERE s.tenant_id=$1 AND i.auth_provider=$2 AND i.auth_subject_digest=$3
          AND i.actor_type='human' AND i.state='active' AND s.revoked_at IS NULL
          AND s.issued_at <= $4 AND s.expires_at > $4 ORDER BY s.issued_at`,
      [profile.tenantId, profile.provider, subjectDigest, new Date(nowMs).toISOString()])).rows;
      return rows.map(row => Object.freeze({ tokenDigest: row.token_digest,
        issuedAt: new Date(row.issued_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() }));
    },
    async save(session: PersistedLocalOwnerSessionV1) {
      const identityId = await identity();
      if (!identityId) throw new Error("local_owner_session_store_owner_unavailable");
      await db.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,token_digest) DO NOTHING`,
      [profile.tenantId, session.tokenDigest, identityId, session.issuedAt, session.expiresAt]);
    },
    async revoke(tokenDigest: string, revokedAt: string) {
      const identityId = await identity();
      if (!identityId) throw new Error("local_owner_session_store_owner_unavailable");
      const result = await db.query(`UPDATE control_web_sessions SET revoked_at=coalesce(revoked_at,$1)
        WHERE tenant_id=$2 AND token_digest=$3 AND identity_id=$4 RETURNING token_digest`,
      [revokedAt, profile.tenantId, tokenDigest, identityId]);
      if (result.rows.length !== 1) throw new Error("local_owner_session_store_revoke_refused");
    },
  });
}
