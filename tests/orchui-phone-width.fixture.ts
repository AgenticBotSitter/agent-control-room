// Renders the chief-of-staff panels to static markup with the app's own
// stylesheets attached, so a real browser can measure layout at phone width.
// Not a lane: this produces the fixture, tests/orchui-phone-width.measure.mjs
// does the measuring.
//
//   node --import tsx tests/orchui-phone-width.fixture.ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ChiefOfStaffSuggestionCard, ProjectOrchestrationPanel, ProjectOrchestrationSettings } from
  "../private-app/app/project-orchestration";

const projectId = "project:test", batchId = "batch:test", now = "2026-09-29T12:00:00.000Z";
const option = { key: "planner:1", label: "worker:chief · model:plan · high", workerId: "worker:chief",
  workerKind: "codex" as const, modelKey: "model:plan", effort: "high" as const };
const choice = { mode: "selected" as const, workerId: option.workerId, workerKind: option.workerKind,
  modelKey: option.modelKey, effort: option.effort };
const settings = (over: Record<string, unknown> = {}) => ({ projectId, version: 1, choice, options: [option],
  choiceStale: false, describeAvailable: true, dismissAvailable: true,
  startsWork: false as const, grantsExecutionAuthority: false as const, ...over });
const proposal = { schema: "control-room.work-batch-proposal/v1" as const, projectId,
  tasks: [{ localId: "first", title: "First part", instructions: "Do the first bounded part.",
    requiredCapability: "code.change", role: "builder" as const, acceptanceCriteria: "The first part works.",
    acceptanceTests: "Run the focused test." }], edges: [] };
const suggestion = { suggestionId: "suggestion:test", batchId, projectId, baseRevision: 2, proposal,
  createdAt: now, dismissed: false, startsWork: false, grantsExecutionAuthority: false, savesRevision: false };
const client = (read: unknown) => ({ hasPendingDescription: () => false, forgetPendingDescription() {},
  readSettings: async () => read, saveSettings: async () => read,
  describe: async () => ({ status: "proposal", batchId, href: "/b", startsWork: false, grantsExecutionAuthority: false }),
  retryDescription: async () => ({ status: "proposal", batchId, href: "/b", startsWork: false, grantsExecutionAuthority: false }),
  listSuggestions: async () => ({ projectId, batchId, suggestions: [], dismissAvailable: true,
    startsWork: false, grantsExecutionAuthority: false }),
  useSuggestion: async () => ({ proposal, startsWork: false, grantsExecutionAuthority: false, savesRevision: false }),
  dismissSuggestion: async () => {} });

const panels: Record<string, string> = {
  describe: renderToStaticMarkup(createElement(ProjectOrchestrationPanel,
    { projectId, client: client(settings()) as never })),
  describeNoPlanner: renderToStaticMarkup(createElement(ProjectOrchestrationPanel,
    { projectId, client: client(settings({ describeAvailable: false })) as never })),
  settings: renderToStaticMarkup(createElement(ProjectOrchestrationSettings,
    { projectId, client: client(settings()) as never })),
  settingsStale: renderToStaticMarkup(createElement(ProjectOrchestrationSettings,
    { projectId, client: client(settings({ choiceStale: true, choice: { mode: "selected",
      workerId: "worker:gone", workerKind: "codex", modelKey: "model:gone", effort: "high" } })) as never })),
  card: renderToStaticMarkup(createElement(ChiefOfStaffSuggestionCard,
    { suggestion: suggestion as never, dismissAvailable: true, onUse: () => {}, onDismiss: () => {} })),
  cardNoDismiss: renderToStaticMarkup(createElement(ChiefOfStaffSuggestionCard,
    { suggestion: suggestion as never, dismissAvailable: false, onUse: () => {}, onDismiss: () => {} })),
};

const read = (path: string) => { try { return readFileSync(new URL(path, import.meta.url), "utf8"); }
  catch { return ""; } };
const css = [read("../private-app/app/private.css"), read("../private-app/styles/control-room.css")].join("\n");
// Under the scratch directory, not the repository: build/ is gitignored and this is
// a disposable render fixture, not a build product.
const OUT = process.env.ORCHUI_FIXTURE_DIR ?? "/Users/alastairfraser/work/acr-lander/.mof/orchui-phone-width";
mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/index.html`,
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Chief of staff — phone width</title>
<style>${css}
:root{--border:#d0d0d0;--border-strong:#9a9a9a;--text:#161616;--surface:#fff;--muted:#5a5a5a;
  --amber-soft:#fff6df;--radius:.5rem;--accent:#1a4fd6}
body{margin:0;font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif;color:var(--text);background:var(--surface)}
.private-shell{min-height:100vh}.private-panel{padding:1rem}
a{color:var(--accent)}button{font:inherit}
</style></head><body><div class="private-shell"><main class="private-panel">
${Object.entries(panels).map(([name, html]) => `<section data-panel="${name}">${html}</section>`).join("\n")}
</main></div></body></html>`);
console.log(`rendered ${Object.keys(panels).length} panels into ${OUT}/index.html`);