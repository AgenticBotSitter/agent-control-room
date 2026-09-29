import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkReadmeStatus, checkRepositoryReadme } from "../scripts/check-readme-status.mjs";
import { skipDecision } from "../scripts/check-private-names.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const guard = join(repositoryRoot, "scripts/check-private-names.mjs");
const installer = join(repositoryRoot, "scripts/install-private-name-hook.mjs");
const REPOSITORY = "ExampleOrg/agent-control-room";
const FORK = "ExternalContributor/agent-control-room";

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "control-room-private-name-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Fixture"]);
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts/check-private-names.mjs"), `#!/bin/sh\nexit 0\n`);
  writeFileSync(join(root, "safe.txt"), "ordinary public text\n");
  git(root, ["add", "."]);
  return root;
}

// The shape GitHub writes for a pull_request event: which repository the workflow runs
// in, and which one the pull request came from. A fork is exactly the case where those
// two differ, which is the whole basis for the skip.
function pullRequestEvent({ head = REPOSITORY, base = REPOSITORY } = {}) {
  const file = join(mkdtempSync(join(tmpdir(), "control-room-event-")), "event.json");
  writeFileSync(file, JSON.stringify({
    pull_request: { head: { repo: { full_name: head } } },
    repository: { full_name: base },
  }));
  return file;
}

