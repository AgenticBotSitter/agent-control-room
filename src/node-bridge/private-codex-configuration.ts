import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { SqliteBridgeJournal } from './journal';
import { parseWorkspaceIntent, type WorkspaceIntent } from './workspace-intent';
import { createCodexLocalHostV1, type CodexLocalInitialHostInputV1,
  type CodexLocalRecoverHostInputV1 } from '../harness/codex-v1/local-host';
import { SqliteCodexStartJournalV1 } from '../harness/codex-v1/start-journal';
import type { CodexNativeProcessAcquisitionV1 } from './codex-native-process';
import type { CodexDeliveryBoundWorkspacePolicyV1 } from '../harness/codex-v1/delivery-bound-workspace-preparation';

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
  workspacePolicy: CodexDeliveryBoundWorkspacePolicyV1;
  startTimeoutMs: number;
  processCleanupTimeoutMs: number;
}

interface PrivateCodexRecoverConfigurationInputV1 {
  mode: 'recover';
  paths: PrivateCodexStatePathsV1;
  runId: string;
  connectionAttemptId: string;
  initializedConnectionDigest: string;
  readTimeoutMs: number;
  cleanupTimeoutMs: number;
  processCleanupTimeoutMs: number;
}

export type PrivateCodexConfigurationInputV1 = PrivateCodexInitialConfigurationInputV1
  | PrivateCodexRecoverConfigurationInputV1;

type PrivateCodexInitialConfigurationPortsV1 = Pick<CodexLocalInitialHostInputV1,
  'authority' | 'workspacePort' | 'acquireProcess' | 'clock'>;
type PrivateCodexRecoverConfigurationPortsV1 = Pick<CodexLocalRecoverHostInputV1,
  'authority' | 'acquireProcess'>;
export type PrivateCodexConfigurationPortsV1 = PrivateCodexInitialConfigurationPortsV1
  | PrivateCodexRecoverConfigurationPortsV1;
export type OwnedPrivateCodexConfigurationPortsV1 =
  | Omit<PrivateCodexInitialConfigurationPortsV1, 'acquireProcess'>
  | Omit<PrivateCodexRecoverConfigurationPortsV1, 'acquireProcess'>;

const unavailable = (): never => { throw new Error('private_codex_configuration_unavailable'); };
const cleanupUncertain = (): never => { throw new Error('private_codex_configuration_cleanup_uncertain'); };

type PrivateCodexHostV1 = ReturnType<typeof createCodexLocalHostV1>;
type PrivateCodexRunResultV1 = Awaited<ReturnType<PrivateCodexHostV1['run']>>;
type PrivateCodexResourcesV1 = {
  bridge?: SqliteBridgeJournal;
  starts?: SqliteCodexStartJournalV1;
  host?: PrivateCodexHostV1;
};

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
  if (!('workspacePort' in value) || !('acquireProcess' in value) || !('clock' in value)
    || !('currentAdmissionDigest' in value.authority)) unavailable();
  return value as PrivateCodexInitialConfigurationPortsV1;
}

function recoverPorts(value: PrivateCodexConfigurationPortsV1): PrivateCodexRecoverConfigurationPortsV1 {
  if (!('acquireProcess' in value) || 'currentAdmissionDigest' in value.authority) unavailable();
  return value as PrivateCodexRecoverConfigurationPortsV1;
}

function constructPrivateCodexResourcesV1(input: PrivateCodexConfigurationInputV1,
  ports: PrivateCodexConfigurationPortsV1, signal: AbortSignal, resources: PrivateCodexResourcesV1): PrivateCodexHostV1 {
  if (!(signal instanceof AbortSignal) || signal.aborted) unavailable();
  const paths = validatePrivateCodexStatePathsV1(input.paths);
  resources.bridge = new SqliteBridgeJournal(paths.bridge);
  resources.starts = new SqliteCodexStartJournalV1(paths.starts);
  resources.host = input.mode === 'initial' ? (() => {
    const selected = initialPorts(ports), workspaceIntent: WorkspaceIntent = parseWorkspaceIntent(input.workspaceIntent);
    return createCodexLocalHostV1({ mode: 'initial', runId: input.runId, queueId: input.queueId,
      connectionAttemptId: input.connectionAttemptId,
      initializedConnectionDigest: input.initializedConnectionDigest,
      threadStartRequestId: input.threadStartRequestId, turnStartRequestId: input.turnStartRequestId,
      workspaceIntent, bridgeJournal: resources.bridge!, startJournal: resources.starts!, authority: selected.authority,
      workspacePort: selected.workspacePort, acquireProcess: selected.acquireProcess.bind(selected),
      workspacePolicy: input.workspacePolicy,
      startTimeoutMs: input.startTimeoutMs, processCleanupTimeoutMs: input.processCleanupTimeoutMs,
      clock: selected.clock });
  })() : (() => {
    const selected = recoverPorts(ports);
    return createCodexLocalHostV1({ mode: 'recover', runId: input.runId, startJournal: resources.starts!,
      connectionAttemptId: input.connectionAttemptId,
      initializedConnectionDigest: input.initializedConnectionDigest,
      authority: selected.authority, acquireProcess: selected.acquireProcess.bind(selected),
      readTimeoutMs: input.readTimeoutMs, cleanupTimeoutMs: input.cleanupTimeoutMs,
      processCleanupTimeoutMs: input.processCleanupTimeoutMs });
  })();
  return resources.host;
}

