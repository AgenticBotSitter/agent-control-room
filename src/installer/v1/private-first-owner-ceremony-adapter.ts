import type { DatabaseClient } from "../../persistence/database";
import { sha256Digest } from "../../security/canonical-digest";
import type { PrivateOwnerBootstrapConfiguration } from "../../web/v1/private-owner-bootstrap";
import type { LinuxUnixOwnerBootstrapControlAttemptV1, OwnerBootstrapCeremonyV1 } from
  "../../web/v1/owner-bootstrap-ceremony";
import { PRIVATE_FIRST_OWNER_CLEANUP_V1, PRIVATE_FIRST_OWNER_EXISTING_OWNER_EVIDENCE_V1,
  type PrivateFirstOwnerCeremonyCompletionV1, type PrivateFirstOwnerInstallationBindingV1,
  type PrivateFirstOwnerRunnerContextV1, type PrivateFirstOwnerRuntimeV1 } from "./private-first-owner-runner";

/**
 * Private source composition for the already-retained owner ceremony. It owns
 * no listener, assertion, code, credential, database connection, identity
 * implementation, or receipt store. The caller retains all of those existing
 * components and mounts route() in the existing bootstrap-only host.
 */
export const PRIVATE_FIRST_OWNER_CEREMONY_ADAPTER_V1 =
  "control-room.private-first-owner-ceremony-adapter/v1" as const;

type AdapterInputV1 = Readonly<{
  binding: PrivateFirstOwnerInstallationBindingV1;
  owner: PrivateOwnerBootstrapConfiguration;
  database: Pick<DatabaseClient, "query">;
  ceremony: OwnerBootstrapCeremonyV1;
  acquireOwnerAttendedControlAttempt(context: PrivateFirstOwnerRunnerContextV1):
    Promise<LinuxUnixOwnerBootstrapControlAttemptV1>;
  cleanupDeadlineMs: number;
}>;

export type PrivateFirstOwnerCeremonyAdapterV1 = Readonly<{
  schema: typeof PRIVATE_FIRST_OWNER_CEREMONY_ADAPTER_V1;
  route(request: Request): Promise<Response | undefined>;
  runRetainedOwnerBootstrapCeremony: PrivateFirstOwnerRuntimeV1["runRetainedOwnerBootstrapCeremony"];
  verifyExistingOwner: PrivateFirstOwnerRuntimeV1["verifyExistingOwner"];
  cleanupRetainedOwnerBootstrapCeremony: PrivateFirstOwnerRuntimeV1["cleanupRetainedOwnerBootstrapCeremony"];
}>;

type OwnerRow = Readonly<{
  database_name: string;
  tenant_id: string;
  tenant_display_name: string;
  workspace_id: string;
  workspace_tenant_id: string;
  workspace_display_name: string;
  identity_id: string;
  identity_tenant_id: string;
  actor_type: string;
  identity_display_name: string;
  auth_provider: string;
  auth_subject_digest: string;
  identity_state: string;
  grant_id: string;
  grant_tenant_id: string;
  grant_identity_id: string;
  role_key: string;
  allowed_actions: unknown;
  project_ids: unknown;
  risk_ceiling: string;
  allow_external_effects: boolean;
  require_strong_factor: boolean;
  expires_at: unknown;
  revoked_at: unknown;
  identity_count: string;
  workspace_count: string;
  grant_count: string;
  owner_grant_count: string;
}>;

const OWNER_QUERY = `SELECT current_database() AS database_name,
  t.id AS tenant_id,t.display_name AS tenant_display_name,
  w.id AS workspace_id,w.tenant_id AS workspace_tenant_id,w.display_name AS workspace_display_name,
  i.id AS identity_id,i.tenant_id AS identity_tenant_id,i.actor_type,
  i.display_name AS identity_display_name,i.auth_provider,i.auth_subject_digest,i.state AS identity_state,
  g.id AS grant_id,g.tenant_id AS grant_tenant_id,g.identity_id AS grant_identity_id,g.role_key,
  g.allowed_actions,g.project_ids,g.risk_ceiling,g.allow_external_effects,g.require_strong_factor,
  g.expires_at,g.revoked_at,
  (SELECT count(*)::text FROM control_identities ci WHERE ci.tenant_id=t.id) AS identity_count,
  (SELECT count(*)::text FROM workspaces cw WHERE cw.tenant_id=t.id) AS workspace_count,
  (SELECT count(*)::text FROM control_role_grants ca
    WHERE ca.tenant_id=t.id AND ca.identity_id=i.id) AS grant_count,
  (SELECT count(*)::text FROM control_role_grants cg
    WHERE cg.tenant_id=t.id AND cg.identity_id=i.id AND cg.role_key='owner'
      AND cg.revoked_at IS NULL) AS owner_grant_count
FROM tenants t
JOIN workspaces w ON w.tenant_id=t.id AND w.id=$2
JOIN control_identities i ON i.tenant_id=t.id AND i.id=$3
JOIN control_role_grants g ON g.tenant_id=t.id AND g.identity_id=i.id AND g.id=$4
WHERE t.id=$1 AND i.auth_subject_digest=$5`;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const uncertainError = (): Error => {
  const error = new Error("private_first_owner_ceremony_adapter_uncertain"); error.stack = undefined; return error;
};
const fail = (): never => {
  throw uncertainError();
};

