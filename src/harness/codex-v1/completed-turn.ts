import { createHash } from 'node:crypto';
import { z } from 'zod';
import { assertNoSecretMaterial } from '../../security/redaction';
import { sha256Digest } from '../../security/canonical-digest';
import { CODEX_APP_SERVER_READ_CONTRACT, CODEX_APP_SERVER_RESULT_CONTRACT } from './schema-contract';

const MAXIMUM_READ_BYTES = 262_144;
const MAXIMUM_RESULT_BYTES = 65_536;
const MAXIMUM_ITEMS = 1_024;
const upstreamId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,179}$/);
const unsignedInteger = z.number().int().nonnegative();
const memoryCitationEntry = z.object({
  path: z.string(), lineStart: unsignedInteger, lineEnd: unsignedInteger, note: z.string(),
}).strict();
const memoryCitation = z.object({ entries: z.array(memoryCitationEntry), threadIds: z.array(z.string()) }).strict();
const agentMessage = z.object({
  type: z.literal('agentMessage'), id: upstreamId, text: z.string(),
  phase: z.enum(CODEX_APP_SERVER_RESULT_CONTRACT.messagePhases).nullable().optional(),
  delivery: z.literal('async').nullable().optional(), memoryCitation: memoryCitation.nullable().optional(),
}).passthrough();
const item = z.object({ type: z.string().min(1).max(80), id: upstreamId.optional() }).passthrough();
const turn = z.object({ id: upstreamId, status: z.enum(CODEX_APP_SERVER_READ_CONTRACT.turnStatuses),
  items: z.array(z.unknown()).max(MAXIMUM_ITEMS),
  itemsView: z.enum(['notLoaded', 'summary', 'full']).optional() }).passthrough();
const response = z.object({ thread: z.object({ id: upstreamId,
  cliVersion: z.literal(CODEX_APP_SERVER_READ_CONTRACT.version),
  turns: z.array(turn).max(1_024) }).passthrough() }).passthrough();

export const CODEX_EXACT_PACKAGE_RESULT_CONTRACT_V1 = Object.freeze({
  schema: 'control-room.codex-exact-package-result-contract/v1' as const,
  basis: 'exact_package_generated_schema' as const,
  agentMessageType: 'agentMessage' as const,
  finalPhases: Object.freeze(['unphased', 'final_answer'] as const),
  ignoredPhase: 'commentary' as const,
  maximumReadBytes: MAXIMUM_READ_BYTES,
  maximumItems: MAXIMUM_ITEMS,
  maximumResultBytes: MAXIMUM_RESULT_BYTES,
  selectedResultItemSchemaQualified: true as const,
  canonicalPublicationAllowed: false as const,
});

function unavailable(): never { throw new Error('codex_completed_turn_projection_unavailable'); }

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (++index >= value.length) return false;
      const low = value.charCodeAt(index);
      if (low < 0xdc00 || low > 0xdfff) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/**
 * Exact-package result projection. The selected agent-message shape is pinned
 * to retained generated-schema evidence. It still cannot publish a canonical
 * result until native restart/read behavior is independently qualified.
 * No I/O occurs here.
 */
export function projectExactPackageCodexCompletedTurnV1(input: {
  threadId: string; turnId: string; rawResult: string;
}) {
  try {
    const binding = z.object({ threadId: upstreamId, turnId: upstreamId }).strict()
      .parse({ threadId: input.threadId, turnId: input.turnId });
    if (typeof input.rawResult !== 'string') return unavailable();
    if (Buffer.byteLength(input.rawResult, 'utf8') > MAXIMUM_READ_BYTES) return unavailable();
    const parsed = response.parse(JSON.parse(input.rawResult));
    if (parsed.thread.id !== binding.threadId
      || new Set(parsed.thread.turns.map(candidate => candidate.id)).size !== parsed.thread.turns.length) return unavailable();
    const matched = parsed.thread.turns.find(candidate => candidate.id === binding.turnId);
    if (!matched || matched.status !== 'completed'
      || matched.itemsView !== undefined && matched.itemsView !== CODEX_APP_SERVER_RESULT_CONTRACT.completeItemsView) return unavailable();
    const ids = new Set<string>();
    let selected: z.infer<typeof agentMessage> | undefined;
    for (const rawItem of matched.items) {
      const described = item.parse(rawItem);
      if (described.id) {
        if (ids.has(described.id)) return unavailable();
        ids.add(described.id);
      }
      if (described.type !== 'agentMessage') continue;
      const message = agentMessage.parse(rawItem);
      if (message.phase === 'commentary') continue;
      if (!wellFormed(message.text) || message.text.trim().length === 0) return unavailable();
      selected = message;
    }
    if (!selected) return unavailable();
    const bytes = Buffer.from(selected.text, 'utf8');
    if (bytes.byteLength < 1 || bytes.byteLength > MAXIMUM_RESULT_BYTES) return unavailable();
    assertNoSecretMaterial(selected.text, 'exact-package Codex result');
    const material = {
      schema: 'control-room.codex-exact-package-completed-turn/v1' as const,
      threadId: binding.threadId, turnId: binding.turnId, itemId: selected.id,
      phase: selected.phase ?? 'unphased', text: selected.text, sizeBytes: bytes.byteLength,
      contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      rawResultDigest: sha256Digest(input.rawResult), matchedTurnDigest: sha256Digest(matched),
      source: 'exact_package_generated_schema' as const, selectedResultItemSchemaQualified: true as const,
      canonicalPublicationAllowed: false as const, completionVerified: false as const,
      grantsExecutionAuthority: false as const, permitsRetry: false as const,
      permitsResume: false as const, permitsThreadRead: false as const,
    };
    return Object.freeze({ ...material, projectionDigest: sha256Digest(material) });
  } catch { return unavailable(); }
}
