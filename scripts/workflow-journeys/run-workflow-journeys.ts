/**
 * Driver for the issue #208 workflow journeys.
 *
 * Runs every attributed journey against the real product services and prints one
 * evidence line per step, so the run can be pasted into a handoff without editing.
 * Exits non-zero if any journey fails.
 *
 * Usage (from the repository root):
 *   node --import tsx scripts/workflow-journeys/run-workflow-journeys.ts
 *   node --import tsx scripts/workflow-journeys/run-workflow-journeys.ts --evidence-file=.hermes/journey-evidence.json
 *
 * The lane is opt-in at runtime: this packet may not edit package.json, so the
 * journeys are registered as a CI lane at integration (see
 * docs/integration/workflow-journeys/). Until then this driver is the runner.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runArticleAttributionJourney } from "../../tests/workflow-journeys/article-attribution.journey";
import { runIdeaLabAttributionJourney } from "../../tests/workflow-journeys/idea-lab-attribution.journey";
import type { JourneyOutcomeV1 } from "../../tests/workflow-journeys/attributed-cases";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
process.chdir(repositoryRoot);

const argument = (name: string): string | undefined =>
  process.argv.slice(2).find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);

const runners: { name: string; run: () => Promise<JourneyOutcomeV1> }[] = [
  { name: "idea-lab-attribution", run: runIdeaLabAttributionJourney },
  { name: "article-attribution", run: runArticleAttributionJourney },
];
const selected = argument("journey");
const chosen = selected ? runners.filter(runner => runner.name === selected) : runners;

if (!chosen.length) {
  console.error(`unknown journey: ${selected}`);
  console.error(`available: ${runners.map(runner => runner.name).join(", ")}`);
  process.exit(2);
}

const outcomes: JourneyOutcomeV1[] = [];
let failed = 0;
for (const runner of chosen) {
  process.stdout.write(`\n# journey ${runner.name}\n`);
  try {
    const outcome = await runner.run();
    outcomes.push(outcome);
    for (const step of outcome.steps) process.stdout.write(`  ok   ${step.step} — ${step.detail}\n`);
    for (const finding of outcome.findings) process.stdout.write(`  note ${finding}\n`);
    process.stdout.write(`  result ${outcome.journey}: all ${outcome.steps.length} steps held\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`  FAIL ${runner.name}: ${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof Error && error.stack) process.stdout.write(`${error.stack}\n`);
  }
}

const evidenceFile = argument("evidence-file");
if (evidenceFile) {
  const target = resolve(repositoryRoot, evidenceFile);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ observedAt: new Date().toISOString(),
    worker: "ziggy-results-01", issue: 208, journeys: outcomes }, null, 2)}\n`, "utf8");
  process.stdout.write(`\nevidence written: ${target}\n`);
}

process.stdout.write(`\n${outcomes.length} journey(s) completed, ${failed} failed\n`);
process.exitCode = failed ? 1 : 0;