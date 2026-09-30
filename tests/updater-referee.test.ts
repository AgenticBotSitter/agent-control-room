import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { classifyUpdaterCandidateV1 as classify, parseUpdaterCandidateTreeV1, parseUpdaterRawDiffV1,
  classifyUpdaterSettingV1, updaterPolicyGlobMatchesV1 as glob, UPDATER_REFEREE_MAX_DIFF_RECORDS_V1,
  UPDATER_REFEREE_MAX_RAW_DIFF_BYTES_V1, UPDATER_REFEREE_MAX_TREE_RECORDS_V1,
  UPDATER_REFEREE_PLAN_TIME_BUDGET_MS_V1,
  UpdaterRefereePlanTimeBudgetV1 } from
  "../src/updater/v1/referee";

const policyDirectory = new URL("../src/updater/v1/policy/", import.meta.url);
const policies = {
  protectedJson: readFileSync(new URL("protected.json", policyDirectory), "utf8"),
  classesJson: readFileSync(new URL("classes.json", policyDirectory), "utf8"),
};
const oid = (character: string) => character.repeat(40);
const zero = "0".repeat(40);
type Row = { oldMode?: string; newMode?: string; oldOid?: string; newOid?: string;
  status: string; oldPath?: string; newPath?: string };

function candidate(rows: Row[], blobs: Record<string, string> = {}) {
  let raw = "";
  const tree = new Map<string, { mode: string; oid: string }>();
  for (const row of rows) {
    const oldMode = row.oldMode ?? (row.status.startsWith("A") ? "000000" : "100644");
    const newMode = row.newMode ?? (row.status.startsWith("D") ? "000000" : "100644");
    const oldOid = row.oldOid ?? (oldMode === "000000" ? zero : oid("a"));
    const newOid = row.newOid ?? (newMode === "000000" ? zero : oid("b"));
    raw += `:${oldMode} ${newMode} ${oldOid} ${newOid} ${row.status}\0${row.oldPath ?? row.newPath}\0`;
    if (row.status.startsWith("R") || row.status.startsWith("C")) raw += `${row.newPath}\0`;
    if (row.status.startsWith("C") && row.oldPath) tree.set(row.oldPath, { mode: oldMode, oid: oldOid });
    const candidatePath = row.newPath ?? row.oldPath;
    if (!row.status.startsWith("D") && candidatePath) tree.set(candidatePath, { mode: newMode, oid: newOid });
  }
  const treeRaw = [...tree.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([path, value]) => `${value.mode} ${value.mode === "160000" ? "commit" : "blob"} ${value.oid}\t${path}\0`).join("");
  return { raw: new TextEncoder().encode(raw), treeRaw: new TextEncoder().encode(treeRaw), blobs };
}

const pathRow = (status: string, path: string, extra: Partial<Row> = {}): Row => ({ status, oldPath: path, ...extra });
const classOf = (rows: Row[], blobs: Record<string, string> = {}) => classify(policies, candidate(rows, blobs));
const refusalIds = (result: ReturnType<typeof classify>) => result.refusals.map(value => value.id);
const encode = (value: string) => new TextEncoder().encode(value);

function treeRaw(entries: Array<{ path: string; oid?: string; mode?: string }>) {
  return encode(entries.map(entry => {
    const mode = entry.mode ?? "100644";
    return `${mode} ${mode === "160000" ? "commit" : "blob"} ${entry.oid ?? oid("b")}\t${entry.path}\0`;
  }).join(""));
}

