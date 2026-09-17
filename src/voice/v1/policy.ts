/** Optional voice input + read-aloud — policy (v1). */
import type {
  ReadAloudContentV1,
  VoiceSettingsV1,
  VoiceTranscriptEventV1,
} from "./types";

export const DEFAULT_VOICE_SETTINGS_V1: VoiceSettingsV1 = { enabled: false };

/**
 * Read-aloud gate. Returns true only for visible, non-secret content.
 * Secrets and hidden content are always refused — never read, never logged.
 */
export function canReadAloudV1(content: ReadAloudContentV1): boolean {
  if (content.isSecret === true) return false;
  if (content.isHidden === true) return false;
  return content.text.trim().length > 0;
}

/**
 * Drop duplicate transcript events by eventId, keeping first occurrence order.
 * Duplicate delivery is a normal adapter behaviour, not an error.
 */
export function dedupeTranscriptEventsV1(events: VoiceTranscriptEventV1[]): VoiceTranscriptEventV1[] {
  const seen = new Set<string>();
  const out: VoiceTranscriptEventV1[] = [];
  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    out.push(event);
  }
  return out;
}

/**
 * Unmount cleanup: stop recognition and cancel synthesis. Safe to call with
 * adapters that already stopped — both calls are idempotent by contract.
 */
export function cleanupVoiceV1(deps: {
  stopRecognition: () => void;
  cancelSynthesis: () => void;
}): void {
  deps.stopRecognition();
  deps.cancelSynthesis();
}
