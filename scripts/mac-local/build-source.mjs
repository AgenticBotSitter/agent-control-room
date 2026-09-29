import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const MAC_LOCAL_BUILD_SOURCE_V1 = "control-room.mac-local-build-source/v1";
const sourceScopes = Object.freeze([
  "src", "private-app", "db", "deploy/postgres", "scripts/mac-local", "scripts/build-vps.mjs",
  "vite.vps.config.ts", "package.json", "pnpm-lock.yaml",
]);

/** Digest every tracked input that can change the Mac task host or the schema
 * it expects. This catches a clean checkout with an old dist-vps directory as
 * well as a build made before later uncommitted source edits. */
export async function macLocalBuildSourceV1(root) {
  const [{ stdout: listed }, { stdout: commit }] = await Promise.all([
    exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...sourceScopes],
      { cwd: root, encoding: "buffer" }),
    exec("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }),
  ]);
  const files = listed.toString("utf8").split("\0").filter(Boolean).sort();
  if (!files.length || !/^[a-f0-9]{40}\n?$/u.test(commit)) throw new Error("mac_local_build_source_unavailable");
  const digest = createHash("sha256");
  for (const file of files) {
    const body = await readFile(join(root, file));
    digest.update(Buffer.from(`${file.length}:${file}:${body.length}:`, "utf8"));
    digest.update(body);
  }
  return Object.freeze({ schema: MAC_LOCAL_BUILD_SOURCE_V1, commit: commit.trim(),
    sourceDigest: `sha256:${digest.digest("hex")}` });
}

export function captureMacLocalBuildSourceV1(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("|") !== "commit|schema|sourceDigest"
    || value.schema !== MAC_LOCAL_BUILD_SOURCE_V1 || !/^[a-f0-9]{40}$/u.test(value.commit)
    || !/^sha256:[a-f0-9]{64}$/u.test(value.sourceDigest)) throw new Error("mac_local_build_source_invalid");
  return Object.freeze({ schema: value.schema, commit: value.commit, sourceDigest: value.sourceDigest });
}