function exactRecord(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return fail();
  const record = value as Readonly<Record<string, unknown>>, keys = Object.keys(record);
  if (keys.length !== names.length || keys.some(name => !names.includes(name))
    || names.some(name => !Object.prototype.hasOwnProperty.call(record, name))
    || Object.getOwnPropertyNames(record).some(name => {
      const descriptor = Object.getOwnPropertyDescriptor(record, name);
      return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
    })) return fail();
  return record;
}

function dataMethod<T extends (...args: never[]) => unknown>(value: unknown, name: string): T {
  if (!value || typeof value !== "object") return fail();
  const method = (value as Record<string, unknown>)[name];
  if (typeof method !== "function") return fail();
  return method.bind(value) as T;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return fail();
  return value;
}

function captureBinding(value: PrivateFirstOwnerInstallationBindingV1): PrivateFirstOwnerInstallationBindingV1 {
  const binding = exactRecord(value, ["schema", "installationId", "installationPlanDigest",
    "installationPlanRevision", "releaseDigest", "databaseAuthorityOutcomeDigest", "expectedOwnerSubjectDigest"]);
  if (binding.schema !== "control-room.private-first-owner-installation-binding/v1"
    || typeof binding.installationId !== "string" || !installationIdPattern.test(binding.installationId)
    || !Number.isSafeInteger(binding.installationPlanRevision) || (binding.installationPlanRevision as number) < 0) return fail();
  return Object.freeze({ schema: binding.schema, installationId: binding.installationId,
    installationPlanDigest: digest(binding.installationPlanDigest),
    installationPlanRevision: binding.installationPlanRevision as number, releaseDigest: digest(binding.releaseDigest),
    databaseAuthorityOutcomeDigest: digest(binding.databaseAuthorityOutcomeDigest),
    expectedOwnerSubjectDigest: digest(binding.expectedOwnerSubjectDigest) });
}

function captureOwner(value: PrivateOwnerBootstrapConfiguration): PrivateOwnerBootstrapConfiguration {
  exactRecord(value, ["databaseName", "tenantId", "workspaceId", "tenantDisplayName", "workspaceDisplayName",
    "identityId", "grantId", "displayName", "expectedOwnerSubjectDigest"]);
  if (typeof value.databaseName !== "string" || value.databaseName.length < 1 || value.databaseName.length > 63
    || !/^[A-Za-z0-9_:.-]{1,128}$/u.test(value.tenantId)
    || !/^[A-Za-z0-9_:.-]{1,128}$/u.test(value.workspaceId)
    || !/^[A-Za-z0-9_:.-]{1,128}$/u.test(value.identityId)
    || !/^[A-Za-z0-9_:.-]{1,128}$/u.test(value.grantId)) return fail();
  for (const name of ["tenantDisplayName", "workspaceDisplayName", "displayName"] as const) {
    if (typeof value[name] !== "string" || value[name].trim() !== value[name]
      || value[name].length < 1 || value[name].length > 120) return fail();
  }
  return Object.freeze({ databaseName: value.databaseName, tenantId: value.tenantId, workspaceId: value.workspaceId,
    tenantDisplayName: value.tenantDisplayName, workspaceDisplayName: value.workspaceDisplayName,
    identityId: value.identityId, grantId: value.grantId, displayName: value.displayName,
    expectedOwnerSubjectDigest: digest(value.expectedOwnerSubjectDigest) });
}

function requestDigest(context: PrivateFirstOwnerRunnerContextV1): string {
  return sha256Digest({ purpose: "first-owner-action-request/v1", request: context.request });
}

