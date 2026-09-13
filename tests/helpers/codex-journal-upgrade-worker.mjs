import { parentPort, workerData } from 'node:worker_threads';
import { SqliteCodexStartJournalV1 } from '../../src/harness/codex-v1/start-journal.ts';

if (!parentPort || !workerData || !(workerData.gate instanceof SharedArrayBuffer)
  || typeof workerData.path !== 'string' || !Array.isArray(workerData.runIds)) {
  throw new Error('upgrade_worker_input_invalid');
}

parentPort.postMessage('ready');
const gate = new Int32Array(workerData.gate);
Atomics.wait(gate, 0, 0);
const journal = new SqliteCodexStartJournalV1(workerData.path);
try {
  parentPort.postMessage({ status: 'migrated', loads: workerData.runIds.map(runId => journal.load(runId).status) });
} finally {
  journal.close();
}
