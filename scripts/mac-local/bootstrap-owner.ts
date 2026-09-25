// Read-only verification of the one-time Mac-local owner setup.
// Usage: pnpm mac:bootstrap-owner ABSOLUTE_PROTECTED_ROOT
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMacLocalProtectedConfigurationFromRootV1, loadMacLocalDatabaseRolesFromRootV1 } from "../../src/web/v1/mac-local-protected-loader";
import { createPrivatePostgresDatabase } from "../../src/web/v1/private-postgres";
import { sha256Digest } from "../../src/security";
import { DOMAIN_CONTRACT_VERSION, nodeRecordSchema } from "../../src/domain/v1";
import { publicKeyFingerprint } from "../../src/node-protocol/v1";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 } from "../../src/harness/codex-v1/owner-trusted-local-task-planning-contract";
import { HERMES_LOCAL_ADAPTER_V1 } from "../../src/harness/hermes-local-v1/task-planning-contract";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "../../src/harness/claude-code-v1/task-planning-contract";
import { macLocalOwnerIdentityIdV1, macLocalOwnerGrantIdV1 } from "../../src/web/v1/mac-local-owner-bootstrap";
import { checkMacLocalNodeKeyPinV1 } from "../../src/web/v1/mac-local-node-key-pin";

const refusal = "first-owner setup has not been run; see OWNER_GUIDE_MAC.md";
const missing = (): never => { throw new Error("first_owner_binding_missing"); };
const conflict = (): never => { throw new Error("first_owner_binding_conflict"); };

