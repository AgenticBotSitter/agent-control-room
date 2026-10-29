import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, isAbsolute } from "node:path";

// Release assembly refuses an output directory inside the release root by design.
// When the inherited TMPDIR sits inside the checkout, use a sibling of the checkout instead.
export async function releaseFixtureTemp(repository: string, prefix: string) {
  const root = await realpath(repository), base = await realpath(tmpdir());
  const path = relative(root, base);
  const nested = path === "" || (!path.startsWith("..") && !isAbsolute(path));
  return realpath(await mkdtemp(nested ? join(dirname(root), `${basename(root)}-${prefix}`) : join(base, prefix)));
}
