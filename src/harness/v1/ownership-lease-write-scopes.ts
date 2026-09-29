import type { DatabaseSession } from "../../persistence/database";

export type OwnershipLeaseWriteScopeV1 = Readonly<{ scopeKind: "file" | "tree"; path: string }>;

/** Reads the durable scopes owned by one canonical lease. Dispatch preparation
 * fails closed when the lease has no scope evidence. */
export async function readOwnershipLeaseWriteScopesV1(tx: DatabaseSession, tenantId: string,
  leaseId: string): Promise<readonly OwnershipLeaseWriteScopeV1[]> {
  const rows = (await tx.query<{ scope_kind: "file" | "tree"; path: string }>(
    `SELECT scope_kind,path FROM control_assignment_lease_scopes
     WHERE tenant_id=$1 AND lease_id=$2 ORDER BY scope_kind,path`, [tenantId, leaseId])).rows;
  if (!rows.length) throw new Error("ownership_lease_write_scopes_unavailable");
  return Object.freeze(rows.map(row => Object.freeze({ scopeKind: row.scope_kind, path: row.path })));
}
