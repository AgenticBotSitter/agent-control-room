import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readWorkerInbox, renderWorkerInbox } from './public-worker-inbox.mjs';

// Foreground, read-only watcher. The supervisor owns restart and termination.
// No agent invocation, executable content, token storage, or GitHub writes.
export function createInboxPoller({ read = readWorkerInbox, emit = console.log, workerId, repository, token }) {
  let previous;
  return async () => {
    let result;
    try { result = { ok: true, actions: await read({ workerId, repository, token }) }; }
    catch { result = { ok: false, message: 'GitHub inbox unavailable. Existing assignments remain unresolved; retry on the next poll.' }; }
    const digest = createHash('sha256').update(JSON.stringify(result)).digest('hex');
    if (digest !== previous) {
      emit(result.ok ? renderWorkerInbox(workerId, result.actions) : result.message);
      previous = digest;
      return true;
    }
    return false;
  };
}

async function main() {
  const [workerId, repository = 'AgenticBotSitter/agent-control-room', seconds = '300'] = process.argv.slice(2);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/.test(workerId ?? '')
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || !/^\d+$/.test(seconds) || Number(seconds) < 60 || Number(seconds) > 3600) throw new Error('watch_arguments_invalid');
  const poll = createInboxPoller({ workerId, repository, token: process.env.GITHUB_TOKEN });
  let stopping = false;
  let timer;
  let wake;
  const stop = () => { stopping = true; clearTimeout(timer); wake?.(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  while (!stopping) {
    await poll();
    if (!stopping) await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, Number(seconds) * 1000); });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
