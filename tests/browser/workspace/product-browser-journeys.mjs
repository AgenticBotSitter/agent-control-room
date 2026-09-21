// Pure, side-effect-free journey plan for the public product browser command.
// Imported by tests and the journey documentation; never imports the
// compiled bundle or any database dependency.

export const PRODUCT_BROWSER_JOURNEYS_SCHEMA_V1 = "acr-product-browser-journeys:v1";

export function planProductBrowserJourneys() {
  return Object.freeze({
    schema: PRODUCT_BROWSER_JOURNEYS_SCHEMA_V1,
    simulator: Object.freeze(
      "Disposable PGlite database, in-memory HTTP handler, single Playwright route; no listener, no remote request, no live agent or provider was used."),
    journeys: Object.freeze([
      Object.freeze({ title: "Create project A and open its overview",
        command: "/api/v1/projects",
        proof: "browser route records the POST exactly once and lands on the alpha project page",
        simulated: true }),
      Object.freeze({ title: "Save a task under project A and follow its protected detail",
        command: "/api/v1/projects/{projectId}/tasks",
        proof: "browser route records the POST exactly once and the URL stays scoped to project A",
        simulated: true }),
      Object.freeze({ title: "Read local setup and worker availability without inventing live proof",
        command: "(read-only navigation)",
        proof: "The real protected setup endpoint renders all three local harness cards; failed and malformed refreshes remove previous setup success. Deliberately unavailable inventory stays unavailable while navigating Workers, the saved project/task and Needs Me, with no protected POST and no fixture private identity or digest in setup output.",
        simulated: true }),
      Object.freeze({ title: "Create project B and confirm navigation stays inside it",
        command: "/api/v1/projects",
        proof: "second POST is recorded, the URL stays under project B, and project A's task name never appears there",
        simulated: true }),
      Object.freeze({ title: "Reconnect a browser context and prove project A still has its task",
        command: "(no protected command)",
        proof: "context.close then newContext navigates to the saved alpha URL; no POST is recorded during the reconnect",
        simulated: true }),
      Object.freeze({ title: "Walk the Files, Reviews, Activity, Settings pages at 360px and 1280px",
        command: "(read-only navigation)",
        proof: "every page reaches its heading; the document never scrolls sideways at 360px or 1280px",
        simulated: true }),
      Object.freeze({ title: "Archive project A and reopen it without losing its task",
        command: "/api/v1/projects/{projectId}/lifecycle",
        proof: "POST 200 from each archive/reopen POST; the alpha task heading remains visible across both",
        simulated: true }),
      Object.freeze({ title: "Reload, back/forward, and the narrow workspace menu",
        command: "(no protected command)",
        proof: "reload, goBack and goForward never produce a POST; the workspace menu exposes Projects at 360px",
        simulated: true }),
      Object.freeze({ title: "Open the agent progress page that the result lifecycle publishes",
        command: "(read-only navigation)",
        proof: "task detail reaches the Agent progress heading; a deep link reload preserves it",
        simulated: true }),
      Object.freeze({ title: "Open the protected result content and read the exact returned text",
        command: "(read-only navigation)",
        proof: "Read result reveals a Protected result content region whose textarea holds the returned string; deep-link reload preserves the read state",
        simulated: true }),
      Object.freeze({ title: "Accept the owner quality decision and confirm the saved review decision",
        command: "/api/v1/tasks/{jobId}/reviews",
        proof: "Accept quality POST carries decision: accepted with empty feedback and one idempotency key; reload re-renders the decision without replaying the POST",
        simulated: true }),
      Object.freeze({ title: "Prepare a revised task and follow its protected follow-up page",
        command: "/api/v1/tasks/{jobId}/revisions",
        proof: "This journey drove decision: accepted above, which closes the source revision branch; the changes_requested / Prepare-revised-task branch (the revision-planning product journey) is exercised by scripts/private-revision-browser-acceptance.mjs and by tests/vps-built-revision-planning.test.mjs, and is recorded honestly as untested here. The harness does NOT drive revisions.plan via context.request.post; Playwright's APIRequestContext bypasses the installProtectedRequestRouting closure and the literal origin hostname returns ENOTFOUND, so any direct API call would be theater.",
        simulated: true }),
      Object.freeze({ title: "Finalize the source task through the production completion gate",
        command: "(bootstrap-only)",
        proof: "After the public product UI records the Accept quality review above, the script calls installedApplication.quality.sweep({ projectId }) on the completion-capable bootstrap coordinator pool (the same composition tests/vps-built-quality.test.mjs line 60 exercises). The sweep observes exactly one reconciled item whose result.disposition is completed and whose completion receipt has the same jobId/runId the source task recorded. The post-completion canonical states of job, attempt and lease are read via CanonicalStore(startup.coordinator.client) — the coordinator_test role PGlite grants SELECT rights to on control_harness_runs, the same role the completion service used to lock the run row. The script asserts job.state === 'succeeded', attempt.state === 'succeeded' and lease.state === 'released'. A replay of installedApplication.quality.reconcile against the same input returns the same completion receipt with replayed: true, proving the receipt is canonical and replay-safe. The source result page is then reloaded in the browser and asserted to render the saved accept-quality decision without re-issuing a protected command.",
        simulated: true }),
      Object.freeze({ title: "Distinguish a lost request from a lost reply using request-level evidence",
        command: "/api/v1/projects",
        proof: "aborted request produces no project, fulfilled-then-aborted request produces exactly one project, and each retry replays the same idempotency key",
        simulated: true }),
      Object.freeze({ title: "Exercise keyboard focus at both 360px and 1280px without sideways scroll",
        command: "(no protected command)",
        proof: "The narrow product page begins with the skip link (a.skip-link, \"Skip to content\"); the wide product page begins with a layout-dependent first focusable. The skip-link branch actually presses Enter and asserts focus reaches the main landmark; the non-skip-link branch records both the first-focus and the layout-specific Enter binding as untested rather than passing them under the same label. Both branches reach the alpha task link at 360px and 1280px without sideways scroll.",
        simulated: true }),
      Object.freeze({ title: "Verify idempotency on every protected save command",
        command: "/api/v1/projects",
        proof: "every project, task and review POST in the route log carries an idempotency-key header of at least 8 characters",
        simulated: true }),
      Object.freeze({ title: "Clean up the exact owned browser, context, application and temporary profile data",
        command: "(cleanup)",
        proof: "the script closes the owned Chromium, context, application and disposable database; the temp profile directory is removed and never reused on the next run",
        simulated: true }),
    ]),
  });
}

export function renderProductBrowserJourneys(plan = planProductBrowserJourneys()) {
  if (plan.schema !== PRODUCT_BROWSER_JOURNEYS_SCHEMA_V1)
    throw new Error("renderProductBrowserJourneys: expected acr-product-browser-journeys:v1 schema");
  const lines = [
    `Product browser journeys (schema: ${plan.schema})`,
    `Simulator: ${plan.simulator}`,
    "",
  ];
  plan.journeys.forEach((journey, index) => {
    lines.push(`${index + 1}. ${journey.title}`);
    lines.push(`   - Command: \`${journey.command}\``);
    lines.push(`   - Proof: ${journey.proof}`);
    lines.push(`   - Simulated: ${journey.simulated ? "yes" : "no"}`);
    lines.push("");
  });
  return lines.join("\n");
}
