import { z } from 'zod';
import { CODEX_APP_SERVER_READ_CONTRACT } from './schema-contract';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/);
const bindingSchema = z.object({ threadId: id, turnId: id }).strict();
const responseSchema = z.object({ thread: z.object({ id,
  turns: z.array(z.object({ id, status: z.enum(CODEX_APP_SERVER_READ_CONTRACT.turnStatuses) })).max(1024),
}) });

/** Projection only, for an already authorized exact native identity. No transport,
 * resume, start, subscription, credential discovery or canonical state writes.
 * Caller supplies the correlated result value of the upstream thread/read RPC.
 */
export function createCodexReadRecovery(input: z.infer<typeof bindingSchema>) {
  const binding = Object.freeze(bindingSchema.parse(input));
  const request = Object.freeze({ method: CODEX_APP_SERVER_READ_CONTRACT.method,
    params: Object.freeze({ threadId: binding.threadId, includeTurns: CODEX_APP_SERVER_READ_CONTRACT.includeTurns }) });
  return Object.freeze({ request,
    project(rawResult: string) {
      try {
        if (typeof rawResult !== 'string' || Buffer.byteLength(rawResult, 'utf8') > 262_144) throw new Error();
        const response = responseSchema.parse(JSON.parse(rawResult));
        if (response.thread.id !== binding.threadId
          || new Set(response.thread.turns.map(turn => turn.id)).size !== response.thread.turns.length) throw new Error();
        const turn = response.thread.turns.find(turn => turn.id === binding.turnId);
        return Object.freeze({ ...binding, status: turn?.status ?? 'not_observed',
          source: 'stored_thread_read' as const, usage: 'unknown' as const,
          completionVerified: false as const, cleanupVerified: false as const, grantsExecutionAuthority: false as const });
      } catch { throw new Error('codex_read_recovery_unavailable'); }
    },
  });
}
