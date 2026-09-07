import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = name => readFileSync(new URL(`../docs/public-launch-draft/${name}`, import.meta.url), "utf8");

test("contributor handoff requests reuse and verifiable evidence without CI authority", () => {
  const pr = read("PULL_REQUEST_TEMPLATE.md");
  for (const field of ["Base revision", "Submitted revision", "Platform and tool versions",
    "Exact commands and observed results", "What was not tested", "Upstream component",
    "why suitable existing components cannot meet the requirement", "Reviewing maintainer",
    "another confirmed independent", "no unapproved workflow"]) {
    assert.ok(pr.includes(field), field);
  }
  assert.match(pr, /pass, fail or not run honestly/);
  assert.match(pr, /do not paste raw logs, login codes, credentials/);
  assert.match(pr, /Unpublished draft/);
});

test("work assignment identifies eligibility before a contributor starts", () => {
  const work = read("WORK_ITEM.md");
  for (const field of ["Required OS", "Exact public base commit", "Required prior issues",
    "Named reviewing maintainer", "Files/components allowed to change", "Out of scope",
    "Specific reason for custom infrastructure", "Wait for the maintainer to confirm"]) {
    assert.ok(work.includes(field), field);
  }
  assert.match(work, /Never retry an uncertain external/);
  assert.match(work, /ask\s+to release the assignment/);
});

test("release templates do not embed private destinations or obsolete demo status", () => {
  for (const name of ["PULL_REQUEST_TEMPLATE.md", "WORK_ITEM.md", "GOVERNANCE.md", "README.md"]) {
    assert.doesNotMatch(read(name), /dash\.cloudflare\.com|\/Users\/|\/root\/|MarvinAi5\/control-room/);
  }
  assert.doesNotMatch(read("README.md"), /interactive demo startup remains unfinished/);
});
