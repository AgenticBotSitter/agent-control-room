import type { DatabaseClient } from "../../persistence/database";
import { SecurityStore, sha256Digest } from "../../security";
import type { MacLocalProtectedConfigurationV1 } from "./mac-local-protected-configuration";

export const macLocalOwnerIdentityIdV1 = (tenantId: string) => `identity:${tenantId}:owner`;
export const macLocalOwnerGrantIdV1 = (tenantId: string) => `grant:${tenantId}:owner`;

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
