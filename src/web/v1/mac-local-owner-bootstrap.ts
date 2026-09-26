import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { SecurityStore, sha256Digest } from "../../security";
import type { MacLocalProtectedConfigurationV1 } from "./mac-local-protected-configuration";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 } from "../../harness/codex-v1/owner-trusted-local-task-planning-contract";
import { HERMES_LOCAL_ADAPTER_V1 } from "../../harness/hermes-local-v1/task-planning-contract";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "../../harness/claude-code-v1/task-planning-contract";
import { DOMAIN_CONTRACT_VERSION, nodeRecordSchema } from "../../domain/v1";
import { generateKeyPairSync } from "node:crypto";
import { publicKeyFingerprint } from "../../node-protocol/v1";

export const macLocalOwnerIdentityIdV1 = (tenantId: string) => `identity:${tenantId}:owner`;
export const macLocalOwnerGrantIdV1 = (tenantId: string) => `grant:${tenantId}:owner`;

/** Each local worker has its own assignment route. Its public identity key is
 * recorded so the coordinator can assign, but the private half is never exported
 * or retained. No remote party can therefore authenticate as this local worker. */
export async function seedMacLocalNodeV1(db: DatabaseClient, configuration: MacLocalProtectedConfigurationV1,
  clock: () => number = Date.now): Promise<"created" | "already_present"> {
  const tenantId = configuration.localOwnerSession.tenantId;
  const workers = ["hermes", "claude", "codex"] as const;
  const workerRecords = workers.map(kind => {
    const adapterKind = kind === "claude" ? "claude-code" : kind;
    const worker = configuration.enablement.workers.find(item => item.kind === adapterKind);
    if (!worker) throw new Error("mac_local_node_conflict");
    return { kind, workerId: worker.workerId, adapterId: kind === "claude" ? CLAUDE_CODE_LOCAL_ADAPTER_V1
      : kind === "hermes" ? HERMES_LOCAL_ADAPTER_V1 : CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 };
  });
  return db.transaction(async tx => {
    let created = false;
    for (const worker of workerRecords) {
    const nodeId = `${configuration.enablement.nodeId}.${worker.kind}`;
    const staticFields = {
      contractVersion: DOMAIN_CONTRACT_VERSION, kind: "node" as const, id: nodeId, tenantId,
      displayName: `Mac local ${worker.kind}`, state: "active" as const, version: 1,
      platform: "macos" as const, architecture: "local", identityKeyId: `local-owner:${nodeId}`,
      hardwareFingerprint: sha256Digest({ purpose: "mac-local-node", nodeId }),
      softwareFingerprint: sha256Digest({ purpose: "mac-local-worker-node", nodeId,
        workerId: worker.workerId, adapterId: worker.adapterId }),
      policyVersion: "mac-local/v1", minimumProtocolVersion: "local-only",
    };
    const existing = (await tx.query<{ tenant_id: string; state: string; version: number;
      identity_key_id: string; payload: unknown; created_at: Date | string; updated_at: Date | string }>(
      "SELECT tenant_id,state,version,identity_key_id,payload,created_at,updated_at FROM control_nodes WHERE id=$1 FOR UPDATE", [nodeId])).rows[0];
    const keys = (await tx.query<{ id: string; tenant_id: string; algorithm: string; state: string; valid_until: unknown;
      public_key_spki: string; fingerprint: string }>(
      "SELECT id,tenant_id,algorithm,state,valid_until,public_key_spki,fingerprint FROM control_node_keys WHERE node_id=$1", [nodeId])).rows;
    if (existing) {
      const payload = nodeRecordSchema.safeParse(existing.payload);
      const expected = { ...staticFields, enrolledAt: payload.success ? payload.data.enrolledAt : undefined,
        createdAt: payload.success ? payload.data.createdAt : undefined,
        updatedAt: payload.success ? payload.data.updatedAt : undefined };
      if (!payload.success || existing.tenant_id !== tenantId || existing.state !== "active" || Number(existing.version) !== 1
        || existing.identity_key_id !== staticFields.identityKeyId
        || sha256Digest(payload.data) !== sha256Digest(expected)
        || new Date(existing.created_at).toISOString() !== payload.data.createdAt
        || new Date(existing.updated_at).toISOString() !== payload.data.updatedAt
        || keys.length !== 1 || keys[0]?.id !== staticFields.identityKeyId || keys[0]?.tenant_id !== tenantId
        || keys[0]?.algorithm !== "ed25519" || keys[0]?.state !== "active" || keys[0]?.valid_until !== null
        || publicKeyFingerprint(keys[0]?.public_key_spki ?? "") !== keys[0]?.fingerprint)
        throw new Error("mac_local_node_conflict");
      continue;
    }
    if (keys.length) throw new Error("mac_local_node_conflict");
    const now = new Date(clock()).toISOString();
    const node = nodeRecordSchema.parse({ ...staticFields, enrolledAt: now, createdAt: now, updatedAt: now });
    const pair = generateKeyPairSync("ed25519");
    const publicSpki = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    // Deliberately never export, return, persist or log pair.privateKey.
    await tx.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
      VALUES($1,$2,'active',1,$3,$4::jsonb,$5,$5)`, [nodeId, tenantId, node.identityKeyId, JSON.stringify(node), now]);
    await tx.query(`INSERT INTO control_node_keys(id,tenant_id,node_id,algorithm,public_key_spki,fingerprint,state,valid_from,created_at)
      VALUES($1,$2,$3,'ed25519',$4,$5,'active',$6,$6)`,
    [node.identityKeyId, tenantId, nodeId, publicSpki, publicKeyFingerprint(publicSpki), now]);
    created = true;
    }
    return created ? "created" : "already_present";
  });
}

/**
 * Fixed, tenant-scoped rows for the three owner-trusted local harness
 * adapters. `durable-result-publication.ts`'s identity verification reads
 * this row before it will publish any result for that adapter; without it,
 * every local task's result stays stuck at "receipt accepted, never
 * published" no matter how correctly everything upstream ran. Idempotent:
 * safe to call every time `mac:up` bootstraps the owner.
 *
 * `adapter_registry.id` is a global primary key, not a per-tenant one (a
 * later migration adds a `UNIQUE(tenant_id,id)` alongside it, but never
 * changes the primary key). These three adapter ids are fixed, source-level
 * constants, so this insert can succeed for at most one tenant, system-wide,
 * for the lifetime of the database. That is safe for the one real Mac-local
 * tenant this ever runs against in production, but a silent `ON CONFLICT DO
 * NOTHING` would mask a genuine problem if it ever collided with a different
 * tenant (a stale row from another environment, or a misconfigured tenant
 * id). Fail closed instead: adopt only a row that already belongs to this
 * exact tenant.
 *
 * Deliberately not called from `bootstrapMacLocalOwnerV1` itself: that
 * function is also exercised in tests against many disposable, unrelated
 * tenant ids sharing one database, which is fine for the tenant/workspace/
 * owner logic but not for a genuinely global-singleton id. Call this
 * separately, after the owner bootstrap, from the real `mac:up` flow only.
 */
export async function seedMacLocalAdapterRegistryV1(tx: DatabaseSession, tenantId: string): Promise<void> {
  for (const adapterId of [CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, HERMES_LOCAL_ADAPTER_V1, CLAUDE_CODE_LOCAL_ADAPTER_V1]) {
    await tx.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
      VALUES($1,$2,'control-room-mac-local','1.0.0','control_room_native','online','v1',30) ON CONFLICT (id) DO NOTHING`,
    [adapterId, tenantId]);
    const owner = (await tx.query<{ tenant_id: string }>("SELECT tenant_id FROM adapter_registry WHERE id=$1", [adapterId])).rows[0];
    if (owner?.tenant_id !== tenantId) throw new Error("mac_local_owner_bootstrap_conflict");
  }
}

/**
 * Creates the fixed Mac-local tenant, workspace and owner once. Re-running is a
 * no-op when the same local owner already holds the owner grant. An existing
 * tenant or workspace with any other owner is never adopted.
 */
export async function bootstrapMacLocalOwnerV1(db: DatabaseClient, configuration: MacLocalProtectedConfigurationV1,
  clock: () => number = Date.now): Promise<"created" | "already_present"> {
  const { tenantId, provider, subject } = configuration.localOwnerSession;
  const workspaceId = configuration.workspaceId;
  const digest = sha256Digest({ provider, subject });
  return db.transaction(async tx => {
    const tenant = (await tx.query<{ id: string }>("SELECT id FROM tenants WHERE id=$1 FOR UPDATE", [tenantId])).rows;
    if (tenant.length === 1) {
      const owner = (await tx.query<{ id: string }>(`SELECT i.id FROM control_identities i
        JOIN control_role_grants g ON g.identity_id=i.id AND g.tenant_id=i.tenant_id AND g.role_key='owner'
        WHERE i.tenant_id=$1 AND i.id=$2 AND i.auth_provider=$3 AND i.auth_subject_digest=$4 AND i.state='active'`,
      [tenantId, macLocalOwnerIdentityIdV1(tenantId), provider, digest])).rows;
      const workspace = (await tx.query<{ id: string }>("SELECT id FROM workspaces WHERE id=$1 AND tenant_id=$2",
        [workspaceId, tenantId])).rows;
      if (owner.length !== 1 || workspace.length !== 1) throw new Error("mac_local_owner_bootstrap_conflict");
      return "already_present" as const;
    }
    if ((await tx.query("SELECT id FROM workspaces WHERE id=$1", [workspaceId])).rows.length !== 0)
      throw new Error("mac_local_owner_bootstrap_conflict");
    await tx.query("INSERT INTO tenants(id,display_name) VALUES($1,$2)", [tenantId, "Mac local"]);
    await tx.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$3)", [workspaceId, tenantId, "Mac local"]);
    const joined: DatabaseClient = { query: tx.query.bind(tx), transaction: work => work(tx),
      transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } };
    const now = clock();
    await new SecurityStore(joined).bootstrapOwner({ tenantId, identityId: macLocalOwnerIdentityIdV1(tenantId),
      grantId: macLocalOwnerGrantIdV1(tenantId), displayName: "Owner", provider, subject,
      verifiedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), now: new Date(now).toISOString() });
    return "created" as const;
  });
}
