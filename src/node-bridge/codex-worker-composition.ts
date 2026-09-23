import { createCodexLocalHostV1, type CodexLocalInitialHostInputV1,
  type CodexLocalRecoverHostInputV1 } from '../harness/codex-v1/local-host';
import { createCodexResultSenderV1 } from '../harness/codex-v1/result-sender';
import { parseCodexTaskActivationV1 } from '../harness/codex-v1/activation-contract';
import { assertSynchronousFence } from '../security/synchronous-fence';
import { sha256Digest } from '../security/canonical-digest';
import { digestSchema } from '../harness/v1/native-run-identifiers';

type ResultConfiguration = Parameters<typeof createCodexResultSenderV1>[0];

/** Installation-owned composition. All journals and process ports are supplied
 * by the existing private Codex configuration; no task chooses a path or port.
 * The session fence belongs to the authenticated node owner and must include
 * current enrollment/revocation checks. Construction performs no I/O. */
export interface CodexWorkerCompositionInputV1 {
  initial: CodexLocalInitialHostInputV1;
  recovery: CodexLocalRecoverHostInputV1;
  result: Omit<ResultConfiguration, 'bridgeEvidence' | 'startEvidence' | 'clock'> & {
    bridgeEvidence: ResultConfiguration['bridgeEvidence'];
  };
  binding: Readonly<{ tenantId: string; nodeId: string; enrollmentDigest: string;
    connectorProfileDigest: string; sessionIdentityDigest: string; activationFrameDigest: string }>;
  assertSessionCurrent(): void;
}

const unavailable = (): never => { throw new Error('codex_worker_composition_unavailable'); };

export function createCodexWorkerCompositionV1(value: CodexWorkerCompositionInputV1) {
  const initial = Object.freeze({ ...value.initial }), recovery = Object.freeze({ ...value.recovery });
  const binding = Object.freeze({ ...value.binding });
  const assertSessionCurrent = value.assertSessionCurrent.bind(value);
  const evidence = initial.bridgeJournal.acceptedCodexActivation.bind(initial.bridgeJournal);
  const resultEvidence = value.result.bridgeEvidence.acceptedCodexActivation.bind(value.result.bridgeEvidence);
  const sendResult = value.result.bridge.sendCodexResultReturn.bind(value.result.bridge);
  if (initial.mode !== 'initial' || recovery.mode !== 'recover' || initial.runId !== recovery.runId
    || initial.startJournal !== recovery.startJournal) unavailable();
  try { digestSchema.parse(binding.enrollmentDigest); digestSchema.parse(binding.connectorProfileDigest);
    digestSchema.parse(binding.sessionIdentityDigest); digestSchema.parse(binding.activationFrameDigest); }
  catch { unavailable(); }
  let startAttempted = false, recoveryAttempted = false, closed = false;
  const fence = () => {
    if (closed) unavailable();
    assertSynchronousFence(assertSessionCurrent, unavailable);
    const saved = evidence(initial.queueId), returned = resultEvidence(initial.queueId);
    if (!saved || !returned || sha256Digest(saved.frame) !== binding.activationFrameDigest
      || sha256Digest(returned.frame) !== binding.activationFrameDigest) unavailable();
    const activation = parseCodexTaskActivationV1((saved ?? unavailable()).frame.body);
    if (activation.tenantId !== binding.tenantId || activation.nodeId !== binding.nodeId
      || activation.enrollmentDigest !== binding.enrollmentDigest
      || activation.connectorProfileDigest !== binding.connectorProfileDigest
      || activation.queueId !== initial.queueId || activation.runId !== initial.runId) unavailable();
    assertSynchronousFence(() => initial.authority.assertCurrent(initial.queueId), unavailable);
    if (initial.authority.currentAdmissionDigest(initial.queueId) !== activation.currentAdmissionDigest) unavailable();
  };
  const start = createCodexLocalHostV1({ ...initial,
    authority: { currentAdmissionDigest: initial.authority.currentAdmissionDigest.bind(initial.authority),
      assertCurrent() { fence(); } },
    acquireProcess: (request, signal) => { fence(); return initial.acquireProcess(request, signal); },
  });
  const recover = createCodexLocalHostV1({ ...recovery,
    authority: { assertCurrent(identity: Parameters<CodexLocalRecoverHostInputV1['authority']['assertCurrent']>[0]) {
      fence(); return recovery.authority.assertCurrent(identity);
    } },
    acquireProcess: (request, signal) => { fence(); return recovery.acquireProcess(request, signal); },
  });
  const sender = createCodexResultSenderV1({ ...value.result,
    startEvidence: initial.startJournal, clock: initial.clock,
    bridge: { async sendCodexResultReturn(...args) {
      fence(); return sendResult(...args);
    } },
  });
  return Object.freeze({
    startsWork: false as const,
    async start(signal: AbortSignal) {
      if (startAttempted || signal.aborted) unavailable();
      startAttempted = true;
      fence();
      return start.run(signal);
    },
    async recoverAndReturn(signal: AbortSignal) {
      if (recoveryAttempted || signal.aborted) unavailable();
      recoveryAttempted = true;
      fence();
      const observed = await recover.run(signal);
      fence();
      if (observed.status !== 'completed' || !observed.exactPackageResult) {
        return Object.freeze({ disposition: 'observed' as const, status: observed.status });
      }
      const receipt = await sender.sendRecovered({ runId: initial.runId, queueId: initial.queueId,
        connectionAttemptId: recovery.connectionAttemptId,
        initializedConnectionDigest: recovery.initializedConnectionDigest,
        observedAt: new Date(initial.clock()).toISOString(), status: 'completed',
        identity: observed.identity, exactPackageResult: observed.exactPackageResult,
      }, signal);
      return Object.freeze({ disposition: 'receipted' as const, receipt });
    },
    async close() { closed = true; await start.close(); await recover.close(); },
  });
}
