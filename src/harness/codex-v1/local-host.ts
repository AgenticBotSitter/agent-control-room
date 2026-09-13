import { assertSynchronousFence } from '../../security/synchronous-fence';
import type { WorkspaceIntent } from '../../node-bridge/workspace-intent';
import type { ObservableGitWorkspacePort } from './git-workspace-port';
import { createCodexLocalReadCompositionV1, type CodexLocalReadAuthorityV1,
  type CodexLocalReadIdentityV1 } from './local-read-composition';
import { createCodexLocalStartCompositionV1 } from './local-start-composition';
import type { CodexLocalStartAuthorityV1 } from './local-start-runtime';
import { createCodexOwnedStartV1 } from './owned-start';
import type { CodexStartJsonlConnectionV1 } from './start-jsonl';
import type { OwnedCodexReadConnection } from './owned-read';
import type { SqliteCodexStartJournalV1 } from './start-journal';
import type { SqliteBridgeJournal } from '../../node-bridge/journal';

type BridgeJournal = Pick<SqliteBridgeJournal,
  'acceptedCodexActivation' | 'reserveWorkspaceIntent' | 'recordWorkspaceRoots' | 'recordWorkspaceCreation'
  | 'reserveWorkspaceRemoval' | 'recordWorkspaceRemoved'>;
type StartJournal = Pick<SqliteCodexStartJournalV1, 'reserveStart' | 'recordThread' | 'recordTurn' | 'load'>;

interface CommonHostInputV1 {
  runId: string;
  startJournal: StartJournal;
}

export interface CodexLocalInitialHostInputV1 extends CommonHostInputV1 {
  mode: 'initial';
  queueId: string;
  connectionAttemptId: string;
  initializedConnectionDigest: string;
  threadStartRequestId: number;
  turnStartRequestId: number;
  workspaceIntent: WorkspaceIntent;
  bridgeJournal: BridgeJournal;
  authority: CodexLocalStartAuthorityV1;
  workspacePort: ObservableGitWorkspacePort;
  openStartSession(signal: AbortSignal): Promise<CodexStartJsonlConnectionV1>;
  startTimeoutMs: number;
  clock(): number;
}

export interface CodexLocalRecoverHostInputV1 extends CommonHostInputV1 {
  mode: 'recover';
  authority: CodexLocalReadAuthorityV1;
  openReadSession(identity: CodexLocalReadIdentityV1, signal: AbortSignal): OwnedCodexReadConnection;
  readTimeoutMs: number;
  cleanupTimeoutMs: number;
}

export type CodexLocalHostInputV1 = CodexLocalInitialHostInputV1 | CodexLocalRecoverHostInputV1;

const unavailable = (): never => { throw new Error('codex_local_host_unavailable'); };

function validateTimeout(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) unavailable();
  return value;
}

function publicIdentity(identity: CodexLocalReadIdentityV1) {
  return Object.freeze({ runId: identity.runId, threadId: identity.threadId,
    turnId: identity.turnId, source: identity.source });
}

/**
 * Bounded, one-shot local Codex host. The initial mode can only consume the
 * exact protected activation/workspace binding and issue thread/start followed
 * by turn/start. Recover can only read the exact durably recorded pair. Neither
 * mode has a canonical writer, retry, resume, new-turn, listener or provider
 * API. Native JSONL ownership and all physical workspace effects are injected.
 */
