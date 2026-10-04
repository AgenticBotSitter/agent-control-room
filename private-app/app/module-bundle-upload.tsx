"use client";
import { useRef, useState } from "react";
import { BrowserRequestError } from "../../src/web/v1/browser-client";
import { createModuleTransferBrowserClient, moduleTransferErrorMessage } from "../../src/web/v1/module-transfer-browser-client";

/**
 * Upload a module bundle file: the server verifies it with the existing
 * bundle verifier, this panel shows exactly what it asks for in plain
 * language, and approving records the owner's decision with the existing
 * approval service. This never installs, executes, or migrates anything --
 * approving only produces "Approved, not installed yet."
 *
 * The whole bundle is read client-side (`File.text()`); nothing is staged
 * to a temp file, and the file object is dropped once its text is read.
 */

/** Matches the server's own bundle ceiling (`MAX_BUNDLE_SUBMISSION_BYTES` in module-transfer-http.ts)
 * so an oversized file is refused before ever being read or sent. */
const MAX_UPLOAD_BYTES = 12_000_000;

export type ModuleBundleSubmission = { bundle: unknown; signature?: unknown };

export interface ModulePreview {
  moduleId: string;
  moduleVersion: string;
  moduleClass: "declarative" | "code";
  name: string;
  publisher: string;
  bundleDigest: string;
  source: { kind: string; keyId?: string | null; keyLabel?: string };
  expectedSource: { kind: string; keyId: string | null };
  codeWarning: boolean;
  currentApproval: { approvalId: string } | null;
  permissionDiff: { added: string[]; removed: string[] };
  permissionDiffDigest: string;
}

type Stage =
  | { status: "idle" }
  | { status: "previewing" }
  | { status: "ready"; submission: ModuleBundleSubmission; preview: ModulePreview; ackCode: boolean; approvalKey: string }
  | { status: "approving"; submission: ModuleBundleSubmission; preview: ModulePreview; approvalKey: string }
  | { status: "uncertain"; submission: ModuleBundleSubmission; preview: ModulePreview; approvalKey: string }
  | { status: "approved"; preview: ModulePreview }
  | { status: "outdated" }
  | { status: "error"; error: BrowserRequestError };

/** A plain sentence for the verifier's exact refusal reason, when the server sent one (see
 * `MODULE_SUBMISSION_REFUSAL_PATTERN` in module-transfer-http.ts). Falls back to `moduleTransferErrorMessage`
 * below when there is no reason, or the reason is not one of these families. */
function moduleRefusalSentence(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  if (reason.startsWith("module_signature_")) return "This file was changed after it was signed.";
  if (reason === "module_bundle_code_source_untrusted") return "This module can run code and isn't signed by a key you trust.";
  if (reason.startsWith("module_bundle_") || reason.startsWith("module_manifest_") || reason.startsWith("module_permission_")) {
    return "This file is not a valid module bundle.";
  }
  return undefined;
}

function trustLine(preview: ModulePreview): string {
  if (preview.source.kind === "signed") return `Signed by ${preview.source.keyLabel ?? preview.source.keyId ?? "a trusted key"}.`;
  if (preview.source.kind === "reviewed") return "From a source this installation has separately reviewed and pinned.";
  return "Shared unsigned (declarative only: configuration, templates, and prompts, no executable code).";
}

function isModulePreview(value: unknown): value is ModulePreview {
  if (value === null || typeof value !== "object") return false;
  const preview = value as Record<string, unknown>;
  return typeof preview.moduleId === "string" && typeof preview.moduleVersion === "string"
    && typeof preview.name === "string" && typeof preview.publisher === "string"
    && typeof preview.bundleDigest === "string" && typeof preview.codeWarning === "boolean"
    && typeof preview.permissionDiffDigest === "string" && preview.source !== null && typeof preview.source === "object"
    && preview.expectedSource !== null && typeof preview.expectedSource === "object"
    && preview.permissionDiff !== null && typeof preview.permissionDiff === "object";
}

