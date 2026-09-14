import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CHANGE_CLASSES,
  LANES,
  formatDecision,
  gateLanes,
  globToRegExp,
  parseNameStatus,
  routeChanges,
  routeDiff,
} from "../scripts/ci-path-routing.mjs";

const workflow = readFileSync(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");

function decisionFor(...paths) {
  return routeChanges({ paths });
}

// --- class mapping -------------------------------------------------------

test("a docs-only change runs only the quick check and skips every heavy lane", () => {
  const decision = decisionFor("docs/contributors/worker-inbox/README.md", "CONTRIBUTOR_HANDBOOK.md");
  assert.deepEqual(decision.classes, ["docs"]);
  assert.equal(decision.full, false);
  assert.deepEqual(gateLanes(decision), LANES, "every heavy lane must be left to the merge gate");
  assert.equal(decision.lanes.quick, true, "the quick check is never skipped");
  for (const lane of LANES) assert.equal(decision.lanes[lane], false, `${lane} must be skipped`);
});

test("a generated docs artifact is inert too, because it is written rather than read", () => {
  // docs/license-inventory.json is an output of scripts/license-inventory.mjs and no
  // test reads it, so it must not be treated as a release input by accident.
  assert.deepEqual(decisionFor("docs/license-inventory.json").classes, ["docs"]);
  assert.equal(decisionFor("docs/license-inventory.json").full, false);
});

test("a frontend change runs the demo and component lanes but not the server or article lanes", () => {
  const decision = decisionFor("private-app/routes/article-reader.tsx", "contributor-demo/panels.ts");
  assert.deepEqual(decision.classes, ["frontend"]);
  assert.equal(decision.lanes.demo, true);
  assert.equal(decision.lanes.components, true);
  assert.equal(decision.lanes.server, false, "the compiled server lane does not read the frontend");
  assert.equal(decision.lanes.articles, false);
  assert.deepEqual(gateLanes(decision).sort(), ["articles", "server"]);
});

test("a release change runs the server and component lanes", () => {
  const decision = decisionFor("third_party/jsdom/LICENSE.txt", "deploy/operator-config.mjs");
  assert.deepEqual(decision.classes, ["release"]);
  assert.equal(decision.lanes.server, true);
  assert.equal(decision.lanes.components, true);
  assert.equal(decision.lanes.demo, false);
});

test("a database change runs the complete suite", () => {
  const decision = decisionFor("db/migrations/0018_worker.sql");
  assert.deepEqual(decision.classes, ["database"]);
  assert.equal(decision.full, true);
  assert.deepEqual(gateLanes(decision), [], "a full decision leaves nothing for the gate");
  for (const lane of LANES) assert.equal(decision.lanes[lane], true);
});

test("a connector change runs the complete suite", () => {
  assert.equal(decisionFor("src/server/hermes-gpt-connector.ts").classes[0], "connector");
  assert.equal(decisionFor("src/server/hermes-gpt-connector.ts").full, true);
  assert.equal(decisionFor("src/connectors/native.ts").full, true);
});

test("workflow, lockfile and test changes run the complete suite", () => {
  for (const path of [
    ".github/workflows/ci.yml",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.vps.json",
    "scripts/check-test-lane-coverage.mjs",
    "tests/worker-inbox-platform.test.mjs",
  ]) {
    const decision = decisionFor(path);
    assert.equal(decision.full, true, `${path} must run the complete suite`);
  }
});

test("an unclassified path refuses to guess and runs the complete suite", () => {
  const decision = decisionFor("newarea/thing.bin");
  assert.deepEqual(decision.classes, ["unknown"]);
  assert.equal(decision.full, true);
  assert.match(decision.reasons.join(" "), /unknown/u);
});

test("one unclassified path in an otherwise light change still forces the complete suite", () => {
  const decision = decisionFor("docs/README.md", "mystery/payload.dat");
  assert.equal(decision.full, true, "a single unknown path must not be skipped over");
});

// --- diff parsing --------------------------------------------------------

test("a rename is classified on both sides, so a move between classes cannot slip through", () => {
  const light = routeDiff("R100\tdocs/old.md\tdocs/new.md\n");
  assert.equal(light.full, false, "a docs-to-docs move stays light");
  const heavy = routeDiff("R100\tdocs/old.md\tsrc/server/old.ts\n");
  assert.equal(heavy.full, true, "a move into src/ must run the complete suite");
  assert.deepEqual(heavy.renames, ["docs/old.md -> src/server/old.ts"]);
  const outOfDocs = routeDiff("R100\tdocs/old.md\tmystery/old.bin\n");
  assert.equal(outOfDocs.full, true, "a move into an unknown area must run the complete suite");
});

test("markdown is documentation wherever it lives, which is why a .md rename stays light", () => {
  // The docs class owns `**/*.md` deliberately: no lane reads markdown, so a
  // markdown file at any path is inert. This case records that intent, because it
  // is the difference between a safe skip and a guessed one.
  for (const path of ["README.md", "docs/deep/nested/guide.md", "src/server/notes.md"]) {
    assert.deepEqual(decisionFor(path).classes, ["docs"], `${path} should be inert`);
    assert.equal(decisionFor(path).full, false, `${path} should not force the complete suite`);
  }
});

test("deletions are classified, and deleting a heavy path still runs the complete suite", () => {
  const light = routeDiff("D\tdocs/old.md\n");
  assert.equal(light.full, false);
  assert.deepEqual(light.deletions, ["docs/old.md"]);
  const heavy = routeDiff("D\tsrc/server/handler.ts\n");
  assert.equal(heavy.full, true, "a deletion of server code can change what every lane builds");
});

test("both sides of a rename and every changed path are reported, not just the first", () => {
  const parsed = parseNameStatus("M\tdocs/a.md\nA\tdocs/b.md\nR100\tdocs/c.md\tdocs/d.md\nD\tdocs/e.md\n");
  assert.deepEqual(parsed.paths, ["docs/a.md", "docs/b.md", "docs/c.md", "docs/d.md", "docs/e.md"]);
  assert.equal(parsed.uncertain.length, 0);
});

test("diff uncertainty of every kind routes to the complete suite", () => {
  const empty = routeDiff("");
  assert.equal(empty.full, true);
  assert.match(empty.reasons.join(" "), /empty/u);

  const unreadable = routeDiff("M\tdocs/a.md\nnot a diff line at all\n");
  assert.equal(unreadable.full, true, "an unparsed line is an unclassified path");
  assert.match(unreadable.reasons.join(" "), /could not read/u);

  const missingPath = routeDiff("M\n");
  assert.equal(missingPath.full, true);

  const missingRenameTarget = routeDiff("R100\tdocs/a.md\n");
  assert.equal(missingRenameTarget.full, true);

  // The workflow path: uncertainty supplied directly must also force the gate.
  const declared = routeChanges({ paths: ["docs/a.md"], uncertain: ["the base revision was unavailable"] });
  assert.equal(declared.full, true);
  assert.deepEqual(gateLanes(declared), []);
});

test("the diff parser is quiet about certainty it does not have", () => {
  assert.equal(parseNameStatus("M\tdocs/a.md").uncertain.length, 0);
  assert.equal(parseNameStatus("A\tsrc/new.ts").uncertain.length, 0);
  assert.equal(parseNameStatus("T\tpackage.json").uncertain.length, 0);
});

// --- the invariant that makes skipping safe -----------------------------

test("for every possible decision the fast path plus the merge gate is the complete suite", () => {
  const samples = [
    [],
    ["docs/README.md"],
    ["CONTRIBUTOR_HANDBOOK.md", "docs/license-inventory.json"],
    ["private-app/shell.tsx"],
    ["third_party/jsdom/package.json"],
    ["src/server/handler.ts"],
    ["db/migrations/0001.sql"],
    [".github/workflows/ci.yml"],
    ["unknown/thing"],
    ["docs/README.md", "src/server/handler.ts"],
  ];
  for (const paths of samples) {
    for (const uncertain of [[], ["the base revision was unavailable"]]) {
      const decision = routeChanges({ paths, uncertain });
      const covered = new Set([...LANES.filter((lane) => decision.lanes[lane]), ...gateLanes(decision)]);
      assert.deepEqual(
        [...covered].sort(),
        [...LANES].sort(),
        `paths=${paths.join(",") || "(none)"} uncertain=${uncertain.length} left a lane unrun`,
      );
      for (const lane of gateLanes(decision)) {
        assert.equal(decision.lanes[lane], false, "the gate must not repeat a lane the fast path ran");
      }
    }
  }
});

test("the quick check is present in every decision", () => {
  for (const paths of [[], ["docs/README.md"], ["src/server/handler.ts"], ["unknown/x"]]) {
    assert.equal(routeChanges({ paths }).lanes.quick, true);
  }
});

// --- glob dialect --------------------------------------------------------

test("the glob dialect matches whole paths and crosses directories only where asked", () => {
  assert.ok(globToRegExp("**/*.md").test("README.md"), "**/ must match no directory at all");
  assert.ok(globToRegExp("**/*.md").test("docs/a/b/c.md"));
  assert.ok(!globToRegExp("docs/*.md").test("docs/a/b.md"), "* must stay inside a segment");
  assert.ok(globToRegExp("docs/**").test("docs/a/b.md"));
  assert.ok(!globToRegExp("docs/**").test("docsish/a.md"), "a pattern must not match a sibling prefix");
  assert.ok(globToRegExp("tsconfig*.json").test("tsconfig.vps.json"));
  assert.ok(!globToRegExp("tsconfig*.json").test("nested/tsconfig.vps.json"), "a bare pattern is rooted");
});

test("every class declares its evidence and the unknown class cannot claim lanes", () => {
  for (const entry of CHANGE_CLASSES) {
    assert.ok(entry.evidence && entry.evidence.length > 40, `${entry.name} must record its evidence`);
    assert.ok(entry.patterns.length > 0);
  }
  // Guard the ordering assumption: a broad pattern placed before a narrow one would
  // silently reclassify it, and the first-match rule makes order load-bearing.
  assert.equal(routeChanges({ paths: ["src/server/x.ts"] }).classes[0], "server");
  assert.equal(routeChanges({ paths: ["docs/a.md"] }).classes[0], "docs");
});

// --- the workflow itself -------------------------------------------------

test("the merge gate cannot be skipped by anything the pull request controls", () => {
  const gateJob = workflow.slice(workflow.indexOf("  merge-gate:"));
  assert.ok(gateJob.length > 0, "the merge gate job must exist");
  const header = gateJob.slice(0, gateJob.indexOf("    steps:"));
  assert.match(header, /if: \$\{\{ always\(\) \}\}/u, "the gate must run even when a lane fails");
  assert.ok(
    !/needs\.route\.outputs/u.test(header),
    "routing must never gate the merge-check job itself, only which lanes run early",
  );
});

test("every lane the fast path can skip has a merge-gate counterpart", () => {
  const gateJob = workflow.slice(workflow.indexOf("  merge-gate:"));
  for (const lane of LANES) {
    const condition = `needs.route.outputs.${lane} == 'false'`;
    assert.ok(
      workflow.includes(condition),
      `no gate condition runs the ${lane} lane when routing skips it`,
    );
  }
  // And the gate must not run a lane twice when the fast path already ran it.
  assert.ok(!/needs\.route\.outputs\.\w+ == 'true'/u.test(gateJob));
});

test("routing decisions reach the lanes through the route job's outputs", () => {
  assert.match(workflow, /^ {2}route:/mu, "the route job must exist");
  for (const lane of LANES) {
    assert.match(
      workflow,
      new RegExp(`needs\\.route\\.outputs\\.${lane}`, "u"),
      `the ${lane} lane does not read its routing flag`,
    );
  }
});

test("every action stays on the reviewed allowlist and stays pinned to a commit SHA", () => {
  const allowlist = new Map([
    ["actions/checkout", "11d5960a326750d5838078e36cf38b85af677262"],
    ["pnpm/action-setup", "b906affcce14559ad1aafd4ab0e942779e9f58b1"],
    ["actions/setup-node", "49933ea5288caeca8642d1e84afbd3f7d6820020"],
  ]);
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)].map((match) => ({
    reference: match[1],
    trailing: match[2],
  }));
  assert.ok(uses.length >= 6, "the workflow should still use the reviewed actions");
  for (const { reference, trailing } of uses) {
    const [name, pin] = reference.split("@");
    assert.ok(allowlist.has(name), `${name} is not on the reviewed allowlist`);
    assert.match(pin ?? "", /^[0-9a-f]{40}$/u, `${name} must be pinned to a full commit SHA`);
    assert.equal(pin, allowlist.get(name), `${name} pin does not match the reviewed revision`);
    assert.match(trailing, /#\s*v\d/u, `${name} should keep its readable version comment`);
  }
});

