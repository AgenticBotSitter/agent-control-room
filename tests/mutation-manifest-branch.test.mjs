import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    env: { ...process.env, HEAD_REF: branch, REF_NAME: ref, BASE_SHA: base, GITHUB_OUTPUT: outputPath, RUNNER_TEMP: f.root },
  });
  const output = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  const list = /^list=(.*)$/m.exec(output)?.[1];
  const manifests = list && existsSync(list) ? readFileSync(list, "utf8").split("\0").filter(Boolean) : [];
  return { ...result, output: output.replace(/^list=.*\n/m, ""), manifests, list };
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
  assert.equal(result.output, "path=mutation-checks/cook-fu021.json\nexists=true\n");
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


test("R1 modified foreign manifest is selected when own manifest is absent", t => {
  const f = fixture(t, { "mutation-checks/shared.json": "[]\n" });
  f.write("mutation-checks/shared.json", "[{}]\n"); f.commit();
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.manifests, ["mutation-checks/shared.json"], "modified manifest must be verified");
});

test("R2 tree at own manifest path refuses before publishing selection", t => {
  const f = fixture(t);
  f.write("mutation-checks/cook-fu021.json/child", "tree input");
  f.write("mutation-checks/foreign.json"); f.commit();
  const result = run(f);
  assert.equal(result.status, 1, "a tree is not a manifest blob");
  assert.match(result.stderr, /not a regular manifest blob/);
  assert.equal(result.output, "");
});


test("all changed manifests plus unchanged own manifest are selected once", t => {
  const f = fixture(t, { "mutation-checks/cook-fu021.json": "[]\n", "mutation-checks/old.json": "[]\n" });
  f.write("mutation-checks/old.json", "[{}]\n");
  f.write("mutation-checks/new space 雪.json"); f.commit();
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.manifests, ["mutation-checks/cook-fu021.json", "mutation-checks/new space 雪.json", "mutation-checks/old.json"]);
});

test("symlink at own manifest path refuses a nonregular blob", t => {
  const f = fixture(t, { "target": "[]\n" });
  mkdirSync(join(f.root, "mutation-checks"));
  symlinkSync("../target", join(f.root, "mutation-checks/cook-fu021.json")); f.commit();
  const result = run(f);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a regular manifest blob/);
  assert.equal(result.output, "");
});

test("modified foreign symlink refuses even when own manifest exists", t => {
  const f = fixture(t, { "target": "[]\n", "mutation-checks/cook-fu021.json": "[]\n", "second": "[]\n" });
  symlinkSync("../target", join(f.root, "mutation-checks/shared.json")); const base = f.commit();
  rmSync(join(f.root, "mutation-checks/shared.json"));
  symlinkSync("../second", join(f.root, "mutation-checks/shared.json")); f.commit();
  const result = run(f, { base });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a regular manifest blob/);
  assert.equal(result.output, "");
});

const verifyStep = workflow.split("      - name: Re-run declared guard mutations\n")[1].split("      - name:")[0];
const verifyBody = verifyStep.includes("        run: |\n")
  ? verifyStep.split("        run: |\n")[1].split("\n").map(line => line.slice(10)).join("\n")
  : verifyStep.split("        run: ")[1].trim();

function verifierFixture(t, { firstFails = false } = {}) {
  const f = fixture(t, {
    ".gitignore": "step-output\nmutation-manifests.*\n",
    "scripts/ci/check-mutation-manifest-branch.sh": readFileSync(join(repository, "scripts/ci/check-mutation-manifest-branch.sh"), "utf8"),
    "scripts/ci/verify-mutation-checks.mjs": readFileSync(join(repository, "scripts/ci/verify-mutation-checks.mjs"), "utf8"),
    "guard.mjs": "export const permitted = false;\n",
    "guard.test.mjs": 'import assert from "node:assert/strict"; import test from "node:test"; import { permitted } from "./guard.mjs"; test("literal refusal is enforced", () => assert.equal(permitted, false));\n',
    "failing.test.mjs": 'import assert from "node:assert/strict"; import test from "node:test"; test("intentional baseline failure", () => assert.equal(true, false));\n',
    "mutation-checks/first.json": "[]\n",
    "mutation-checks/second.json": "[]\n",
  });
  const valid = JSON.stringify([{ file: "guard.mjs", find: "permitted = false", replace: "permitted = true", test: "node --test guard.test.mjs", why: "literal false from this synthetic input contract" }]);
  f.write("mutation-checks/first.json", firstFails ? valid.replace("node --test guard.test.mjs", "node --test failing.test.mjs") : valid);
  f.write("mutation-checks/second.json", valid); f.commit();
  return f;
}

function verify(f, result) {
  const env = { ...process.env, MANIFEST_LIST: result.list ?? "missing-list", MANIFEST: "mutation-checks/cook-fu021.json" };
  // Nested test runners must not inherit the parent node:test execution marker.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync("bash", ["-e", "-c", verifyBody], {
    cwd: f.root, encoding: "utf8", timeout: 30_000,
    env,
  });
}

test("real verifier runs every modified manifest without an own manifest", t => {
  const f = verifierFixture(t);
  const selected = run(f);
  assert.equal(selected.status, 0, selected.stderr);
  const result = verify(f, selected);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal((result.stdout.match(/the mutation was caught/g) ?? []).length, 2, "both real manifest mutations must run");
  assert.match(result.stdout, /tests 1/);
  assert.equal(readFileSync(join(f.root, "guard.mjs"), "utf8"), "export const permitted = false;\n", "verifier restores guard");
});

test("verifier loop keeps going after failure and fails the aggregate", t => {
  const f = verifierFixture(t, { firstFails: true });
  const selected = run(f);
  assert.equal(selected.status, 0, selected.stderr);
  const result = verify(f, selected);
  assert.equal(result.status, 1, "a failed manifest must fail the job");
  assert.match(result.stdout, /intentional baseline failure/);
  assert.match(result.stdout, /Verifying mutation manifest: mutation-checks\/second.json/);
  assert.match(result.stdout, /the mutation was caught/, "later real verifier must complete");
  // Retry uses the same selected list after repairing the intentionally bad input.
  f.write("mutation-checks/first.json", readFileSync(join(f.root, "mutation-checks/second.json"), "utf8")); f.commit();
  const retried = verify(f, selected);
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert.equal((retried.stdout.match(/the mutation was caught/g) ?? []).length, 2);
});

test("nested JSON files are not top-level manifests", t => {
  const f = fixture(t, { "mutation-checks/cook-fu021.json": "[]\n" });
  f.write("mutation-checks/nested/other.json"); f.commit();
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.manifests, ["mutation-checks/cook-fu021.json"], "nested JSON must not be passed to a verifier that ignores it");
});

test("nested JSON addition without own manifest preserves empty selection", t => {
  const f = fixture(t);
  f.write("mutation-checks/nested/other.json"); f.commit();
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "path=mutation-checks/cook-fu021.json\nexists=false\n");
  assert.deepEqual(result.manifests, []);
});
