import type { DatabaseClient } from '../../persistence/database';
import { WebSessionAuthority } from './session-authority';
import { WebProjectService } from './project-service';
import { WebAccessError, type VerifiedWebIdentity } from './access-verifier';
import { catalogProjectIdSchema } from './project-wire';
import type { HerdrObservationReader } from './herdr-observation-source';
import { herdrObservationPageSchema } from './herdr-wire';

/** Reads only retained minimized observations under existing project authority.
 * No source polling, registration, terminal command or automatic dispatch.
 */
export class WebHerdrService {
  private readonly authority: WebSessionAuthority;
  private readonly projects: WebProjectService;
  private readonly sources = new Map<string, HerdrObservationReader>();
  constructor(db: DatabaseClient, scope: { tenantId: string; workspaceId: string },
    sources: readonly HerdrObservationReader[], clock: () => number = Date.now, ideaIntegrityKey?: Uint8Array) {
    this.authority = new WebSessionAuthority(db, scope, clock);
    this.projects = new WebProjectService(db, scope, clock, ideaIntegrityKey);
    for (const source of sources) {
      if (source.tenantId !== scope.tenantId || source.workspaceId !== scope.workspaceId
          || this.sources.has(source.projectId) || !catalogProjectIdSchema.safeParse(source.projectId).success
          || typeof source.view !== 'function') throw new Error('observation_configuration_invalid');
      this.sources.set(source.projectId, Object.freeze({ tenantId: source.tenantId, workspaceId: source.workspaceId,
        projectId: source.projectId, view: source.view.bind(source) }));
    }
  }
  async list(identity: VerifiedWebIdentity, projectId: string) {
    if (!catalogProjectIdSchema.safeParse(projectId).success) throw new WebAccessError('invalid_request');
    await this.authority.authenticated(identity, async (tx, actor) => {
      actor.require('projects.read', projectId);
      await this.projects.getViewInSession(tx, actor, projectId);
      actor.assertTimeCurrent();
    });
    // Snapshot after the authorization transaction settles: enrollment revoked
    // while SQL was committing must not expose the pre-revocation cached rows.
    const source = this.sources.get(projectId);
    const page = herdrObservationPageSchema.parse(source ? source.view() : { projectId, status: 'not_configured' as const, rows: [], ageMs: null,
      executionAuthority: false as const, completionVerified: false as const, cleanupVerified: false as const });
    if (page.projectId !== projectId) throw new Error('observation_unavailable');
    return page;
  }
}
