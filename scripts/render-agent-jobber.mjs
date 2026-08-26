#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { jobberTitle } from "./agent-jobber-queue.mjs";

function bullets(values) {
  return values.length === 0 ? "- none" : values.map((value) => `- ${value}`).join("\n");
}

export function renderJobber(capsule, capsulePath) {
  const title = jobberTitle("READY", capsule);
  const body = `Capsule: \`${capsulePath}\`
Integration: \`${capsule.integrationBranch}\`

## Pick-up check

- Platform: **${capsule.platform.toUpperCase()}**
- Tier: **${capsule.taskClass.split("-")[0].toUpperCase()}**
- Mode/risk: \`${capsule.mode}\` / \`${capsule.risk}\`
- Eligible routes: ${capsule.eligibleRoutes.map((route) => `\`${route}\``).join(", ")}
- Concurrent claims per route: ${capsule.maxConcurrentClaimsPerRoute}

Required tools:
${bullets(capsule.requiredTools)}

Dependencies:
${bullets(capsule.dependencies)}

## Objective

${capsule.objective}

Allowed product paths:
${bullets(capsule.allowedPaths.map((file) => `\`${file}\``))}

Acceptance commands:
${bullets(capsule.acceptanceCommands.map((command) => `\`${command}\``))}

- Repair iterations: ${capsule.limits.maxRepairIterations}
- Effects: \`${capsule.effects.level}\`, maximum ${capsule.effects.maxCount}
- Independent verification: ${capsule.verification.required ? `required by ${capsule.verification.independence}` : "not required"}

Stop conditions:
${bullets(capsule.stopConditions)}

## Queue commands

- Claim: \`/claim <route-id>\`
- Untouched return: \`/release <route-id> --no-work-started <reason>\`
- Blocked handoff: \`/blocked <route-id> <reason and evidence reference>\`
- Submission: \`/submitted <route-id> <pull-request-url>\`

Read and follow \`skills/agent-build-worker/SKILL.md\`. The issue alone does not authorize work; wait for \`CLAIM ACCEPTED\`.`;
  return { title, labels: ["work-packet", "jobber-ready"], body };
}

function main() {
  const capsulePath = process.argv[2];
  if (!capsulePath) throw new Error("usage: node scripts/render-agent-jobber.mjs <capsule-path>");
  const normalized = capsulePath.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.startsWith("./") || normalized.split("/").includes("..")) {
    throw new Error("capsule path must be repository-relative");
  }
  const capsule = JSON.parse(readFileSync(capsulePath, "utf8"));
  console.log(JSON.stringify(renderJobber(capsule, normalized), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