test("the workflow keeps its read-only, fork-safe shape", () => {
  assert.match(workflow, /^\s{2}pull_request:/mu, "pull_request must still trigger the workflow");
  // Anchored to the trigger key: the header comment also names this event in order
  // to say it must never be used, and a whole-file substring search matches that.
  assert.ok(
    !/^\s*pull_request_target:/mu.test(workflow),
    "pull_request_target must never be a trigger",
  );
  assert.match(workflow, /^permissions:\n {2}contents: read$/mu, "contents must stay read-only");
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/u);
  // Anchored to the expression form, not the word: the header comment says the run
  // has no access to secrets, and a substring search matches that prose.
  assert.ok(
    !/\$\{\{\s*secrets\./u.test(workflow),
    "the workflow must not read secrets",
  );
  assert.ok(!/runs-on:.*self-hosted/u.test(workflow), "no contributor-hosted runners");
  assert.match(workflow, /cancel-in-progress: true/u, "superseded runs must still cancel");
});

test("every lane command that ran before still runs, so no test loses its lane", () => {
  const commands = [
    "pnpm run check:demo",
    "pnpm run check",
    "pnpm run test:demo",
    "pnpm run test:build:demo",
    "pnpm run test",
    "pnpm run test:components",
    "node --import tsx --test tests/resource-bound-native-contract-v2.test.ts tests/resource-bound-codex-contract-v2.test.ts tests/resource-bound-local-start-contract-v2.test.ts",
    "pnpm run test:build:articles",
    "node --test tests/check-test-lane-coverage.test.mjs",
    "node scripts/check-test-lane-coverage.mjs",
  ];
  for (const command of commands) {
    assert.ok(workflow.includes(command), `the workflow no longer runs: ${command}`);
  }
});

test("no job output is interpolated into a shell command", () => {
  // The routing outputs are derived from the changed-path list, which a pull request
  // controls. Interpolating one into `run:` would let a crafted file name execute as
  // shell, so outputs must reach a step through `env:` and be quoted there. `if:`
  // conditions are evaluated by the runner rather than a shell and are exempt.
  const lines = workflow.split("\n");
  const offenders = [];
  for (let index = 0; index < lines.length; index++) {
    const match = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const indentation = match[1].length;
    const block = [match[2]];
    let cursor = index;
    while (++cursor < lines.length) {
      const next = /^(\s*)(.*)$/.exec(lines[cursor]);
      if (!next || (next[2].trim() && next[1].length <= indentation)) break;
      block.push(next[2]);
    }
    for (const line of block) {
      if (/\$\{\{[^}]*\boutputs\./u.test(line)) offenders.push(line.trim().slice(0, 90));
    }
  }
  assert.deepEqual(offenders, [], "job outputs must be passed through env:, never interpolated");
  // And the rule has to be doing something: the same scan must find the expressions
  // where they are legitimate, so a scan that silently matches nothing is caught.
  const legitimate = lines.filter((line) => /^\s*if: \$\{\{[^}]*\boutputs\./u.test(line));
  assert.ok(legitimate.length >= LANES.length, "the lane conditions should still read routing outputs");
});

test("the early and gate conditions partition every lane, so no case leaves a lane unrun", () => {
  // The two conditions are the exact complement of each other:
  //   early runs unless routing succeeded AND explicitly said false
  //   gate runs only when routing succeeded AND explicitly said false
  // That makes them mutually exclusive and exhaustive, so an empty output (a routing
  // script that emits nothing and still exits 0) runs the lane early instead of
  // letting both sides skip it, which would leave the lane unrun entirely.
  const lines = workflow.split("\n");
  for (const lane of LANES) {
    const early = lines.filter((line) => line.includes(`needs.route.outputs.${lane} != 'false'`));
    const gate = lines.filter((line) => line.includes(`needs.route.outputs.${lane} == 'false'`));
    assert.equal(early.length, 1, `expected one early condition for ${lane}`);
    assert.equal(gate.length, 1, `expected one gate condition for ${lane}`);
    assert.match(early[0], /needs\.route\.result != 'success' \|\|/u, "early must run when routing failed");
    assert.match(gate[0], /needs\.route\.result == 'success' &&/u, "gate must not double-run after a failure");
  }

  // Evaluate the two rules over every possible routing outcome and require that the
  // lane is run exactly once, whatever the outcome is.
  const earlyRuns = (result, output) => result !== "success" || output !== "false";
  const gateRuns = (result, output) => result === "success" && output === "false";
  for (const result of ["success", "failure", "cancelled"]) {
    for (const output of ["true", "false", ""]) {
      const runs = [earlyRuns(result, output), gateRuns(result, output)].filter(Boolean).length;
      assert.equal(
        runs,
        1,
        `route=${result} output='${output}' ran the lane ${runs} times, expected exactly once`,
      );
    }
  }
});

test("the routing helper is exercised by the workflow, not only by its test", () => {
  assert.match(workflow, /node scripts\/ci-path-routing\.mjs/u);
});

test("the decision is rendered in the shape the workflow consumes", () => {
  const rendered = formatDecision(routeChanges({ paths: ["docs/a.md"] }));
  for (const lane of LANES) assert.match(rendered, new RegExp(`^${lane}=(true|false)$`, "mu"));
  assert.match(rendered, /^quick=true$/mu);
  assert.match(rendered, /^full=(true|false)$/mu);
  assert.match(rendered, /^gate=/mu);
});
