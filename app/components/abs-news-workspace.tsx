"use client";

import { useReducer, type FormEvent } from "react";
import {
  createAbsNewsWorkspaceUiStateV1,
  effectiveAbsNewsQueueV1,
  reduceAbsNewsWorkspaceUiV1,
  visibleAbsNewsStoriesV1,
  type AbsNewsWorkspaceUiActionV1,
  type AbsNewsWorkspaceUiStateV1,
} from "@/src/project-adapters/abs-news/v1/ui-state";
import type { AbsNewsPlatformV1, AbsNewsSyntheticWorkspaceV1 } from "@/src/project-adapters/abs-news/v1/types";

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function AbsNewsWorkspace({ fixture }: { fixture: AbsNewsSyntheticWorkspaceV1 }) {
  const [state, dispatch] = useReducer(
    (current: AbsNewsWorkspaceUiStateV1, action: AbsNewsWorkspaceUiActionV1) => reduceAbsNewsWorkspaceUiV1(fixture, current, action),
    undefined,
    createAbsNewsWorkspaceUiStateV1,
  );
  const stories = visibleAbsNewsStoriesV1(fixture, state);
  const importantCount = fixture.stories.filter((story) => effectiveAbsNewsQueueV1(state, story) === "important_now").length;
  const selected = fixture.stories.find((story) => story.storyId === state.selectedStoryId);
  const editorAction = state.editor ? fixture.actionCatalog.find((action) => action.actionId === state.editor!.actionId) : undefined;

  function saveDraft(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    dispatch({ type: "save_local_draft" });
  }

  return (
    <section className="abs-workspace section-block" aria-label="Synthetic ABS AI and Tech News project workspace">
      <nav className="project-workspace-nav" aria-label="Project workspace navigation">
        {fixture.workspace.sections.map((section, index) => (
          <button key={section.sectionId} type="button" className={index === 0 ? "current" : "planned"} aria-current={index === 0 ? "page" : undefined}>
            {section.label}{section.itemCount !== undefined ? <small>{section.label === "Research Queue" ? state.drafts.length : section.itemCount}</small> : null}
          </button>
        ))}
      </nav>

      <div className="abs-workspace-banner">
        <div><p className="eyebrow">Daily brief · Local synthetic workspace</p><h2>What matters in AI and tech today</h2><p>Verified discoveries can prepare bounded agent work-order drafts. Nothing on this screen dispatches, fetches, installs, publishes, or authorizes an effect.</p></div>
        <dl>
          <div><dt>Important now</dt><dd>{importantCount}</dd></div>
          <div><dt>Needs verification</dt><dd>{fixture.workspace.waitingReviewCount}</dd></div>
          <div><dt>Draft jobs</dt><dd>{state.drafts.length}</dd></div>
        </dl>
      </div>

      <div className="abs-source-strip" aria-label="ABS synthetic source status">
        {fixture.workspace.sourceStatuses.map((source) => (
          <article key={source.sourceId} className={`source-${source.state}`}>
            <span>{source.label}</span><strong>{label(source.state)}</strong><small>{source.mode === "synthetic" ? "Injected fixture only" : label(source.safeStatusCode)}</small>
          </article>
        ))}
      </div>

      <div className="abs-queue-heading">
        <div><p className="eyebrow">AI and Tech News</p><h2>{state.queueFilter === "all" ? "All saved stories" : label(state.queueFilter)}</h2></div>
        <div className="abs-queue-tools" aria-label="News queue filters">
          {(["important_now", "earlier", "archive", "all"] as const).map((queueFilter) => (
            <button type="button" key={queueFilter} className={state.queueFilter === queueFilter ? "active" : ""} aria-pressed={state.queueFilter === queueFilter} onClick={() => dispatch({ type: "set_queue_filter", queueFilter })}>{label(queueFilter)}</button>
          ))}
          <button type="button" className={state.sort === "priority" ? "active" : ""} aria-pressed={state.sort === "priority"} onClick={() => dispatch({ type: "set_sort", sort: state.sort === "priority" ? "newest" : "priority" })}>Sort: {label(state.sort)}</button>
        </div>
      </div>

      {state.notice ? <p className="abs-workspace-notice" role="status">{state.notice}</p> : null}

      <div className="abs-story-grid">
        {stories.map((story) => {
          const queue = effectiveAbsNewsQueueV1(state, story);
          return (
            <article className={`abs-story-card state-${story.verificationState}`} key={story.storyId}>
              <header><span>{story.sourceLabel}</span><b>Priority {story.priorityScore}</b></header>
              <p className="abs-story-state">{story.verificationState === "verified" ? "Direct evidence verified" : "Review only · cannot create work"}</p>
              <h3>{story.title}</h3>
              <p>{story.summary}</p>
              <dl><div><dt>Coverage</dt><dd>{story.coverageCount} source{story.coverageCount === 1 ? "" : "s"}</dd></div><div><dt>Queue</dt><dd>{label(queue)}</dd></div><div><dt>Evidence</dt><dd>{story.sourceEvidence.length} retained</dd></div></dl>
              <div className="abs-story-controls">
                <button type="button" onClick={() => dispatch({ type: "select_story", storyId: story.storyId })}>View evidence</button>
                {queue === "archive"
                  ? <button type="button" onClick={() => dispatch({ type: "restore_story", storyId: story.storyId, queue: "earlier" })}>Restore</button>
                  : <button type="button" onClick={() => dispatch({ type: "archive_story", storyId: story.storyId })}>Archive locally</button>}
              </div>
              <footer>
                {story.verificationState === "verified" ? fixture.actionCatalog.map((action) => (
                  <button key={action.actionId} type="button" onClick={() => dispatch({ type: "open_proposal", storyId: story.storyId, actionId: action.actionId })}>{action.label}</button>
                )) : <span>Verify the canonical page before preparing an agent job.</span>}
              </footer>
            </article>
          );
        })}
      </div>
      {stories.length === 0 ? <p className="empty-state">No stories are in this local queue.</p> : null}

      <div className="abs-workbench">
        <section className="abs-story-detail" aria-label="Selected story evidence">
          <p className="eyebrow">Story detail</p>
          {selected ? <><h2>{selected.title}</h2><p>{selected.summary}</p><dl><div><dt>Canonical source</dt><dd>{selected.canonicalHost}</dd></div><div><dt>Verification</dt><dd>{label(selected.verificationState)}</dd></div><div><dt>Evidence digest count</dt><dd>{selected.sourceEvidence.length}</dd></div></dl><ul>{selected.sourceEvidence.map((item) => <li key={item.evidenceId}>{item.sourceLabel} · {label(item.sourceKind)} · retained {new Date(item.observedAt).toLocaleDateString("en-US", { timeZone: "UTC" })}</li>)}</ul></> : <p>Select “View evidence” on a story. Raw newsletter bodies and credentials are never shown.</p>}
        </section>

        <section className="abs-proposal-editor" aria-label="Draft work-order proposal editor">
          <p className="eyebrow">Research queue · Proposal editor</p>
          {state.editor && editorAction ? (
            <form onSubmit={saveDraft}>
              <h2>{editorAction.label}</h2>
              <p>This prepares a local draft for owner review. It does not create work or contact an agent.</p>
              <label>Requested title<input value={state.editor.requestedTitle} maxLength={240} required onChange={(event) => dispatch({ type: "edit_proposal", field: "requestedTitle", value: event.target.value })} /></label>
              <label>Goal<textarea value={state.editor.goal} maxLength={1200} required rows={5} onChange={(event) => dispatch({ type: "edit_proposal", field: "goal", value: event.target.value })} /></label>
              <label>Platform<select value={state.editor.requestedPlatform} onChange={(event) => dispatch({ type: "edit_proposal", field: "requestedPlatform", value: event.target.value as AbsNewsPlatformV1 })}>{editorAction.allowedPlatforms.map((platform) => <option key={platform} value={platform}>{label(platform)}</option>)}</select></label>
              <dl><div><dt>Route</dt><dd>{editorAction.routeProfileId}</dd></div><div><dt>Reasoning</dt><dd>{label(editorAction.reasoningProfile)} · {editorAction.effortHint}</dd></div><div><dt>Risk</dt><dd>{label(editorAction.risk)}</dd></div></dl>
              <div className="abs-editor-actions"><button type="submit">Save local draft</button><button type="button" onClick={() => dispatch({ type: "close_proposal" })}>Cancel</button></div>
            </form>
          ) : <><h2>Choose an article action</h2><p>The editor will bind the exact story, evidence, deliverable, platform, route, risk, and reasoning profile. The durable server boundary revalidates the draft before it can enter later review.</p></>}
        </section>
      </div>

      {state.drafts.length > 0 ? <section className="abs-local-drafts" aria-label="Local draft proposals"><h2>Local draft proposals</h2>{state.drafts.map((draft) => <article key={draft.localDraftId}><strong>{draft.requestedTitle}</strong><span>{label(draft.actionId)} · {label(draft.requestedPlatform)}</span><small>Owner review required · No work item · Not dispatched</small></article>)}</section> : null}
      <p className="abs-workspace-note">Queue changes and editor drafts in this screen are local previews. The authenticated SQLite store and proposal contract preserve restart, replay, scope, evidence, and append-only history without granting dispatch or publication authority.</p>
    </section>
  );
}
