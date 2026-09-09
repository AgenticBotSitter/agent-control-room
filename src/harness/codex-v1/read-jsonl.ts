import { createCodexReadRecovery } from './read-recovery';

/** Narrow adaptation of Control Room's existing JSONL correlation pattern.
 * No general request method and no transport/process ownership. Each instance
 * allows one initialized, exact-ID read and must never be reused for a retry.
 */
export function createCodexReadJsonl(binding: { threadId: string; turnId: string }) {
  const recovery = createCodexReadRecovery(binding);
  let state: 'new' | 'initializing' | 'acknowledged' | 'ready' | 'reading' | 'complete' | 'closed' = 'new';
  let notifications = 0;
  const fail = (): never => { state = 'closed'; throw new Error('codex_read_session_unavailable'); };
  const encode = (value: unknown) => `${JSON.stringify(value)}\n`;
  return Object.freeze({
    initialize() {
      if (state !== 'new') fail();
      state = 'initializing';
      return encode({ id: 1, method: 'initialize', params: {
        clientInfo: { name: 'agent_control_room_read_recovery', version: '0.1.0' },
      } });
    },
    initialized() {
      if (state !== 'acknowledged') fail();
      state = 'ready';
      return encode({ method: 'initialized', params: {} });
    },
    read() {
      if (state !== 'ready') fail();
      state = 'reading';
      return encode({ id: 2, ...recovery.request });
    },
    receive(line: string) {
      try {
        if (state !== 'initializing' && state !== 'reading') return fail();
        if (typeof line !== 'string' || !line.length || Buffer.byteLength(line, 'utf8') > 262_144
          || line.includes('\n') || line.includes('\r')) return fail();
        const value = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.hasOwn(value, 'jsonrpc')) return fail();
        if (!Object.hasOwn(value, 'id')) {
          if (typeof value.method !== 'string' || !value.method.length || value.method.length > 256
            || Object.keys(value).some(key => key !== 'method' && key !== 'params')
            || ++notifications > 64) return fail();
          // No notification can supply recovery evidence or invoke a callback.
          return Object.freeze({ kind: 'ignored_notification' as const });
        }
        if (Object.keys(value).some(key => key !== 'id' && key !== 'result')
          || !Object.hasOwn(value, 'result') || !value.result || typeof value.result !== 'object'
          || Array.isArray(value.result) || value.id !== (state === 'initializing' ? 1 : 2)) return fail();
        if (state === 'initializing') {
          state = 'acknowledged';
          return Object.freeze({ kind: 'initialized' as const });
        }
        const observation = recovery.project(JSON.stringify(value.result));
        state = 'complete';
        return Object.freeze({ kind: 'observation' as const, observation });
      } catch { return fail(); }
    },
    disconnect() {
      const hadPendingRead = state === 'reading';
      state = 'closed';
      return Object.freeze({ hadPendingRead, cleanupVerified: false as const });
    },
  });
}
