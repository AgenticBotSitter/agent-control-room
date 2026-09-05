import { randomUUID } from "node:crypto";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { appendAuditWith } from "../../audit/audit-store";
import { evaluatePolicy, type RoleGrant } from "../../security/policy";
import { sha256Digest } from "../../security/digest";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { IdeaLabProjectRegistryStoreV1 } from "../../idea-lab/v1/store";
import { CONTROL_ROOM_IDEA_ADAPTER_V1 } from "../../idea-lab/v1/schemas";

import { catalogProjectIdSchema, projectCreateSchema, projectTransitionSchema, projectViewSchema,
  type ProjectCatalogPage, type ProjectView, type WebProject } from "./project-wire";
export { projectCreateSchema, projectTransitionSchema, lifecycleSchema, type WebProject } from "./project-wire";
type Actor = { id: string; now: string;
  can: (action: string, projectId?: string, ownerOnly?: boolean) => boolean;
  require: (action: string, projectId?: string, ownerOnly?: boolean) => void };
const iso = (value: string | Date) => new Date(value).toISOString();

/** Server composition supplies deployment scope. No request can choose a tenant or workspace. */
export class WebProjectService {
  private readonly ideas?: IdeaLabProjectRegistryStoreV1;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    private readonly clock: () => number = Date.now, ideaIntegrityKey?: Uint8Array) {
    if (ideaIntegrityKey !== undefined) this.ideas = new IdeaLabProjectRegistryStoreV1(db, ideaIntegrityKey);
  }

  private async authorized<T>(identity: VerifiedWebIdentity, action: string, projectId: string | undefined,
    operation: (tx: DatabaseSession, actor: Actor) => Promise<T>): Promise<T> {
    return this.authenticated(identity, (tx, actor) => { actor.require(action, projectId); return operation(tx, actor); });
  }

  private async authenticated<T>(identity: VerifiedWebIdentity,
    operation: (tx: DatabaseSession, actor: Actor) => Promise<T>): Promise<T> {
    const nowMs = this.clock();
    const assertFresh = () => {
      const current = this.clock();
      if (!Number.isSafeInteger(current) || current < nowMs || Date.parse(identity.issuedAt) > current
        || !Number.isFinite(Date.parse(identity.expiresAt)) || Date.parse(identity.expiresAt) <= current
        || !Number.isFinite(Date.parse(identity.verificationExpiresAt)) || Date.parse(identity.verificationExpiresAt) <= current)
        throw new WebAccessError("authentication_required");
    };
    assertFresh();
    const now = new Date(nowMs).toISOString();
    const grantChecks: (() => void)[] = [];
    return this.db.transactionWithPreCommitCheck(async tx => {
      // Serialize each identity's requests and lock its current grants through the operation.
      // Revocation committed before this lock is observed; already-running transactions may finish first.
      const row = (await tx.query<{ id: string }>(`SELECT id FROM control_identities
        WHERE tenant_id=$1 AND auth_provider=$2 AND auth_subject_digest=$3 AND actor_type='human' AND state='active' FOR UPDATE`,
      [this.scope.tenantId, identity.provider, sha256Digest({ provider: identity.provider, subject: identity.subject })])).rows[0];
      if (!row) throw new WebAccessError("access_denied");
      await tx.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [this.scope.tenantId, identity.tokenDigest, row.id, identity.issuedAt, identity.expiresAt]);
      const session = (await tx.query<{ identity_id: string; revoked_at: string | null; expires_at: string; issued_at: string }>(
        `SELECT identity_id,revoked_at,expires_at,issued_at FROM control_web_sessions WHERE tenant_id=$1 AND token_digest=$2 FOR UPDATE`,
        [this.scope.tenantId, identity.tokenDigest])).rows[0];
      if (!session || session.identity_id !== row.id || session.revoked_at || Date.parse(session.expires_at) <= nowMs
        || iso(session.issued_at) !== identity.issuedAt) throw new WebAccessError("authentication_required");
      const grants = (await tx.query<{ id: string; role_key: string; allowed_actions: string[]; project_ids: string[];
        risk_ceiling: RoleGrant["riskCeiling"]; allow_external_effects: boolean; require_strong_factor: boolean;
        expires_at: string | null; revoked_at: string | null }>(
        `SELECT * FROM control_role_grants WHERE tenant_id=$1 AND identity_id=$2 FOR SHARE`, [this.scope.tenantId, row.id])).rows
        .filter(g => g.role_key === "owner" || g.role_key === "operator").map(g => ({ id: g.id,
          roleKey: g.role_key, allowedActions: g.allowed_actions, projectIds: g.project_ids, riskCeiling: g.risk_ceiling,
          allowExternalEffects: g.allow_external_effects, requireStrongFactor: g.require_strong_factor,
          ...(g.expires_at ? { expiresAt: iso(g.expires_at) } : {}), ...(g.revoked_at ? { revokedAt: iso(g.revoked_at) } : {}) }));
      const principal = { tenantId: this.scope.tenantId, identityId: row.id, actorType: "human" as const,
        authenticatedAt: identity.issuedAt, expiresAt: new Date(Math.min(Date.parse(session.expires_at), Date.parse(identity.expiresAt))).toISOString() };
      const can = (action: string, projectId?: string, ownerOnly = false) => {
        const selected = ownerOnly ? grants.filter(g => g.roleKey === "owner") : grants;
        const decision = evaluatePolicy(principal, selected, { tenantId: this.scope.tenantId, action,
          resourceType: "project", resourceId: projectId ?? this.scope.workspaceId, ...(projectId ? { projectId } : {}),
          risk: "low", externalEffect: false, occurredAt: new Date(this.clock()).toISOString() });
        // Enumeration/create always require a matching wildcard project grant, never just a per-project grant.
        return decision.allowed && (!!projectId || selected.some(g => decision.matchedGrantIds.includes(g.id) && g.projectIds.includes("*")));
      };
      const require = (action: string, projectId?: string, ownerOnly = false) => {
        const check = () => { if (!can(action, projectId, ownerOnly)) throw new WebAccessError("access_denied"); };
        check(); grantChecks.push(check);
      };
      return operation(tx, { id: row.id, now, can, require });
    }, () => { assertFresh(); for (const check of grantChecks) check(); });
  }

  async list(identity: VerifiedWebIdentity): Promise<WebProject[]> {
    return this.authorized(identity, "projects.read", undefined, async tx => {
      const rows = await tx.query<WebProject>(`SELECT p.id AS "projectId",p.title,coalesce(p.description,'') AS summary,
        h.lifecycle,h.version,h.created_at AS "createdAt",h.updated_at AS "updatedAt" FROM projects p
        JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
        WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.adapter_id=$3 ORDER BY p.id LIMIT 201`,
      [this.scope.tenantId, this.scope.workspaceId, this.manualAdapterId()]);
      // Do not silently present a partial catalog. Pagination is required before expanding this beta limit.
      if (rows.rows.length > 200) throw new WebAccessError("conflict");
      return rows.rows.map(row => ({ ...row, version: Number(row.version), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) }));
    });
  }

  async authorizeCatalog(identity: VerifiedWebIdentity): Promise<void> {
    await this.authenticated(identity, async (_, actor) => { this.catalogAccess(actor); });
  }

  private catalogAccess(actor: Actor): ProjectCatalogPage["sources"] {
    const ordinary = actor.can("projects.read");
    const ideas = actor.can("idea_lab.project_read", undefined, true);
    if (!ordinary && !ideas) throw new WebAccessError("access_denied");
    if (!ordinary && !this.ideas) throw new Error("idea_catalog_not_configured");
    if (ordinary) actor.require("projects.read");
    if (ideas && this.ideas) actor.require("idea_lab.project_read", undefined, true);
    return { ordinary: ordinary ? "included" : "not_authorized",
      ideas: !ideas ? "not_authorized" : this.ideas ? "included" : "not_configured" };
  }

  async listPage(identity: VerifiedWebIdentity, after?: string): Promise<ProjectCatalogPage> {
    if (after !== undefined && !catalogProjectIdSchema.safeParse(after).success) throw new WebAccessError("invalid_request");
    return this.authenticated(identity, async (tx, actor) => {
      const sources = this.catalogAccess(actor);
      const rows = await tx.query<{ id: string; adapter_id: string }>(`SELECT p.id,p.adapter_id FROM projects p
        WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND ($3::text IS NULL OR p.id COLLATE "C" > $3 COLLATE "C")
        AND ((p.adapter_id=$4 AND $6::boolean AND EXISTS(SELECT 1 FROM control_manual_project_heads h
          WHERE h.tenant_id=p.tenant_id AND h.project_id=p.id)) OR (p.adapter_id=$5 AND $7::boolean))
        ORDER BY p.id COLLATE "C" LIMIT 51 FOR SHARE OF p`, [this.scope.tenantId, this.scope.workspaceId, after ?? null,
        this.manualAdapterId(), CONTROL_ROOM_IDEA_ADAPTER_V1, sources.ordinary === "included", sources.ideas === "included"]);
      const projects: ProjectView[] = [];
      for (const row of rows.rows.slice(0, 50)) projects.push(await this.readView(tx, actor, row.id, row.adapter_id));
      return { projects, nextCursor: rows.rows.length > 50 ? projects.at(-1)!.projectId : null,
        canCreate: actor.can("projects.create"), sources };
    });
  }

  async getView(identity: VerifiedWebIdentity, projectId: string): Promise<ProjectView> {
    if (!catalogProjectIdSchema.safeParse(projectId).success) throw new WebAccessError("invalid_request");
    return this.authenticated(identity, async (tx, actor) => {
      const ordinary = actor.can("projects.read", projectId), ideas = actor.can("idea_lab.project_read", projectId, true);
      // Decide eligible sources before resolving an ID. A hidden source and an absent row must look identical.
      if (!ordinary && !ideas) throw new WebAccessError("access_denied");
      const row = (await tx.query<{ adapter_id: string }>(`SELECT adapter_id FROM projects
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
        AND ((adapter_id=$4 AND $6::boolean) OR (adapter_id=$5 AND $7::boolean)) FOR SHARE`,
      [this.scope.tenantId, this.scope.workspaceId, projectId, this.manualAdapterId(), CONTROL_ROOM_IDEA_ADAPTER_V1, ordinary, ideas])).rows[0];
      if (!row) throw new WebAccessError("not_found");
      return this.readView(tx, actor, projectId, row.adapter_id);
    });
  }

  private async readView(tx: DatabaseSession, actor: Actor, projectId: string, adapterId: string): Promise<ProjectView> {
    if (adapterId === CONTROL_ROOM_IDEA_ADAPTER_V1) {
      actor.require("idea_lab.project_read", projectId, true);
      if (!this.ideas) throw new Error("idea_catalog_not_configured");
      const idea = await this.ideas.getProjectInSession(tx, this.scope.tenantId, this.scope.workspaceId, projectId);
      if (!idea) throw new WebAccessError("not_found");
      // Preserve the existing authenticated Idea lifecycle; this integration is read-only for Idea projects.
      return projectViewSchema.parse({ projectId: idea.projectId, title: idea.title, summary: idea.summary,
        lifecycle: idea.lifecycleState, version: idea.version, createdAt: iso(idea.createdAt), updatedAt: iso(idea.updatedAt),
        origin: "idea_lab", lifecycleEditable: false });
    }
    actor.require("projects.read", projectId);
    if (adapterId !== this.manualAdapterId()) throw new WebAccessError("not_found");
    const row = (await tx.query<WebProject>(`SELECT p.id AS "projectId",p.title,coalesce(p.description,'') AS summary,
      h.lifecycle,h.version,h.created_at AS "createdAt",h.updated_at AS "updatedAt" FROM projects p
      JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
      WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3 AND p.adapter_id=$4 FOR SHARE OF p,h`,
    [this.scope.tenantId, this.scope.workspaceId, projectId, this.manualAdapterId()])).rows[0];
    if (!row) throw new WebAccessError("not_found");
    return projectViewSchema.parse({ ...row, version: Number(row.version), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
      origin: "ordinary", lifecycleEditable: actor.can("projects.lifecycle", projectId) });
  }

  private manualAdapterId() { return `adapter:manual:${sha256Digest(this.scope).slice(7, 39)}`; }

  async create(identity: VerifiedWebIdentity, value: unknown, key: string) {
    const parsed = projectCreateSchema.safeParse(value);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    return this.command(identity, "projects.create", undefined, parsed.data, key, async (tx, actor) => {
      const adapterId = this.manualAdapterId();
      const workspace = await tx.query(`SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR SHARE`, [this.scope.tenantId, this.scope.workspaceId]);
      if (!workspace.rows.length) throw new WebAccessError("access_denied");
      await tx.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
        VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30) ON CONFLICT DO NOTHING`, [adapterId, this.scope.tenantId]);
      const project: WebProject = { projectId: `project:${randomUUID()}`, ...parsed.data, lifecycle: "active", version: 1, createdAt: actor.now, updatedAt: actor.now };
      await tx.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
        normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
        VALUES($1,$2,$3,$4,$1,'1',$5,$6,'planned','manual_project_active','healthy','control_room_native',$7,$8::jsonb,$7)`,
      [project.projectId, this.scope.tenantId, this.scope.workspaceId, adapterId, project.title, project.summary, actor.now,
        JSON.stringify({ projectKind: "general", origin: "manual", createdAt: actor.now })]);
      await tx.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
        VALUES($1,$2,'active',1,$3,$3)`, [this.scope.tenantId, project.projectId, actor.now]);
      return project;
    });
  }

  async get(identity: VerifiedWebIdentity, projectId: string): Promise<WebProject> {
    if (!/^project:[A-Za-z0-9:_-]{1,160}$/.test(projectId)) throw new WebAccessError("invalid_request");
    return this.authorized(identity, "projects.read", projectId, async tx => {
      const row = (await tx.query<WebProject>(`SELECT p.id AS "projectId",p.title,coalesce(p.description,'') AS summary,
        h.lifecycle,h.version,h.created_at AS "createdAt",h.updated_at AS "updatedAt" FROM projects p
        JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
        WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3 AND p.adapter_id=$4`,
      [this.scope.tenantId, this.scope.workspaceId, projectId, this.manualAdapterId()])).rows[0];
      if (!row) throw new WebAccessError("not_found");
      return { ...row, version: Number(row.version), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
    });
  }

  async transition(identity: VerifiedWebIdentity, projectId: string, value: unknown, key: string) {
    const parsed = projectTransitionSchema.safeParse(value);
    if (!parsed.success || !/^project:[A-Za-z0-9:_-]{1,160}$/.test(projectId)) throw new WebAccessError("invalid_request");
    return this.command(identity, "projects.lifecycle", projectId, parsed.data, key, async (tx, actor) => {
      const row = (await tx.query<WebProject>(`SELECT p.id AS "projectId",p.title,coalesce(p.description,'') AS summary,
        h.lifecycle,h.version,h.created_at AS "createdAt",h.updated_at AS "updatedAt" FROM projects p
        JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
        WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3 AND p.adapter_id=$4 FOR UPDATE OF p,h`,
      [this.scope.tenantId, this.scope.workspaceId, projectId, this.manualAdapterId()])).rows[0];
      if (!row) throw new WebAccessError("not_found");
      const { lifecycle, expectedVersion } = parsed.data;
      if (Number(row.version) !== expectedVersion || row.lifecycle === lifecycle
        || row.lifecycle === "archived" && lifecycle !== "active") throw new WebAccessError("conflict");
      const project: WebProject = { ...row, lifecycle, version: expectedVersion + 1, createdAt: iso(row.createdAt), updatedAt: actor.now };
      await tx.query(`UPDATE control_manual_project_heads SET lifecycle=$1,version=$2,updated_at=$3 WHERE tenant_id=$4 AND project_id=$5`,
        [lifecycle, project.version, actor.now, this.scope.tenantId, projectId]);
      await tx.query(`UPDATE projects SET domain_state=$1,source_version=$2,updated_at=$3,
        normalized_state=CASE WHEN $1='manual_project_completed' THEN 'complete'
          WHEN $1='manual_project_active' THEN 'planned' WHEN $1='manual_project_paused' THEN 'waiting' ELSE normalized_state END
        WHERE tenant_id=$4 AND id=$5`,
        [`manual_project_${lifecycle}`, String(project.version), actor.now, this.scope.tenantId, projectId]);
      // Project lifecycle never cancels a job, changes a lease or creates an external effect.
      return project;
    });
  }

  private async command(identity: VerifiedWebIdentity, action: string, projectId: string | undefined, value: unknown, key: string,
    operation: (tx: DatabaseSession, actor: Actor) => Promise<WebProject>) {
    if (!/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new WebAccessError("invalid_request");
    const digest = sha256Digest({ ...this.scope, action, projectId: projectId ?? null, value });
    return this.authorized(identity, action, projectId, async (tx, actor) => {
      const existing = (await tx.query<{ request_digest: string; result: WebProject }>(
        `SELECT request_digest,result FROM control_web_project_commands WHERE tenant_id=$1 AND identity_id=$2 AND idempotency_key=$3`,
        [this.scope.tenantId, actor.id, key])).rows[0];
      if (existing) {
        if (existing.request_digest !== digest) throw new WebAccessError("conflict");
        return { project: existing.result, replayed: true };
      }
      const project = await operation(tx, actor);
      await appendAuditWith(tx, { id: `audit:${randomUUID()}`, ...this.scope, projectId: project.projectId,
        actorId: actor.id, actorType: "human", action, targetType: "project", targetId: project.projectId,
        idempotencyKey: key, occurredAt: actor.now, safeMetadata: { lifecycle: project.lifecycle, version: project.version } });
      await tx.query(`INSERT INTO control_web_project_commands(tenant_id,identity_id,idempotency_key,request_digest,result,occurred_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [this.scope.tenantId, actor.id, key, digest, JSON.stringify(project), actor.now]);
      return { project, replayed: false };
    });
  }

  async logout(identity: VerifiedWebIdentity): Promise<void> {
    const started = this.clock();
    const assertFresh = () => {
      const current = this.clock();
      if (!Number.isSafeInteger(current) || current < started || !Number.isFinite(Date.parse(identity.issuedAt))
        || Date.parse(identity.issuedAt) > current || !Number.isFinite(Date.parse(identity.expiresAt))
        || Date.parse(identity.expiresAt) <= current || !Number.isFinite(Date.parse(identity.verificationExpiresAt))
        || Date.parse(identity.verificationExpiresAt) <= current) throw new WebAccessError("authentication_required");
    };
    assertFresh();
    await this.db.transactionWithPreCommitCheck(async tx => {
      // Authentication binds the caller's own assertion. Revoking it never needs project authority,
      // and remains possible after the identity or its grants have been suspended/revoked.
      const actor = (await tx.query<{ id: string }>(`SELECT id FROM control_identities WHERE tenant_id=$1
        AND auth_provider=$2 AND auth_subject_digest=$3 AND actor_type='human' FOR UPDATE`,
      [this.scope.tenantId, identity.provider, sha256Digest({ provider: identity.provider, subject: identity.subject })])).rows[0];
      if (!actor) throw new WebAccessError("authentication_required");
      await tx.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [this.scope.tenantId, identity.tokenDigest, actor.id, identity.issuedAt, identity.expiresAt]);
      const revoked = await tx.query(`UPDATE control_web_sessions SET revoked_at=coalesce(revoked_at,$1)
        WHERE tenant_id=$2 AND token_digest=$3 AND identity_id=$4 AND issued_at=$5 RETURNING token_digest`,
      [new Date(started).toISOString(), this.scope.tenantId, identity.tokenDigest, actor.id, identity.issuedAt]);
      if (revoked.rows.length !== 1) throw new WebAccessError("authentication_required");
    }, assertFresh);
  }
}
