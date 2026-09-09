import { randomUUID } from "node:crypto";
import { WebSessionAuthority, type WebActor as Actor } from "./session-authority";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { appendAuditWith } from "../../audit/audit-store";
import { sha256Digest } from "../../security/digest";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { IdeaLabProjectRegistryStoreV1 } from "../../idea-lab/v1/store";
import { CONTROL_ROOM_IDEA_ADAPTER_V1 } from "../../idea-lab/v1/schemas";
import { assertProjectLifecycleTransitionV1 } from "../../idea-lab/v1/contracts";
import { ideaLabProjectLifecycleActionsV1 } from "../../idea-lab/v1/lifecycle-service";
import type { WebIdeaProjectLifecycleOperation } from "./idea-project-lifecycle-operation";
import { ideaProjectActionTarget } from "./project-wire";

import { catalogProjectIdSchema, projectCreateSchema, projectTransitionSchema, projectViewSchema,
  type ProjectCatalogPage, type ProjectView, type WebProject } from "./project-wire";
export { projectCreateSchema, projectTransitionSchema, lifecycleSchema, type WebProject } from "./project-wire";
const iso = (value: string | Date) => new Date(value).toISOString();

/** Server composition supplies deployment scope. No request can choose a tenant or workspace. */
export class WebProjectService {
  private readonly authority: WebSessionAuthority;
  private readonly ideas?: IdeaLabProjectRegistryStoreV1;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    clock: () => number = Date.now, ideaIntegrityKey?: Uint8Array,
    private readonly ideaLifecycle?: WebIdeaProjectLifecycleOperation) {
    this.authority = new WebSessionAuthority(db, scope, clock);
    if (ideaIntegrityKey !== undefined) this.ideas = new IdeaLabProjectRegistryStoreV1(db, ideaIntegrityKey);
  }

  private async authorized<T>(identity: VerifiedWebIdentity, action: string, projectId: string | undefined,
    operation: (tx: DatabaseSession, actor: Actor) => Promise<T>): Promise<T> {
    return this.authenticated(identity, (tx, actor) => { actor.require(action, projectId); return operation(tx, actor); });
  }

  private authenticated<T>(identity: VerifiedWebIdentity,
    operation: (tx: DatabaseSession, actor: Actor) => Promise<T>): Promise<T> {
    return this.authority.authenticated(identity, operation);
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
    return this.authenticated(identity, (tx, actor) => this.getViewInSession(tx, actor, projectId));
  }

  /** Server-only composition inside the shared session/grant transaction. No new identity authority. */
  async getViewInSession(tx: DatabaseSession, actor: Actor, projectId: string): Promise<ProjectView> {
    if (!catalogProjectIdSchema.safeParse(projectId).success) throw new WebAccessError("invalid_request");
      const ordinary = actor.can("projects.read", projectId), ideas = actor.can("idea_lab.project_read", projectId, true);
      // Decide eligible sources before resolving an ID. A hidden source and an absent row must look identical.
      if (!ordinary && !ideas) throw new WebAccessError("access_denied");
      const row = (await tx.query<{ adapter_id: string }>(`SELECT adapter_id FROM projects
        WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3
        AND ((adapter_id=$4 AND $6::boolean) OR (adapter_id=$5 AND $7::boolean)) FOR SHARE`,
      [this.scope.tenantId, this.scope.workspaceId, projectId, this.manualAdapterId(), CONTROL_ROOM_IDEA_ADAPTER_V1, ordinary, ideas])).rows[0];
      if (!row) throw new WebAccessError("not_found");
      return this.readView(tx, actor, projectId, row.adapter_id);
  }

  private async readView(tx: DatabaseSession, actor: Actor, projectId: string, adapterId: string): Promise<ProjectView> {
    if (adapterId === CONTROL_ROOM_IDEA_ADAPTER_V1) {
      actor.require("idea_lab.project_read", projectId, true);
      if (!this.ideas) throw new Error("idea_catalog_not_configured");
      const idea = await this.ideas.getProjectInSession(tx, this.scope.tenantId, this.scope.workspaceId, projectId);
      if (!idea) throw new WebAccessError("not_found");
      // A project-scoped grant must not reveal workspace-wide discussion IDs.
      // Register the optional read for the same transaction's precommit check.
      const canReadDiscussion = actor.can("idea_lab.session_read", undefined, true);
      if (canReadDiscussion) actor.require("idea_lab.session_read", undefined, true);
      const actions = this.ideaLifecycle ? ideaLabProjectLifecycleActionsV1.filter(action => {
        if (action === "resume" && idea.lifecycleState !== "paused" || action === "reopen" && idea.lifecycleState !== "archived") return false;
        try { assertProjectLifecycleTransitionV1(idea.lifecycleState, ideaProjectActionTarget[action]); }
        catch { return false; }
        return actor.can(`idea_lab.project_${action}`, projectId, true);
      }) : [];
      return projectViewSchema.parse({ projectId: idea.projectId, title: idea.title, summary: idea.summary,
        lifecycle: idea.lifecycleState, version: idea.version, createdAt: iso(idea.createdAt), updatedAt: iso(idea.updatedAt),
        origin: "idea_lab", lifecycleEditable: actions.length > 0,
        ...(canReadDiscussion ? { sourceIdeaSessionId: idea.sourceIdeaSessionId } : {}),
        ...(this.ideaLifecycle ? { ideaLifecycleActions: actions } : {}) });
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

  async transitionIdea(identity: VerifiedWebIdentity, projectId: string, value: unknown, key: string) {
    if (!this.ideaLifecycle) throw new Error("idea_lifecycle_not_configured");
    return this.ideaLifecycle.transition(identity, projectId, value, key);
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

  async logout(identity: VerifiedWebIdentity): Promise<void> { return this.authority.logout(identity); }
}