export function ModuleBundleUploadPanel({ client: suppliedClient }: {
  client?: ReturnType<typeof createModuleTransferBrowserClient>;
}) {
  const [client] = useState(() => suppliedClient ?? createModuleTransferBrowserClient());
  const [stage, setStage] = useState<Stage>({ status: "idle" });

  const approvalBusy = useRef(false);

  async function onFileChosen(file: File) {
    if (file.size > MAX_UPLOAD_BYTES) {
      setStage({ status: "error", error: new BrowserRequestError("invalid_request") });
      return;
    }
    setStage({ status: "previewing" });
    try {
      const text = await file.text();
      const submission = JSON.parse(text) as { bundle: unknown; signature?: unknown };
      const preview = await client.preview(submission);
      if (!isModulePreview(preview)) throw new BrowserRequestError("unavailable");
      setStage({ status: "ready", submission, preview, ackCode: false, approvalKey: crypto.randomUUID() });
    } catch (error) {
      setStage({ status: "error", error: error instanceof BrowserRequestError ? error : new BrowserRequestError("invalid_request") });
    }
  }

  async function approve() {
    if (approvalBusy.current || (stage.status !== "ready" && stage.status !== "uncertain")) return;
    approvalBusy.current = true;
    const { submission, preview, approvalKey } = stage;
    setStage({ status: "approving", submission, preview, approvalKey });
    try {
      const draft = {
        expectedBundleDigest: preview.bundleDigest,
        expectedSource: preview.expectedSource,
        expectedCurrentApprovalId: preview.currentApproval?.approvalId ?? null,
        acknowledgedPermissionDiffDigest: preview.permissionDiffDigest,
        acknowledgedCodeWarning: preview.codeWarning,
      };
      const receipt = await client.approve(submission, draft, approvalKey);
      if (receipt === null || typeof receipt !== "object"
        || typeof (receipt as { current?: unknown }).current !== "boolean") {
        throw new BrowserRequestError("unavailable");
      }
      setStage((receipt as { current: boolean }).current ? { status: "approved", preview } : { status: "outdated" });
    } catch (error) {
      const failure = error instanceof BrowserRequestError ? error : new BrowserRequestError("uncertain");
      setStage(failure.code === "uncertain" || failure.code === "unavailable" ? { status: "uncertain", submission, preview, approvalKey }
        : { status: "error", error: failure });
    } finally { approvalBusy.current = false; }
  }

  const busy = stage.status === "previewing" || stage.status === "approving";
  return (
    <section className="private-panel" aria-labelledby="module-upload-heading">
      <h2 id="module-upload-heading">Upload a module bundle</h2>
      <p className="private-note">
        Choose a module bundle file. Control Room checks it and shows exactly what it asks for before
        anything is approved. This never installs or runs anything.
      </p>
      <label htmlFor="module-bundle-file-input">Module bundle file</label>
      <input id="module-bundle-file-input" data-field="module-bundle-file-input" type="file" accept=".json,application/json"
        disabled={busy || stage.status === "uncertain"}
        onChange={event => { const file = event.target.files?.[0]; if (file) void onFileChosen(file); }} />
      <div aria-live="polite">
        {stage.status === "idle" && <p data-field="module-upload-idle">No bundle chosen yet.</p>}
        {stage.status === "previewing" && <p data-field="module-upload-checking">Checking the bundle…</p>}
        {stage.status === "error" && (
          <p role="alert" data-field="module-upload-error" data-reason={stage.error.code}>
            {moduleRefusalSentence(stage.error.reason) ?? moduleTransferErrorMessage[stage.error.code]}
            {" "}Reason code: <code>{stage.error.reason ?? stage.error.code}</code>
          </p>
        )}
        {stage.status === "uncertain" && <div role="status">
          <p>The approval may have been saved. Retry the original approval to confirm it before choosing another file.</p>
          <button type="button" onClick={() => { void approve(); }}>Retry original approval</button>
        </div>}
        {(stage.status === "ready" || stage.status === "approving") && (
          <ModulePreviewPanel
            preview={stage.preview}
            ackCode={stage.status === "ready" ? stage.ackCode : true}
            onAckChange={stage.status === "ready" ? checked => setStage({ ...stage, ackCode: checked }) : undefined}
            onApprove={stage.status === "ready" ? () => { void approve(); } : undefined}
            approving={stage.status === "approving"}
          />
        )}
        {stage.status === "outdated" && <div role="status" data-field="module-upload-outdated">
          <h3>Approval out of date</h3>
          <p>Your earlier decision was saved but has been superseded. Choose the bundle file again for a fresh preview before approving.</p>
        </div>}
        {stage.status === "approved" && (
          <section aria-labelledby="module-upload-approved-heading">
            <h3 id="module-upload-approved-heading">Approved, not installed yet</h3>
            <p data-field="module-upload-approved">
              You approved <strong>{stage.preview.name}</strong> ({stage.preview.moduleId}@{stage.preview.moduleVersion}).
              Installing it is a separate, later step.
            </p>
          </section>
        )}
      </div>
    </section>
  );
}

export function ModulePreviewPanel({ preview, ackCode, onAckChange, onApprove, approving }: {
  preview: ModulePreview;
  ackCode: boolean;
  onAckChange?: (checked: boolean) => void;
  onApprove?: () => void;
  approving: boolean;
}) {
  const canApprove = onApprove !== undefined && (!preview.codeWarning || ackCode);
  return (
    <section className="private-panel" aria-labelledby="module-preview-heading">
      <h3 id="module-preview-heading">What this bundle asks for</h3>
      <p data-field="module-preview-name">{preview.name}</p>
      <p data-field="module-preview-publisher">Publisher: {preview.publisher}</p>
      <p data-field="module-preview-id">{preview.moduleId}@{preview.moduleVersion} ({preview.moduleClass})</p>
      <p data-field="module-preview-trust">{trustLine(preview)}</p>
      {preview.codeWarning && (
        <p role="alert" data-field="module-preview-code-warning">
          This module can run code. Only approve it if you trust the source above.
        </p>
      )}
      <h4>Permissions</h4>
      {preview.permissionDiff.added.length === 0 && preview.permissionDiff.removed.length === 0 ? (
        <p data-field="module-preview-no-change">No change from the current approval.</p>
      ) : (
        <>
          {preview.permissionDiff.added.length > 0 && (
            <>
              <p data-field="module-preview-added-label">Newly requested:</p>
              <ul>{preview.permissionDiff.added.map(line => <li key={line} data-field="module-preview-added-item">{line}</li>)}</ul>
            </>
          )}
          {preview.permissionDiff.removed.length > 0 && (
            <>
              <p data-field="module-preview-removed-label">No longer requested:</p>
              <ul>{preview.permissionDiff.removed.map(line => <li key={line} data-field="module-preview-removed-item">{line}</li>)}</ul>
            </>
          )}
        </>
      )}
      {preview.codeWarning && onAckChange && (
        <label>
          <input type="checkbox" checked={ackCode} onChange={event => onAckChange(event.target.checked)} />
          {" "}I understand this module can run code.
        </label>
      )}
      {onApprove && (
        <div>
          <button type="button" disabled={!canApprove || approving} onClick={onApprove}>
            {approving ? "Approving…" : "Approve"}
          </button>
        </div>
      )}
      <p className="private-note" data-field="module-preview-digest">Fingerprint: <code>{preview.bundleDigest}</code></p>
    </section>
  );
}
