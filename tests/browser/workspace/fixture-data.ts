// Shared synthetic data for the workspace browser fixture. Extracted so a
// Node-side test can validate the wire shapes without spinning up the
// browser. The fixture itself (main.tsx) imports this and applies dynamic
// values (timestamp, sha256 digest) at fetch time.

export interface ProjectFixture {
  projectId: string;
  title: string;
  summary: string;
  task: { jobId: string; title: string; instructions: string };
  result: { artifactId: string; text: string };
  review: { targetId: string; status: "pending" | "changes_requested" | "ready"; contentText: string };
}

export const fixtures: Record<string, ProjectFixture> = {
  "project:alpha": {
    projectId: "project:alpha",
    title: "Alpha workspace validation",
    summary: "Disposable synthetic project used for the browser journey check. Not a real plan.",
    task: {
      jobId: "job:alpha-001",
      title: "Compare harness recovery behavior",
      instructions: "Synthetic instructions only. Read the synthetic review below; do not run anything.",
    },
    result: {
      artifactId: "artifact:alpha-001-r2",
      text: "# Synthetic alpha result\n\nThis file is a fixture. It exists only to exercise the read-result path on the workspace browser check.\n\n## What to verify\n- Open the file and confirm the bytes match the listed fingerprint.\n- Request a revision and confirm the new file replaces this one.\n- Reload the page; the open file must still match the saved review.",
    },
    review: {
      targetId: "review:alpha-001-r2",
      status: "changes_requested",
      contentText: "Synthetic review: please add a section listing the prerequisites of an interruption and how recovery differs across harnesses. Do not run anything.",
    },
  },
  "project:beta": {
    projectId: "project:beta",
    title: "Beta workspace validation",
    summary: "Second disposable project. Switching between Alpha and Beta must clear the open result and the matching review.",
    task: {
      jobId: "job:beta-001",
      title: "Draft the no-live-agents acceptance checklist",
      instructions: "Synthetic instructions. Produce the visible checklist, save it as Revision 2, then run the recorded review.",
    },
    result: {
      artifactId: "artifact:beta-001-r2",
      text: "# Synthetic beta checklist\n\n1. Confirm the open file ID and fingerprint match a recorded review.\n2. Switch project; the open file must disappear from the panel.\n3. Reload; the saved revision must still be available for reading.\n4. Submit a revision request; the new file ID must replace the old one in the list.",
    },
    review: {
      targetId: "review:beta-001-r2",
      status: "ready",
      contentText: "Synthetic review: this revision matches the recorded checklist. Quality review is recorded, not approval.",
    },
  },
};
