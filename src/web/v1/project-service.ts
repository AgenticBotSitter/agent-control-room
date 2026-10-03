import { randomUUID } from "node:crypto";
import { WebSessionAuthority, type WebActor as Actor } from "./session-authority";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { appendAuditWith } from "../../audit/audit-store";
import { sha256Digest } from "../../security/digest";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { IdeaLabProjectRegistryStoreV1 } from "../../idea-lab/v1/store";
import { CONTROL_ROOM_IDEA_ADAPTER_V1 } from "../../idea-lab/v1/schemas";
import type { ProjectRegistryProjectionV1 } from "../../idea-lab/v1/types";
import { assertProjectLifecycleTransitionV1 } from "../../idea-lab/v1/contracts";
import { ideaLabProjectLifecycleActionsV1 } from "../../idea-lab/v1/lifecycle-service";
import type { WebIdeaProjectLifecycleOperation } from "./idea-project-lifecycle-operation";
import { ideaProjectActionTarget } from "./project-wire";
import { projectSettingsSchema, projectSettingsDraftSchema, type ProjectSettings } from "./project-settings-wire";
import { insertProjectSettingsRowV1 } from "./project-settings-first-row";

import { catalogProjectIdSchema, lifecycleSchema, projectCreateSchema, projectTransitionSchema, projectViewSchema,
  type EffectiveProjectPresentation, type ProjectCatalogPage, type ProjectView, type WebProject } from "./project-wire";
export { projectCreateSchema, projectTransitionSchema, lifecycleSchema, type WebProject } from "./project-wire";
import { PRODUCT_CONFIGURATION_SCHEMA_V1, parseProductConfigurationV1, type ProductConfigurationV1 } from "../../config/v1/product-configuration";
import { buildProjectPresentationV1, computeEffectiveProjectPresentationV1, parseStoredProjectPresentationV1,
  ProjectPresentationError, verifyProjectTemplateSelectionV1,
  type EffectiveProjectPresentationV1, type ProjectPresentationV1 } from "../../config/v1/project-presentation";
import { deriveProjectEventIntegrityKeyV1, ProjectEventStoreV1, TaskProjectEventWriterV1 } from "../../project-events/v1";
const iso = (value: string | Date) => new Date(value).toISOString();
type CatalogRow = { id: string; adapter_id: string; payload: unknown; title: string; summary: string;
  lifecycle: WebProject["lifecycle"] | null; version: number | string | null; created_at: string | Date | null;
  updated_at: string | Date | null };

function configurationDigestFor(productConfiguration: Readonly<ProductConfigurationV1>): string {
  return sha256Digest(productConfiguration);
}

/**
 * Server composition supplies deployment scope. No request can choose a tenant or workspace.
 * The optional `productConfiguration` is trusted operator-supplied startup input; the service
 * never re-reads or discovers configuration at request time.
 */
