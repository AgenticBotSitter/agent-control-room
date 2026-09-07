/** Navigation and explanation only; never infers permission or execution from task state. */
export function TaskWorkflowGuide() {
  return <nav className="private-panel" aria-label="Task workflow"><h2>How this task moves forward</h2>
    <ol>
      <li><a href="#task-planning">Prepare</a>: turn a saved proposal into a separate prepared task. Open that task to continue.</li>
      <li><a href="#task-assignment">Assign</a>: reserve an eligible machine. This does not run the task.</li>
      <li><a href="#task-approval">Approve</a>: review the exact request and save its separately signed approval file. Signing is not connected to this website yet.</li>
      <li><a href="#task-approval">Queue</a>: after approval is saved, the submission controls appear below it. Queuing can allow execution if the current checks pass.</li>
      <li><a href="#task-results">Review results</a>: inspect the returned work and complete the required review and verification.</li>
    </ol>
    <p>Checking or refreshing only reads status. If an outcome is uncertain, inspect its existing receipt rather than creating replacement work.</p>
  </nav>;
}
