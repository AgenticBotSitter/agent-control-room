import type { SqliteCodexStartJournalV1 } from './start-journal';
import { createOwnedCodexRead, type OwnedCodexReadConnection } from './owned-read';
import { assertSynchronousFence } from '../../security/synchronous-fence';

type StartEvidence = Pick<SqliteCodexStartJournalV1, 'load'>;
type RecordedStart = Extract<ReturnType<SqliteCodexStartJournalV1['load']>, { status: 'recorded' }>;
export type CodexLocalReadIdentityV1 = NonNullable<RecordedStart['readIdentity']>;

export interface CodexLocalReadAuthorityV1 {
  /** Current local authority for this exact saved identity. It must complete
   * synchronously and is rechecked around every awaited native operation. */
  assertCurrent(identity: CodexLocalReadIdentityV1): void;
}

const unavailable = (): never => { throw new Error('codex_local_read_composition_unavailable'); };

/**
 * One-shot, read-only restart composition. It can inspect only the exact
 * thread/turn durably recorded by the start journal. It exposes no resume,
 * retry, new-turn or canonical result-publication capability.
 */
export function createCodexLocalReadCompositionV1(input: {
  runId: string;
  startEvidence: StartEvidence;
  authority: CodexLocalReadAuthorityV1;
  open(identity: CodexLocalReadIdentityV1, signal: AbortSignal): OwnedCodexReadConnection;
  timeoutMs?: number;
  cleanupMs?: number;
}) {
  const load = input.startEvidence.load.bind(input.startEvidence);
  const assert = input.authority.assertCurrent.bind(input.authority);
  const open = input.open.bind(input);
  const runId = input.runId;
  const timeoutMs = input.timeoutMs ?? 5_000, cleanupMs = input.cleanupMs ?? 1_000;
  let attempted = false;

  return Object.freeze({ async read(signal: AbortSignal) {
    if (attempted) return unavailable(); attempted = true;
    if (!(signal instanceof AbortSignal) || signal.aborted) return unavailable();
    const saved = load(runId);
    if (saved.status !== 'recorded' || !saved.readIdentity) return unavailable();
    const identity = Object.freeze(structuredClone(saved.readIdentity));
    if (identity.runId !== runId) return unavailable();
    const current = () => assertSynchronousFence(() => assert(identity), unavailable);
    current();
    const owned = createOwnedCodexRead({ binding: { threadId: identity.threadId, turnId: identity.turnId },
      open: nativeSignal => open(identity, nativeSignal), assertCurrent: current, timeoutMs, cleanupMs });
    const observation = await owned.read(signal);
    current();
    if (observation.threadId !== identity.threadId || observation.turnId !== identity.turnId) return unavailable();
    return Object.freeze({ ...observation, identity,
      exactPackageResultQualified: false as const, canonicalPublicationAllowed: false as const,
      grantsExecutionAuthority: false as const, permitsRetry: false as const,
      permitsResume: false as const, permitsNewTurn: false as const });
  } });
}