function closePrivateCodexJournalsV1(resources: PrivateCodexResourcesV1): boolean {
  let failed = false;
  try { resources.starts?.close(); } catch { failed = true; }
  try { resources.bridge?.close(); } catch { failed = true; }
  return failed;
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
  const resources: PrivateCodexResourcesV1 = {};
  try {
    const host = constructPrivateCodexResourcesV1(input, ports, signal, resources);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      let failed = false;
      try { await host.close(); } catch { failed = true; }
      if (closePrivateCodexJournalsV1(resources)) failed = true;
      if (failed) cleanupUncertain();
    };
    return Object.freeze({ harness: 'codex-local-v1' as const, mode: input.mode,
      ...(input.mode === 'initial' && host.mode === 'initial' ? { bindDelivery: host.bindDelivery } : {}),
      run: host.run, close });
  } catch {
    closePrivateCodexJournalsV1(resources);
    return unavailable();
  }
}

/**
 * Adopts one already-created native acquisition into the existing private Codex
 * host owner. Construction opens only the approved journals: acquisition stays
 * inert until the host requests its exact process binding. Cleanup is a single
 * ordered attempt across host/session, acquisition, then journals.
 */
export async function openOwnedPrivateCodexConfigurationV1(input: PrivateCodexConfigurationInputV1,
  ports: OwnedPrivateCodexConfigurationPortsV1, acquisition: CodexNativeProcessAcquisitionV1,
  signal: AbortSignal) {
  const resources: PrivateCodexResourcesV1 = {};
  let acquire: CodexNativeProcessAcquisitionV1['acquire'] | undefined;
  let closeAcquisition: (() => Promise<void>) | undefined;
  let closePromise: Promise<void> | undefined;
  let runController: AbortController | undefined;
  let activeRun: Promise<PrivateCodexRunResultV1> | undefined;
  let cleanupStepMs = 5_000;

  const close = () => {
    if (closePromise) return closePromise;
    runController?.abort();
    closePromise = (async () => {
      let failed = false;
      const attempt = async (work: () => Promise<unknown>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const operation = Promise.resolve().then(work); void operation.catch(() => {});
        try { await Promise.race([operation, new Promise<never>((_, reject) => {
          timer = setTimeout(reject, cleanupStepMs);
        })]); } catch { failed = true; }
        finally { clearTimeout(timer); }
      };
      if (resources.host) await attempt(() => resources.host!.close());
      if (activeRun) {
        await attempt(() => activeRun!.then(() => {}, () => {}));
      }
      if (closeAcquisition) await attempt(closeAcquisition);
      if (closePrivateCodexJournalsV1(resources)) failed = true;
      if (failed) cleanupUncertain();
    })();
    return closePromise;
  };

  try {
    if (!acquisition || typeof acquisition !== 'object') unavailable();
    if (typeof acquisition.close === 'function') closeAcquisition = acquisition.close.bind(acquisition);
    if (typeof acquisition.acquire !== 'function' || !closeAcquisition) unavailable();
    acquire = acquisition.acquire.bind(acquisition);
    const hostPorts = Object.freeze({ ...ports, acquireProcess: acquire }) as PrivateCodexConfigurationPortsV1;
    const host = constructPrivateCodexResourcesV1(input, hostPorts, signal, resources);
    cleanupStepMs = input.mode === 'initial' ? input.processCleanupTimeoutMs
      : Math.min(10_000, input.cleanupTimeoutMs + input.processCleanupTimeoutMs);
    return Object.freeze({ harness: 'codex-local-v1' as const, mode: input.mode,
      ...(input.mode === 'initial' && host.mode === 'initial' ? { bindDelivery: host.bindDelivery } : {}),
      async run(runSignal: AbortSignal) {
        if (closePromise || runController || !(runSignal instanceof AbortSignal) || runSignal.aborted) unavailable();
        runController = new AbortController();
        const selectedSignal = AbortSignal.any([runSignal, runController.signal]);
        activeRun = Promise.resolve().then(() => host.run(selectedSignal) as Promise<PrivateCodexRunResultV1>);
        try { return await activeRun; }
        catch {
          try { await close(); } catch { return cleanupUncertain(); }
          return unavailable();
        }
      }, close });
  } catch {
    try { await close(); } catch { return cleanupUncertain(); }
    return unavailable();
  }
}
