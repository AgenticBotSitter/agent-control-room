import type { DatabaseClient } from '../../persistence/database';
import { WebSessionAuthority } from './session-authority';
import { WebProjectService } from './project-service';
import { WebAccessError, type VerifiedWebIdentity } from './access-verifier';
import { catalogProjectIdSchema } from './project-wire';
import type { HerdrObservationReader } from './herdr-observation-source';
import { herdrObservationPageSchema, herdrObservationFleetSchema } from './herdr-wire';

/** Reads only retained minimized observations under existing project authority.
 * No source polling, registration, terminal command or automatic dispatch.
 */
export class WebHerdrService {
  private readonly authority: WebSessionAuthority;
  private readonly projects: WebProjectService;
  private readonly sources = new Map<string, HerdrObservationReader[]>();
  constructor(db: DatabaseClient, scope: { tenantId: string; workspaceId: string },
    sources: readonly HerdrObservationReader[], clock: () => number = Date.now, ideaIntegrityKey?: Uint8Array) {
    this.authority = new WebSessionAuthority(db, scope, clock);
    this.projects = new WebProjectService(db, scope, clock, ideaIntegrityKey);
    if (sources.length > 256) throw new Error('observation_configuration_invalid');
    for (const source of sources) {
      const group = this.sources.get(source.projectId) ?? [];
      if (source.tenantId !== scope.tenantId || source.workspaceId !== scope.workspaceId
          || group.some(item => item.sourceKey === source.sourceKey) || group.length >= 16
          || !/^[a-f0-9]{64}$/.test(source.sourceKey) || !catalogProjectIdSchema.safeParse(source.projectId).success
          || typeof source.view !== 'function') throw new Error('observation_configuration_invalid');
      group.push(Object.freeze({ tenantId: source.tenantId, workspaceId: source.workspaceId,
        projectId: source.projectId, sourceKey: source.sourceKey, view: source.view.bind(source) }));
      this.sources.set(source.projectId, group);
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
    const sources = (this.sources.get(projectId) ?? []).map(source => ({ sourceKey: source.sourceKey,
      observation: herdrObservationPageSchema.parse(source.view()) }));
    return herdrObservationFleetSchema.parse({ projectId, sources });
  }
}
