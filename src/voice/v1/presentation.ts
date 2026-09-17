/** Optional voice input + read-aloud — owner-visible wording (v1). */
import type { VoiceInputStateV1, VoiceReadStateV1 } from "./types";

/**
 * Every voice state has a labelled text form. No decision depends on colour,
 * icon or pointer interaction: the status paragraph repeats the state in words
 * and every action is a labelled native button reachable by keyboard.
 */
export function voiceInputStateTextV1(state: VoiceInputStateV1): string {
  switch (state) {
    case "idle": return "Voice input is off. Nothing is listening.";
    case "listening": return "Listening. Press Stop or Cancel, then confirm before any text is used.";
    case "confirming": return "Heard something. Review the words below, then Confirm to use them or Cancel to discard.";
    case "denied": return "Microphone permission was denied. Voice input stays off; type instead.";
    case "unsupported": return "Voice input is not supported in this browser. Type instead.";
    case "cancelled": return "Voice input was cancelled. Nothing was used; type instead.";
    case "error": return "Voice input hit an error and stopped. Nothing was used; type instead.";
  }
}

export function voiceReadStateTextV1(state: VoiceReadStateV1): string {
  switch (state) {
    case "idle": return "Read-aloud is idle.";
    case "speaking": return "Reading aloud. Press Stop to stop immediately.";
    case "stopped": return "Read-aloud stopped.";
    case "denied": return "Read-aloud permission was denied. Nothing was read.";
    case "unsupported": return "Read-aloud is not supported in this browser.";
    case "refused": return "Refused to read: secrets and hidden content are never read aloud.";
  }
}