export class WebProjectService {
  private readonly authority: WebSessionAuthority;
  private readonly ideas?: IdeaLabProjectRegistryStoreV1;
  private readonly productConfiguration?: Readonly<ProductConfigurationV1>;
  private readonly configurationDigest?: string;
  private readonly projectEvents?: TaskProjectEventWriterV1;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    clock: () => number = Date.now, ideaIntegrityKey?: Uint8Array,
    private readonly ideaLifecycle?: WebIdeaProjectLifecycleOperation,
    productConfiguration?: Readonly<ProductConfigurationV1>, projectEventRootKey?: Uint8Array) {
    this.authority = new WebSessionAuthority(db, scope, clock);
    if (ideaIntegrityKey !== undefined) this.ideas = new IdeaLabProjectRegistryStoreV1(db, ideaIntegrityKey);
    if (productConfiguration !== undefined) {
      this.productConfiguration = productConfiguration;
      this.configurationDigest = configurationDigestFor(productConfiguration);
    }
    if (projectEventRootKey !== undefined) this.projectEvents = new TaskProjectEventWriterV1(new ProjectEventStoreV1(db,
      deriveProjectEventIntegrityKeyV1(projectEventRootKey), () => new Date(clock()).toISOString()));
  }

  private async authorized<T>(identity: VerifiedWebIdentity, action: string, projectId: string | undefined,
    operation: (tx: DatabaseSession, actor: Actor) => Promise<T>, readOnly = false): Promise<T> {
    return this.authenticated(identity, (tx, actor) => { actor.require(action, projectId); return operation(tx, actor); }, readOnly);
  }

  private authenticated<T>(identity: VerifiedWebIdentity,
    operation: (tx: DatabaseSession, actor: Actor) => Promise<T>, readOnly = false): Promise<T> {
    return this.authority.authenticated(identity, operation, readOnly ? { readOnly: true } : undefined);
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
    }, true);
  }

  async authorizeCatalog(identity: VerifiedWebIdentity): Promise<void> {
    await this.authenticated(identity, async (_, actor) => { this.catalogAccess(actor); }, true);
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

  async listPage(identity: VerifiedWebIdentity, after?: string, lifecycle?: WebProject["lifecycle"]): Promise<ProjectCatalogPage> {
    if (after !== undefined && !catalogProjectIdSchema.safeParse(after).success) throw new WebAccessError("invalid_request");
    if (lifecycle !== undefined && !lifecycleSchema.safeParse(lifecycle).success) throw new WebAccessError("invalid_request");
    return this.authenticated(identity, async (tx, actor) => {
      const sources = this.catalogAccess(actor);
      const rows = await tx.query<CatalogRow>(`SELECT p.id,p.adapter_id,p.payload,p.title,coalesce(p.description,'') AS summary,
        h.lifecycle,h.version,h.created_at,h.updated_at FROM projects p
        LEFT JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
        WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND ($3::text IS NULL OR p.id COLLATE "C" > $3 COLLATE "C")
        AND ((p.adapter_id=$4 AND $6::boolean AND EXISTS(SELECT 1 FROM control_manual_project_heads h
          WHERE h.tenant_id=p.tenant_id AND h.project_id=p.id)) OR (p.adapter_id=$5 AND $7::boolean))
        AND ($8::text IS NULL OR p.domain_state IN ('manual_project_' || $8,'idea_project_' || $8))
        ORDER BY p.id COLLATE "C" LIMIT 51 FOR SHARE OF p`, [this.scope.tenantId, this.scope.workspaceId, after ?? null,
        this.manualAdapterId(), CONTROL_ROOM_IDEA_ADAPTER_V1, sources.ordinary === "included", sources.ideas === "included",
        lifecycle ?? null]);
      const ideaIds = rows.rows.slice(0, 50).filter(row => row.adapter_id === CONTROL_ROOM_IDEA_ADAPTER_V1).map(row => row.id);
      const ideaProjects = ideaIds.length && this.ideas
        ? await this.ideas.getProjectsInSession(tx, this.scope.tenantId, this.scope.workspaceId, ideaIds)
        : new Map<string, ProjectRegistryProjectionV1>();
      const projects: ProjectView[] = [];
      for (const row of rows.rows.slice(0, 50))
        projects.push(await this.readViewWithPayload(tx, actor, row.id, row.adapter_id, row.payload, row, ideaProjects.get(row.id)));
      return { projects, nextCursor: rows.rows.length > 50 ? projects.at(-1)!.projectId : null,
        canCreate: actor.can("projects.create"), sources };
    }, true);
  }

  async getView(identity: VerifiedWebIdentity, projectId: string): Promise<ProjectView> {
    return this.authenticated(identity, (tx, actor) => this.getViewInSession(tx, actor, projectId), true);
  }

  /** Fixed-query project verification for task pages that already hold one
   * authenticated transaction. Every returned row still passes the ordinary
   * or Idea-specific integrity and permission checks used by getViewInSession. */
  async getViewsInSession(tx: DatabaseSession, actor: Actor, projectIds: readonly string[]): Promise<ReadonlyMap<string, ProjectView>> {
    const ids = [...new Set(projectIds)];
    for (const id of ids) if (!catalogProjectIdSchema.safeParse(id).success) throw new WebAccessError("invalid_request");
    if (!ids.length) return new Map();
    const rows = (await tx.query<CatalogRow>(`SELECT p.id,p.adapter_id,p.payload,p.title,coalesce(p.description,'') AS summary,
      h.lifecycle,h.version,h.created_at,h.updated_at FROM projects p
      LEFT JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
      WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=ANY($3::text[])
      AND p.adapter_id IN ($4,$5) ORDER BY p.id COLLATE "C" FOR SHARE OF p`,
    [this.scope.tenantId, this.scope.workspaceId, ids, this.manualAdapterId(), CONTROL_ROOM_IDEA_ADAPTER_V1])).rows;
    const ideaIds = rows.filter(row => row.adapter_id === CONTROL_ROOM_IDEA_ADAPTER_V1).map(row => row.id);
    const ideaProjects = ideaIds.length && this.ideas
      ? await this.ideas.getProjectsInSession(tx, this.scope.tenantId, this.scope.workspaceId, ideaIds)
      : new Map<string, ProjectRegistryProjectionV1>();
    const output = new Map<string, ProjectView>();
    for (const row of rows) output.set(row.id, await this.readViewWithPayload(tx, actor, row.id, row.adapter_id, row.payload,
      row, ideaProjects.get(row.id)));
    if (output.size !== ids.length) throw new WebAccessError("not_found");
    return output;
  }

  /** Server-only composition inside the shared session/grant transaction. No new identity authority. */
  async getViewInSession(tx: DatabaseSession, actor: Actor, projectId: string): Promise<ProjectView> {
    if (!catalogProjectIdSchema.safeParse(projectId).success) throw new WebAccessError("invalid_request");
      const ordinary = actor.can("projects.read", projectId), ideas = actor.can("idea_lab.project_read", projectId, true);
      // Decide eligible sources before resolving an ID. A hidden source and an absent row must look identical.
      if (!ordinary && !ideas) throw new WebAccessError("access_denied");
      const row = (await tx.query<CatalogRow>(`SELECT p.id,p.adapter_id,p.payload,p.title,coalesce(p.description,'') AS summary,
        h.lifecycle,h.version,h.created_at,h.updated_at FROM projects p
        LEFT JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
        WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3
        AND ((p.adapter_id=$4 AND $6::boolean) OR (p.adapter_id=$5 AND $7::boolean)) FOR SHARE OF p`,
      [this.scope.tenantId, this.scope.workspaceId, projectId, this.manualAdapterId(), CONTROL_ROOM_IDEA_ADAPTER_V1, ordinary, ideas])).rows[0];
      if (!row) throw new WebAccessError("not_found");
      return this.readViewWithPayload(tx, actor, projectId, row.adapter_id, row.payload, row);
  }

  private async readViewWithPayload(tx: DatabaseSession, actor: Actor, projectId: string, adapterId: string,
    storedPayload: unknown, selected?: CatalogRow, selectedIdea?: ProjectRegistryProjectionV1): Promise<ProjectView> {
    if (adapterId === CONTROL_ROOM_IDEA_ADAPTER_V1) {
      actor.require("idea_lab.project_read", projectId, true);
      if (!this.ideas) throw new Error("idea_catalog_not_configured");
      const idea = selectedIdea ?? await this.ideas.getProjectInSession(tx, this.scope.tenantId, this.scope.workspaceId, projectId);
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
      // Idea projects do not carry presentation. Templates and module selection are ordinary-project only.
      return projectViewSchema.parse({ projectId: idea.projectId, title: idea.title, summary: idea.summary,
        lifecycle: idea.lifecycleState, version: idea.version, createdAt: iso(idea.createdAt), updatedAt: iso(idea.updatedAt),
        origin: "idea_lab", lifecycleEditable: actions.length > 0,
        ...(canReadDiscussion ? { sourceIdeaSessionId: idea.sourceIdeaSessionId } : {}),
        ...(this.ideaLifecycle ? { ideaLifecycleActions: actions } : {}) });
    }
    actor.require("projects.read", projectId);
    if (adapterId !== this.manualAdapterId()) throw new WebAccessError("not_found");
    const row = selected ? {
      projectId: selected.id, title: selected.title, summary: selected.summary, lifecycle: selected.lifecycle,
      version: selected.version, createdAt: selected.created_at, updatedAt: selected.updated_at,
    } : (await tx.query<WebProject>(`SELECT p.id AS "projectId",p.title,coalesce(p.description,'') AS summary,
      h.lifecycle,h.version,h.created_at AS "createdAt",h.updated_at AS "updatedAt" FROM projects p
      JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
      WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3 AND p.adapter_id=$4 FOR SHARE OF p,h`,
    [this.scope.tenantId, this.scope.workspaceId, projectId, this.manualAdapterId()])).rows[0];
    if (!row || row.lifecycle === null || row.version === null || row.createdAt === null || row.updatedAt === null)
      throw new WebAccessError("not_found");
    const presentation = this.derivePresentation(storedPayload);
    return projectViewSchema.parse({ ...row, version: Number(row.version), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
      origin: "ordinary", lifecycleEditable: actor.can("projects.lifecycle", projectId),
      ...(presentation ? { presentation } : {}) });
  }

  private derivePresentation(storedPayload: unknown): EffectiveProjectPresentationV1 | undefined {
    const stored = parseStoredProjectPresentationV1(storedPayload);
    return computeEffectiveProjectPresentationV1(stored, this.productConfiguration);
  }

  private manualAdapterId() { return `adapter:manual:${sha256Digest(this.scope).slice(7, 39)}`; }

  async create(identity: VerifiedWebIdentity, value: unknown, key: string) {
    const parsed = projectCreateSchema.safeParse(value);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    // Idempotency digest shape MUST match the legacy request shape exactly when no template is
    // supplied, so historical no-template replays continue to return their original receipts
    // across the deploy boundary. The digest key is only added when a template is actually
    // selected; omitting it via spread-strip preserves the pre-deploy canonical encoding.
    const idempotencyValue = parsed.data.templateSelection
      ? { ...parsed.data }
      : (() => { const { templateSelection: _omit, ...rest } = parsed.data; return rest; })();
    return this.command(identity, "projects.create", undefined, idempotencyValue, key, async (tx, actor) => {
      let presentation: Readonly<ProjectPresentationV1> | undefined;
      if (parsed.data.templateSelection) {
        if (!this.productConfiguration || !this.configurationDigest) throw new WebAccessError("invalid_request");
        let candidate;
        try {
          candidate = verifyProjectTemplateSelectionV1(this.productConfiguration, parsed.data.templateSelection,
            this.configurationDigest);
        } catch (error) {
          if (error instanceof ProjectPresentationError) throw new WebAccessError("invalid_request");
          throw error;
        }
        presentation = buildProjectPresentationV1(candidate, this.configurationDigest);
      }
      // Compute the effective presentation now so the create receipt returns it directly —
      // it is the same value the next getView would derive, just computed at insert time.
      // The wire shape uses the schema-inferred type (mutable arrays), not the readonly interface.
      const effectivePresentation = computeEffectiveProjectPresentationV1(presentation, this.productConfiguration);
      const adapterId = this.manualAdapterId();
      const workspace = await tx.query(`SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR SHARE`, [this.scope.tenantId, this.scope.workspaceId]);
      if (!workspace.rows.length) throw new WebAccessError("access_denied");
      await tx.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
        VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30) ON CONFLICT DO NOTHING`, [adapterId, this.scope.tenantId]);
      const project: WebProject = { projectId: `project:${randomUUID()}`, title: parsed.data.title, summary: parsed.data.summary,
        lifecycle: "active", version: 1, createdAt: actor.now, updatedAt: actor.now,
        ...(effectivePresentation ? { presentation: effectivePresentation as EffectiveProjectPresentation } : {}) };
      const payload = JSON.stringify({ projectKind: "general", origin: "manual", createdAt: actor.now,
        ...(presentation ? { presentation } : {}) });
      await tx.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
        normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
        VALUES($1,$2,$3,$4,$1,'1',$5,$6,'planned','manual_project_active','healthy','control_room_native',$7,$8::jsonb,$7)`,
      [project.projectId, this.scope.tenantId, this.scope.workspaceId, adapterId, project.title, project.summary, actor.now, payload]);
      await tx.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
        VALUES($1,$2,'active',1,$3,$3)`, [this.scope.tenantId, project.projectId, actor.now]);
      return project;
    });
  }

  async get(identity: VerifiedWebIdentity, projectId: string): Promise<WebProject> {
    if (!/^project:[A-Za-z0-9:_-]{1,160}$/.test(projectId)) throw new WebAccessError("invalid_request");
    return this.authorized(identity, "projects.read", projectId, async tx => {
      const row = (await tx.query<WebProject & { payload: unknown }>(`SELECT p.id AS "projectId",p.title,coalesce(p.description,'') AS summary,
        h.lifecycle,h.version,h.created_at AS "createdAt",h.updated_at AS "updatedAt",p.payload
        FROM projects p
        JOIN control_manual_project_heads h ON h.tenant_id=p.tenant_id AND h.project_id=p.id
        WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.id=$3 AND p.adapter_id=$4`,
        [this.scope.tenantId, this.scope.workspaceId, projectId, this.manualAdapterId()])).rows[0];
      if (!row) throw new WebAccessError("not_found");
      // Read the stored payload so the receipt can echo the same effective presentation
      // create() returned. Malformed stored data fails visibly rather than silently dropped.
      const stored = parseStoredProjectPresentationV1(row.payload);
      const presentation = computeEffectiveProjectPresentationV1(stored, this.productConfiguration);
      const { payload: _payload, ...rest } = row;
      return { ...rest, version: Number(rest.version), createdAt: iso(rest.createdAt),
        updatedAt: iso(rest.updatedAt),
        ...(presentation ? { presentation: presentation as EffectiveProjectPresentation } : {}) };
    }, true);
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
      if (this.projectEvents && (lifecycle === "completed" || lifecycle === "archived")) {
        await this.projectEvents.appendInSession(tx, { ...this.scope, projectId, subjectId: projectId,
          action: lifecycle === "completed" ? "project_completed" : "project_archived", sourceId: projectId,
          sourceVersion: `project-v${project.version}`, occurredAt: actor.now });
      }
      // Project lifecycle never cancels a job, changes a lease or creates an external effect.
      return project;
    });
  }

  async transitionIdea(identity: VerifiedWebIdentity, projectId: string, value: unknown, key: string) {
    if (!this.ideaLifecycle) throw new Error("idea_lifecycle_not_configured");
    return this.ideaLifecycle.transition(identity, projectId, value, key);
  }

  /** Raw settings row, unauthorized -- callers (readSettings and the assignment coordinator's own
   * eligibility/concurrency checks) hold or re-check their own authorization on the same
   * transaction. An absent row means "no settings saved": unrestricted, uncapped, no default. */
  async readSettingsRowInSession(tx: DatabaseSession, projectId: string): Promise<Readonly<{
    version: number; eligibleWorkerKinds: readonly string[] | null; maxConcurrentTasks: number | null;
    defaultWorkerKind: string | null; defaultModel: string | null; defaultEffort: string | null; updatedAt: string | null }>> {
    const row = (await tx.query<{ eligible_worker_kinds: string[] | null; max_concurrent_tasks: number | string | null;
      default_worker_kind: string | null; default_model: string | null; default_effort: string | null;
      version: number | string; updated_at: string | Date }>(
      `SELECT eligible_worker_kinds,max_concurrent_tasks,default_worker_kind,default_model,default_effort,version,updated_at
       FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2`, [this.scope.tenantId, projectId])).rows[0];
    if (!row) return { version: 0, eligibleWorkerKinds: null, maxConcurrentTasks: null,
      defaultWorkerKind: null, defaultModel: null, defaultEffort: null, updatedAt: null };
    return { version: Number(row.version), eligibleWorkerKinds: row.eligible_worker_kinds,
      maxConcurrentTasks: row.max_concurrent_tasks === null ? null : Number(row.max_concurrent_tasks),
      defaultWorkerKind: row.default_worker_kind, defaultModel: row.default_model, defaultEffort: row.default_effort,
      updatedAt: iso(row.updated_at) };
  }

  async readSettings(identity: VerifiedWebIdentity, projectId: string): Promise<ProjectSettings> {
    return this.authenticated(identity, async (tx, actor) => {
      const project = await this.getViewInSession(tx, actor, projectId);
      if (project.origin !== "ordinary") throw new WebAccessError("not_found");
      const row = await this.readSettingsRowInSession(tx, projectId);
      return projectSettingsSchema.parse({ projectId, ...row, updatedAt: row.updatedAt ?? actor.now });
    }, true);
  }

  /** Owner-only, version-checked write. `projects.settings` requires the owner role explicitly
   * (the third `true`), the same way tasks.assign does for revoke/cancel -- an operator grant can
   * never edit these regardless of its own allowed_actions. */
  async updateSettings(identity: VerifiedWebIdentity, projectId: string, draft: unknown): Promise<ProjectSettings> {
    const parsed = projectSettingsDraftSchema.safeParse(draft);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    return this.authenticated(identity, async (tx, actor) => {
      actor.require("projects.read", projectId); actor.require("projects.settings", projectId, true);
      const project = await this.getViewInSession(tx, actor, projectId);
      if (project.origin !== "ordinary") throw new WebAccessError("not_found");
      const existing = (await tx.query<{ version: number | string }>(
        `SELECT version FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2 FOR UPDATE`,
        [this.scope.tenantId, projectId])).rows[0];
      const currentVersion = existing ? Number(existing.version) : 0;
      if (currentVersion !== parsed.data.expectedVersion) throw new WebAccessError("conflict");
      const { eligibleWorkerKinds, maxConcurrentTasks, defaultWorkerKind, defaultModel, defaultEffort } = parsed.data;
      const nextVersion = currentVersion + 1;
      const eligibleJson = eligibleWorkerKinds ? JSON.stringify(eligibleWorkerKinds) : null;
      if (existing) {
        await tx.query(`UPDATE control_project_settings SET eligible_worker_kinds=$1::jsonb,max_concurrent_tasks=$2,
          default_worker_kind=$3,default_model=$4,default_effort=$5,version=$6,updated_by_identity_id=$7,updated_at=$8
          WHERE tenant_id=$9 AND project_id=$10`,
        [eligibleJson, maxConcurrentTasks, defaultWorkerKind, defaultModel, defaultEffort,
          nextVersion, actor.id, actor.now, this.scope.tenantId, projectId]);
      } else {
        // The absent-row branch, shared with the chief-of-staff panel. See
        // project-settings-first-row.ts for why one function and not two statements: the
        // two panels disagreed about how to lose this race, and each was correct about
        // only half of what a caller can hit.
        // Named columns, not a shared fixed list: 0201's `planner_mode` is
        // NOT NULL DEFAULT 'inherit', so this panel must not mention any planner column
        // at all -- naming it NULL would be refused, and writing it would have one panel
        // store the other's state.
        await insertProjectSettingsRowV1(tx,
          "tenant_id,project_id,version,updated_by_identity_id,updated_at,eligible_worker_kinds,"
          + "max_concurrent_tasks,default_worker_kind,default_model,default_effort",
          [this.scope.tenantId, projectId, nextVersion, actor.id, actor.now,
            eligibleJson, maxConcurrentTasks, defaultWorkerKind, defaultModel, defaultEffort]);
      }
      return projectSettingsSchema.parse({ projectId, version: nextVersion, eligibleWorkerKinds, maxConcurrentTasks,
        defaultWorkerKind, defaultModel, defaultEffort, updatedAt: actor.now });
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

  async logout(identity: VerifiedWebIdentity): Promise<void> { return this.authority.logout(identity); }
}

/** Public helper for tests and helpers that want to compute the digest the service uses. */
export function projectConfigurationDigestFor(productConfiguration: Readonly<ProductConfigurationV1>): string {
  return configurationDigestFor(productConfiguration);
}

/** Re-export to keep call sites in private-process.ts terse. */
export const PRODUCT_CONFIGURATION_SCHEMA_NAME_V1 = PRODUCT_CONFIGURATION_SCHEMA_V1;
