/** Is this module the process's entry point?
 *
 * Every runnable script in this repo ends with an "only when invoked directly"
 * guard so the same file can be imported by tests and by other modules without
 * its top-level side effects running. The obvious way to write that guard is
 *
 *     if (process.argv[1] === fileURLToPath(import.meta.url))
 *
 * which is WRONG, and fails silently rather than loudly.
 *
 * Node resolves the ES module's entry specifier to its real path before
 * `import.meta.url` is set, while `process.argv[1]` keeps the path exactly as
 * the caller wrote it. So the two strings only agree when no component of the
 * path is a symlink. When one is, the guard is false, the module body that is
 * supposed to do the work never runs, the process exits 0 with no output, and
 * the caller sees a success that changed nothing.
 *
 * That is not hypothetical on macOS, where the system temporary directory is
 * under `/var`, and `/var` is a symlink to `/private/var`. A script spawned from
 * a checkout staged under `os.tmpdir()` therefore resolves
 * `/var/folders/…/scripts/x.mjs` while `import.meta.url` says
 * `/private/var/folders/…/scripts/x.mjs`. The guard misses, and the command
 * silently does nothing. Linux containers are usually unaffected, which is why
 * this survives review and CI and then breaks on the maintainer's own machine.
 *
 * It failed once here in exactly that shape: the two real-kill database upgrade
 * tests spawn the staged upgrade step through a temporary checkout, the child
 * exited 0 without touching the database, and both tests reported the
 * migration apply had made no progress.
 *
 * The fix is to compare REAL paths on both sides. `realpathSync` resolves
 * symlinks and `..` on the argument too, so both spellings of the same file
 * agree; a caller that reached the file by a different name still gets one
 * answer. Resolution failure (a file removed between spawn and execution, or an
 * unreadable path) returns false, which is the safe direction: the module is
 * treated as imported rather than executed, so nothing runs by surprise.
 *
 * This mirrors `scripts/mac-local/prepare-task-runtime.ts`, which had already
 * solved the same problem locally with the same reasoning.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @param {string | undefined} entry `process.argv[1]`, the path the process was started with.
 * @param {string} moduleUrl `import.meta.url` of the module asking.
 * @returns {boolean}
 */
export function invokedDirectlyV1(entry, moduleUrl) {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
