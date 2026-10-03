import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ownerStatusLabels } from "../private-app/app/owner-status-labels";
import { TaskCatalogPanel, taskSummaryStateLabel } from "../private-app/app/task-panels";
import { runNightKitV1 } from "../src/night-kit/v1";
import type { TaskPage } from "../src/web/v1/task-wire";
import nonStatusQuotes from "./fixtures/owner-guide-non-status-quotes.json";

function quotedLabels(markdown: string): string[] {
  // Commands and configuration values describe CLI/wire contracts, not screen
  // labels. Classify every remaining emphasized or quoted phrase, so a new
  // unknown status cannot quietly fall outside a known-label substring check.
  const prose = markdown.replace(/```[\s\S]*?```|`[^`]+`/gu, "");
  return [...prose.matchAll(/\*\*([^*]+)\*\*|“([^”]+)”|"([^"\n]+)"/gu)]
    .map(match => (match[1] ?? match[2] ?? match[3]).replace(/\s+/gu, " ").trim());
}

test("every quoted guide screen status comes from the product label catalog", async () => {
  const practiceMessage = (await runNightKitV1("practice")).message;
  const screenLabels = new Set(Object.values(ownerStatusLabels).flatMap(group => Object.values(group)));
  const files = [...readdirSync("docs/owner-guides").filter(name => name.endsWith(".md"))
    .map(name => `docs/owner-guides/${name}`), "docs/OWNER_GUIDE_MAC.md", "docs/INSTALL_NIGHT_OWNER_GUIDE.md", "docs/FLEET_GUIDE.md"];
  // The other quotations are controls, headings, external-app instructions,
  // example input, legacy capability descriptions, or prose emphasis. This
  // explicit inventory must never contain a screen status from the catalog.
  const classified = nonStatusQuotes as Record<string, string[]>;
  for (const file of files) {
    const quotes = quotedLabels(readFileSync(file, "utf8"));
    const other = new Set(classified[file] ?? []);
    for (const quote of other) {
      assert.ok(!screenLabels.has(quote), `${file}: status misclassified as prose: ${quote}`);
      assert.ok(quotes.includes(quote), `${file}: stale non-status quotation: ${quote}`);
    }
    const terminalSources: Record<string, string> = {
      "The attempted install was undone": "src/updater/v1/cli.mjs",
      "The install could not be fully undone": "src/updater/v1/cli.mjs",
    };
    for (const quote of quotes) {
      if (quote === "Practice night completed") {
        assert.ok(practiceMessage.startsWith(quote), `${file}: practice outcome label drift`);
      } else if (terminalSources[quote]) {
        assert.ok(readFileSync(terminalSources[quote], "utf8").includes(quote), `${file}: terminal label drift: ${quote}`);
      } else {
        assert.ok(screenLabels.has(quote) || other.has(quote), `${file}: unknown quoted label: ${quote}`);
      }
    }
  }
});

test("guide task outcome labels are the exact labels rendered for recorded decisions", () => {
  const task = { state: "cancelled", ownerRejected: true } as TaskPage["tasks"][number];
  const outcomes = [taskSummaryStateLabel(task), taskSummaryStateLabel({ ...task, ownerRejected: undefined }),
    taskSummaryStateLabel({ ...task, state: "succeeded", qualityStatus: "accepted" })];
  assert.deepEqual(outcomes, [ownerStatusLabels.taskOutcome.ownerRejected, ownerStatusLabels.task.cancelled, ownerStatusLabels.taskOutcome.accepted]);
  for (const outcome of [task, { ...task, ownerRejected: undefined },
    { ...task, state: "succeeded" as const, qualityStatus: "accepted" as const }]) {
    const page = { tasks: [{ ...outcome, jobId: "job:guide", projectId: "project:guide", title: "Guide task",
      createdAt: "2026-10-03T00:00:00.000Z" }], project: { projectId: "project:guide" } } as TaskPage;
    const html = renderToStaticMarkup(<TaskCatalogPanel page={page} />);
    assert.ok(html.includes(taskSummaryStateLabel(outcome)), "the task catalog must render the documented outcome");
  }
  assert.ok(readFileSync("docs/OWNER_GUIDE_MAC.md", "utf8").includes(ownerStatusLabels.taskOutcome.accepted));
  for (const file of ["docs/OWNER_GUIDE_MAC.md", "docs/INSTALL_NIGHT_OWNER_GUIDE.md", "docs/FLEET_GUIDE.md"]) {
    const quotes = quotedLabels(readFileSync(file, "utf8"));
    assert.ok(quotes.includes(taskSummaryStateLabel(task)), `${file}: missing owner rejection label`);
    assert.ok(quotes.includes(taskSummaryStateLabel({ ...task, ownerRejected: undefined })), `${file}: missing cancellation label`);
  }
});
