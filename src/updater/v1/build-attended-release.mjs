import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const SCHEMA = "control-room.attended-build-manifest/v1";
const COMMIT = /^[a-f0-9]{40}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const MAX_FILES = 25_000;
const MAX_BYTES = 1024 * 1024 * 1024;
const FILES = Object.freeze([
  "LICENSE", "NOTICE", "THIRD_PARTY.md", "package.json", "pnpm-lock.yaml",
  "deploy/operator-config.mjs", "deploy/agent-task-operator-config.mjs",
  "scripts/prepare-local-installation.mjs", "scripts/prepare-local-production-dependencies.mjs",
  "scripts/launch-local-setup.mjs", "scripts/initialize-local-installation-plan.mjs",
  "scripts/run-local-setup-host.mjs", "scripts/preflight-private-local-owner-host.mjs",
  "scripts/run-private-local-installation-operator.mjs", "scripts/run-private-vps.mjs",
  "scripts/activate-private-vps.mjs", "scripts/bootstrap-private-vps-owner.mjs",
  "scripts/check-private-vps-database.mjs", "deploy/FIRST_ACTIVATION.md",
  "scripts/mac-local/task-host-supervisor.mjs", "scripts/mac-local/stack.mjs",
  "scripts/mac-local/start-task-host.mjs", "scripts/mac-local/start-web-host.mjs",
  "src/installer/shared/is-main-module.mjs", "src/installer/shared/file-custody.mjs", "src/installer/shared/private-process-lock.mjs", "src/installer/shared/mac-local-runtime-directory.mjs",
]);
const DIRECTORIES = Object.freeze([
  "db/migrations", "db/roles", "db/setup", "deploy/postgres", "dist-vps/client", "dist-vps/server", "third_party",
]);

const refuse = code => { throw Object.assign(new Error(code), { code }); };
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const inside = (parent, child) => {
  const path = relative(resolve(parent), resolve(child));
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

async function regular(path, root) {
  const entry = await lstat(path).catch(() => refuse("updater_build_input_refused"));
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || !inside(root, path))
    refuse("updater_build_input_refused");
  return entry;
}

// This file also runs unbundled in the reviewed seed, so the metadata reader
// must use only Node builtins. Validate before opening, then bound the read and
// recheck both the descriptor and the source directory before parsing.
async function packageMetadata(source, sourceEntry) {
  const path = join(source, "package.json"), before = await regular(path, source);
  // Bounded, but with room: the root manifest carries every test lane, and the
  // int9 integration took it to 65,588 bytes, past the old 64 KiB cap, which made
  // every release build of that tree refuse its own package.json.
  if (before.size > 256 * 1024) refuse("updater_build_input_refused");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const same = entry => entry.isFile() && entry.nlink === 1 && entry.dev === before.dev && entry.ino === before.ino
      && entry.size === before.size && entry.mode === before.mode && entry.uid === before.uid && entry.gid === before.gid
      && entry.mtimeMs === before.mtimeMs && entry.ctimeMs === before.ctimeMs;
    if (!same(await handle.stat())) refuse("updater_build_input_refused");
    const bytes = Buffer.alloc(before.size + 1); let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
      if (!bytesRead) break;
      position += bytesRead;
    }
    const parent = await lstat(source);
    if (position !== before.size || !same(await handle.stat()) || !same(await lstat(path))
      || !parent.isDirectory() || parent.dev !== sourceEntry.dev || parent.ino !== sourceEntry.ino)
      refuse("updater_build_input_refused");
    return JSON.parse(bytes.subarray(0, position).toString("utf8"));
  } finally { await handle.close(); }
}

async function collect(source) {
  const values = [];
  for (const name of FILES) {
    const path = join(source, name), entry = await regular(path, source);
    values.push({ path: name, source: path, entry });
  }
  async function visit(directoryName) {
    const directory = join(source, directoryName), entry = await lstat(directory).catch(() => refuse("updater_build_input_refused"));
    if (!entry.isDirectory() || entry.isSymbolicLink() || !inside(source, directory)) refuse("updater_build_input_refused");
    for (const name of (await readdir(directory)).sort()) {
      const local = `${directoryName}/${name}`, path = join(source, local), child = await lstat(path);
      if (child.isDirectory() && !child.isSymbolicLink()) await visit(local);
      else if (child.isFile() && !child.isSymbolicLink() && child.nlink === 1) values.push({ path: local, source: path, entry: child });
      else refuse("updater_build_input_refused");
      if (values.length > MAX_FILES) refuse("updater_build_input_too_large");
    }
  }
  for (const name of DIRECTORIES) await visit(name);
  values.sort((left, right) => left.path.localeCompare(right.path, "en"));
  return values;
}

