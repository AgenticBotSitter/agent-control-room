import { lstat } from "node:fs/promises";
import { join } from "node:path";

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
