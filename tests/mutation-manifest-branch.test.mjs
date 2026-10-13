import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repository = resolve(".");
const workflow = readFileSync(join(repository, ".github/workflows/ci.yml"), "utf8");
const marker = "      - name: Find this branch's mutation manifest";
const start = workflow.indexOf(marker);
assert.notEqual(start, -1);
const step = workflow.slice(start, workflow.indexOf("      - uses:", start));
const body = step.split("        run: |\n")[1].split("\n").map(line => line.slice(10)).join("\n");

function git(root, ...args) {
  // Disposable input commits use a role identity, independent of host/CI config.
  // Branch commits retain the checkout's configured identity.
  const result = spawnSync("git", args, {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, GIT_AUTHOR_NAME: "the fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "the fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t, initial = {}) {
  // The clean-clone proof must work without pre-existing scratch directories.
  const scratch = join(repository, ".test-tmp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "fu021-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content = "[]\n") => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  for (const [path, content] of Object.entries(initial)) write(path, content);
  git(root, "init", "-q");
  const commit = () => {
    git(root, "add", ".");
    git(root, "commit", "--allow-empty", "-qm", "fixture revision");
    return git(root, "rev-parse", "HEAD");
  };
  const base = commit();
  return { root, write, commit, base };
}

function run(f, { branch = "cook/fu021", base = f.base, ref = "unrelated" } = {}) {
  const script = "scripts/ci/check-mutation-manifest-branch.sh";
  // Copy the real checker into the disposable Git checkout; fixtures create
  // changed PR inputs only. The product writes GITHUB_OUTPUT, which starts absent.
  let source;
  try { source = readFileSync(join(repository, script), "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (source !== undefined) {
    f.write(script, source);
  }
  const outputPath = join(f.root, "step-output");
  assert.equal(existsSync(outputPath), false, "fixture leaves product output absent");
  const result = spawnSync("bash", ["-c", body], {
    cwd: f.root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, HEAD_REF: branch, REF_NAME: ref, BASE_SHA: base, GITHUB_OUTPUT: outputPath },
  });
  const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  return { ...result, output };
}

function refusal(result, expected, found) {
  assert.equal(result.status, 1, `mismatch must refuse: ${result.stdout}${result.stderr}`);
  assert.ok(result.stderr.includes(`expected '${expected}'`), result.stderr);
  assert.ok(result.stderr.includes(`found '${found}'`), result.stderr);
  assert.equal(result.output, "", "refusal must not publish mutation-selection outputs");
}

test("matching changed manifest selects branch mutations", t => {
  const f = fixture(t); f.write("mutation-checks/cook-fu021.json"); f.commit();
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "path=mutation-checks/cook-fu021.json\nexists=true\n");
});

test("mismatched added manifest refuses with expected and found names", t => {
  // Recorded escape: a renamed branch added the previous branch name.
  const f = fixture(t); f.write("mutation-checks/cook-updater-classify.json"); f.commit();
  refusal(run(f, { branch: "cook/updater-classify-v2" }),
    "mutation-checks/cook-updater-classify-v2.json", "mutation-checks/cook-updater-classify.json");
});

test("modified foreign manifest passes when matching manifest exists", t => {
  const f = fixture(t, { "mutation-checks/cook-previous.json": "[]\n", "mutation-checks/cook-fu021.json": "[]\n" });
  f.write("mutation-checks/cook-previous.json", "[{}]\n"); f.commit();
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "path=mutation-checks/cook-fu021.json\nexists=true\n");
});

test("modified foreign manifest passes when matching manifest is absent", t => {
  const f = fixture(t, { "mutation-checks/shared.json": "[]\n" });
  f.write("mutation-checks/shared.json", "[{}]\n"); f.commit();
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "path=mutation-checks/cook-fu021.json\nexists=false\n");
});

test("foreign addition alongside own manifest passes", t => {
  const f = fixture(t);
  f.write("mutation-checks/shared.json"); f.write("mutation-checks/cook-fu021.json"); f.commit();
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "path=mutation-checks/cook-fu021.json\nexists=true\n");
});

test("no changed manifest preserves absent-manifest behavior", t => {
  const f = fixture(t, { "mutation-checks/cook-previous.json": "[]\n" });
  f.write("README.md", "change\n"); f.commit();
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "path=mutation-checks/cook-fu021.json\nexists=false\n");
});

test("rename into the derived filename passes", t => {
  const f = fixture(t, { "mutation-checks/cook-previous.json": "[]\n" });
  git(f.root, "mv", "mutation-checks/cook-previous.json", "mutation-checks/cook-fu021.json"); f.commit();
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "path=mutation-checks/cook-fu021.json\nexists=true\n");
});

test("rename away from the derived filename refuses the destination", t => {
  const f = fixture(t, { "mutation-checks/cook-fu021.json": "[]\n" });
  git(f.root, "mv", "mutation-checks/cook-fu021.json", "mutation-checks/wrong.json"); f.commit();
  refusal(run(f), "mutation-checks/cook-fu021.json", "mutation-checks/wrong.json");
});

test("deleted other-branch manifest is not an added or modified manifest", t => {
  const f = fixture(t, { "mutation-checks/cook-previous.json": "[]\n" });
  git(f.root, "rm", "mutation-checks/cook-previous.json"); f.commit();
  assert.equal(run(f).status, 0);
});

test("every branch slash is replaced and shell metacharacters stay literal", t => {
  const f = fixture(t); f.write("mutation-checks/cook-topic-$(false).json"); f.commit();
  const result = run(f, { branch: "cook/topic/$(false)" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "path=mutation-checks/cook-topic-$(false).json\nexists=true\n");
});

test("newline and unicode changed filename is compared without line parsing", t => {
  const f = fixture(t); f.write("mutation-checks/wrong\n雪.json"); f.commit();
  refusal(run(f), "mutation-checks/cook-fu021.json", "mutation-checks/wrong\n雪.json");
});

test("unreadable PR base fails rather than accepting unknown changes", t => {
  const f = fixture(t); f.write("mutation-checks/cook-fu021.json"); f.commit();
  const result = run(f, { base: "missing-revision" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing-revision/);
});

test("non-PR fallback keeps existing branch selection without a PR diff", t => {
  const f = fixture(t); f.write("mutation-checks/cook-fu021.json"); f.commit();
  const result = run(f, { branch: "", ref: "cook/fu021", base: "" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "path=mutation-checks/cook-fu021.json\nexists=true\n");
});

test("rename to foreign manifest passes when own manifest remains at HEAD", t => {
  const f = fixture(t, { "mutation-checks/cook-fu021.json": "[]\n", "mutation-checks/previous.json": "[]\n" });
  git(f.root, "mv", "mutation-checks/previous.json", "mutation-checks/other.json"); f.commit();
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "path=mutation-checks/cook-fu021.json\nexists=true\n");
});