export async function buildAttendedReleaseV1({ source: sourceInput, output: outputInput, commit, releaseTrust }) {
  if (!COMMIT.test(commit ?? "") || !isAbsolute(sourceInput ?? "") || !isAbsolute(outputInput ?? "")
    || resolve(sourceInput) !== sourceInput || resolve(outputInput) !== outputInput || inside(sourceInput, outputInput))
    refuse("updater_build_arguments_refused");
  const sourceEntry = await lstat(sourceInput), outputEntry = await lstat(outputInput);
  if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink() || !outputEntry.isDirectory() || outputEntry.isSymbolicLink()
    || (await readdir(outputInput)).length !== 0) refuse("updater_build_arguments_refused");
  const packageValue = await packageMetadata(sourceInput, sourceEntry);
  if (packageValue?.name !== "control-room" || !VERSION.test(packageValue.version ?? "")) refuse("updater_build_version_refused");
  // Bundling needs esbuild and zod from the verified source's build dependencies.
  // The installed release has neither source scripts nor node_modules. Only the
  // public trust is given to the builder; signing stays in the root phase.
  if (releaseTrust !== undefined) {
    const builder = await import(pathToFileURL(join(sourceInput, "scripts/build-fleet-connector.mjs")).href);
    await builder.buildFleetConnectorReleaseFromVerifiedSourceV1({
      root: join(sourceInput, "dist-vps/server/fleet/release"), builtFrom: commit, releaseTrust,
    });
  }
  const inputs = await collect(sourceInput), files = []; let byteCount = 0;
  for (const input of inputs) {
    const bytes = await readFile(input.source); byteCount += bytes.length;
    if (byteCount > MAX_BYTES) refuse("updater_build_input_too_large");
    const destination = join(outputInput, input.path); await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(input.source, destination, constants.COPYFILE_EXCL);
    const mode = input.entry.mode & 0o111 ? 0o500 : 0o400; await chmod(destination, mode);
    files.push({ path: input.path, sha256: sha256(bytes), mode, bytes: bytes.length });
  }
  const manifest = { schema: SCHEMA, commit, version: packageValue.version, fileCount: files.length, byteCount, files };
  const path = join(outputInput, "RELEASE_MANIFEST.json");
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o400);
  try { await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  return manifest;
}

function argumentsV1(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values[name] !== undefined) refuse("updater_build_arguments_refused");
    values[name] = value;
  }
  if (!["--commit,--output,--source", "--commit,--output,--release-trust-json,--source"].includes(Object.keys(values).sort().join(","))) refuse("updater_build_arguments_refused");
  return { source: values["--source"], output: values["--output"], commit: values["--commit"],
    ...(values["--release-trust-json"] ? { releaseTrust: JSON.parse(values["--release-trust-json"]) } : {}) };
}

// The shared entry guard, asked the one question it can answer here — "is this
// the entry?" — and its refusal is only allowed to BE the answer when there IS
// an entry to be wrong about.
//
// This file is both an entry and an import target: anything that imports it must
// reach its body without running its CLI. A `process.argv[1]` that is ABSENT is
// the import context — MEASURED, `node --input-type=module --eval "<code>"`
// with no extra argument leaves `argv` at one element — and the guard answers
// `false`. A `file:` URL in `argv[1]` is now a REFUSAL, because `realpathSync`
// on a URL string is ENOENT and `node <a file: URL>` fails with `Cannot find
// module '<cwd>/file:/…'`, so a real entry is never spelled that way. The
// pre-guard that used to sit here duplicated that decision in three files; it is
// gone with the second copy of the guard.
//
// The shared entry guard's contract (`src/installer/shared/is-main-module.mjs`),
// carried INLINE because this file runs UNBUNDLED from `updater/seed-<c12>/bin/`
// and from each job's per-phase `builder-tools/bin/` copy (rv-9b B3). From there
// the shared module's relative import resolves outside the copy, so every fresh
// install failed at `ERR_MODULE_NOT_FOUND` before building. The seed's contract is
// "dependency-free builder entry points" (`install/bootstrap.mjs`), and
// `tests/invoked-directly.test.mjs` holds this copy equal to the shared guard case
// by case and allows it in exactly the two seed-run builders.
export function seedEntryIsMainV1(entryPath, moduleUrl) {
  if (entryPath === undefined || entryPath === null) return false;
  const refuse = reason => {
    throw Object.assign(new Error(`direct_entry_guard_refused: ${reason}`), { code: "direct_entry_guard_refused" });
  };
  if (typeof entryPath !== "string") refuse("process.argv[1] is not a string");
  if (entryPath.length === 0) refuse("process.argv[1] is empty");
  if (entryPath.startsWith("file:")) refuse("process.argv[1] is a file: URL, not a path this process was started with");
  let canonicalEntry, canonicalModule;
  try { canonicalEntry = realpathSync(entryPath); } catch { refuse("process.argv[1] could not be resolved"); }
  try { canonicalModule = realpathSync(fileURLToPath(moduleUrl)); } catch { refuse("import.meta.url could not be resolved"); }
  return canonicalEntry === canonicalModule;
}

if (seedEntryIsMainV1(process.argv[1], import.meta.url)) {
  buildAttendedReleaseV1(argumentsV1(process.argv.slice(2))).then(result => {
    process.stdout.write(`${result.fileCount} files\n`);
  }).catch(error => { process.stderr.write(`${error?.code ?? "updater_build_failed"}\n`); process.exitCode = 1; });
}