export function createCodexLocalHostV1(inputValue: CodexLocalHostInputV1) {
  const input = Object.freeze({ ...inputValue });
  let attempted = false;

  if (input.mode === 'initial') {
    const startTimeoutMs = validateTimeout(input.startTimeoutMs, 30_000);
    if (input.workspaceIntent.runId !== input.runId) unavailable();
    const authority: CodexLocalStartAuthorityV1 = Object.freeze({
      currentAdmissionDigest: input.authority.currentAdmissionDigest.bind(input.authority),
      assertCurrent: input.authority.assertCurrent.bind(input.authority),
    });
    const ownedStart = createCodexOwnedStartV1({
      open: input.openStartSession.bind(input), timeoutMs: startTimeoutMs,
    });
    const composition = createCodexLocalStartCompositionV1({
      queueId: input.queueId, connectionAttemptId: input.connectionAttemptId,
      initializedConnectionDigest: input.initializedConnectionDigest,
      threadStartRequestId: input.threadStartRequestId, turnStartRequestId: input.turnStartRequestId,
      workspaceIntent: input.workspaceIntent, bridgeJournal: input.bridgeJournal,
      startJournal: input.startJournal, workspacePort: input.workspacePort,
      authority, ownedStart, clock: input.clock.bind(input),
    });
    return Object.freeze({ harness: 'codex-local-v1' as const, mode: 'initial' as const,
      async run(signal: AbortSignal) {
        if (attempted || !(signal instanceof AbortSignal) || signal.aborted) return unavailable();
        attempted = true;
        const stop = () => { void composition.close().catch(() => {}); };
        signal.addEventListener('abort', stop, { once: true });
        try {
          const started = await composition.start();
          if (signal.aborted) return unavailable();
          const saved = input.startJournal.load(input.runId);
          const identity = saved.readIdentity;
          if (saved.status !== 'recorded' || !identity
            || saved.threadId !== started.thread.threadId || saved.turnId !== started.turn.turnId) {
            throw new Error('codex_local_host_unavailable');
          }
          assertSynchronousFence(() => authority.assertCurrent(input.queueId), unavailable);
          return Object.freeze({ disposition: 'observed' as const, mode: 'initial' as const,
            status: 'started' as const, identity: publicIdentity(identity),
            exactPackageResult: null, selectedResultItemSchemaQualified: false as const,
            nativeReadQualified: false as const, canonicalPublicationAllowed: false as const,
            completionVerified: false as const, grantsExecutionAuthority: false as const,
            permitsRetry: false as const, permitsResume: false as const,
            permitsNewTurn: false as const, writesResult: false as const,
            writesArtifact: false as const, writesReview: false as const,
            releasesCapacity: false as const });
        } catch { return unavailable(); }
        finally { signal.removeEventListener('abort', stop); }
      },
      close: composition.close,
    });
  }

  const readTimeoutMs = validateTimeout(input.readTimeoutMs, 30_000);
  const cleanupTimeoutMs = validateTimeout(input.cleanupTimeoutMs, 5_000);
  const read = createCodexLocalReadCompositionV1({ runId: input.runId,
    startEvidence: input.startJournal, authority: input.authority,
    open: input.openReadSession.bind(input), timeoutMs: readTimeoutMs, cleanupMs: cleanupTimeoutMs });
  return Object.freeze({ harness: 'codex-local-v1' as const, mode: 'recover' as const,
    async run(signal: AbortSignal) {
      if (attempted || !(signal instanceof AbortSignal) || signal.aborted) return unavailable();
      attempted = true;
      try {
        const observed = await read.read(signal);
        if (signal.aborted || observed.canonicalPublicationAllowed !== false
          || observed.grantsExecutionAuthority !== false || observed.permitsRetry !== false
          || observed.permitsResume !== false || observed.permitsNewTurn !== false) unavailable();
        const selected = observed.exactPackageResult;
        return Object.freeze({ disposition: 'observed' as const, mode: 'recover' as const,
          status: observed.status, identity: publicIdentity(observed.identity), usage: observed.usage,
          exactPackageResult: selected ?? null,
          selectedResultItemSchemaQualified: selected?.selectedResultItemSchemaQualified ?? false,
          nativeReadQualified: false as const, canonicalPublicationAllowed: false as const,
          completionVerified: false as const, grantsExecutionAuthority: false as const,
          permitsRetry: false as const, permitsResume: false as const,
          permitsNewTurn: false as const, writesResult: false as const,
          writesArtifact: false as const, writesReview: false as const,
          releasesCapacity: false as const });
      } catch { return unavailable(); }
    },
    async close() { /* the owned read retires its session before run resolves */ },
  });
}
