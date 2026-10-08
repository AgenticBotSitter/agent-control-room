import { createHash } from "node:crypto";
import { constants } from "node:fs";
import filesystem from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseStrictJsonV1 } from "../../../installer/shared/strict-json.mjs";
import { updaterRefuseV1 } from "../contracts.mjs";

const PATH = "gateway-local-capability.json";
const SCHEMA = "control-room.gateway-local-capability/v1";
const RELEASE = /^releases\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const refuse = () => { throw updaterRefuseV1("gateway_capability_refused"); };
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const same = (a, b) => ["dev", "ino", "uid", "gid", "mode", "size", "nlink", "mtimeMs", "ctimeMs"].every(key => a[key] === b[key]);

// The installer executes as root. Match its effective identity, as the protected
// health-key reader does; an unprivileged caller cannot bless root's install.
// The optional filesystem is a test boundary, never used by production callers.
export async function readGatewayLocalCapabilityV1(input, runtime = {}) {
  if (!isAbsolute(input?.root ?? "") || resolve(input.root) !== input.root || !RELEASE.test(input.expectedRelease ?? "")) refuse();
  const fs = runtime.capabilityFileSystem ?? filesystem, uid = process.geteuid();
  const id = RELEASE.exec(input.expectedRelease)[1], directories = [input.root, join(input.root, "releases"), join(input.root, input.expectedRelease)];
  const path = join(directories[2], PATH);
  let declarationEntry;
  try { declarationEntry = await fs.lstat(path); }
  catch (error) {
    // legacy-on-absence: OLD's builder emits none, including when installing R1.
    // Only ENOENT defaults to IPv4; present unsafe or unreadable bytes never do.
    if (error?.code === "ENOENT") return "127.0.0.1";
    refuse();
  }
  try {
    const parents = [];
    for (const directory of directories) {
      const entry = await fs.lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid || (entry.mode & 0o022) !== 0) refuse();
      parents.push(entry);
    }
    async function readImmutable(file, before, limit) {
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== uid
        || (before.mode & 0o222) !== 0 || before.size < 1 || before.size > limit) refuse();
      const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!same(before, await handle.stat())) refuse();
        const bytes = Buffer.alloc(before.size + 1); let length = 0;
        while (length < bytes.length) {
          const read = await handle.read(bytes, length, bytes.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length !== before.size || !same(before, await handle.stat()) || !same(before, await fs.lstat(file))) refuse();
        return bytes.subarray(0, length);
      } finally { await handle.close(); }
    }
    const bytes = await readImmutable(path, declarationEntry, 4096);
    const manifestPath = join(directories[2], "RELEASE_MANIFEST.json");
    const manifestBytes = await readImmutable(manifestPath, await fs.lstat(manifestPath), 8 * 1024 * 1024);
    if (input.manifestDigest !== undefined && (!DIGEST.test(input.manifestDigest) || hash(manifestBytes) !== input.manifestDigest)) refuse();
    const declaration = parseStrictJsonV1(bytes.toString("utf8"), { maxBytes: 4096 });
    const manifest = parseStrictJsonV1(manifestBytes.toString("utf8"), { maxBytes: 8 * 1024 * 1024 });
    if (!exactKeys(declaration, ["schema", "commit", "version", "releaseId", "gatewayLocalHost", "updaterSupportsGatewayHosts"])
      || declaration.schema !== SCHEMA || !Array.isArray(declaration.updaterSupportsGatewayHosts)
      || JSON.stringify(declaration.updaterSupportsGatewayHosts) !== '["127.0.0.1","::1"]') refuse();
    if (!["127.0.0.1", "::1"].includes(declaration.gatewayLocalHost)) refuse();
    if (manifest.schema !== "control-room.attended-build-manifest/v1" || !COMMIT.test(manifest.commit ?? "")
      || !VERSION.test(manifest.version ?? "") || declaration.commit !== manifest.commit || declaration.version !== manifest.version
      || declaration.releaseId !== id || id !== `${manifest.version}-${manifest.commit.slice(0, 12)}`) refuse();
    const entries = Array.isArray(manifest.files) ? manifest.files.filter(value => value?.path === PATH) : [];
    if (entries.length !== 1 || entries[0].bytes !== bytes.length || entries[0].sha256 !== hash(bytes)
      || entries[0].mode !== 0o400) refuse();
    for (let index = 0; index < directories.length; index++) {
      if (!same(parents[index], await fs.lstat(directories[index]))) refuse();
    }
    // Recheck the declaration after reading its separate trusted manifest.
    if (!same(declarationEntry, await fs.lstat(path))) refuse();
    return declaration.gatewayLocalHost;
  } catch { refuse(); }
}