function assertContext(context: PrivateFirstOwnerRunnerContextV1, binding: PrivateFirstOwnerInstallationBindingV1): void {
  if (!context || typeof context !== "object" || context.requestDigest !== requestDigest(context)
    || context.binding.schema !== binding.schema || context.binding.installationId !== binding.installationId
    || context.binding.installationPlanDigest !== binding.installationPlanDigest
    || context.binding.installationPlanRevision !== binding.installationPlanRevision
    || context.binding.releaseDigest !== binding.releaseDigest
    || context.binding.databaseAuthorityOutcomeDigest !== binding.databaseAuthorityOutcomeDigest
    || context.binding.expectedOwnerSubjectDigest !== binding.expectedOwnerSubjectDigest
    || context.request.installationPlanDigest !== binding.installationPlanDigest
    || context.request.installationPlanRevision !== binding.installationPlanRevision
    || context.request.releaseDigest !== binding.releaseDigest
    || context.request.databaseAuthorityOutcomeDigest !== binding.databaseAuthorityOutcomeDigest
    || context.request.expectedOwnerSubjectDigest !== binding.expectedOwnerSubjectDigest
    || !context.signal || typeof context.signal.aborted !== "boolean") return fail();
}

function exactCompletion(value: unknown): PrivateFirstOwnerCeremonyCompletionV1 {
  const completion = exactRecord(value, ["schema", "ownerCreated", "normalApplicationAvailable",
    "physicalGatewayAcceptanceComplete"]);
  if (completion.schema !== "control-room.owner-bootstrap-complete/v1" || completion.ownerCreated !== true
    || completion.normalApplicationAvailable !== true || completion.physicalGatewayAcceptanceComplete !== false) return fail();
  return Object.freeze({ schema: "control-room.owner-bootstrap-complete/v1", ownerCreated: true,
    normalApplicationAvailable: true, physicalGatewayAcceptanceComplete: false });
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.status !== 201 || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()
    !== "application/json" || !response.body) return undefined;
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/u.test(length) || Number(length) > 1024)) return fail();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 1024) return fail(); chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch { return fail(); }
  finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) return fail();
  return value;
}

function exactOwner(row: OwnerRow, owner: PrivateOwnerBootstrapConfiguration): Readonly<Record<string, unknown>> {
  exactRecord(row, ["database_name", "tenant_id", "tenant_display_name", "workspace_id", "workspace_tenant_id",
    "workspace_display_name", "identity_id", "identity_tenant_id", "actor_type", "identity_display_name",
    "auth_provider", "auth_subject_digest", "identity_state", "grant_id", "grant_tenant_id", "grant_identity_id",
    "role_key", "allowed_actions", "project_ids", "risk_ceiling", "allow_external_effects",
    "require_strong_factor", "expires_at", "revoked_at", "identity_count", "workspace_count", "grant_count",
    "owner_grant_count"]);
  const actions = stringArray(row.allowed_actions), projects = stringArray(row.project_ids);
  if (row.database_name !== owner.databaseName || row.tenant_id !== owner.tenantId
    || row.tenant_display_name !== owner.tenantDisplayName || row.workspace_id !== owner.workspaceId
    || row.workspace_tenant_id !== owner.tenantId || row.workspace_display_name !== owner.workspaceDisplayName
    || row.identity_id !== owner.identityId || row.identity_tenant_id !== owner.tenantId || row.actor_type !== "human"
    || row.identity_display_name !== owner.displayName || typeof row.auth_provider !== "string"
    || row.auth_provider.length < 1 || row.auth_provider.length > 256
    || row.auth_subject_digest !== owner.expectedOwnerSubjectDigest || row.identity_state !== "active"
    || row.grant_id !== owner.grantId || row.grant_tenant_id !== owner.tenantId
    || row.grant_identity_id !== owner.identityId || row.role_key !== "owner"
    || actions.length !== 1 || actions[0] !== "*" || projects.length !== 1 || projects[0] !== "*"
    || row.risk_ceiling !== "critical" || row.allow_external_effects !== true
    || row.require_strong_factor !== false || row.expires_at !== null || row.revoked_at !== null
    || row.identity_count !== "1" || row.workspace_count !== "1" || row.grant_count !== "1"
    || row.owner_grant_count !== "1") return fail();
  return Object.freeze({ databaseName: row.database_name, tenantId: row.tenant_id,
    workspaceId: row.workspace_id, identityId: row.identity_id, actorType: row.actor_type,
    displayName: row.identity_display_name, authProvider: row.auth_provider,
    authSubjectDigest: row.auth_subject_digest, state: row.identity_state, grantId: row.grant_id,
    roleKey: row.role_key, allowedActions: Object.freeze([...actions]), projectIds: Object.freeze([...projects]),
    riskCeiling: row.risk_ceiling, allowExternalEffects: row.allow_external_effects,
    requireStrongFactor: row.require_strong_factor, expiresAt: null, revokedAt: null,
    identityCount: row.identity_count, workspaceCount: row.workspace_count, grantCount: row.grant_count,
    ownerGrantCount: row.owner_grant_count });
}

