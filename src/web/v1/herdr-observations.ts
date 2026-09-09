import { createHash } from 'node:crypto';

// Adapted from Control Room's evaluated Herdr v0.9.0 pane-list projection.
// No Herdr process, socket, terminal reader or execution API is exposed here.
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const label = (value: unknown): string => {
  if (typeof value !== 'string' || !value.length || value.length > 512
      || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('invalid_observation');
  return value;
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_observation');
  return value as Record<string, unknown>;
};
export type HerdrProjectBinding = Readonly<{
  projectId: string;
  sourceId: string;
  enrollmentRevision: string;
  workspaceIds: readonly string[];
}>;

/** Trusted configuration only; raw pane metadata cannot establish this binding.
 * The caller must authorize the project and current enrollment on every read.
 * Returned hashes are correlation hints, not anonymization or authorization.
 */
export function createHerdrProjectProjection(input: HerdrProjectBinding) {
  const projectId = label(input.projectId), sourceId = label(input.sourceId);
  const revision = label(input.enrollmentRevision);
  if (!Array.isArray(input.workspaceIds) || input.workspaceIds.length > 1024)
    throw new Error('invalid_observation');
  const permitted = new Set(input.workspaceIds.map(label));
  if (permitted.size !== input.workspaceIds.length) throw new Error('invalid_observation');
  const scope = [projectId, sourceId, revision];
  return Object.freeze({
    projectId,
    project(raw: string, generation: number) {
      if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 256 * 1024
          || !Number.isSafeInteger(generation) || generation < 1) throw new Error('invalid_observation');
      const response = record(JSON.parse(raw));
      const result = record(response.result);
      if (response.id !== 'cli:pane:list' || response.error != null || result.type !== 'pane_list'
          || !Array.isArray(result.panes) || result.panes.length > 1024) throw new Error('invalid_observation');
      const identities = new Set<string>(), sessions = new Map<string, number>();
      const rows = [];
      for (const value of result.panes) {
        const pane = record(value), workspace = label(pane.workspace_id);
        // Filter before session correlation: another project's duplicate must
        // neither appear nor influence a visible project's duplicate warning.
        if (!permitted.has(workspace)) continue;
        const tab = label(pane.tab_id), paneId = label(pane.pane_id);
        const key = digest([...scope, generation, workspace, tab, paneId]);
        if (identities.has(key)) throw new Error('invalid_observation');
        identities.add(key);
        let sessionKey: string | null = null;
        if (pane.agent_session != null) {
          const session = record(pane.agent_session);
          if (session.kind !== 'id' && session.kind !== 'path') throw new Error('invalid_observation');
          sessionKey = digest([...scope, label(session.source), label(session.agent), session.kind, label(session.value)]);
          sessions.set(sessionKey, (sessions.get(sessionKey) ?? 0) + 1);
        }
        if (pane.agent == null && sessionKey === null) continue;
        const status = ['idle', 'working', 'blocked', 'done', 'unknown'].includes(String(pane.agent_status))
          ? String(pane.agent_status) : 'unknown';
        rows.push({ key, status, sessionKey });
      }
      return rows.map(({ key, status, sessionKey }) => Object.freeze({
        key, status, duplicateSession: sessionKey !== null && sessions.get(sessionKey)! > 1,
        stateSource: 'advisory' as const, executionAuthority: false as const,
        completionVerified: false as const, cleanupVerified: false as const,
      }));
    },
  });
}
