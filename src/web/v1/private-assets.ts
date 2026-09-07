import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { privateResponseHeaders } from "./http-common";

const types: Readonly<Record<string, string>> = Object.freeze({
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff": "font/woff", ".woff2": "font/woff2", ".png": "image/png",
  ".svg": "image/svg+xml", ".ico": "image/x-icon",
});
const maxFileBytes = 4 * 1024 * 1024, maxTotalBytes = 32 * 1024 * 1024;
export interface PrivateClientAssets {
  readonly count: number;
  readonly digest: string;
  respond(pathname: string, method: string): Response | undefined;
}

/** Trusted startup only. Snapshot client bytes once; HTTP never supplies a filesystem path.
 * The release tree must be operator-owned and immutable during loading. Same-UID/administrator
 * replacement of the release is outside this boundary, not defeated by pathname checks.
 */
export async function loadPrivateClientAssets(clientDirectory: string): Promise<PrivateClientAssets> {
  return loadClientAssets(clientDirectory, false);
}

/** Explicit demo build only. Adds its single entry document, never arbitrary HTML. */
export async function loadContributorClientAssets(clientDirectory: string): Promise<PrivateClientAssets> {
  return loadClientAssets(clientDirectory, true);
}

async function loadClientAssets(clientDirectory: string, demo: boolean): Promise<PrivateClientAssets> {
  try {
    const root = resolve(clientDirectory);
    if (basename(root) !== "client" || basename(dirname(root)) !== (demo ? "dist-contributor" : "dist-vps")
      || await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw new Error();
    const assets = new Map<string, { bytes: Buffer; type: string }>();
    let total = 0, inspected = 0;
    async function visit(relative: string, depth: number) {
      if (++inspected > 1024 || depth > 8) throw new Error();
      const path = join(root, relative), stat = await lstat(path);
      if (stat.isSymbolicLink() || await realpath(path) !== path) throw new Error();
      if (stat.isDirectory()) {
        if (relative === "favicon.svg" || relative === "index.html") throw new Error();
        for (const name of (await readdir(path)).sort()) {
          if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,180}$/.test(name)) throw new Error();
          await visit(`${relative}/${name}`, depth + 1);
        }
        return;
      }
      if (!stat.isFile()) throw new Error();
      const type = demo && relative === "index.html" ? "text/html; charset=utf-8" : types[extname(relative)];
      // Source maps, manifests, HTML, config and arbitrary public/ files are not published.
      if (!type) return;
      if (assets.size >= 512 || stat.size > maxFileBytes || (total += stat.size) > maxTotalBytes) throw new Error();
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error();
        // Fixed allocation/read ceiling, including a byte to detect growth during loading.
        const buffer = Buffer.alloc(stat.size + 1);
        let size = 0;
        while (size < buffer.length) {
          const read = await file.read(buffer, size, buffer.length - size, null);
          if (read.bytesRead === 0) break;
          size += read.bytesRead;
        }
        if (size !== stat.size) throw new Error();
        assets.set(`/${relative}`, { bytes: buffer.subarray(0, size), type });
      } finally { await file.close(); }
    }
    // Never traverse the server tree or treat the whole release/public directory as public.
    await visit("_next/static", 0);
    await visit("favicon.svg", 0);
    if (demo) await visit("index.html", 0);
    if (assets.size < 2) throw new Error();
    const hash = createHash("sha256");
    for (const [path, asset] of assets) hash.update(JSON.stringify([path, asset.type, asset.bytes.length,
      createHash("sha256").update(asset.bytes).digest("hex")]));
    return Object.freeze({ count: assets.size, digest: `sha256:${hash.digest("hex")}`,
      respond(pathname: string, method: string) {
        const asset = assets.get(pathname);
        if (!asset || !["GET", "HEAD"].includes(method)) return undefined;
        return new Response(method === "HEAD" ? null : new Uint8Array(asset.bytes), { headers: {
          ...privateResponseHeaders, "content-type": asset.type, "content-length": String(asset.bytes.length),
        } });
      } });
  } catch { throw new Error("private_assets_invalid"); }
}
