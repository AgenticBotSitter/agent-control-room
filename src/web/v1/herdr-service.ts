import type { DatabaseClient } from '../../persistence/database';
import { WebSessionAuthority } from './session-authority';
import { WebProjectService } from './project-service';
import { WebAccessError, type VerifiedWebIdentity } from './access-verifier';
import { catalogProjectIdSchema } from './project-wire';
import type { HerdrObservationSource } from './herdr-observation-source';

/** Reads only retained minimized observations under existing project authority.
 * No source polling, registration, terminal command or automatic dispatch.
 */
export class WebHerdrService {
  private readonly authority: WebSessionAuthority;
  private readonly projects: WebProjectService;
  private readonly sources = new Map<string, HerdrObservationSource>();
  constructor(db: DatabaseClient, scope: { tenantId: string; workspaceId: string },
    sources: readonly HerdrObservationSource[], clock: () => number = Date.now, ideaIntegrityKey?: Uint8Array) {
    this.authority = new WebSessionAuthority(db, scope, clock);
    this.projects = new WebProjectService(db, scope, clock, ideaIntegrityKey);
    for (const source of sources) {
      if (source.tenantId !== scope.tenantId || source.workspaceId !== scope.workspaceId
          || this.sources.has(source.projectId)) throw new Error('observation_configuration_invalid');
      this.sources.set(source.projectId, source);
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
    return source ? source.view() : { projectId, status: 'not_configured' as const, rows: [], ageMs: null,
      executionAuthority: false as const, completionVerified: false as const, cleanupVerified: false as const };
  }
}
