import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { redactPrivateNames } from "../check-private-names.mjs";

export const MAX_BODY_BYTES = 65_536;
const sourcePath = /^(?:src|db)\//u;
const strayReportPath = /^reports\//u;
const testPath = /^tests\/[a-zA-Z0-9_./-]+\.(?:test|spec)\.(?:ts|tsx|mjs|js)$/u;
const absoluteClaim = /\b(?:all|zero|never|guaranteed)\b/iu;
const evidenceMarker = /(?:^|\n)[ \t]*(?:[-*][ \t]+)?(?:test|ci|cmd):[ \t]*\S/iu;
const evidenceItem = /^[ \t]*(?:[-*][ \t]+)?(test|ci|cmd):[ \t]*(.+?)[ \t]*$/iu;

function evidenceSection(body) {
  const lines = body.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^## Evidence\s*$/u.test(line));
  if (start < 0) return null;
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/u.test(line));
  return lines.slice(start + 1, endOffset < 0 ? undefined : start + 1 + endOffset).join("\n");
}

function bulletBlocks(section) {
  const blocks = [];
  let block = null;
  let fence = null;
  for (const line of section.split(/\r?\n/u)) {
    const marker = /^\s*(`{3,}|~{3,})[^\r\n]*$/u.exec(line);
    if (fence) {
      if (block !== null) block += `\n${line}`;
      const close = new RegExp(`^\\s*${fence.character}{${fence.length},}\\s*$`, "u");
      if (close.test(line)) fence = null;
      continue;
    }
    if (/^[-*]\s+/u.test(line)) {
      if (block !== null) blocks.push(block.trim());
      block = line;
      continue;
    }
    if (block !== null) block += `\n${line}`;
    if (marker) fence = { character: marker[1][0], length: marker[1].length };
  }
  if (block !== null) blocks.push(block.trim());
  return blocks;
}

// Evidence is only a reference when the item is the whole line. Prose that
// merely contains the token - a DB-VERIFIED line naming `pnpm test:database`,
// a sentence ending in "the new test:" - is not a reference.
function referenceAtLineStart(line) {
  const match = evidenceItem.exec(line);
  return match ? { type: match[1].toLowerCase(), value: match[2] } : null;
}

function references(block, onUnclosedFence = () => {}) {
  const found = [];
  let fence = null;
  for (const line of block.split(/\r?\n/u)) {
    const marker = /^\s*(`{3,}|~{3,})[^\r\n]*$/u.exec(line);
    if (fence) {
      const close = new RegExp(`^\\s*${fence.character}{${fence.length},}\\s*$`, "u");
      if (close.test(line)) fence = null;
      continue;
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      continue;
    }
    const ref = referenceAtLineStart(line);
    if (ref) found.push(ref);
  }
  if (fence) onUnclosedFence();
  return found;
}

