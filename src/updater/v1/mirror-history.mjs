import { cp, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Whether a mirror's commit graph is the one its objects record.
 *
 * Git rewrites parents from three pieces of local metadata: a shallow boundary
 * (`shallow`), a grafts file (`info/grafts`) and replace refs (`refs/replace/`).
 * Any of them can make `merge-base --is-ancestor` say yes for a commit whose
 * real history never contained the ancestor, or drop commits from a range walk
 * while the ancestor is still reached through another parent. A mirror that
 * carries any of them proves nothing about history.
 *
 * One check for every reader of mirror ancestry - the attended classifier and
 * the watcher's admission - so the two can never disagree about it. `runGit`
 * runs git against `mirror` and resolves to `{ stdout }`.
 */
export async function mirrorHistoryCompleteV1(mirror, runGit) {
  if ((await runGit(["rev-parse", "--is-shallow-repository"])).stdout.trim() !== "false") return false;
  if ((await runGit(["for-each-ref", "--count=1", "--format=%(refname)", "refs/replace/"])).stdout !== "") return false;
  return !await lstat(join(mirror, "info", "grafts")).then(() => true,
    error => error?.code === "ENOENT" ? false : Promise.reject(error));
}

/** Copy the object store and metadata once; all trust-dependent reads use this
 * private repository. No hardlinks or alternate stores can share mutable bytes
 * with the live mirror. Concurrent writes there cannot change this graph. */
export async function pinMirrorHistoryV1(mirror) {
  const snapshot = await mkdtemp(join(dirname(mirror), ".history-"));
  let bytes = 0;
  try {
    const inspect = async path => {
      const entry = await lstat(path);
      if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) throw new Error("mirror_snapshot_refused");
      if (entry.isFile()) {
        bytes += entry.size;
        if (bytes > 256 * 1024 * 1024 || ["alternates", "http-alternates"].includes(basename(path)))
          throw new Error("mirror_snapshot_refused");
      }
      return true;
    };
    await cp(mirror, snapshot, { recursive: true, filter: inspect });
    bytes = 0;
    const audit = async path => {
      await inspect(path);
      if ((await lstat(path)).isDirectory()) for (const name of await readdir(path)) await audit(join(path, name));
    };
    await audit(snapshot);
    return snapshot;
  } catch (error) { await rm(snapshot, { recursive: true, force: true }); throw error; }
}