export function createPrivateFirstOwnerCeremonyAdapterV1(input: AdapterInputV1): PrivateFirstOwnerCeremonyAdapterV1 {
  if (!input || typeof input !== "object") return fail();
  const binding = captureBinding(input.binding), owner = captureOwner(input.owner);
  if (owner.expectedOwnerSubjectDigest !== binding.expectedOwnerSubjectDigest
    || !Number.isSafeInteger(input.cleanupDeadlineMs) || input.cleanupDeadlineMs < 1
    || input.cleanupDeadlineMs > 30_000) return fail();
  const ceremonyRoute = dataMethod<OwnerBootstrapCeremonyV1["route"]>(input.ceremony, "route");
  const ceremonyArm = dataMethod<OwnerBootstrapCeremonyV1["arm"]>(input.ceremony, "arm");
  const ceremonyClose = dataMethod<OwnerBootstrapCeremonyV1["close"]>(input.ceremony, "close");
  const ceremonyIsBootstrapOnly = dataMethod<OwnerBootstrapCeremonyV1["isBootstrapOnly"]>(
    input.ceremony, "isBootstrapOnly");
  const query = dataMethod<DatabaseClient["query"]>(input.database, "query");
  if (typeof input.acquireOwnerAttendedControlAttempt !== "function") return fail();
  const acquire = input.acquireOwnerAttendedControlAttempt;
  const cleanupDeadlineMs = input.cleanupDeadlineMs;
  let state: "idle" | "running" | "complete" | "closed" = "idle";
  let resolveCompletion: ((value: PrivateFirstOwnerCeremonyCompletionV1) => void) | undefined;
  let rejectCompletion: (() => void) | undefined;
  const completionPromise = new Promise<PrivateFirstOwnerCeremonyCompletionV1>((resolve, reject) => {
    resolveCompletion = resolve; rejectCompletion = () => reject(uncertainError());
  });
  // Cleanup may close a never-run adapter. Keep that deliberate rejection from
  // becoming an ambient unhandled-rejection side effect.
  void completionPromise.catch(() => {});
  const isBootstrapOnly = () => {
    try { return ceremonyIsBootstrapOnly(); } catch { return fail(); }
  };

  const adapter: PrivateFirstOwnerCeremonyAdapterV1 = {
    schema: PRIVATE_FIRST_OWNER_CEREMONY_ADAPTER_V1,
    async route(request) {
      if (state === "closed") return Response.json({ error: "owner_bootstrap_unavailable" }, { status: 503 });
      let response: Response | undefined;
      try { response = await ceremonyRoute(request); } catch { if (state === "running") rejectCompletion?.(); return fail(); }
      // close() is a permanent adapter fence. A request that began before
      // close but returns afterward must not tell the browser that bootstrap
      // succeeded: the runner has already made the outcome owner attention.
      if (state === "closed") return Response.json({ error: "owner_bootstrap_unavailable" }, { status: 503 });
      if (state === "running" && response instanceof Response) {
        let pathname = "";
        try { pathname = new URL(request.url).pathname; } catch { return response; }
        if (request.method === "POST" && pathname === "/api/v1/owner-bootstrap" && response.status === 201) {
          try {
            const completed = exactCompletion(await boundedJson(response.clone()));
            // The body can arrive after cleanup. Recheck after every await
            // before turning an owner-visible response into completion.
            if (state === "closed") return Response.json({ error: "owner_bootstrap_unavailable" }, { status: 503 });
            if (isBootstrapOnly() !== false) return fail();
            if (state === "closed") return Response.json({ error: "owner_bootstrap_unavailable" }, { status: 503 });
            state = "complete"; resolveCompletion?.(completed);
          } catch {
            if (state === "closed") return Response.json({ error: "owner_bootstrap_unavailable" }, { status: 503 });
            rejectCompletion?.();
          }
        }
      }
      if (state === "closed") return Response.json({ error: "owner_bootstrap_unavailable" }, { status: 503 });
      return response;
    },
    async runRetainedOwnerBootstrapCeremony(context) {
      assertContext(context, binding);
      if (state !== "idle" || context.signal.aborted || isBootstrapOnly() !== true) return fail();
      state = "running";
      let armed: Readonly<Record<string, unknown>>;
      try {
        const attempt = await acquire(context);
        armed = exactRecord(await ceremonyArm(attempt, context.signal), ["schema", "armed", "expiresAt",
          "listenerStarted", "physicalPeerQualificationComplete"]);
      } catch { return fail(); }
      if (armed.schema !== "control-room.owner-bootstrap-arm/v1" || armed.armed !== true
        || armed.listenerStarted !== false || armed.physicalPeerQualificationComplete !== false
        || typeof armed.expiresAt !== "string" || !Number.isFinite(Date.parse(armed.expiresAt))) return fail();
      if (context.signal.aborted) return fail();
      const abort = new Promise<never>((_, reject) => context.signal.addEventListener("abort",
        () => reject(uncertainError()), { once: true }));
      return Promise.race([completionPromise, abort]);
    },
    async verifyExistingOwner(context) {
      assertContext(context, binding);
      if (state !== "complete" || context.signal.aborted || typeof context.ceremonyOutcomeDigest !== "string") return fail();
      const expectedOutcome = sha256Digest({ purpose: "private-first-owner-ceremony-outcome/v1",
        installationId: binding.installationId, requestDigest: context.requestDigest,
        completion: exactCompletion({ schema: "control-room.owner-bootstrap-complete/v1", ownerCreated: true,
          normalApplicationAvailable: true, physicalGatewayAcceptanceComplete: false }) });
      if (context.ceremonyOutcomeDigest !== expectedOutcome) return fail();
      let rows: OwnerRow[];
      try { rows = (await query<OwnerRow>(OWNER_QUERY,
        [owner.tenantId, owner.workspaceId, owner.identityId, owner.grantId, owner.expectedOwnerSubjectDigest])).rows; }
      catch { return fail(); }
      if (!Array.isArray(rows) || rows.length !== 1) return fail();
      const observed = exactOwner(rows[0]!, owner);
      const ownerProofDigest = sha256Digest({ purpose: "private-first-owner-authoritative-owner-proof/v1",
        installationId: binding.installationId, requestDigest: context.requestDigest,
        installationPlanDigest: binding.installationPlanDigest,
        installationPlanRevision: binding.installationPlanRevision, releaseDigest: binding.releaseDigest,
        databaseAuthorityOutcomeDigest: binding.databaseAuthorityOutcomeDigest,
        expectedOwnerSubjectDigest: binding.expectedOwnerSubjectDigest,
        ceremonyOutcomeDigest: context.ceremonyOutcomeDigest, owner: observed });
      return Object.freeze({ schema: PRIVATE_FIRST_OWNER_EXISTING_OWNER_EVIDENCE_V1,
        installationId: binding.installationId, requestDigest: context.requestDigest,
        installationPlanDigest: binding.installationPlanDigest,
        installationPlanRevision: binding.installationPlanRevision, releaseDigest: binding.releaseDigest,
        databaseAuthorityOutcomeDigest: binding.databaseAuthorityOutcomeDigest,
        expectedOwnerSubjectDigest: binding.expectedOwnerSubjectDigest, ownerConfirmed: true, ownerState: "existing",
        ownerProofDigest, ceremonyOutcomeDigest: context.ceremonyOutcomeDigest, outcome: "verified" });
    },
    async cleanupRetainedOwnerBootstrapCeremony(context) {
      assertContext(context, binding);
      if (context.scope !== "retained_owner_bootstrap_ceremony") return fail();
      state = "closed"; rejectCompletion?.();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([ceremonyClose(), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(uncertainError()), cleanupDeadlineMs);
        }), new Promise<never>((_, reject) => context.signal.addEventListener("abort",
          () => reject(uncertainError()), { once: true }))]);
      } catch { return fail(); } finally { clearTimeout(timer); }
      return Object.freeze({ schema: PRIVATE_FIRST_OWNER_CLEANUP_V1, installationId: binding.installationId,
        requestDigest: context.requestDigest, scope: "retained_owner_bootstrap_ceremony", outcome: "confirmed" });
    },
  };
  return Object.freeze(adapter);
}
