import type { JSX } from "react";
import type { CompletionGatePreviewV1, CompletionGateViewModelV1 } from "@/src/completion-gate/v1/view-model";

function label(value: string): string { return value.replace(/[._:-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function shortDigest(value: string): string { return `${value.slice(0, 19)}…`; }

function PreviewSummary({ preview }: { preview: CompletionGatePreviewV1 }): JSX.Element {
  const details = preview.kind === "media"
    ? `${preview.mimeType} · ${preview.byteSize.toLocaleString()} bytes${preview.durationSeconds === undefined ? "" : ` · ${preview.durationSeconds}s`}`
    : preview.kind === "diff"
      ? `${preview.changedFileCount} files · +${preview.additions} / −${preview.deletions} lines`
      : `${preview.sectionCount} report sections`;
  return <li className="completion-preview">
    <div><span>{label(preview.kind)} preview</span><small>{label(preview.availability)}</small></div>
    <h4>{preview.title}</h4><p>{details}</p>
    <small>Digest only · {shortDigest(preview.contentDigest)} · Raw content stays protected</small>
  </li>;
}

/** Read-only completion evidence. It contains no action control or artifact reader. */
export function CompletionGatePanel({ items, additionalTargetsOmitted = false }: {
  items: readonly CompletionGateViewModelV1[]; additionalTargetsOmitted?: boolean;
}): JSX.Element {
  return <section className="completion-gate" aria-label="Completion Gate review evidence">
    <p className="completion-gate-boundary">This panel shows review evidence only. It cannot approve, dispatch, execute, read protected artifacts, or expose a raw locator.</p>
    {additionalTargetsOmitted && <p role="status">More review targets exist than this view can show. This is not the complete history.</p>}
    {items.length === 0 ? <p className="empty-state">No Completion Gate targets are visible in this scope.</p> : <ol className="completion-gate-list">
      {items.map((item) => <li key={item.target.id} className={`completion-gate-item status-${item.status}`}>
        <header className="completion-gate-header">
          <div><p>{label(item.target.kind)} · Revision {item.target.revisionNumber}</p><h3>{item.target.subjectLabel}</h3><small>{item.target.projectId} · {shortDigest(item.target.targetDigest)}</small></div>
          <div className="completion-status"><b>{item.statusLabel}</b><span>{item.statusDetail}</span></div>
        </header>
        {item.coverage?.additionalEvidenceOmitted && <p role="status">Some review evidence is omitted from this view. The quality status comes from the full stored record.</p>}

        <div className="completion-gate-grid">
          <section><h4>Review evidence</h4>
            {item.reviews.length === 0 ? <p className="completion-empty">{item.coverage?.additionalEvidenceOmitted ? "No reviews are included in this partial view." : "No review evidence recorded."}</p> : <ol className="completion-facts">
              {item.reviews.map((review) => <li key={review.id}><b>{label(review.decision)}</b><span>{review.authority === "advisory" ? "Advisory comment" : "Completion review"} · {review.reviewerLabel} · {label(review.effectiveRisk)}</span><small>{review.evidenceDigests.length} evidence digest{review.evidenceDigests.length === 1 ? "" : "s"} · {review.reviewedAt}</small></li>)}
            </ol>}
          </section>
          <section><h4>Verification</h4>
            {item.verifications.length === 0 ? <p className="completion-empty">{item.coverage?.additionalEvidenceOmitted ? "No verifications are included in this partial view." : "No verification evidence recorded."}</p> : <ol className="completion-facts">
              {item.verifications.map((verification) => <li key={verification.id}><b>{label(verification.outcome)}</b><span>{verification.scenarioId} · {verification.verifierLabel}</span><small>{verification.evidenceDigests.length} evidence digest{verification.evidenceDigests.length === 1 ? "" : "s"} · {verification.verifiedAt}</small></li>)}
            </ol>}
            {item.missingVerificationScenarioIds.length > 0 && <p className="completion-lineage" role="status">Still needed: {item.missingVerificationScenarioIds.map(label).join(", ")}</p>}
          </section>
        </div>

        <div className="completion-gate-grid">
          <section><h4>Findings and lineage</h4>
            {item.findings.length === 0 ? <p className="completion-empty">No finding details are shown for this target.</p> : <ol className="completion-facts">
              {item.findings.map((finding) => <li key={finding.id}><b>{label(finding.severity)} · {finding.code}</b><span>{finding.statement}</span><small>{finding.evidenceDigests.length} evidence digest{finding.evidenceDigests.length === 1 ? "" : "s"} · {finding.raisedAt}</small></li>)}
            </ol>}
            {item.target.supersedesTargetId && <p className="completion-lineage">This revision supersedes an earlier immutable target. It does not overwrite it.</p>}
            {item.openFindingIds.length > 0 && <p className="completion-lineage">{item.coverage?.additionalEvidenceOmitted ? "At least " : ""}{item.openFindingIds.length} open finding{item.openFindingIds.length === 1 ? "" : "s"} require explicit resolution in a bounded revision.</p>}
            {item.coverage?.preferencesLoaded === false && <p className="completion-empty">Review preferences are not loaded by this source.</p>}
            {item.preferences.length > 0 && <ol className="completion-facts completion-preferences" aria-label="Recorded review preferences">
              {item.preferences.map((preference) => <li key={preference.id}><b>Preference {label(preference.state)}</b><span>{preference.subjectLabel}</span><small>Recorded {preference.selectedAt}</small></li>)}
            </ol>}
          </section>
          <section><h4>Separate operation approval</h4><p className="completion-approval-state" role="status">{item.approval.label}</p><p className="completion-approval-detail">{item.approval.detail}</p>
            {item.approval.expiresAt && <small>Record expiry: {item.approval.expiresAt}</small>}
            <p className="completion-authority">Quality state: no approval authority · no execution authority · separate node attestation required.</p>
          </section>
        </div>

        <section className="completion-previews"><h4>Safe previews</h4>
          {item.previews.length === 0 ? <p className="completion-empty">{item.coverage?.previewsLoaded === false ? "Preview metadata is not loaded by this source." : "No digest-addressed preview metadata is available."}</p> : <ol>{item.previews.map((preview) => <PreviewSummary key={preview.previewId} preview={preview} />)}</ol>}
        </section>
      </li>)}
    </ol>}
  </section>;
}
