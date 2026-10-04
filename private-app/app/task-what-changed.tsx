"use client";
import { useState } from "react";
import type { TaskWorktreeChangeDetail } from "../../src/web/v1/task-result-wire";
import { projectTaskChangeViewV1, type TaskChangeUnifiedLineV1, type TaskFileChangeViewV1 }
  from "../../src/web/v1/task-change-diff";

type DiffMode = "unified" | "split";

function lineClass(kind: TaskChangeUnifiedLineV1["kind"]): string {
  return `private-diff-line is-${kind}`;
}

function UnifiedDiff({ file }: { file: TaskFileChangeViewV1 }) {
  return <div className="private-unified-diff" role="table" aria-label={`Unified diff for ${file.path}`}>
    {file.unifiedLines.map((line, index) => <div className={lineClass(line.kind)} role="row" key={index}>
      <span className="private-diff-number" role="cell" aria-label={line.oldLine === null ? "" : `Old line ${line.oldLine}`}>{line.oldLine ?? ""}</span>
      <span className="private-diff-number" role="cell" aria-label={line.newLine === null ? "" : `New line ${line.newLine}`}>{line.newLine ?? ""}</span>
      <code role="cell">{line.text || " "}</code>
    </div>)}
  </div>;
}

function SplitDiff({ file }: { file: TaskFileChangeViewV1 }) {
  return <div className="private-split-diff" role="table" aria-label={`Side-by-side diff for ${file.path}`}>
    <div className="private-split-heading" role="row"><span role="columnheader">Before</span><span role="columnheader">After</span></div>
    {file.splitRows.map((row, index) => <div className="private-split-row" role="row" key={index}>
      <div className={`private-split-cell${row.oldKind ? ` is-${row.oldKind}` : " is-empty"}`} role="cell">
        <span className="private-diff-number">{row.oldLine ?? ""}</span><code>{row.oldText ?? ""}</code></div>
      <div className={`private-split-cell${row.newKind ? ` is-${row.newKind}` : " is-empty"}`} role="cell">
        <span className="private-diff-number">{row.newLine ?? ""}</span><code>{row.newText ?? ""}</code></div>
    </div>)}
  </div>;
}

function FileChange({ file, initialMode }: { file: TaskFileChangeViewV1; initialMode: DiffMode }) {
  const [mode, setMode] = useState<DiffMode>(initialMode);
  return <li className="private-file-change"><details open={!file.large}>
    <summary><span><code>{file.path}</code><small>{file.kind} · {file.bytes.toLocaleString()} diff bytes</small></span>
      {!!file.sensitiveAreas.length && <span className="private-sensitive-markers" aria-label="Sensitive areas">
        {file.sensitiveAreas.map(area => <strong key={area}>{area}</strong>)}</span>}</summary>
    <p className="private-file-summary">{file.summary}</p>
    {!file.diffRetained ? <p className="private-state-empty">No detailed lines for this file are present in the retained diff.</p> : <>
      <div className="private-diff-modes" role="group" aria-label={`Diff layout for ${file.path}`}>
        <button type="button" aria-pressed={mode === "unified"} onClick={() => setMode("unified")}>Unified</button>
        <button type="button" aria-pressed={mode === "split"} onClick={() => setMode("split")}>Side by side</button>
      </div>
      {mode === "unified" ? <UnifiedDiff file={file} /> : <SplitDiff file={file} />}
      {file.displayTruncated && <p className="private-notice">This on-screen diff reached the display line limit. The complete retained-diff fingerprint remains below.</p>}
    </>}
  </details></li>;
}

export function TaskWhatChanged({ evidence, initialMode = "unified" }: {
  evidence: TaskWorktreeChangeDetail; initialMode?: DiffMode;
}) {
  const view = projectTaskChangeViewV1(evidence);
  return <section className="private-what-changed" aria-labelledby="task-what-changed-heading">
    <h3 id="task-what-changed-heading">What changed</h3>
    <p>{view.files.length} file{view.files.length === 1 ? "" : "s"} in this result’s verified change evidence.</p>
    <p className="private-note">File summaries and line counts come only from the result’s retained diff evidence. They do not infer the agent’s intent.</p>
    {!view.files.length ? <p className="private-state-empty">No changed files were recorded for this result.</p>
      : <ul className="private-file-change-list">{view.files.map(file => <FileChange key={file.path} file={file} initialMode={initialMode} />)}</ul>}
    {evidence.unifiedDiff.truncated && <p className="private-notice">The saved diff is truncated. Files remain listed from the verified inventory, but some detailed lines may be absent. The complete {evidence.unifiedDiff.originalBytes.toLocaleString()}-byte diff is bound by the fingerprint below.</p>}
    {view.displayTruncated && <p className="private-notice">The on-screen diff is limited to {view.displayLineLimit.toLocaleString()} retained lines across all files.</p>}
  </section>;
}
