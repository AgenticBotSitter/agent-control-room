#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { classifyUpdaterCandidateV1, parseUpdaterCandidateTreeV1, parseUpdaterRawDiffV1,
  UpdaterRefereePlanTimeBudgetV1 } from "./index";

function usage(): never {
  process.stderr.write("usage: referee-cli --policy-dir DIR [--repo DIR] FROM_COMMIT CANDIDATE_COMMIT\n");
  process.exit(2);
}

const args = process.argv.slice(2);
let policyDirectory: string | null = null;
let repository = process.cwd();
const revisions: string[] = [];
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]!;
  if (argument === "--policy-dir") policyDirectory = args[++index] ?? usage();
  else if (argument === "--repo") repository = args[++index] ?? usage();
  else if (argument.startsWith("-")) usage();
  else revisions.push(argument);
}
if (policyDirectory === null || revisions.length !== 2 ||
    revisions.some(revision => !/^[0-9a-f]{7,64}$/u.test(revision))) usage();

const gitEnvironment = {
  NODE_ENV: process.env.NODE_ENV ?? "production",
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: "/var/empty",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
};
const git = (...gitArgs: string[]) => execFileSync("git", ["-C", repository, ...gitArgs], {
  encoding: "buffer", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: gitEnvironment,
});

try {
  const budget = new UpdaterRefereePlanTimeBudgetV1();
  const raw = git("-c", "core.quotepath=off", "diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-textconv",
    "--ignore-submodules=none", "--no-relative", revisions[0]!, revisions[1]!, "--");
  const treeRaw = git("ls-tree", "-r", "-z", revisions[1]!);
  const records = parseUpdaterRawDiffV1(raw);
  const treeEntries = parseUpdaterCandidateTreeV1(treeRaw);
  const treeSymlinks = treeEntries.filter(entry => entry.mode === "120000");
  const treeAttributes = treeEntries.filter(entry => {
    const lower = entry.path.toLowerCase();
    return lower === ".gitattributes" || lower.endsWith("/.gitattributes");
  });
  if (treeSymlinks.length > 1024 || treeAttributes.length > 64) throw new Error("tree_unreadable");
  const blobs: Record<string, Uint8Array> = Object.create(null);
  for (const entry of treeSymlinks) blobs[entry.oid] = git("cat-file", "blob", entry.oid);
  for (const entry of treeAttributes) blobs[entry.oid] = git("cat-file", "blob", entry.oid);
  for (const record of records) {
    const paths = [record.oldPath, record.newPath].filter((path): path is string => path !== null);
    const needsManifest = paths.some(path => path.toLowerCase() === "package.json" || path.toLowerCase().endsWith("/package.json"));
    if (record.oldMode !== "000000" && (record.oldMode === "120000" || needsManifest))
      blobs[record.oldOid] = git("cat-file", "blob", record.oldOid);
    if (record.newMode !== "000000" && (record.newMode === "120000" || needsManifest))
      blobs[record.newOid] = git("cat-file", "blob", record.newOid);
  }
  const directory = resolve(policyDirectory);
  const result = classifyUpdaterCandidateV1({
    protectedJson: readFileSync(resolve(directory, "protected.json"), "utf8"),
    classesJson: readFileSync(resolve(directory, "classes.json"), "utf8"),
  }, { raw, treeRaw, blobs }, budget);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.refused) process.exitCode = 1;
} catch {
  process.stderr.write("Control Room couldn't read what this update changes.\n");
  process.exitCode = 1;
}
