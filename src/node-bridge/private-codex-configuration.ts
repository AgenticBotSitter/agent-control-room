import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { SqliteBridgeJournal } from './journal';
import { parseWorkspaceIntent, type WorkspaceIntent } from './workspace-intent';
import { createCodexLocalHostV1, type CodexLocalInitialHostInputV1,
  type CodexLocalRecoverHostInputV1 } from '../harness/codex-v1/local-host';
import { SqliteCodexStartJournalV1 } from '../harness/codex-v1/start-journal';

export interface PrivateCodexStatePathsV1 { bridge: string; starts: string }

interface PrivateCodexInitialConfigurationInputV1 {
  mode: 'initial';
  paths: PrivateCodexStatePathsV1;
  runId: string;
  queueId: string;
  connectionAttemptId: string;
  initializedConnectionDigest: string;
  threadStartRequestId: number;
  turnStartRequestId: number;
  workspaceIntent: unknown;
  startTimeoutMs: number;
}

interface PrivateCodexRecoverConfigurationInputV1 {
  mode: 'recover';
  paths: PrivateCodexStatePathsV1;
  runId: string;
  readTimeoutMs: number;
  cleanupTimeoutMs: number;
}

export type PrivateCodexConfigurationInputV1 = PrivateCodexInitialConfigurationInputV1
  | PrivateCodexRecoverConfigurationInputV1;

type PrivateCodexInitialConfigurationPortsV1 = Pick<CodexLocalInitialHostInputV1,
  'authority' | 'workspacePort' | 'openStartSession' | 'clock'>;
type PrivateCodexRecoverConfigurationPortsV1 = Pick<CodexLocalRecoverHostInputV1,
  'authority' | 'openReadSession'>;
export type PrivateCodexConfigurationPortsV1 = PrivateCodexInitialConfigurationPortsV1
  | PrivateCodexRecoverConfigurationPortsV1;

const unavailable = (): never => { throw new Error('private_codex_configuration_unavailable'); };

/** Require existing owner-only state files. The operator provisions them; this
 * seam does not choose directories, follow links, repair permissions or erase
 * prior state. SQLite sidecars receive the same checks when present. */
function inspectPrivateCodexStatePathsV1(value: unknown): PrivateCodexStatePathsV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => key !== 'bridge' && key !== 'starts')) unavailable();
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.bridge !== 'string' || typeof candidate.starts !== 'string'
    || candidate.bridge === candidate.starts || typeof process.getuid !== 'function') unavailable();
  const bridgePath = candidate.bridge as string, startsPath = candidate.starts as string;
  const uid = process.getuid!(), identities = new Set<string>();
  for (const path of [bridgePath, startsPath]) {
    if (!isAbsolute(path) || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) unavailable();
    const directory = dirname(path), parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077)
      || realpathSync(directory) !== directory) unavailable();
    for (const candidatePath of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
      let stat: ReturnType<typeof lstatSync>;
      try { stat = lstatSync(candidatePath); }
      catch (error) {
        if (candidatePath !== path && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error('private_codex_configuration_unavailable');
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid
        || (stat.mode & 0o077) || realpathSync(candidatePath) !== candidatePath) unavailable();
      const identity = `${stat.dev}:${stat.ino}`;
      if (identities.has(identity)) unavailable();
      identities.add(identity);
    }
  }
  return Object.freeze({ bridge: bridgePath, starts: startsPath });
}

export function validatePrivateCodexStatePathsV1(value: unknown): PrivateCodexStatePathsV1 {
  try { return inspectPrivateCodexStatePathsV1(value); }
  catch { return unavailable(); }
}

function initialPorts(value: PrivateCodexConfigurationPortsV1): PrivateCodexInitialConfigurationPortsV1 {
  if (!('workspacePort' in value) || !('openStartSession' in value) || !('clock' in value)
    || !('currentAdmissionDigest' in value.authority)) unavailable();
  return value as PrivateCodexInitialConfigurationPortsV1;
}

function recoverPorts(value: PrivateCodexConfigurationPortsV1): PrivateCodexRecoverConfigurationPortsV1 {
  if (!('openReadSession' in value) || 'currentAdmissionDigest' in value.authority) unavailable();
  return value as PrivateCodexRecoverConfigurationPortsV1;
}

/**
 * Opens only the two approved Codex observation journals and composes one
 * explicitly selected host mode. All authority, physical workspace and native
 * JSONL session behavior is supplied by the operator. This factory has no
 * process spawning, credential discovery, listener, canonical writer or
 * deployment behavior.
 */
export function openPrivateCodexConfigurationV1(input: PrivateCodexConfigurationInputV1,
  ports: PrivateCodexConfigurationPortsV1, signal: AbortSignal) {
  if (!(signal instanceof AbortSignal) || signal.aborted) unavailable();
  const paths = validatePrivateCodexStatePathsV1(input.paths);
  let bridge: SqliteBridgeJournal | undefined, starts: SqliteCodexStartJournalV1 | undefined;
  let closed = false;
  try {
    bridge = new SqliteBridgeJournal(paths.bridge);
    starts = new SqliteCodexStartJournalV1(paths.starts);
    const host = input.mode === 'initial' ? (() => {
      const selected = initialPorts(ports), workspaceIntent: WorkspaceIntent = parseWorkspaceIntent(input.workspaceIntent);
      return createCodexLocalHostV1({ mode: 'initial', runId: input.runId, queueId: input.queueId,
        connectionAttemptId: input.connectionAttemptId,
        initializedConnectionDigest: input.initializedConnectionDigest,
        threadStartRequestId: input.threadStartRequestId, turnStartRequestId: input.turnStartRequestId,
        workspaceIntent, bridgeJournal: bridge!, startJournal: starts!, authority: selected.authority,
        workspacePort: selected.workspacePort, openStartSession: selected.openStartSession,
        startTimeoutMs: input.startTimeoutMs, clock: selected.clock });
    })() : (() => {
      const selected = recoverPorts(ports);
      return createCodexLocalHostV1({ mode: 'recover', runId: input.runId, startJournal: starts!,
        authority: selected.authority, openReadSession: selected.openReadSession,
        readTimeoutMs: input.readTimeoutMs, cleanupTimeoutMs: input.cleanupTimeoutMs });
    })();
    const close = async () => {
      if (closed) return;
      closed = true;
      let failed = false;
      try { await host.close(); } catch { failed = true; }
      try { starts?.close(); } catch { failed = true; }
      try { bridge?.close(); } catch { failed = true; }
      if (failed) throw new Error('private_codex_configuration_cleanup_uncertain');
    };
    return Object.freeze({ harness: 'codex-local-v1' as const, mode: input.mode,
      run: host.run, close });
  } catch {
    try { starts?.close(); } catch { /* setup is unavailable */ }
    try { bridge?.close(); } catch { /* setup is unavailable */ }
    return unavailable();
  }
}
