"use client";
import type { EffectiveProjectPresentation } from "../../src/web/v1/project-wire";

/**
 * Surface the current template selection and explain any unavailable modules.
 * Presentation is never authorization: this component only renders text and
 * does not hide anything the server would otherwise show.
 */
export function ProjectModuleAvailability({ presentation }: { presentation?: EffectiveProjectPresentation }) {
  if (!presentation) return null;
  if (presentation.source === "legacy_global") {
    return <section className="private-panel" aria-label="Template">
      <h2>Template</h2>
      <p className="private-note">This project was created before templates were available; it uses the current global module selection.</p>
    </section>;
  }
  const unavailable = presentation.enabledModules.filter((module) => !presentation.availableModules.includes(module));
  const removed = presentation.templateRemoved;
  return <section className="private-panel" aria-label="Template">
    <h2>Template</h2>
    <p>Saved template: <strong>{presentation.templateDisplayName}</strong></p>
    <p>Modules saved with this project: {presentation.enabledModules.length === 0
      ? <em>None (core pages only)</em>
      : presentation.enabledModules.join(", ")}</p>
    {removed && <p role="status">This template is no longer in the operator configuration. Core project pages remain available; saved template modules appear unavailable until the operator restores the template.</p>}
    {!removed && unavailable.length > 0 && <p role="status">The operator has disabled {unavailable.join(", ")} globally. This project keeps its saved selection, but those modules are not currently active.</p>}
  </section>;
}