function workflowJobs(source) {
  const jobs = new Set();
  let inJobs = false;
  for (const line of source.split(/\r?\n/u)) {
    if (/^jobs:\s*$/u.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    const job = /^  ([a-zA-Z0-9_-]+):\s*$/u.exec(line);
    if (job) { jobs.add(job[1]); continue; }
    const name = /^    name:\s*(.+?)\s*$/u.exec(line);
    if (name) jobs.add(name[1].replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2"));
  }
  return jobs;
}

function safeTestFile(root, file) {
  if (isAbsolute(file) || !testPath.test(file)) return null;
  const candidate = normalize(join(root, file));
  if (!existsSync(candidate)) return null;
  const resolved = realpathSync(candidate);
  const inside = relative(realpathSync(join(root, "tests")), resolved);
  if (inside.startsWith(`..${sep}`) || inside === ".." || !existsSync(resolved)) return null;
  return statSync(resolved).isFile() ? resolved : null;
}

function hasNamedTest(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`\\b(?:test|it|describe)(?:\\.[a-z]+)?\\s*\\(\\s*([\"'])${escaped}\\1`, "u");
  return pattern.test(source);
}

function hasFencedOutput(block) {
  let fence = null;
  let output = "";
  for (const line of block.split(/\r?\n/u)) {
    const marker = /^\s*(`{3,}|~{3,})[^\r\n]*$/u.exec(line);
    if (fence) {
      const close = new RegExp(`^\\s*${fence.character}{${fence.length},}\\s*$`, "u");
      if (close.test(line)) return Boolean(output.trim());
      output += `${line}\n`;
      continue;
    }
    if (marker) fence = { character: marker[1][0], length: marker[1].length };
  }
  return Boolean(fence && output.trim());
}

function absoluteWarnings(body) {
  let count = 0;
  for (const paragraph of body.split(/\n\s*\n|(?=^[-*]\s+)/gmu)) {
    if (absoluteClaim.test(paragraph) && !evidenceMarker.test(paragraph)) count++;
  }
  return count;
}

export function checkPrClaims({
  body,
  changedPaths,
  addedPaths = [],
  root = process.cwd(),
  workflowSource = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"),
} = {}) {
  const errors = [];
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return { ok: false, errors: ["body_too_large_or_invalid"], warnings: 0 };
  }
  if (!Array.isArray(changedPaths)) {
    return { ok: false, errors: ["changed_paths_unavailable"], warnings: absoluteWarnings(body) };
  }

  if (!Array.isArray(addedPaths)) addedPaths = [];
  if (addedPaths.some((path) => strayReportPath.test(path))) {
    errors.push("stray_report_path");
  }

  const section = evidenceSection(body);
  if (changedPaths.some((path) => sourcePath.test(path)) && section === null) {
    errors.push("evidence_section_missing");
  }
  if (section !== null) {
    const bullets = bulletBlocks(section);
    if (bullets.length === 0) errors.push("evidence_bullets_missing");
    const jobs = workflowJobs(workflowSource);
    let unclosedFenceWarnings = 0;
    for (const block of bullets) {
      const refs = references(block, () => { unclosedFenceWarnings++; });
      if (refs.length === 0) errors.push("evidence_reference_missing");
      for (const ref of refs) {
        if (ref.type === "test") {
          const split = ref.value.indexOf("::");
          const file = split > 0 ? ref.value.slice(0, split).trim() : "";
          const name = split > 0 ? ref.value.slice(split + 2).trim() : "";
          const resolved = safeTestFile(root, file);
          if (!resolved || !name || !hasNamedTest(readFileSync(resolved, "utf8"), name)) {
            errors.push("test_reference_unresolved");
          }
        } else if (ref.type === "ci" && !jobs.has(ref.value.trim())) {
          errors.push("ci_reference_unresolved");
        } else if (ref.type === "cmd" && !hasFencedOutput(block)) {
          errors.push("command_output_missing");
        }
      }
    }
    if (unclosedFenceWarnings > 0) {
      return {
        ok: errors.length === 0,
        errors,
        warnings: absoluteWarnings(body),
        fenceWarnings: unclosedFenceWarnings,
      };
    }
  }
  return { ok: errors.length === 0, errors, warnings: absoluteWarnings(body) };
}

function diffPaths(event, root, filter) {
  const base = event?.pull_request?.base?.sha;
  const head = event?.pull_request?.head?.sha;
  if (!base || !head) return null;
  try {
    return execFileSync("git", ["diff", "--name-only", "-z", `--diff-filter=${filter}`, `${base}...${head}`], {
      cwd: root, encoding: "utf8", maxBuffer: 1_048_576,
    }).split("\0").filter(Boolean);
  } catch { return null; }
}

function changedPaths(event, root) { return diffPaths(event, root, "ACDMRTUXB"); }
function addedPaths(event, root) { return diffPaths(event, root, "ARC"); }

export function main(env = process.env) {
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    if (!event.pull_request) { console.log("PR claims check skipped: not a pull request"); return; }
    const result = checkPrClaims({
      body: event.pull_request.body ?? "",
      changedPaths: changedPaths(event, process.cwd()),
      addedPaths: addedPaths(event, process.cwd()),
    });
    if (result.warnings > 0) console.warn(`PR claims check warning: ${result.warnings} absolute claim(s) lack an evidence line`);
    if (result.fenceWarnings > 0) console.warn(`PR claims check warning: ${result.fenceWarnings} unclosed evidence fence(s)`);
    if (!result.ok) {
      const codes = [...new Set(result.errors)].map((code) => redactPrivateNames(code, env));
      console.error(`PR claims check failed: ${codes.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    console.log("PR claims check passed");
  } catch {
    console.error("PR claims check failed: event_payload_unreadable");
    process.exitCode = 1;
  }
}

if (isMainModuleV1(process.argv[1], import.meta.url)) main();