/** Checks the one-time binding using only SELECTs and verifies the protected public-key pin. */
export async function verifyMacLocalOwnerBindingV1(root: string): Promise<void> {
  const configuration = await loadMacLocalProtectedConfigurationFromRootV1(root);
  const roles = await loadMacLocalDatabaseRolesFromRootV1(root);
  const tenantId = configuration.localOwnerSession.tenantId;
  const identityId = macLocalOwnerIdentityIdV1(tenantId);
  const grantId = macLocalOwnerGrantIdV1(tenantId);
  const subjectDigest = sha256Digest({ provider: configuration.localOwnerSession.provider,
    subject: configuration.localOwnerSession.subject });
  const web = createPrivatePostgresDatabase(roles.web);
  const coordinator = createPrivatePostgresDatabase(roles.coordinator);
  try {
    const ownerDb = web.client;
    const tenant = (await coordinator.client.query<{ display_name: string }>("SELECT display_name FROM tenants WHERE id=$1", [tenantId])).rows;
    const completionGate = (await coordinator.client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM control_completion_gate_integrity WHERE tenant_id=$1", [tenantId])).rows[0];
    const workspace = (await ownerDb.query<{ tenant_id: string; display_name: string }>(
      "SELECT tenant_id,display_name FROM workspaces WHERE id=$1", [configuration.workspaceId])).rows;
    const identity = (await ownerDb.query<{ tenant_id: string; actor_type: string; display_name: string;
      auth_provider: string; auth_subject_digest: string; state: string }>(
      "SELECT tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state FROM control_identities WHERE id=$1", [identityId])).rows;
    const grant = (await ownerDb.query<{ tenant_id: string; identity_id: string; role_key: string;
      allowed_actions: unknown; project_ids: unknown; risk_ceiling: string; allow_external_effects: boolean;
      require_strong_factor: boolean; expires_at: unknown; revoked_at: unknown }>(
      "SELECT tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,expires_at,revoked_at FROM control_role_grants WHERE id=$1", [grantId])).rows;
    if (!tenant.length || completionGate?.count === "0" || !workspace.length || !identity.length || !grant.length) missing();
    if (tenant.length !== 1 || tenant[0]?.display_name !== "Mac local" || completionGate?.count !== "1"
      || workspace.length !== 1 || workspace[0]?.tenant_id !== tenantId || workspace[0]?.display_name !== "Mac local"
      || identity.length !== 1 || identity[0]?.tenant_id !== tenantId || identity[0]?.actor_type !== "human"
      || identity[0]?.display_name !== "Owner" || identity[0]?.auth_provider !== configuration.localOwnerSession.provider
      || identity[0]?.auth_subject_digest !== subjectDigest || identity[0]?.state !== "active"
      || grant.length !== 1 || grant[0]?.tenant_id !== tenantId || grant[0]?.identity_id !== identityId
      || grant[0]?.role_key !== "owner" || JSON.stringify(grant[0]?.allowed_actions) !== JSON.stringify(["*"])
      || JSON.stringify(grant[0]?.project_ids) !== JSON.stringify(["*"]) || grant[0]?.risk_ceiling !== "critical"
      || grant[0]?.allow_external_effects !== true || grant[0]?.require_strong_factor !== false
      || grant[0]?.expires_at !== null || grant[0]?.revoked_at !== null) conflict();

    const adapters = [CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1, HERMES_LOCAL_ADAPTER_V1, CLAUDE_CODE_LOCAL_ADAPTER_V1];
    const adapterRows = (await ownerDb.query<{ id: string; tenant_id: string; source_system: string;
      contract_version: string; authority_mode: string; status: string; redaction_policy_version: string;
      cursor_retention_days: number }>(
      "SELECT id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days FROM adapter_registry WHERE id=ANY($1::text[])", [adapters])).rows;
    if (adapterRows.length < 3) missing();
    if (adapterRows.length !== 3 || adapters.some(id => {
      const row = adapterRows.find(item => item.id === id);
      return !row || row.tenant_id !== tenantId || row.source_system !== "control-room-mac-local"
        || row.contract_version !== "1.0.0" || row.authority_mode !== "control_room_native"
        || row.status !== "online" || row.redaction_policy_version !== "v1" || Number(row.cursor_retention_days) !== 30;
    })) conflict();

    const workers = ["hermes", "claude", "codex"] as const;
    const expectedNodes = workers.map(kind => {
      const adapterKind = kind === "claude" ? "claude-code" : kind;
      const worker = configuration.enablement.workers.find(item => item.kind === adapterKind);
      if (!worker) throw new Error("first_owner_binding_conflict");
      const workerId = worker.workerId;
      const adapterId = kind === "claude" ? CLAUDE_CODE_LOCAL_ADAPTER_V1
        : kind === "hermes" ? HERMES_LOCAL_ADAPTER_V1 : CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1;
      const id = `${configuration.enablement.nodeId}.${kind}`;
      return { id, identityKeyId: `local-owner:${id}`, payload: {
        contractVersion: DOMAIN_CONTRACT_VERSION, kind: "node" as const, id, tenantId,
        displayName: `Mac local ${kind}`, state: "active" as const, version: 1,
        platform: "macos" as const, architecture: "local", identityKeyId: `local-owner:${id}`,
        hardwareFingerprint: sha256Digest({ purpose: "mac-local-node", nodeId: id }),
        softwareFingerprint: sha256Digest({ purpose: "mac-local-worker-node", nodeId: id, workerId, adapterId }),
        policyVersion: "mac-local/v1", minimumProtocolVersion: "local-only",
      } };
    });
    const nodeIds = expectedNodes.map(node => node.id);
    const nodes = (await coordinator.client.query<{ id: string; tenant_id: string; state: string; version: number;
      identity_key_id: string; payload: unknown; created_at: Date | string; updated_at: Date | string }>(
      "SELECT id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at FROM control_nodes WHERE id=ANY($1::text[])", [nodeIds])).rows;
    const keys = (await coordinator.client.query<{ node_id: string; id: string; tenant_id: string; algorithm: string;
      state: string; valid_until: unknown; public_key_spki: string; fingerprint: string }>(
      "SELECT node_id,id,tenant_id,algorithm,state,valid_until,public_key_spki,fingerprint FROM control_node_keys WHERE node_id=ANY($1::text[])", [nodeIds])).rows;
    if (nodes.length < 3 || keys.length < 3) missing();
    if (nodes.length !== 3 || keys.length !== 3) conflict();
    for (const expected of expectedNodes) {
      const row = nodes.find(item => item.id === expected.id);
      const key = keys.find(item => item.node_id === expected.id);
      const parsed = nodeRecordSchema.safeParse(row?.payload);
      if (!row || row.tenant_id !== tenantId || row.state !== "active" || Number(row.version) !== 1
        || row.identity_key_id !== expected.identityKeyId || !parsed.success
        || sha256Digest(parsed.data) !== sha256Digest({ ...expected.payload, enrolledAt: parsed.data.enrolledAt,
          createdAt: parsed.data.createdAt, updatedAt: parsed.data.updatedAt })
        || new Date(row.created_at).toISOString() !== parsed.data.createdAt
        || new Date(row.updated_at).toISOString() !== parsed.data.updatedAt
        || !key || key.id !== expected.identityKeyId || key.tenant_id !== tenantId || key.algorithm !== "ed25519"
        || key.state !== "active" || key.valid_until !== null
        || publicKeyFingerprint(key.public_key_spki) !== key.fingerprint) conflict();
    }
    try { await checkMacLocalNodeKeyPinV1(coordinator.client, root, configuration); }
    catch { conflict(); }
  } finally {
    await Promise.all([web.close(), coordinator.close()]);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.argv[2];
  if (!root || process.argv.length !== 3 || !isAbsolute(root) || resolve(root) !== root) {
    console.error("usage: pnpm mac:bootstrap-owner ABSOLUTE_PROTECTED_ROOT");
    process.exit(2);
  }
  try {
    await verifyMacLocalOwnerBindingV1(root);
    console.log("first-owner binding verified");
  } catch (error) {
    if (error instanceof Error && error.message === "first_owner_binding_missing") {
      console.error(refusal);
      process.exitCode = 2;
    } else {
      console.error("first-owner binding verification failed");
      process.exitCode = 1;
    }
  }
}
