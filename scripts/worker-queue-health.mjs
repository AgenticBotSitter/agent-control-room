import { pathToFileURL } from 'node:url';
import { readWorkerInbox } from './public-worker-inbox.mjs';

export function queueHealth(actions, { now = Date.now(), staleMinutes = 60 } = {}) {
  const alerts = [];
  for (const item of actions) {
    const age = (now - Date.parse(item.requestedAt)) / 60000;
    const reason = item.disposition === 'attention' ? 'Record needs reconciliation.'
      : item.disposition === 'stop' && !item.acknowledged ? 'Stop needs worker acknowledgment; retain ownership.'
        : age >= staleMinutes && item.markerState === 'changes-required' && item.acknowledged !== true ? 'Correction has no recorded acknowledgment.'
          : age >= staleMinutes && item.disposition === 'waiting' ? 'Submission is waiting for review or integration.' : undefined;
    if (reason) alerts.push({ issue: item.issue, workerId: item.workerId, reason, url: item.instructionUrl ?? item.issueUrl });
  }
  return alerts;
}

async function main() {
  const workerIds = process.argv.slice(2);
  if (!workerIds.length || workerIds.some(id => !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/.test(id))) throw new Error('health_worker_ids_required');
  // Share each read-only GitHub response across worker views in this single report.
  const cache = new Map();
  const fetchImpl = (url, options) => {
    if (!cache.has(url)) cache.set(url, fetch(url, options));
    return cache.get(url).then(response => response.clone());
  };
  const results = await Promise.all(workerIds.map(workerId => readWorkerInbox({ workerId, fetchImpl, token: process.env.GITHUB_TOKEN })));
  console.log(JSON.stringify({ alerts: queueHealth(results.flat()), workersChecked: workerIds.length,
    note: 'Read-only report. Legacy acknowledgments are not machine-verifiable. No worker was awakened or reassigned.' }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { console.error('Queue health unavailable; do not interpret this as no waiting work.'); process.exitCode = 1; });
