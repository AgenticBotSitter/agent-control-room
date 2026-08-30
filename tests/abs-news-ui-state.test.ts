import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAbsNewsSyntheticWorkspaceV1,
  createAbsNewsWorkspaceUiStateV1,
  effectiveAbsNewsQueueV1,
  reduceAbsNewsWorkspaceUiV1,
  visibleAbsNewsStoriesV1,
} from "../src/project-adapters/abs-news/v1/index.ts";

test("CR9D-ABS-030 filters, sorts, archives, restores, and preserves source story truth", () => {
  const fixture = buildAbsNewsSyntheticWorkspaceV1(), target = fixture.stories[0]!;
  let state = createAbsNewsWorkspaceUiStateV1();
  assert.equal(visibleAbsNewsStoriesV1(fixture, state).length, 2);
  state = reduceAbsNewsWorkspaceUiV1(fixture, state, { type: "archive_story", storyId: target.storyId });
  assert.equal(effectiveAbsNewsQueueV1(state, target), "archive");
  assert.equal(target.queue, "important_now");
  assert.match(state.notice ?? "", /evidence and history were retained/i);
  state = reduceAbsNewsWorkspaceUiV1(fixture, state, { type: "set_queue_filter", queueFilter: "archive" });
  assert.deepEqual(visibleAbsNewsStoriesV1(fixture, state).map((story) => story.storyId), [target.storyId]);
  state = reduceAbsNewsWorkspaceUiV1(fixture, state, { type: "restore_story", storyId: target.storyId, queue: "earlier" });
  assert.equal(effectiveAbsNewsQueueV1(state, target), "earlier");
});

test("CR9D-ABS-030 prepares all eight local proposal actions without creating or dispatching work", () => {
  const fixture = buildAbsNewsSyntheticWorkspaceV1(), target = fixture.stories.find((story) => story.verificationState === "verified")!;
  let state = createAbsNewsWorkspaceUiStateV1();
  for (const action of fixture.actionCatalog) {
    state = reduceAbsNewsWorkspaceUiV1(fixture, state, { type: "open_proposal", storyId: target.storyId, actionId: action.actionId });
    assert.equal(state.editor?.actionId, action.actionId);
    state = reduceAbsNewsWorkspaceUiV1(fixture, state, { type: "save_local_draft" });
  }
  assert.equal(state.drafts.length, 8);
  for (const draft of state.drafts) assert.deepEqual({ status: draft.status, review: draft.requiresOwnerReview, work: draft.createsWorkItem, dispatch: draft.dispatchState, approval: draft.grantsApproval, network: draft.grantsNetworkAuthority, command: draft.grantsCommandAuthority, execution: draft.grantsExecutionAuthority }, { status: "local_preview", review: true, work: false, dispatch: "not_requested", approval: false, network: false, command: false, execution: false });
});

test("CR9D-ABS-030 refuses proposal editing for a review-only story", () => {
  const fixture = buildAbsNewsSyntheticWorkspaceV1(), target = fixture.stories.find((story) => story.verificationState === "review_only")!;
  const state = reduceAbsNewsWorkspaceUiV1(fixture, createAbsNewsWorkspaceUiStateV1(), { type: "open_proposal", storyId: target.storyId, actionId: "research_brief" });
  assert.equal(state.editor, undefined);
  assert.match(state.notice ?? "", /verification is required/i);
});