test("guard skips cleanly when no private-name list is configured", () => {
  const root = fixture();
  try {
    const result = spawnSync(process.execPath, [guard], { cwd: root, encoding: "utf8", env: {} });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "private-name check skipped: no list configured (not a GitHub Actions run)");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a GitHub Actions run of this repository with no list fails closed, and says what to set", () => {
  const root = fixture();
  const event = pullRequestEvent();
  try {
    const result = spawnSync(process.execPath, [guard], {
      cwd: root,
      encoding: "utf8",
      env: { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_PATH: event },
    });
    assert.equal(result.status, 1, "an unconfigured guard must not report a clean scan in CI");
    assert.match(result.stderr, /no list configured, so nothing was scanned/u);
    assert.match(result.stderr, /CONTROL_ROOM_PRIVATE_NAMES/u, "the message must name the setting the owner controls");
    assert.equal(result.stdout.trim(), "", "a refusal must not also claim it passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(event, { force: true });
  }
});

test("a fork pull request skips with its reason, because it can never receive the secret", () => {
  const root = fixture();
  const event = pullRequestEvent({ head: FORK });
  try {
    const result = spawnSync(process.execPath, [guard], {
      cwd: root,
      encoding: "utf8",
      env: { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_PATH: event },
    });
    assert.equal(result.status, 0, "an external contributor must not be failed on a step they cannot fix");
    assert.match(result.stdout, /^private-name check skipped: no list configured \(fork pull request from ExternalContributor\/agent-control-room\)/u);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(event, { force: true });
  }
});

test("an unreadable or absent event payload is not treated as a fork", () => {
  const root = fixture();
  const unreadable = join(root, "not-json.json");
  writeFileSync(unreadable, "this is not JSON\n");
  const emptyPayload = join(root, "empty.json");
  writeFileSync(emptyPayload, JSON.stringify({ repository: { full_name: REPOSITORY } }));
  try {
    for (const env of [
      { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: REPOSITORY },
      { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_PATH: unreadable },
      { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_PATH: emptyPayload },
    ]) {
      const result = spawnSync(process.execPath, [guard], { cwd: root, encoding: "utf8", env });
      assert.equal(result.status, 1, `unprovable input must fail closed: ${JSON.stringify(env)}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("skipDecision separates a local run, a fork and a same-repository run", () => {
  const sameRepository = pullRequestEvent();
  const fork = pullRequestEvent({ head: FORK });
  try {
    assert.deepEqual(skipDecision({}), { skip: true, reason: "not a GitHub Actions run" });
    assert.equal(skipDecision({ GITHUB_ACTIONS: "false" }).skip, true, "the string matters: only the literal true is Actions");
    assert.equal(skipDecision({ GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: sameRepository, GITHUB_REPOSITORY: REPOSITORY }).skip, false);
    assert.equal(skipDecision({ GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: fork, GITHUB_REPOSITORY: REPOSITORY }).skip, true);
    assert.equal(skipDecision({ GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: sameRepository }).skip, false,
      "the payload's own repository.full_name is enough, with no GITHUB_REPOSITORY fallback");
    assert.equal(skipDecision({ GITHUB_ACTIONS: "TRUE", GITHUB_EVENT_PATH: fork }).skip, true,
      "GitHub writes lowercase true; anything else is not a recognised Actions run");
  } finally {
    rmSync(sameRepository, { force: true });
    rmSync(fork, { force: true });
  }
});

test("a configured-but-blank list is treated as no list, not as a clean scan", () => {
  const root = fixture();
  const blankFile = join(root, "blank-names.txt");
  writeFileSync(blankFile, "\n  \n\n");
  try {
    for (const env of [
      { CONTROL_ROOM_PRIVATE_NAMES: "   \n\n" },
      { CONTROL_ROOM_PRIVATE_NAMES_FILE: blankFile },
    ]) {
      const result = spawnSync(process.execPath, [guard], { cwd: root, encoding: "utf8", env });
      assert.equal(result.status, 0);
      assert.match(result.stdout, /^private-name check skipped: no list configured/u);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the guard is driven against the real repository checkout, not a fixture", () => {
  // The wiring evidence for this guard is a real scan of the real tree: a term that
  // exists nowhere in this repository must be reported as absent, and one that exists
  // everywhere must be found. A fixture cannot show that the production entry point
  // reads the repository the owner actually pushes.
  //
  // The absent term is assembled from parts so that this file does not itself contain
  // the literal it is asserting is missing — otherwise the scan would correctly find
  // it here and the test would be asserting the opposite of what it means.
  const absentTerm = ["Synthetic", "Absent", "Term", "For", "This", "Repository"].join("");
  const absent = spawnSync(process.execPath, [guard], {
    cwd: repositoryRoot, encoding: "utf8",
    env: { CONTROL_ROOM_PRIVATE_NAMES: absentTerm },
  });
  assert.equal(absent.status, 0, `a term absent from the tree must pass: ${absent.stderr}`);
  assert.equal(absent.stdout.trim(), "private-name check passed");

  const presentTerm = ["agent-control", "room"].join("-");
  const present = spawnSync(process.execPath, [guard], {
    cwd: repositoryRoot, encoding: "utf8",
    env: { CONTROL_ROOM_PRIVATE_NAMES: presentTerm },
  });
  assert.equal(present.status, 1, "a term that is all over this tree must be found by the real scan");
  assert.match(present.stderr, /private name <redacted>/u);
  assert.doesNotMatch(present.stderr, new RegExp(presentTerm, "u"),
    "the matched term must not be disclosed in the output");
});

test("a push to main fails closed and says it is a push, not an unreadable payload", () => {
  // The workflow also runs on `push: branches:[main]` and `workflow_dispatch`. Those are
  // unambiguously runs of this repository, so they fail closed -- but the message has to
  // name the event that actually happened, or an owner reading a red main build is told
  // the payload was unreadable when it was read perfectly well.
  const root = fixture();
  const dir = mkdtempSync(join(tmpdir(), "control-room-event-"));
  const pushEvent = join(dir, "push.json");
  const dispatchEvent = join(dir, "dispatch.json");
  writeFileSync(pushEvent, JSON.stringify({
    event_name: "push", ref: "refs/heads/main", repository: { full_name: REPOSITORY },
  }));
  writeFileSync(dispatchEvent, JSON.stringify({
    event_name: "workflow_dispatch", repository: { full_name: REPOSITORY },
  }));
  try {
    const push = spawnSync(process.execPath, [guard], {
      cwd: root, encoding: "utf8",
      env: { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_PATH: pushEvent },
    });
    assert.equal(push.status, 1, "a push to main is a run of this repository and must not skip");
    assert.match(push.stderr, /a push event, which is a run of this repository/u);
    assert.doesNotMatch(push.stderr, /unreadable|could not be read/u,
      "the payload was readable; saying otherwise sends an owner down the wrong path");

    const dispatch = skipDecision({
      GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_PATH: dispatchEvent,
    });
    assert.equal(dispatch.skip, false);
    assert.match(dispatch.reason, /^a workflow_dispatch event/u);

    // The event name is echoed into a CI log, so a crafted payload must not reach it.
    const hostileEvent = join(dir, "hostile.json");
    writeFileSync(hostileEvent, JSON.stringify({
      event_name: "push\n::error::injected", repository: { full_name: REPOSITORY },
    }));
    const hostile = skipDecision({
      GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: hostileEvent,
    });
    assert.equal(hostile.skip, false, "a readable non-fork payload still fails closed");
    assert.match(hostile.reason, /a non-pull-request event/u);
    assert.doesNotMatch(hostile.reason, /::error::/u, "no payload text may reach the CI log");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guard finds case-insensitive content and filename matches without disclosing the term", () => {
  const root = fixture();
  try {
    const privateTerm = "SyntheticPrivateTerm";
    writeFileSync(join(root, "safe.txt"), "prefix syntheticprivateterm suffix\n");
    writeFileSync(join(root, `${privateTerm}.txt`), "otherwise safe\n");
    git(root, ["add", "."]);
    const result = spawnSync(process.execPath, [guard], {
      cwd: root, encoding: "utf8", env: { CONTROL_ROOM_PRIVATE_NAMES: `${privateTerm}\n` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /safe\.txt:1: private name <redacted>/);
    assert.match(result.stderr, /<redacted>\.txt:0: private name <redacted>/);
    assert.doesNotMatch(result.stderr.toLocaleLowerCase(), new RegExp(privateTerm.toLocaleLowerCase()));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("guard prefers the configured file and passes a clean tracked tree", () => {
  const root = fixture();
  try {
    const namesFile = join(root, "..", "private-name-fixture.txt");
    writeFileSync(namesFile, "SyntheticPrivateTerm\n");
    const result = spawnSync(process.execPath, [guard], {
      cwd: root, encoding: "utf8",
      env: { CONTROL_ROOM_PRIVATE_NAMES: "ordinary", CONTROL_ROOM_PRIVATE_NAMES_FILE: namesFile },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "private-name check passed");
    rmSync(namesFile, { force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("installer creates an executable, idempotent hook and preserves unrelated hooks", () => {
  const root = fixture();
  try {
    const namesFile = join(root, "private-names.txt");
    writeFileSync(namesFile, "SyntheticPrivateTerm\n");
    const env = { ...process.env, CONTROL_ROOM_PRIVATE_NAMES_FILE: namesFile };
    const first = spawnSync(process.execPath, [installer], { cwd: root, encoding: "utf8", env });
    assert.equal(first.status, 0, first.stderr);
    const hookPath = join(root, git(root, ["rev-parse", "--git-path", "hooks"]), "pre-push");
    assert.match(readFileSync(hookPath, "utf8"), /control-room-private-name-hook:v1/);
    assert.notEqual(statSync(hookPath).mode & 0o111, 0);
    const second = spawnSync(process.execPath, [installer], { cwd: root, encoding: "utf8", env });
    assert.equal(second.status, 0, second.stderr);

    writeFileSync(hookPath, "#!/bin/sh\nexit 0\n");
    chmodSync(hookPath, 0o755);
    const refused = spawnSync(process.execPath, [installer], { cwd: root, encoding: "utf8", env });
    assert.equal(refused.status, 1);
    assert.equal(readFileSync(hookPath, "utf8"), "#!/bin/sh\nexit 0\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const truthfulReadme = `# Agent Control Room

## Current product status

**Source-backed today:** The Mac-local owner path is covered against disposable PostgreSQL.

**Not yet owner-accepted:** There is no supported downloadable release. The owner guide remains a draft.
`;

test("README status guard accepts explicit source, disposable, owner and release boundaries", () => {
  assert.deepEqual(checkReadmeStatus(truthfulReadme), []);
  assert.deepEqual(checkRepositoryReadme(repositoryRoot), []);
});

test("README status guard refuses missing boundaries and audited stale claims", () => {
  const missing = checkReadmeStatus("# Agent Control Room\n\nReady for everyone.\n");
  assert.equal(missing.length, 6);
  assert.ok(missing.every(finding => finding.startsWith("missing ")));

  for (const claim of [
    "**Still to finish:** real Hermes/Codex integration and recovery",
    "It passes 30 demo tests.",
    "This source preview includes an explicit `pnpm demo` command. No live agent-runtime/platform combination is claimed supported by this preview.",
    "The current baseline has the bounded Claude Code connector foundation.",
    "Hermes and Codex are the first integration priorities. Claude Code, OpenClaw and other harnesses are proposed contributor tracks, not current compatibility claims.",
  ]) {
    const findings = checkReadmeStatus(`${truthfulReadme}\n${claim}\n`);
    assert.equal(findings.length, 1, claim);
    assert.match(findings[0], /^stale /u);
  }
});
