/** Optional voice input + read-aloud — types and adapter boundaries (v1). */

export const VOICE_CONTRACT_V1 = "voice/v1" as const;

export type VoiceCapabilityV1 = "supported" | "unsupported";

export type VoiceInputStateV1 =
  | "idle"
  | "listening"
  | "confirming"
  | "denied"
  | "unsupported"
  | "cancelled"
  | "error";

export type VoiceReadStateV1 = "idle" | "speaking" | "stopped" | "denied" | "unsupported" | "refused";

export interface VoiceSettingsV1 {
  /** Module master switch. Always defaults to false; voice never activates itself. */
  enabled: boolean;
}

export interface VoiceTranscriptEventV1 {
  /** Adapter-provided event id used for duplicate suppression. */
  eventId: string;
  transcript: string;
  isFinal: boolean;
}

export type VoiceRecognitionErrorV1 =
  | "denied"
  | "unsupported"
  | "cancelled"
  | "error";

/**
 * Dependency-injected speech-recognition adapter. The production implementation
 * wraps the browser SpeechRecognition API; tests inject fakes. The module never
 * touches microphones, permissions or the network directly — only this adapter.
 */
export interface VoiceRecognitionAdapterV1 {
  isSupported(): boolean;
  start(callbacks: {
    onEvent: (event: VoiceTranscriptEventV1) => void;
    onError: (kind: VoiceRecognitionErrorV1, message: string) => void;
  }): void;
  stop(): void;
}

/**
 * Dependency-injected speech-synthesis adapter. The production implementation
 * wraps speechSynthesis; tests inject fakes.
 */
export interface VoiceSynthesisAdapterV1 {
  isSupported(): boolean;
  speak(text: string): void;
  cancel(): void;
}

export interface ReadAloudContentV1 {
  text: string;
  /** True when the source field is a secret (password, token, key). Never read. */
  isSecret?: boolean;
  /** True when the source node is hidden from sighted users. Never read. */
  isHidden?: boolean;
}
