// Synthetic workspace data for the browser fixture. Two isolated projects
// with the same task lifecycle so the journey covers:
//   - propose + execute + result list + result content
//   - recorded quality review (changes_requested or ready)
//   - revision request that replaces the result file
//   - archive + reopen on the project lifecycle
//   - read-only reconciliation (idempotency-key replay) after uncertainty
// Extracted so a Node-side test can validate the wire shapes against
// src/web/v1/{task,task-result}-wire.ts without booting the browser.

export type ReviewDecision = "pending" | "changes_requested" | "ready";

export interface ProjectFixture {
  projectId: string;
  title: string;
  summary: string;
  // Tasks seeded at load time. After the user proposes a new task the
  // synthetic server appends it to this list.
  seedTask: { jobId: string; title: string; instructions: string };
}

export const fixtures: Record<string, ProjectFixture> = {
  "project:alpha": {
    projectId: "project:alpha",
    title: "Alpha workspace validation",
    summary: "Disposable synthetic project used for the browser journey check. Not a real plan.",
    seedTask: {
      jobId: "job:alpha-001",
      title: "Compare harness recovery behavior",
      instructions: "Synthetic instructions only. Read the synthetic review below; do not run anything.",
    },
  },
  "project:beta": {
    projectId: "project:beta",
    title: "Beta workspace validation",
    summary: "Second disposable project. Switching between Alpha and Beta must clear the open result and the matching review.",
    seedTask: {
      jobId: "job:beta-001",
      title: "Draft the no-live-agents acceptance checklist",
      instructions: "Synthetic instructions. Produce the visible checklist, save it as Revision 2, then run the recorded review.",
    },
  },
};

// Lifecycle states the synthetic server tracks per project. Initial state
// for both fixtures is "active". The driver scripts can flip a project
// to "archived" and back via POST /api/v1/projects/{id}/lifecycle.
export type LifecycleState = "active" | "archived";

// Initial review status per project. Alpha seeded with changes_requested
// (one open finding), Beta seeded with ready. The fixture also tracks the
// synthetic review targetId per project + result revision.
export const seedReviewStatus: Record<string, ReviewDecision> = {
  "project:alpha": "changes_requested",
  "project:beta": "ready",
};