function withTempRepository(run: (repository: string) => void): void {
  const repository = mkdtempSync(join(tmpdir(), "referee-test-"));
  try {
    run(repository);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
}

function initializeRepository(repository: string): void {
  execFileSync("git", ["init", "-q", repository]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Referee Test"]);
  execFileSync("git", ["-C", repository, "config", "user.email", "referee@example.invalid"]);
}

function writeRepositoryFile(repository: string, path: string, contents = "fixture\n"): void {
  const destination = join(repository, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function commitRepository(repository: string, message: string, paths: string[] = ["."]): string {
  execFileSync("git", ["-C", repository, "add", "-f", "--", ...paths]);
  execFileSync("git", ["-C", repository, "commit", "-q", "-m", message]);
  return execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

function runRefereeCli(repository: string, from: string, to: string, environment: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/updater/v1/referee/cli.ts",
    "--policy-dir", "src/updater/v1/policy", "--repo", repository, from, to], {
    encoding: "utf8", env: { ...process.env, ...environment },
  });
}

function committedCandidate(repository: string, from: string, to: string) {
  return {
    raw: execFileSync("git", ["-C", repository, "diff", "--raw", "-z", "--no-renames", from, to]),
    treeRaw: execFileSync("git", ["-C", repository, "ls-tree", "-r", "-z", to]),
  };
}

test("the ten worked policy examples produce their expected plan class and refusals", () => {
  const oldPackage = JSON.stringify({ name: "control-room", scripts: { test: "node --test" }, dependencies: { a: "1" } });
  const dependencyPackage = JSON.stringify({ name: "control-room", scripts: { test: "node --test" }, dependencies: { a: "2" } });
  const scriptsPackage = JSON.stringify({ name: "control-room", scripts: { test: "true" }, dependencies: { a: "1" } });
  const examples: Array<{ result: ReturnType<typeof classify>; classification: string;
    classes: readonly string[]; refusal?: string }> = [
    { result: classOf([pathRow("M", "private-app/app/news-workspace.tsx"), pathRow("M", "tests/news-workspace.test.tsx")]),
      classification: "code-only", classes: ["code"] },
    { result: classOf([pathRow("A", "db/migrations/0200_task_labels.sql"), pathRow("A", "db/down/0200_task_labels.sql"),
      pathRow("M", "deploy/postgres/migration-ledger.json"), pathRow("M", "src/persistence/task-labels.ts")]),
      classification: "database", classes: ["database"] },
    { result: classOf([pathRow("M", "package.json", { oldOid: oid("1"), newOid: oid("2") }),
      pathRow("M", "pnpm-lock.yaml"), pathRow("M", "src/voice/v1/index.ts")],
      { [oid("1")]: oldPackage, [oid("2")]: dependencyPackage }), classification: "dependency", classes: ["dependency"] },
    { result: classOf([pathRow("M", "package.json", { oldOid: oid("1"), newOid: oid("2") })],
      { [oid("1")]: oldPackage, [oid("2")]: scriptsPackage }), classification: "code-only", classes: ["protected"] },
    { result: classOf([{ status: "R100", oldPath: "tests/private-name-guard.test.mjs",
      newPath: "docs/archive/private-name-guard.test.mjs" }]), classification: "code-only", classes: ["protected"] },
    { result: classOf([pathRow("M", ".gitattributes", { newOid: oid("3") })],
      { [oid("3")]: "* text=auto eol=lf\ntests/attack-kit* export-ignore\n" }), classification: "code-only",
      classes: ["protected"], refusal: "archive_attributes" },
    { result: classOf([pathRow("M", "docs/README.md", { oldMode: "100644", newMode: "100755",
      oldOid: oid("4"), newOid: oid("4") })]), classification: "code-only", classes: ["code"] },
    { result: classOf([pathRow("A", "docs/rules", { oldMode: "000000", newMode: "120000",
      oldOid: zero, newOid: oid("5") })], { [oid("5")]: "../src/updater/v1/policy/protected.json" }),
      classification: "updater", classes: ["protected", "updater"] },
    { result: classOf([pathRow("M", "src/updater/v1/trusted-runtime.mjs"),
      pathRow("A", "src/updater/v1/ddl/0004_heartbeat_index.sql")]),
      classification: "updater", classes: ["protected", "updater"] },
    { result: classOf([pathRow("M", "src/updater/v1/policy/health.json"), pathRow("A", "db/migrations/0201_x.sql")]),
      classification: "updater", classes: ["database", "protected", "updater"], refusal: "updater_with_database" },
  ];
  for (const [index, example] of examples.entries()) {
    assert.equal(example.result.classification, example.classification, `example ${index + 1}`);
    assert.deepEqual(example.result.classes, example.classes, `example ${index + 1}`);
    assert.equal(example.result.refusals.some(refusal => refusal.id === example.refusal), example.refusal !== undefined,
      `example ${index + 1} refusal`);
  }
});

test("the four supplemental examples cover reinstall, case folding, fixture SQL, and protected DB roles", () => {
  const reinstall = classOf([pathRow("M", "src/updater/v1/guard/guard.sh")]);
  assert.equal(reinstall.classification, "updater");
  assert.deepEqual(reinstall.refusals.map(value => value.id), ["needs_reinstall"]);
  assert.deepEqual(classOf([pathRow("A", "Private-App/App/updates/page.tsx")]).classes, ["protected"]);
  assert.deepEqual(classOf([pathRow("M", "tests/fixtures/migrations/dangerous.sql")]).classes, ["database"]);
  assert.deepEqual(classOf([pathRow("M", "db/roles/private_web_roles.sql")]).classes,
    ["database", "protected"]);
});

test("renames classify both sides, symlinks classify their targets, and protected mode changes stay protected", () => {
  const rename = classOf([{ status: "R100", oldPath: "tests/private-name-guard.test.mjs", newPath: "docs/guard.old" }]);
  const deletion = classOf([pathRow("D", "tests/private-name-guard.test.mjs")]);
  const addition = classOf([pathRow("A", "docs/guard.old")]);
  assert.equal(rename.classes.includes("protected"), deletion.classes.includes("protected") || addition.classes.includes("protected"));
  const link = classOf([pathRow("A", "docs/security-link", { oldMode: "000000", newMode: "120000",
    oldOid: zero, newOid: oid("6") })], { [oid("6")]: "../src/security/canonical-digest.ts" });
  assert.deepEqual(link.classes, ["protected"]);
  assert.ok(link.protectedPaths.some(hit => hit.entryId === "symlink-target:security-core"));
  assert.deepEqual(classOf([pathRow("M", "scripts/ci/affected-tests.mjs", { oldMode: "100644", newMode: "100755",
    oldOid: oid("7"), newOid: oid("7") })]).classes, ["protected"]);
});

test("policy edits are judged by the supplied running policy, never candidate policy bytes", () => {
  const result = classOf([pathRow("M", "src/updater/v1/policy/protected.json", {
    oldOid: oid("8"), newOid: oid("9"),
  })], { [oid("8")]: policies.protectedJson, [oid("9")]: '{"entries":[]}' });
  assert.equal(result.classification, "updater");
  assert.equal(result.approvalNeeded.macConfirm, true);
  assert.equal(result.independentReviewRequired, true);
});

test("package manifests fail closed by key and on ambiguous JSON", () => {
  const manifest = (oldText: string, newText: string) => classOf([pathRow("M", "nested/package.json", {
    oldOid: oid("d"), newOid: oid("e"),
  })], { [oid("d")]: oldText, [oid("e")]: newText });
  assert.deepEqual(manifest('{"name":"a"}', '{"name":"b","futurePnpmKey":true}').classes, ["dependency"]);
  assert.deepEqual(manifest('{"name":"a"}', '{"name":"a","name":"b"}').classes,
    ["dependency", "protected"]);
  assert.deepEqual(classOf([{ status: "R100", oldPath: "package.json", newPath: "docs/package.backup" }]).classes,
    ["dependency"]);
});

test("an unreadable running policy fails closed and setting decisions remain non-diff approvals", () => {
  const invalid = classify({ ...policies, protectedJson: policies.protectedJson.replace(
    '"schema": "control-room.policy.protected/v1"', '"schema": "wrong"') }, candidate([pathRow("M", "README.md")]));
  assert.equal(invalid.refused, true); assert.equal(invalid.classification, "updater");
  const malformedGlob = classify({ ...policies, protectedJson: policies.protectedJson.replace(
    '"src/updater/**"', '"src/updater/{broken"') }, candidate([pathRow("M", "README.md")]));
  assert.equal(malformedGlob.refused, true); assert.equal(malformedGlob.classification, "updater");
  const malformedClassGlob = classify({ ...policies, classesJson: policies.classesJson.replace(
    '"db/**"', '"db/{broken"') }, candidate([pathRow("M", "README.md")]));
  assert.equal(malformedClassGlob.refused, true); assert.equal(malformedClassGlob.classification, "updater");
  assert.deepEqual(classifyUpdaterSettingV1(), {
    classification: "setting", classes: [], protectedPaths: [],
    approvalNeeded: { phonePasskey: true, macConfirm: true }, independentReviewRequired: false,
    refused: false, refusals: [], filesChanged: 0, filesAdded: 0, filesDeleted: 0,
    changedPaths: [], changesDatabase: false, changesUpdater: false,
  });
});

test("malformed, oversized, truncated, missing-blob, and unsafe-path input fails closed", () => {
  const malformed = classify(policies, { raw: new TextEncoder().encode(":bad\0path\0"), treeRaw: new Uint8Array() });
  assert.equal(malformed.refused, true); assert.equal(malformed.classification, "updater");
  const hugeHeader = `:100644 100644 ${oid("a")} ${oid("b")} M\0`;
  const huge = classify(policies, { raw: new TextEncoder().encode(
    `${hugeHeader}${"a".repeat(UPDATER_REFEREE_MAX_RAW_DIFF_BYTES_V1 - hugeHeader.length + 1)}\0`),
    treeRaw: new Uint8Array() });
  assert.equal(huge.refused, true); assert.equal(huge.refusals[0]!.id, "diff_unreadable");
  const truncated = classify(policies, {
    raw: candidate([pathRow("M", "docs/a")]).raw.subarray(0, 20), treeRaw: new Uint8Array(),
  });
  assert.equal(truncated.refused, true);
  const missingBlob = classOf([pathRow("A", "docs/link", { oldMode: "000000", newMode: "120000",
    oldOid: zero, newOid: oid("a") })]);
  assert.equal(missingBlob.refused, true);
  const unsafe = classOf([pathRow("M", "docs/bad name.md")]);
  assert.deepEqual(unsafe.refusals.map(value => value.id), ["path_not_allowed"]);
  const unsafeDiffOnly = candidate([pathRow("M", "docs/bad name.md")]);
  unsafeDiffOnly.treeRaw = new Uint8Array();
  assert.deepEqual(refusalIds(classify(policies, unsafeDiffOnly)), ["path_not_allowed"]);
  const traversal = classOf([pathRow("M", "docs/../security.ts")]);
  assert.deepEqual(traversal.refusals.map(value => value.id), ["path_not_allowed"]);
});

test("a leading slash is refused as path_not_allowed", () => {
  assert.deepEqual(refusalIds(classOf([pathRow("M", "/docs/file.ts")])), ["path_not_allowed"]);
});

test("a backslash is refused as path_not_allowed", () => {
  assert.deepEqual(refusalIds(classOf([pathRow("M", "docs\\file.ts")])), ["path_not_allowed"]);
});

test("an ASCII-case-folded .git path segment is refused", () => {
  assert.deepEqual(refusalIds(classOf([pathRow("M", "docs/.GiT/config")])), ["path_not_allowed"]);
});

test("real commits refuse node_modules segments in the diff and anywhere in the candidate tree", () => {
  withTempRepository(repository => {
    initializeRepository(repository);
    writeRepositoryFile(repository, "README.md");
    const base = commitRepository(repository, "base");
    writeRepositoryFile(repository, "src/NoDe_MoDuLeS/@simplewebauthn/server/index.js", "export const verify = () => true;\n");
    const shadow = commitRepository(repository, "shadow dependency");
    const first = runRefereeCli(repository, base, shadow);
    assert.equal(first.status, 1);
    assert.deepEqual(refusalIds(JSON.parse(first.stdout) as ReturnType<typeof classify>), ["path_not_allowed"]);
    writeRepositoryFile(repository, "docs/follow-up.md");
    const followUp = commitRepository(repository, "unrelated follow-up");
    const second = runRefereeCli(repository, shadow, followUp);
    assert.equal(second.status, 1);
    assert.deepEqual(refusalIds(JSON.parse(second.stdout) as ReturnType<typeof classify>), ["path_not_allowed"]);
  });
});

test("an absolute symlink target is refused as symlink_escape", () => {
  const row = pathRow("A", "docs/link", { oldMode: "000000", newMode: "120000", oldOid: zero, newOid: oid("1") });
  assert.deepEqual(refusalIds(classOf([row], { [oid("1")]: "/outside" })), ["symlink_escape"]);
});

test("a non-UTF-8 raw-diff header is unreadable", () => {
  const input = candidate([pathRow("M", "docs/file.ts")]);
  input.raw[1] = 0xb1;
  assert.deepEqual(refusalIds(classify(policies, input)), ["diff_unreadable"]);
});

test("a rename similarity score above 100 is unreadable", () => {
  const raw = encode(`:100644 100644 ${oid("a")} ${oid("b")} R999\0old\0new\0`);
  assert.deepEqual(refusalIds(classify(policies, { raw, treeRaw: treeRaw([{ path: "new" }]) })), ["diff_unreadable"]);
});

test("an object id shorter than seven hexadecimal characters is unreadable", () => {
  const raw = encode(`:100644 100644 abcd ${oid("b")} M\0docs/file.ts\0`);
  assert.deepEqual(refusalIds(classify(policies, { raw, treeRaw: treeRaw([{ path: "docs/file.ts" }]) })),
    ["diff_unreadable"]);
});

test("an unknown Git mode is unreadable", () => {
  const raw = encode(`:100644 77777 ${oid("a")} ${oid("b")} M\0docs/file.ts\0`);
  assert.deepEqual(refusalIds(classify(policies, { raw, treeRaw: treeRaw([{ path: "docs/file.ts" }]) })),
    ["diff_unreadable"]);
});

test("an add row with a nonzero old mode is unreadable", () => {
  const raw = encode(`:100644 100644 ${oid("a")} ${oid("b")} A\0docs/file.ts\0`);
  assert.deepEqual(refusalIds(classify(policies, { raw, treeRaw: treeRaw([{ path: "docs/file.ts" }]) })),
    ["diff_unreadable"]);
});

test("a modify row with a zero old mode is unreadable", () => {
  const raw = encode(`:000000 100644 ${zero} ${oid("b")} M\0docs/file.ts\0`);
  assert.deepEqual(refusalIds(classify(policies, { raw, treeRaw: treeRaw([{ path: "docs/file.ts" }]) })),
    ["diff_unreadable"]);
});

test("a duplicate protected-policy entry id is unreadable", () => {
  const value = JSON.parse(policies.protectedJson) as { entries: unknown[] };
  value.entries.push(value.entries[0]);
  const result = classify({ ...policies, protectedJson: JSON.stringify(value) }, candidate([pathRow("M", "docs/file.ts")]));
  assert.deepEqual(refusalIds(result), ["diff_unreadable"]);
});

test("a symlink target longer than 4096 bytes is unreadable", () => {
  const row = pathRow("A", "docs/link", { oldMode: "000000", newMode: "120000", oldOid: zero, newOid: oid("2") });
  assert.deepEqual(refusalIds(classOf([row], { [oid("2")]: "a".repeat(4097) })), ["diff_unreadable"]);
});

test("the 100001st raw-diff record is unreadable", () => {
  const row = `:000000 100644 0000000 bbbbbbb A\0x\0`;
  const raw = encode(row.repeat(UPDATER_REFEREE_MAX_DIFF_RECORDS_V1 + 1));
  assert.throws(() => parseUpdaterRawDiffV1(raw), /diff_unreadable/u);
});

test("tree parsing rejects an invalid header, the 100001st record, and fatal UTF-8", () => {
  assert.throws(() => parseUpdaterCandidateTreeV1(encode(`100600 blob ${oid("a")}\tdocs/file.ts\0`)),
    /tree_unreadable/u);
  const row = `100644 blob ${oid("a")}\tx\0`;
  assert.throws(() => parseUpdaterCandidateTreeV1(encode(row.repeat(UPDATER_REFEREE_MAX_TREE_RECORDS_V1 + 1))),
    /tree_unreadable/u);
  const invalidUtf8 = encode(`100644 blob ${oid("a")}\tdocs/file.ts\0`);
  invalidUtf8[invalidUtf8.length - 4] = 0xff;
  assert.throws(() => parseUpdaterCandidateTreeV1(invalidUtf8), /encoded data/u);
});

test("a wildcard in the first brace alternative matches", () => {
  assert.equal(glob("scripts/{prepare*,initialize}-local.mjs", "scripts/prepare-release-local.mjs"), true);
});

test("a wildcard in the second brace alternative matches", () => {
  assert.equal(glob("scripts/{prepare,initialize*}-local.mjs", "scripts/initialize-release-local.mjs"), true);
});

test("a question mark in a brace alternative matches exactly one character", () => {
  assert.equal(glob("src/{guard?,safe*}.ts", "src/guard1.ts"), true);
  assert.equal(glob("src/{guard?,safe*}.ts", "src/guard12.ts"), false);
});

test("route brackets are literal glob characters", () => {
  assert.equal(glob("app/[projectid]/**", "app/[projectid]/page.tsx"), true);
  assert.equal(glob("app/[projectid]/**", "app/p/page.tsx"), false);
});

test("a double-star matches both zero and several complete path segments", () => {
  assert.equal(glob("src/**/guard.ts", "src/guard.ts"), true);
  assert.equal(glob("src/**/guard.ts", "src/a/b/guard.ts"), true);
});

test("submodules and escaping symlinks refuse, while a valid retry after missing data succeeds", () => {
  const submodule = classOf([pathRow("A", "vendor/tool", { oldMode: "000000", newMode: "160000",
    oldOid: zero, newOid: oid("b") })]);
  assert.deepEqual(submodule.refusals.map(value => value.id), ["submodule"]);
  const deletedSubmodule = classOf([pathRow("D", "vendor/tool", { oldMode: "160000", newMode: "000000",
    oldOid: oid("b"), newOid: zero })]);
  assert.deepEqual(deletedSubmodule.refusals.map(value => value.id), ["submodule"]);
  const row = pathRow("A", "docs/link", { oldMode: "000000", newMode: "120000", oldOid: zero, newOid: oid("c") });
  assert.equal(classOf([row]).refused, true);
  const retry = classOf([row], { [oid("c")]: "../README.md" });
  assert.equal(retry.refused, false); assert.deepEqual(retry.classes, ["protected"]);
  const escape = classOf([row], { [oid("c")]: "../../outside" });
  assert.ok(escape.refusals.some(value => value.id === "symlink_escape"));
});

test("symlinks resolving through mixed-case .git segments are refused", () => {
  const row = pathRow("A", "docs/hook", { oldMode: "000000", newMode: "120000", oldOid: zero, newOid: oid("3") });
  const result = classOf([row], { [oid("3")]: "../.GIT/hooks/post-commit" });
  assert.equal(result.refused, true);
  assert.ok(refusalIds(result).includes("path_not_allowed"));
});

test("nested candidate symlink chains cannot hide a .git target", () => {
  const input = candidate([pathRow("A", "docs/a", {
    oldMode: "000000", newMode: "120000", oldOid: zero, newOid: oid("3"),
  })], { [oid("3")]: "b/hooks/post-commit", [oid("4")]: "c", [oid("5")]: "../.GiT" });
  input.treeRaw = treeRaw([
    { path: "docs/a", mode: "120000", oid: oid("3") },
    { path: "docs/b", mode: "120000", oid: oid("4") },
    { path: "docs/c", mode: "120000", oid: oid("5") },
  ]);
  assert.ok(refusalIds(classify(policies, input)).includes("path_not_allowed"));
});

test("the candidate tree refuses ASCII-case and canonical Unicode collisions", () => {
  const base = candidate([pathRow("A", "docs/new.ts")]);
  base.treeRaw = treeRaw([{ path: "src/plain.ts" }, { path: "src/PLAIN.ts" }, { path: "docs/new.ts" }]);
  assert.ok(refusalIds(classify(policies, base)).includes("case_collision"));
  base.treeRaw = treeRaw([{ path: "docs/caf\u00e9.ts" }, { path: "docs/cafe\u0301.ts" }, { path: "docs/new.ts" }]);
  assert.ok(refusalIds(classify(policies, base)).includes("case_collision"));
});

test("Unicode look-alikes that are not canonically equivalent do not collide", () => {
  const input = candidate([pathRow("A", "docs/new.ts")]);
  input.treeRaw = treeRaw([{ path: "docs/a.ts" }, { path: "docs/\u0430.ts" }, { path: "docs/new.ts" }]);
  assert.equal(refusalIds(classify(policies, input)).includes("case_collision"), false);
});

test("the fixed plan-time budget is shared across candidate and five overlay probes", () => {
  const input = candidate(Array.from({ length: 20_000 }, (_, index) => pathRow("M", `x/${index.toString(36)}`)));
  const budget = new UpdaterRefereePlanTimeBudgetV1(() => 0);
  for (let index = 0; index < 5; index += 1) assert.equal(classify(policies, input, budget).refused, false);
  assert.deepEqual(refusalIds(classify(policies, input, budget)), ["diff_unreadable"]);
});

test("a real 600-file commit returns the one fail-closed shape when the deadline expires halfway", () => {
  withTempRepository(repository => {
    initializeRepository(repository);
    writeRepositoryFile(repository, "README.md");
    const base = commitRepository(repository, "base");
    for (let index = 0; index < 600; index += 1)
      writeRepositoryFile(repository, `x/${index.toString(36)}`);
    const candidateCommit = commitRepository(repository, "large candidate");
    let calls = 0;
    const budget = new UpdaterRefereePlanTimeBudgetV1(() =>
      calls++ < 3 ? 0 : UPDATER_REFEREE_PLAN_TIME_BUDGET_MS_V1 + 1);
    assert.deepEqual(classify(policies, committedCandidate(repository, base, candidateCommit), budget), {
      classification: "updater", classes: ["updater", "protected"], protectedPaths: [],
      approvalNeeded: { phonePasskey: true, macConfirm: true }, independentReviewRequired: true,
      refused: true,
      refusals: [{ id: "diff_unreadable", text: "Control Room couldn't read what this update changes." }],
      filesChanged: 0, filesAdded: 0, filesDeleted: 0, changedPaths: [],
      changesDatabase: false, changesUpdater: true,
    });
  });
});

test("every present protected-policy pattern and wildcard-in-braces matcher covers the real tracked tree", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" }).toString("utf8").split("\0").filter(Boolean);
  const policy = JSON.parse(policies.protectedJson) as { entries: Array<{
    id: string; status: string; patterns: string[]; exclude?: string[];
  }> };
  for (const entry of policy.entries.filter(value => value.status === "present")) {
    for (const pattern of entry.patterns)
      assert.ok(tracked.some(path => glob(pattern, path)), `${entry.id}: ${pattern}`);
  }
  assert.equal(glob("scripts/{prepare,initialize}-local-installation*.mjs",
    "scripts/prepare-local-installation-release.mjs"), true);
  assert.equal(glob("private-app/app/projects/[projectid]/improvements/**",
    "private-app/app/projects/[projectid]/improvements/page.tsx"), true);
  const classifiable = tracked.filter(path => !path.toLowerCase().endsWith("package.json") &&
    !path.toLowerCase().endsWith(".gitattributes"));
  const result = classOf(classifiable.map(path => pathRow("M", path)));
  const actual = result.protectedPaths.filter(hit => policy.entries.some(entry => entry.id === hit.entryId))
    .map(hit => `${hit.path}\0${hit.entryId}`).sort();
  const expected = policy.entries.flatMap(entry => classifiable
    .filter(path => entry.patterns.some(pattern => glob(pattern, path)) &&
      !(entry.exclude ?? []).some(pattern => glob(pattern, path)))
    .map(path => `${path}\0${entry.id}`)).sort();
  assert.deepEqual(actual, expected);
});

test("two hundred concurrent callers are deterministic and share no mutable state", async () => {
  const input = candidate(Array.from({ length: 50 }, (_, index) => pathRow("M", `src/feature/file-${index}.ts`)));
  const results = await Promise.all(Array.from({ length: 200 }, async () => classify(policies, input)));
  assert.equal(results.every(result => JSON.stringify(result) === JSON.stringify(results[0])), true);
  assert.equal(results[0]!.filesChanged, 50);
  assert.equal(results[0]!.refused, false);
});

test("the CLI classifies a diff between two real repository commits", () => {
  const readAgainst = (JSON.parse(policies.protectedJson) as { readAgainst: { "cook/v1": string } }).readAgainst["cook/v1"];
  const [from, candidateCommit] = execFileSync("git", ["rev-parse", `${readAgainst}^`, readAgainst],
    { encoding: "utf8" }).trim().split(/\s+/u);
  const output = execFileSync(process.execPath, ["--import", "tsx", "src/updater/v1/referee/cli.ts",
    "--policy-dir", "src/updater/v1/policy", from!, candidateCommit!], { encoding: "utf8" });
  const result = JSON.parse(output) as ReturnType<typeof classify>;
  assert.equal(result.classification, "database");
  assert.ok(result.filesChanged > 1);
  assert.equal(result.refused, false);
  assert.ok(parseUpdaterRawDiffV1(execFileSync("git", ["diff", "--raw", "-z", "--find-renames", from!, candidateCommit!])).length > 1);
});

test("the CLI disables copy detection and still protects both halves of a real rename", () => {
  withTempRepository(repository => {
    initializeRepository(repository);
    writeRepositoryFile(repository, "tests/private-name-guard.test.mjs", "export const guard = true;\n");
    const from = commitRepository(repository, "base");
    writeRepositoryFile(repository, "docs/guard-copy.ts", "export const guard = true;\n");
    const copy = commitRepository(repository, "copy");
    const copyResult = runRefereeCli(repository, from, copy);
    assert.equal(copyResult.status, 0);
    assert.deepEqual((JSON.parse(copyResult.stdout) as ReturnType<typeof classify>).classes, ["code"]);
    execFileSync("git", ["-C", repository, "mv", "tests/private-name-guard.test.mjs", "docs/guard-moved.ts"]);
    const to = commitRepository(repository, "rename");
    const output = runRefereeCli(repository, copy, to);
    assert.equal(output.status, 0);
    const result = JSON.parse(output.stdout) as ReturnType<typeof classify>;
    assert.deepEqual(result.classes, ["protected"]);
    assert.ok(result.protectedPaths.some(hit => hit.path === "tests/private-name-guard.test.mjs"));
  });
});

test("real commits protect the security implementations and build pipeline named by the rulebook", () => {
  withTempRepository(repository => {
    initializeRepository(repository);
    writeRepositoryFile(repository, "README.md");
    const base = commitRepository(repository, "base");
    const expected: Array<[string, string]> = [
      ["src/web/v1/mac-local-node-key-pin.ts", "worker-trust-and-protected-configuration"],
      ["src/web/v1/mac-local-protected-loader.ts", "worker-trust-and-protected-configuration"],
      ["src/web/v1/mac-local-protected-configuration.ts", "worker-trust-and-protected-configuration"],
      ["src/node-protocol/v1/crypto.ts", "machine-authentication"],
      ["src/node-protocol/v1/authentication.ts", "machine-authentication"],
      ["src/connection-registry/v1/node-ingress.ts", "machine-authentication"],
      ["src/connection-registry/v1/transport-admission.ts", "machine-authentication"],
      ["src/harness/v1/bounded-owner-signature.ts", "owner-signing"],
      ["src/harness/v1/owned-owner-signature.ts", "owner-signing"],
      ["src/harness/v1/owner-signing-stream.ts", "owner-signing"],
      ["src/work-intake/v1/machine-auth.ts", "machine-authentication"],
      ["src/web/v1/http-common.ts", "front-door-body-parsing"],
      ["private-app/app/layout.tsx", "owner-update-screens"],
      ["private-app/app/layout-providers.tsx", "owner-update-screens"],
      ["private-app/app/owner-ui.tsx", "owner-update-screens"],
      ["src/web/v1/browser-json.ts", "owner-update-screens"],
      ["scripts/mac-local/database-upgrade-scram.mjs", "database-roles"],
      ["src/jsconfig.json", "build-pipeline"],
      ["vite.attack.config.ts", "build-pipeline"],
      ["postcss.config.mjs", "build-pipeline"],
      ["scripts/build-vps.mjs", "build-pipeline"],
      ["scripts/mac-local/build-source.mjs", "build-pipeline"],
    ];
    for (const [path] of expected) writeRepositoryFile(repository, path);
    const candidateCommit = commitRepository(repository, "security implementations");
    const output = runRefereeCli(repository, base, candidateCommit);
    assert.equal(output.status, 0);
    const result = JSON.parse(output.stdout) as ReturnType<typeof classify>;
    assert.deepEqual(result.classes, ["protected"]);
    for (const [path, id] of expected)
      assert.ok(result.protectedPaths.some(hit => hit.path === path && hit.entryId === id), `${id}: ${path}`);
  });
});

test("real package.json commits protect imports and type resolution levers", () => {
  withTempRepository(repository => {
    initializeRepository(repository);
    writeRepositoryFile(repository, "package.json", '{"name":"fixture"}\n');
    const base = commitRepository(repository, "base");
    writeRepositoryFile(repository, "package.json", '{"name":"fixture","type":"module","imports":{"#guard":"./evil.js"}}\n');
    const candidateCommit = commitRepository(repository, "resolution levers");
    const output = runRefereeCli(repository, base, candidateCommit);
    assert.equal(output.status, 0);
    const result = JSON.parse(output.stdout) as ReturnType<typeof classify>;
    assert.deepEqual(result.classes, ["protected"]);
    assert.deepEqual(result.protectedPaths.map(hit => hit.entryId).sort(),
      ["package-json:imports", "package-json:type"]);
  });
});

test("a real tracked .env file is protected", () => {
  withTempRepository(repository => {
    initializeRepository(repository);
    writeRepositoryFile(repository, "README.md");
    const base = commitRepository(repository, "base");
    writeRepositoryFile(repository, ".env.production", "CONTROL_ROOM_BUILD_TARGET=other\n");
    const candidateCommit = commitRepository(repository, "environment file");
    const output = runRefereeCli(repository, base, candidateCommit);
    assert.equal(output.status, 0);
    const result = JSON.parse(output.stdout) as ReturnType<typeof classify>;
    assert.deepEqual(result.classes, ["protected"]);
    assert.ok(result.protectedPaths.some(hit => hit.entryId === "environment-files"));
  });
});

test("real CR-separated archive attributes are refused even when unchanged in the candidate diff", () => {
  withTempRepository(repository => {
    initializeRepository(repository);
    writeRepositoryFile(repository, "README.md");
    const base = commitRepository(repository, "base");
    writeRepositoryFile(repository, ".gitattributes", "guard.txt -diff\rexport-ignore\n");
    const attributesCommit = commitRepository(repository, "archive attributes");
    const changed = runRefereeCli(repository, base, attributesCommit);
    assert.equal(changed.status, 1);
    assert.ok(refusalIds(JSON.parse(changed.stdout) as ReturnType<typeof classify>).includes("archive_attributes"));
    writeRepositoryFile(repository, "docs/follow-up.md");
    const followUp = commitRepository(repository, "follow up");
    const unchanged = runRefereeCli(repository, attributesCommit, followUp);
    assert.equal(unchanged.status, 1);
    assert.ok(refusalIds(JSON.parse(unchanged.stdout) as ReturnType<typeof classify>).includes("archive_attributes"));
  });
});

test("a real burst above 64 candidate attribute files fails before blob loading", () => {
  withTempRepository(repository => {
    initializeRepository(repository);
    writeRepositoryFile(repository, "README.md");
    const base = commitRepository(repository, "base");
    for (let index = 0; index < 65; index += 1)
      writeRepositoryFile(repository, `attributes/${index.toString(36)}/.gitattributes`, "* text=auto eol=lf\n");
    const candidateCommit = commitRepository(repository, "attribute burst");
    const output = runRefereeCli(repository, base, candidateCommit);
    assert.equal(output.status, 1);
    assert.equal(output.stdout, "");
    assert.match(output.stderr, /couldn't read what this update changes/u);
  });
});

test("a real unchanged gitlink in the candidate tree is refused", () => {
  withTempRepository(repository => {
    initializeRepository(repository);
    writeRepositoryFile(repository, "README.md");
    const base = commitRepository(repository, "base");
    execFileSync("git", ["-C", repository, "update-index", "--add", "--cacheinfo", `160000,${base},vendor/tool`]);
    execFileSync("git", ["-C", repository, "commit", "-q", "-m", "gitlink"]);
    const withGitlink = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    writeRepositoryFile(repository, "docs/follow-up.md");
    const followUp = commitRepository(repository, "follow up", ["docs/follow-up.md"]);
    const output = runRefereeCli(repository, withGitlink, followUp);
    assert.equal(output.status, 1);
    assert.ok(refusalIds(JSON.parse(output.stdout) as ReturnType<typeof classify>).includes("submodule"));
  });
});

test("the CLI ignores caller Git config and replacement refs when reading real commits", () => {
  withTempRepository(repository => {
    initializeRepository(repository);
    writeRepositoryFile(repository, "README.md");
    const base = commitRepository(repository, "base");
    writeRepositoryFile(repository, "src/security/digest.ts");
    const protectedCommit = commitRepository(repository, "protected");
    execFileSync("git", ["-C", repository, "checkout", "-q", "-b", "alternate", base]);
    writeRepositoryFile(repository, "docs/ordinary.ts");
    const replacement = commitRepository(repository, "ordinary replacement");
    execFileSync("git", ["-C", repository, "replace", protectedCommit, replacement]);
    const output = runRefereeCli(repository, base, protectedCommit, {
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.repositoryformatversion", GIT_CONFIG_VALUE_0: "99",
    });
    assert.equal(output.status, 0, output.stderr);
    assert.deepEqual((JSON.parse(output.stdout) as ReturnType<typeof classify>).classes, ["protected"]);
  });
});

test("the CLI reads a hostile candidate tree and refuses a case collision", () => {
  withTempRepository(repository => {
    execFileSync("git", ["init", "--bare", "-q", repository]);
    const environment = { ...process.env, GIT_AUTHOR_NAME: "Referee Test", GIT_AUTHOR_EMAIL: "referee@example.invalid",
      GIT_COMMITTER_NAME: "Referee Test", GIT_COMMITTER_EMAIL: "referee@example.invalid" };
    const blob = execFileSync("git", ["-C", repository, "hash-object", "-w", "--stdin"],
      { input: "content\n", encoding: "utf8" }).trim();
    const makeTree = (paths: string[]) => execFileSync("git", ["-C", repository, "mktree", "-z"], {
      input: Buffer.from(paths.sort().map(path => `100644 blob ${blob}\t${path}\0`).join("")), encoding: "utf8",
    }).trim();
    const baseTree = makeTree(["base.ts"]);
    const base = execFileSync("git", ["-C", repository, "commit-tree", baseTree],
      { input: "base\n", encoding: "utf8", env: environment }).trim();
    const hostileTree = makeTree(["base.ts", "PLAIN.ts", "plain.ts"]);
    const candidateCommit = execFileSync("git", ["-C", repository, "commit-tree", hostileTree, "-p", base],
      { input: "hostile\n", encoding: "utf8", env: environment }).trim();
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/updater/v1/referee/cli.ts",
      "--policy-dir", "src/updater/v1/policy", "--repo", repository, base, candidateCommit], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.ok(refusalIds(JSON.parse(result.stdout) as ReturnType<typeof classify>).includes("case_collision"));
  });
});

test("the CLI refuses a real crafted commit containing a dot tree segment", () => {
  withTempRepository(repository => {
    execFileSync("git", ["init", "--bare", "-q", repository]);
    const environment = { ...process.env, GIT_AUTHOR_NAME: "Referee Test", GIT_AUTHOR_EMAIL: "referee@example.invalid",
      GIT_COMMITTER_NAME: "Referee Test", GIT_COMMITTER_EMAIL: "referee@example.invalid" };
    const hashObject = (type: "blob" | "tree", input: string | Buffer) => execFileSync("git",
      ["-C", repository, "hash-object", "--literally", "-t", type, "-w", "--stdin"],
      { input, encoding: "utf8" }).trim();
    const rawTree = (mode: string, name: string, objectId: string) => Buffer.concat([
      Buffer.from(`${mode} ${name}\0`), Buffer.from(objectId, "hex"),
    ]);
    const blob = hashObject("blob", "content\n");
    const baseTree = hashObject("tree", rawTree("100644", "base.ts", blob));
    const base = execFileSync("git", ["-C", repository, "commit-tree", baseTree],
      { input: "base\n", encoding: "utf8", env: environment }).trim();
    const securityTree = hashObject("tree", rawTree("100644", "digest.ts", blob));
    const dotTree = hashObject("tree", rawTree("40000", "security", securityTree));
    const srcTree = hashObject("tree", rawTree("40000", ".", dotTree));
    const hostileTree = hashObject("tree", rawTree("40000", "src", srcTree));
    const candidateCommit = execFileSync("git", ["-C", repository, "commit-tree", hostileTree, "-p", base],
      { input: "dot segment\n", encoding: "utf8", env: environment }).trim();
    const result = runRefereeCli(repository, base, candidateCommit);
    assert.equal(result.status, 1);
    assert.ok(refusalIds(JSON.parse(result.stdout) as ReturnType<typeof classify>).includes("path_not_allowed"));
  });
});
