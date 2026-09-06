import type { TaskDetail } from "./task-wire";
import type { TaskApprovalRead, TaskApprovalReview } from "./task-approval-wire";

export type TaskApprovalEditor = { review: TaskApprovalReview; binding: string; file?: { name: string; text: string } };

/** Local editing continuity only, not approval validation. Submission always revalidates on the server. */
function binding(detail: TaskDetail, review: TaskApprovalReview) {
  const attempt = detail.attempts[0];
  if (detail.project.lifecycle !== "active" || detail.task.projectId !== review.projectId
    || detail.task.jobId !== review.jobId || detail.inputDigest !== review.inputDigest
    || !attempt || attempt.attemptId !== review.attemptId || attempt.state !== "leased"
    || !["leased", "waiting_approval"].includes(detail.task.state)
    || !Number.isFinite(Date.parse(detail.observedAt)) || !Number.isFinite(Date.parse(review.deadline))
    || Date.parse(detail.observedAt) >= Date.parse(review.deadline)) return undefined;
  return JSON.stringify([review.projectId, review.jobId, review.inputDigest, review.attemptId,
    review.operationDigest, detail.task.version, detail.project.version, detail.task.state, attempt.state]);
}
export function createApprovalEditor(detail: TaskDetail, review: TaskApprovalReview): TaskApprovalEditor | undefined {
  const key = binding(detail, review);
  return key ? { binding: key, review: { ...review } } : undefined;
}
export function retainApprovalEditor(editor: TaskApprovalEditor | undefined, detail: TaskDetail, state: TaskApprovalRead) {
  if (!editor || state.receipt || state.projectId !== detail.task.projectId || state.jobId !== detail.task.jobId
    || state.inputDigest !== detail.inputDigest || binding(detail, editor.review) !== editor.binding) return undefined;
  return editor;
}
export function attachApprovalFile(editor: TaskApprovalEditor | undefined, expectedEditor: TaskApprovalEditor, file: { name: string; text: string }) {
  // A newly prepared review can have identical scope. It must not inherit a file
  // whose asynchronous read began under the previous review instance.
  if (!editor || editor.binding !== expectedEditor.binding || editor.review !== expectedEditor.review) return editor;
  if (new TextEncoder().encode(file.text).byteLength > 24_576) throw new Error("approval_file_too_large");
  return { ...editor, file: { name: file.name.slice(0, 180), text: file.text } };
}
