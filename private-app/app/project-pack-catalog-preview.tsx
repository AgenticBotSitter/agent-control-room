import { useState } from "react";
import type { ChangeEvent } from "react";
import {
  browseProjectPackV1,
  refusalTextV1,
  PROJECT_PACK_SCHEMA_V1,
  type ProjectPackBrowseOutcomeV1,
  type ProjectPackLocalConfigurationV1,
} from "../../src/project-packs/v1/browse-preview";

/**
 * Presentational preview/refusal panel: a pure function of the browse outcome.
 *
 * Every refusal reason renders visibly and distinctly — a human-readable
 * sentence plus the canonical reason code — never a raw or opaque error.
 * The preview is inert: no project is created, no credential is requested,
 * nothing executes, and nothing contacts a network or catalog service.
 */
export function ProjectPackCatalogPreviewPanel({ outcome }: { outcome: ProjectPackBrowseOutcomeV1 }) {
  if (outcome.status === "refused") {
    return (
      <section className="private-panel" aria-labelledby="pack-refusal-heading">
        <h3 id="pack-refusal-heading">Pack refused</h3>
        <p data-field="pack-refusal-reason" data-reason={outcome.reason} aria-live="polite">
          {refusalTextV1(outcome.reason)}
        </p>
        <p className="private-note">
          Reason code: <code>{outcome.reason}</code>. Nothing was executed and nothing was sent anywhere.
        </p>
      </section>
    );
  }
  const { preview } = outcome;
  return (
    <section className="private-panel" aria-labelledby="pack-preview-heading">
      <h3 id="pack-preview-heading">Pack preview</h3>
      <p data-field="pack-title">{preview.title}</p>
      <p data-field="pack-summary">{preview.summary}</p>
      {preview.setupGuidance.length > 0 ? (
        <>
          <p data-field="pack-guidance-label">Setup guidance:</p>
          <ul>
            {preview.setupGuidance.map((item, index) => (
              <li key={index} data-field="pack-guidance-item">{item}</li>
            ))}
          </ul>
        </>
      ) : null}
      {preview.attribution !== null ? <p data-field="pack-attribution">Attribution: {preview.attribution}</p> : null}
      {preview.license !== null ? <p data-field="pack-license">License: {preview.license}</p> : null}
      <p data-field="pack-supported-modules">
        Supported locally: {preview.supportedModules.length > 0 ? preview.supportedModules.join(", ") : "none"}
      </p>
      <p data-field="pack-unsupported-modules">
        Not supported locally: {preview.unsupportedModules.length > 0 ? preview.unsupportedModules.join(", ") : "none"}
      </p>
      {preview.warnings.map((warning) => (
        <p key={warning} data-field="pack-warning" aria-live="polite">{warning}</p>
      ))}
      <p className="private-note">
        Preview only: no project is created, no permission is granted, and nothing is sent anywhere.
      </p>
    </section>
  );
}

/**
 * Local pack browse-and-preview surface (standalone, unwired).
 *
 * - A paste textarea and a local file input read the pack entirely
 *   client-side (`FileReader`); the flow makes no network request anywhere.
 * - The preview is derived synchronously from the current text with the
 *   canonical, unmodified parser via the browser-safe bridge in
 *   `src/project-packs/v1/browse-preview.ts`.
 * - Every control is a native labelled element: keyboard and text-only
 *   workflows are fully usable, and status text is `aria-live`.
 */
export function ProjectPackCatalogPreview({ localConfiguration }: { localConfiguration: ProjectPackLocalConfigurationV1 }) {
  const [rawText, setRawText] = useState("");
  const outcome = rawText.trim().length === 0 ? null : browseProjectPackV1({ rawText }, localConfiguration);

  const onFileChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setRawText(reader.result);
    };
    reader.readAsText(file);
  };

  return (
    <section className="private-panel" aria-labelledby="pack-browse-heading">
      <h2 id="pack-browse-heading">Project pack preview (local)</h2>
      <p className="private-note">
        Choose a pack file or paste pack text. Everything is read locally in your browser
        ({PROJECT_PACK_SCHEMA_V1} packs only): nothing is uploaded, no network request is made,
        and no project is created.
      </p>
      <label htmlFor="pack-raw-text">Pack text (paste JSON)</label>
      <textarea
        id="pack-raw-text"
        data-field="pack-raw-text"
        value={rawText}
        onChange={event => setRawText(event.target.value)}
        rows={8}
      />
      <label htmlFor="pack-file-input">Pack file (read locally)</label>
      <input
        id="pack-file-input"
        data-field="pack-file-input"
        type="file"
        accept=".json,application/json,text/plain"
        onChange={onFileChosen}
      />
      <div aria-live="polite">
        {outcome === null ? (
          <p data-field="pack-idle">No pack loaded yet.</p>
        ) : (
          <ProjectPackCatalogPreviewPanel outcome={outcome} />
        )}
      </div>
    </section>
  );
}
