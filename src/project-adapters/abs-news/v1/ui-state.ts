import type { AbsNewsActionIdV1, AbsNewsPlatformV1, AbsNewsQueueV1, AbsNewsStoryV1, AbsNewsSyntheticWorkspaceV1 } from "./types";

export type AbsNewsQueueFilterV1 = "all" | AbsNewsQueueV1;
export type AbsNewsSortV1 = "priority" | "newest";

export interface AbsNewsDraftEditorV1 {
  storyId: string;
  actionId: AbsNewsActionIdV1;
  requestedTitle: string;
  goal: string;
  requestedPlatform: AbsNewsPlatformV1;
}

export interface AbsNewsLocalDraftPreviewV1 extends AbsNewsDraftEditorV1 {
  localDraftId: string;
  status: "local_preview";
  requiresOwnerReview: true;
  createsWorkItem: false;
  dispatchState: "not_requested";
  grantsApproval: false;
  grantsNetworkAuthority: false;
  grantsCommandAuthority: false;
  grantsExecutionAuthority: false;
}

export interface AbsNewsWorkspaceUiStateV1 {
  queueFilter: AbsNewsQueueFilterV1;
  sort: AbsNewsSortV1;
  selectedStoryId?: string;
  queueOverrides: Record<string, AbsNewsQueueV1>;
  editor?: AbsNewsDraftEditorV1;
  drafts: AbsNewsLocalDraftPreviewV1[];
  notice?: string;
}

export type AbsNewsWorkspaceUiActionV1 =
  | { type: "set_queue_filter"; queueFilter: AbsNewsQueueFilterV1 }
  | { type: "set_sort"; sort: AbsNewsSortV1 }
  | { type: "select_story"; storyId: string }
  | { type: "archive_story"; storyId: string }
  | { type: "restore_story"; storyId: string; queue: Exclude<AbsNewsQueueV1, "archive"> }
  | { type: "open_proposal"; storyId: string; actionId: AbsNewsActionIdV1 }
  | { type: "edit_proposal"; field: "requestedTitle" | "goal" | "requestedPlatform"; value: string }
  | { type: "close_proposal" }
  | { type: "save_local_draft" };

export function createAbsNewsWorkspaceUiStateV1(): AbsNewsWorkspaceUiStateV1 {
  return { queueFilter: "important_now", sort: "priority", queueOverrides: {}, drafts: [] };
}

function story(fixture: AbsNewsSyntheticWorkspaceV1, storyId: string): AbsNewsStoryV1 {
  const value = fixture.stories.find((item) => item.storyId === storyId);
  if (!value) throw new Error("story_not_found");
  return value;
}

export function effectiveAbsNewsQueueV1(state: AbsNewsWorkspaceUiStateV1, value: AbsNewsStoryV1): AbsNewsQueueV1 {
  return state.queueOverrides[value.storyId] ?? value.queue;
}

export function visibleAbsNewsStoriesV1(fixture: AbsNewsSyntheticWorkspaceV1, state: AbsNewsWorkspaceUiStateV1): AbsNewsStoryV1[] {
  const values = fixture.stories.filter((item) => state.queueFilter === "all" || effectiveAbsNewsQueueV1(state, item) === state.queueFilter);
  return [...values].sort((left, right) => state.sort === "priority"
    ? right.priorityScore - left.priorityScore || left.storyId.localeCompare(right.storyId)
    : (right.publishedAt ?? right.discoveredAt).localeCompare(left.publishedAt ?? left.discoveredAt) || left.storyId.localeCompare(right.storyId));
}

export function reduceAbsNewsWorkspaceUiV1(fixture: AbsNewsSyntheticWorkspaceV1, state: AbsNewsWorkspaceUiStateV1, action: AbsNewsWorkspaceUiActionV1): AbsNewsWorkspaceUiStateV1 {
  switch (action.type) {
    case "set_queue_filter": return { ...state, queueFilter: action.queueFilter, notice: undefined };
    case "set_sort": return { ...state, sort: action.sort, notice: undefined };
    case "select_story": story(fixture, action.storyId); return { ...state, selectedStoryId: action.storyId, notice: undefined };
    case "archive_story": story(fixture, action.storyId); return { ...state, queueOverrides: { ...state.queueOverrides, [action.storyId]: "archive" }, selectedStoryId: action.storyId, notice: "Archived locally. Source evidence and history were retained." };
    case "restore_story": story(fixture, action.storyId); return { ...state, queueOverrides: { ...state.queueOverrides, [action.storyId]: action.queue }, selectedStoryId: action.storyId, notice: "Restored to the local project queue." };
    case "open_proposal": {
      const item = story(fixture, action.storyId), template = fixture.actionCatalog.find((candidate) => candidate.actionId === action.actionId);
      if (item.verificationState !== "verified" || !template) return { ...state, notice: "Direct source verification is required before preparing a job." };
      const platform = template.allowedPlatforms.includes("any") ? "any" : template.allowedPlatforms[0]!;
      return { ...state, selectedStoryId: item.storyId, editor: { storyId: item.storyId, actionId: template.actionId, requestedTitle: `${template.label}: ${item.title}`, goal: `Prepare a ${template.deliverableKind.replaceAll("_", " ")} using the retained evidence for this story.`, requestedPlatform: platform }, notice: undefined };
    }
    case "edit_proposal": {
      if (!state.editor) return state;
      return { ...state, editor: { ...state.editor, [action.field]: action.value }, notice: undefined };
    }
    case "close_proposal": return { ...state, editor: undefined, notice: undefined };
    case "save_local_draft": {
      if (!state.editor) return state;
      const item = story(fixture, state.editor.storyId), template = fixture.actionCatalog.find((candidate) => candidate.actionId === state.editor!.actionId);
      const title = state.editor.requestedTitle.trim(), goal = state.editor.goal.trim();
      if (item.verificationState !== "verified" || !template || title.length < 1 || title.length > 240 || goal.length < 1 || goal.length > 1_200) return { ...state, notice: "The local draft is incomplete or outside its safe size limits." };
      if ((!template.allowedPlatforms.includes("any") && !template.allowedPlatforms.includes(state.editor.requestedPlatform))
        || (template.allowedPlatforms.includes("any") && state.editor.requestedPlatform !== "any")) return { ...state, notice: "The selected platform is outside this action's frozen route." };
      const localDraftId = `local-draft-${state.drafts.length + 1}`;
      const draft: AbsNewsLocalDraftPreviewV1 = { ...state.editor, requestedTitle: title, goal, localDraftId, status: "local_preview", requiresOwnerReview: true, createsWorkItem: false, dispatchState: "not_requested", grantsApproval: false, grantsNetworkAuthority: false, grantsCommandAuthority: false, grantsExecutionAuthority: false };
      return { ...state, drafts: [...state.drafts, draft], editor: undefined, notice: "Draft saved in this local preview. No work item was created or dispatched." };
    }
  }
}
