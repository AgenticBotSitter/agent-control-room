"use client";

import { useMemo, useState } from "react";
import { VoiceControlsSurface } from "./voice-controls";
import { voiceBrowserAdaptersV1 } from "./voice-browser-adapters";

/**
 * Settings-page composition for the optional browser voice boundary.
 *
 * This deliberately owns no project, task, worker, or server state.  A
 * confirmed transcript becomes an unsent, browser-local draft which the owner
 * may copy into an ordinary typed field.  It cannot dispatch work, submit a
 * command, or enable an agent.
 */
export function VoiceControlsWorkspace() {
  const adapters = useMemo(() => voiceBrowserAdaptersV1(), []);
  const [enabled, setEnabled] = useState(false);
  const [draft, setDraft] = useState("");

  return <div>
    <VoiceControlsSurface
      settings={{ enabled }}
      recognition={adapters.recognition}
      synthesis={adapters.synthesis}
      readContent={{ text: "Voice controls are optional. Dictation creates an unsent local draft only." }}
      onSettingsChange={(next) => setEnabled(next.enabled)}
      onTranscriptCommitted={(transcript) => setDraft(previous => previous.length === 0
        ? transcript
        : `${previous}\n${transcript}`)}
    />
    {enabled ? <section className="private-panel" aria-labelledby="voice-draft-heading">
      <h2 id="voice-draft-heading">Voice draft</h2>
      <p className="private-note">This is an unsent local draft. Review, edit, copy, or delete it yourself. It cannot create a project, send a task, or contact an agent.</p>
      <label htmlFor="voice-local-draft">Draft text</label>
      <textarea id="voice-local-draft" value={draft} onChange={event => setDraft(event.target.value)} rows={5} />
      <button type="button" onClick={() => setDraft("")} disabled={draft.length === 0}>Clear local draft</button>
    </section> : null}
  </div>;
}
