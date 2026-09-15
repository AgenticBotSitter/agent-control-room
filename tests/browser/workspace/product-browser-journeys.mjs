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
        proof: "every page reaches its heading; the document never scrolls sideways at 360px",
        simulated: true }),
      Object.freeze({ title: "Archive project A and reopen it without losing its task",
        command: "/api/v1/projects/{projectId}/lifecycle",
        proof: "POST 200 from each archive/reopen POST; the alpha task heading remains visible across both",
        simulated: true }),
      Object.freeze({ title: "Reload, back/forward, and the narrow workspace menu",
        command: "(no protected command)",
        proof: "reload, goBack and goForward never produce a POST; the workspace menu exposes Projects at 360px",
        simulated: true }),
      Object.freeze({ title: "Verify idempotency on every protected save command",
        command: "/api/v1/projects",
        proof: "every project/task POST in the route log carries an idempotency-key header of at least 8 characters",
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
