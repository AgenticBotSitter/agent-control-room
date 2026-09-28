import type { DatabaseClient } from "../../persistence/database";
import { parseProjectEventPageV1, ProjectEventErrorV1, type ProjectEventPageV1,
  type ProjectEventReadSourceV1 } from "../../project-events/v1";
import { catalogProjectIdSchema } from "./project-wire";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { WebSessionAuthority } from "./session-authority";

export class ProjectActivityServiceV1 {
  private readonly authority: WebSessionAuthority;

  constructor(db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    private readonly source?: ProjectEventReadSourceV1, clock: () => number = Date.now) {
    this.authority = new WebSessionAuthority(db, scope, clock);
  }

  async authorize(identity: VerifiedWebIdentity, projectId: string): Promise<void> {
    if (!catalogProjectIdSchema.safeParse(projectId).success) throw new WebAccessError("invalid_request");
    await this.authority.authenticated(identity, async (_, actor) => {
      actor.require("projects.read", projectId, true);
    }, { readOnly: true });
  }

  async read(identity: VerifiedWebIdentity, projectId: string,
    cursor: { afterCursor?: string; beforeCursor?: string }, limit: number): Promise<ProjectEventPageV1> {
    if (!catalogProjectIdSchema.safeParse(projectId).success || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || cursor.afterCursor !== undefined && cursor.beforeCursor !== undefined) throw new WebAccessError("invalid_request");
    return this.authority.authenticated(identity, async (_, actor) => {
      actor.require("projects.read", projectId, true);
      if (!this.source) throw new Error("project_activity_source_unavailable");
      let value: unknown;
      try { value = await this.source.read({ ...this.scope, projectId, ...cursor, limit }); }
      catch (error) {
        if (error instanceof ProjectEventErrorV1 && error.safeCode === "project_not_found") throw new WebAccessError("not_found");
        if (error instanceof ProjectEventErrorV1 && error.safeCode === "invalid_input") throw new WebAccessError("invalid_request");
        throw error;
      }
      const page = parseProjectEventPageV1(value);
      if (page.tenantId !== this.scope.tenantId || page.workspaceId !== this.scope.workspaceId || page.projectId !== projectId
        || !page.presentationOnly || page.grantsApproval || page.grantsCommandAuthority || page.grantsExecutionAuthority)
        throw new Error("project_activity_scope_mismatch");
      return page;
    }, { readOnly: true });
  }
}
