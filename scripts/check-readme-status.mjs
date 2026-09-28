import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const requiredClaims = Object.freeze([
  ["status heading", /^## Current product status$/mu],
  ["source evidence boundary", /\*\*Source-backed today:\*\*/u],
  ["owner acceptance boundary", /\*\*Not yet owner-accepted:\*\*/u],
  ["release boundary", /no supported downloadable release/iu],
  ["disposable evidence boundary", /disposable PostgreSQL/iu],
  ["owner guide warning", /owner guide(?:\]\([^)]*\))? remains a draft/iu],
]);

const staleClaims = Object.freeze([
  ["unfinished local integration claim", /Still to finish:\*\* real Hermes\/Codex integration and\s+recovery/iu],
  ["drifting demo test count", /\b\d+ demo tests\b/iu],
  ["demo-only status claim", /This source preview includes an explicit `pnpm demo` command[\s\S]{0,700}No live agent-runtime\/platform combination/iu],
  ["obsolete connector baseline", /the bounded Claude Code\s+connector foundation/iu],
  ["obsolete proposed Claude Code track", /Hermes and Codex are the first integration priorities\.\s+Claude Code, OpenClaw and other\s+harnesses are proposed contributor tracks, not current compatibility claims\./iu],
]);

export function checkReadmeStatus(source) {
  if (typeof source !== "string") return Object.freeze(["README source is not text"]);
  const findings = [];
  for (const [label, pattern] of requiredClaims) {
    if (!pattern.test(source)) findings.push(`missing ${label}`);
  }
  for (const [label, pattern] of staleClaims) {
    if (pattern.test(source)) findings.push(`stale ${label}`);
  }
  return Object.freeze(findings);
}

export function checkRepositoryReadme(repositoryRoot = process.cwd()) {
  return checkReadmeStatus(readFileSync(join(repositoryRoot, "README.md"), "utf8"));
}

function main() {
  let findings;
  try { findings = checkRepositoryReadme(); }
  catch { findings = ["README could not be read"]; }
  if (findings.length === 0) {
    console.log("README status check passed");
    return;
  }
  for (const finding of findings) console.error(`README status check failed: ${finding}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
