// Decides which verification lanes a change must run, from the paths it touches.
//
// Two properties matter more here than precision:
//
//   1. Fail safe. Anything this file cannot classify, and any doubt about the diff
//      itself, routes to the complete suite. A wrong skip hides a defect; a wrong
//      full run only costs runner time.
//   2. The union of what runs is always the complete suite. The path-aware lanes in
//      the workflow are the fast path; the merge gate runs every lane the fast path
//      skipped. A skipped lane is therefore never an unrun lane, which is what makes
//      skipping provably safe rather than a judgement call. `gateLanes()` below is
//      the other half of that invariant, and a test asserts it for every routing
//      decision.
//
// The per-class lane lists are evidence, not intuition: each one was derived by
// looking up which test files actually read the area, with
//   git grep -l -E '(\.\./)+<area>/' -- 'tests/*'
// and the results are recorded in docs/ci-budget-security-review.md. A guessed
// mapping is the failure mode this file is written to avoid, so an area is only
// allowed a narrow lane list when nothing under it is read by another lane's tests.

import { readFileSync, appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const LANES = ["demo", "server", "components", "articles"];

// First match wins, so the order is load-bearing: the narrow, provably inert
// classes come first and the catch-all server class comes last.
export const CHANGE_CLASSES = [
  {
    name: "docs",
    patterns: ["docs/**"],
    lanes: [],
    evidence:
      "No test file, build config or script reads anything under docs/. The only reference in the " +
      "whole repository is scripts/license-inventory.mjs writing docs/license-inventory.json, which " +
      "is an output. docs/ is therefore provably inert and skips every heavy lane.",
  },
  {
    name: "markdown",
    patterns: ["*.md"],
    lanes: ["components"],
    evidence:
      "Root-level markdown is read, but only from the components lane. THIRD_PARTY.md is read by " +
      "scripts/license-inventory.mjs, scripts/runtime-license-finalize.mjs and " +
      "tests/runtime-license-finalize.test.mjs; README.md is read by " +
      "tests/runtime-license-bundled-collector.test.mjs and tests/runtime-license-digest.test.mjs. " +
      "Those run inside test:components. No server-lane input (any tests/vps-built-*.test.mjs), no " +
      "article-lane input (tests/vps-built-article-extraction.test.mjs, vite.vps.config.ts, " +
      "scripts/build-vps.mjs) and no demo-lane input reads a markdown file, so those three are " +
      "skipped. This class is why the docs class is 'docs/**' and not '**/*.md': a markdown file " +
      "outside docs/ is not inert, and one inside another area falls through to that area's class.",
  },
  {
    name: "release",
    patterns: ["deploy/**", "third_party/**", "research/**"],
    lanes: ["server", "components"],
    evidence:
      "Third-party notices, bundled-license scans and runtime-license fixtures live in " +
      "test:release-licenses (part of test:components), research/ fixtures are read by the codex and " +
      "license lanes (also test:components), and deploy/operator-config.mjs is read by " +
      "tests/vps-built-startup.test.mjs in the server lane. Every file in the demo lane " +
      "(test:demo and test:build:demo, including vite.contributor.config.ts and " +
      "scripts/contributor-demo.mjs) and every input to the article lane " +
      "(tests/vps-built-article-extraction.test.mjs, vite.vps.config.ts, scripts/build-vps.mjs) was " +
      "checked for reads of these three areas and none reads any of them, so those two lanes are " +
      "skipped. Check the same set again before adding a path here.",
  },
  {
    name: "frontend",
    patterns: ["app/**", "public/**", "styles/**", "private-app/**", "contributor-demo/**"],
    lanes: null,
    evidence:
      "A frontend path is observed by every lane, so this class takes the complete suite. " +
      "vite.vps.config.ts sets appDir: private-app and reads public/favicon.svg, so both " +
      "build-driven lanes see these paths: the compiled server lane (pnpm test builds with it) and " +
      "the article lane (test:build:articles runs pnpm build). tests/vps-built-serving.test.mjs also " +
      "compares the built favicon against public/favicon.svg in the server lane, and " +
      "vite.contributor.config.ts reads the same file for the demo build. An earlier revision of " +
      "this table let this class skip the server and article lanes, which was wrong: an import-only " +
      "grep does not see a root-relative file read like that favicon comparison.",
  },
  {
    name: "connector",
    patterns: ["src/**/*connector*", "src/**/connectors/**"],
    lanes: null,
    evidence:
      "Connector contracts are exercised from src/ by test:contracts (inside test:components) " +
      "and by the compiled server lane, so a connector change runs the complete suite.",
  },
  {
    name: "database",
    patterns: ["db/**"],
    lanes: null,
    evidence:
      "db/ is read by tests/helpers/ fixtures shared across several lanes, so a schema change " +
      "can be observed anywhere and runs the complete suite.",
  },
  {
    name: "workflow",
    patterns: [
      ".github/**",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig*.json",
      "vite*.config.*",
      "scripts/**",
      "tests/**",
    ],
    lanes: null,
    evidence:
      "Shared configuration and tooling. A change here can alter what any lane measures, and " +
      "tests/ changes the lanes themselves, so these run the complete suite.",
  },
  {
    name: "server",
    patterns: ["src/**", "**/dist-vps/**"],
    lanes: null,
    evidence:
      "src/ is read by 350 test imports, the largest single share in the repository, across the " +
      "server and component lanes, so it runs the complete suite.",
  },
];

export const UNKNOWN_CLASS = {
  name: "unknown",
  patterns: [],
  lanes: null,
  evidence: "Unclassified path. Refusing to guess a skip, so this runs the complete suite.",
};

// Translate the small glob dialect the class table uses: `**/` crosses directories
// and may match none, `**` crosses directories, `*` and `?` stay within a segment.
export function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index++;
        if (pattern[index + 1] === "/") {
          index++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(/[\\^$.|+()[\]{}]/, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

// Normalize the leading `./` and any backslashes so class patterns can be written
// one way and matched against any source of paths.
export function normalizePath(path) {
  return String(path).replace(/\\/g, "/").replace(/^\.\//, "");
}

export function classifyPath(path) {
  const normalized = normalizePath(path);
  for (const entry of CHANGE_CLASSES) {
    if (entry.patterns.some((pattern) => globToRegExp(pattern).test(normalized))) return entry;
  }
  return UNKNOWN_CLASS;
}

// Parse `git diff --name-status` output. Rejects anything it cannot read with
// certainty rather than skipping it: an unparsed line is an unclassified path.
export function parseNameStatus(diffText) {
  const paths = new Set();
  const uncertain = [];
  const renames = [];
  const deletions = [];
  const lines = String(diffText).split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    // An empty diff cannot be distinguished from a diff this tool failed to read.
    uncertain.push("the changed-path list was empty, so no routing decision can be proven");
    return { paths: [], uncertain, renames, deletions };
  }
  for (const line of lines) {
    const fields = line.split("\t");
    const status = fields[0] ?? "";
    if (!/^[A-Z]\d*$/.test(status)) {
      uncertain.push(`could not read the diff line: ${line.trim().slice(0, 80)}`);
      continue;
    }
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      if (fields.length < 3) {
        uncertain.push(`a rename or copy line was missing a path: ${line.trim().slice(0, 80)}`);
        continue;
      }
      // Both sides are classified: a file that moved between classes must satisfy
      // both of them, which is a union rather than a guess about which one wins.
      paths.add(normalizePath(fields[1]));
      paths.add(normalizePath(fields[2]));
      renames.push(`${normalizePath(fields[1])} -> ${normalizePath(fields[2])}`);
      continue;
    }
    if (fields.length < 2 || fields[1].trim() === "") {
      uncertain.push(`a changed-path line was missing its path: ${line.trim().slice(0, 80)}`);
      continue;
    }
    paths.add(normalizePath(fields[1]));
    if (kind === "D") deletions.push(normalizePath(fields[1]));
  }
  return { paths: [...paths].sort(), uncertain, renames, deletions };
}

export function routeChanges({ paths = [], uncertain = [], renames = [], deletions = [] } = {}) {
  const classes = new Map();
  const lanes = Object.fromEntries(LANES.map((lane) => [lane, false]));
  const reasons = [...uncertain];
  let full = reasons.length > 0;

  for (const path of paths) {
    const entry = classifyPath(path);
    classes.set(entry.name, entry);
    if (entry.lanes === null) {
      full = true;
      continue;
    }
    for (const lane of entry.lanes) lanes[lane] = true;
  }

  // The complete suite is the conservative answer for anything unproven, and a
  // change that touches nothing classifiable is not evidence of a safe skip.
  for (const lane of LANES) if (full) lanes[lane] = true;

  const ordered = [...classes.keys()].sort();
  if (full && reasons.length === 0) {
    reasons.push(
      ordered.length === 0
        ? "no changed paths were classified"
        : `classes needing the complete suite: ${ordered.join(", ")}`,
    );
  }
  return {
    classes: ordered,
    lanes: { quick: true, ...lanes },
    full,
    reasons,
    renames,
    deletions,
  };
}

// The other half of the invariant: every lane the fast path did not run has to be
// run by the merge gate. The workflow reads these as `needs.route.outputs.<lane>`,
// so the gate cannot silently drop one.
export function gateLanes(decision) {
  return LANES.filter((lane) => !decision.lanes[lane]);
}

export function routeDiff(diffText) {
  return routeChanges(parseNameStatus(diffText));
}

export function formatDecision(decision) {
  const lines = [
    `quick=${decision.lanes.quick}`,
    ...LANES.map((lane) => `${lane}=${decision.lanes[lane]}`),
    `full=${decision.full}`,
    `classes=${decision.classes.join(",")}`,
    `gate=${gateLanes(decision).join(",") || "none"}`,
    `reason=${decision.reasons.join("; ").replace(/\n/g, " ")}`,
  ];
  return `${lines.join("\n")}\n`;
}

function main() {
  const [file] = process.argv.slice(2);
  const diffText = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
  const decision = routeDiff(diffText);
  const rendered = formatDecision(decision);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, rendered);
  const target = process.stdout;
  target.write(
    `path routing: classes=${decision.classes.join(",") || "none"} ` +
      `full=${decision.full} gate=${gateLanes(decision).join(",") || "none"}\n`,
  );
  target.write(rendered);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
