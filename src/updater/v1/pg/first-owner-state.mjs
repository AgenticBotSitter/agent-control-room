import { directoryCustodyV1, sameFileV1, sameIdentityV1, removeOwnedFileV1 } from "../../../installer/shared/file-custody.mjs";
import { parseStrictJsonV1 } from "../../../installer/shared/strict-json.mjs";
// Shared first-owner state custody. Reading never creates or repairs a file.
import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, link, readdir, unlink } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const FIRST_OWNER_STATE_V1 = "control-room.first-owner-state/v1";
const refuse = code => { throw Object.assign(new Error(code), { code }); };
const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const safeRoot = value => typeof value === "string" && value.length > 1 && value.length <= 4095
  && isAbsolute(value) && resolve(value) === value && value !== "/" && !value.includes("\0");
const KEY = /^[A-Za-z0-9_-]{43}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const stateRuntime = (runtime = {}) => ({ open, lstat, ownerUid: process.getuid?.(), ...runtime });

async function readPublishedState(root, directory, path) {
  const entry = await lstat(path);
  // A kill after link() but before unlink(temp) leaves two names for COMPLETE,
  // synced authority. Remove only a generated publication name for that inode.
  // Arbitrary hard links and malformed authority continue to refuse.
  if (entry.isFile() && entry.nlink > 1 && entry.uid === process.getuid?.() && (entry.mode & 0o7777) === 0o600) {
    const check = await directoryCustodyV1(directory);
    for (const name of await readdir(directory)) if (/^\.first-owner-[a-f0-9]{32}\.tmp$/u.test(name)) {
      const temporary = join(directory, name), owned = await lstat(temporary).catch(error => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (owned?.isFile() && sameIdentityV1(entry, owned)) {
        await check();
        await removeOwnedFileV1(temporary, owned).catch(error => { if (error?.code !== "ENOENT") throw error; });
      }
    }
  }
  return readFirstOwnerStateV1(root);
}

async function requireStateDirectory(directory, runtime) {
  const stat = await runtime.lstat(directory).catch(() => refuse("first_owner_state_refused"));
  if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o700
    || stat.uid !== runtime.ownerUid) refuse("first_owner_state_refused");
}

/** Read the existing retry state; installed composition requires ownerUid 0.
 * Filesystem overrides are for non-root lane fixtures only. */
export async function readFirstOwnerStateV1(root, overrides = {}) {
  if (!safeRoot(root)) refuse("first_owner_input_refused");
  const runtime = stateRuntime(overrides), directory = join(root, "updater-state");
  const check = await directoryCustodyV1(directory).catch(() => refuse("first_owner_state_refused"));
  await requireStateDirectory(directory, runtime);
  await check().catch(() => refuse("first_owner_state_refused"));
  const value = await readStateFile(join(directory, "first-owner.json"), runtime);
  await check().catch(() => refuse("first_owner_state_refused"));
  return value;
}

async function readStateFile(path, runtime) {
  const before = await runtime.lstat(path).catch(() => refuse("first_owner_state_refused"));
  const handle = await runtime.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    .catch(() => refuse("first_owner_state_refused"));
  try {
    const stat = await handle.stat();
    if (!sameFileV1(before, stat) || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size > 4096
      || stat.uid !== runtime.ownerUid) refuse("first_owner_state_refused");
    let value;
    try {
      const bytes = await handle.readFile();
      if (bytes.length !== stat.size || !sameFileV1(before, await handle.stat())
        || !sameFileV1(before, await runtime.lstat(path))) refuse("first_owner_state_refused");
      value = parseStrictJsonV1(bytes.toString("utf8"));
    } catch { refuse("first_owner_state_refused"); }
    if (!exactKeys(value, ["schema", "createdAt", "reviewKey"]) || value.schema !== FIRST_OWNER_STATE_V1
      || typeof value.createdAt !== "string" || !ISO.test(value.createdAt)
      || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt
      || typeof value.reviewKey !== "string" || !KEY.test(value.reviewKey)
      || Buffer.from(value.reviewKey, "base64url").toString("base64url") !== value.reviewKey) {
      refuse("first_owner_state_refused");
    }
    return Object.freeze({ createdAt: value.createdAt, reviewKey: value.reviewKey });
  } finally { await handle.close(); }
}

/**
 * A TRUE first run is a root whose installed composition has not taken the review key
 * yet: `<root>/Protected/config/task-runtime.json` is absent.
 *
 * On an installed Mac that file ADOPTS first-owner's `reviewKey`
 * (`src/web/v1/mac-local-task-runtime.ts:116-121`), and `verifyStoredReviewKey()`
 * refuses the install on every later run once the two disagree. So the zero-byte
 * recovery below must be reachable ONLY before that adoption: recovering it later
 * would mint a new review key and permanently strand every stored plan, run and
 * result on that Mac.
 *
 * A root with no `Protected` directory at all (the fixture and lane shapes the F12
 * recovery was written for) is still a true first run: nothing has adopted anything.
 */
async function isTrueFirstRunV1(root, runtime) {
  try {
    // Present in any form — file, directory, symlink, even a broken one — means
    // something is there, so this is NOT a first run. An unreadable shape is a
    // refusal below, never treated as absent.
    await runtime.lstat(join(root, "Protected", "config", "task-runtime.json"));
    return false;
  } catch (error) {
    // ENOENT is the ordinary first-run answer, including "no Protected directory".
    if (error?.code === "ENOENT") return true;
    return refuse("first_owner_state_refused");
  }
}

/**
 * The once-written retry state: `createdAt` and the review key. Written whole to a
 * private temporary and LINKED into place (EEXIST-exclusive), so two runs never mint
 * two keys and a stop part-way never leaves a torn file (atk-fa F12); an existing
 * file is validated and reused, never overwritten, and anything odd about it is a
 * refusal rather than a regeneration. The one exception is a zero-byte file, the
 * shape an older O_EXCL-then-write left after a kill: it never held a key, so
 * replacing it cannot mint a second one — but only while nothing has adopted that
 * key yet (see `isTrueFirstRunV1`).
 */
export async function ensureFirstOwnerStateV1(root, runtime = {}) {
  if (!safeRoot(root)) refuse("first_owner_input_refused");
  const directory = join(root, "updater-state");
  const path = join(directory, "first-owner.json");
  await mkdir(directory, { recursive: true, mode: 0o700 }).catch(() => refuse("first_owner_state_refused"));
  await requireStateDirectory(directory, stateRuntime());
  const createdAt = runtime.now?.() ?? new Date().toISOString();
  const key = (runtime.randomBytes ?? randomBytes)(32);
  if (!Buffer.isBuffer(key) || key.byteLength !== 32 || typeof createdAt !== "string" || !ISO.test(createdAt)) {
    refuse("first_owner_state_refused");
  }
  const bytes = Buffer.from(`${JSON.stringify({ schema: FIRST_OWNER_STATE_V1, createdAt,
    reviewKey: key.toString("base64url") })}\n`);
  // Publish only complete, synced bytes. A killed writer can leave a private
  // temporary, but never a torn first-owner authority. Existing state is sacred.
  // The one exception is a zero-byte file, the shape an older O_EXCL-then-write left
  // after a kill (atk-fa F12): it never held a key, so replacing it cannot mint a
  // second one — while the install has not yet adopted that key. After adoption a
  // zero-byte file is damaged authority: replacing it would rotate the review key
  // this Mac's task runtime already adopted and strand the install permanently.
  const existing = await lstat(path).catch(error => error?.code === "ENOENT" ? null : refuse("first_owner_state_refused"));
  if (existing) {
    const owner = stateRuntime();
    if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== 0 || existing.nlink !== 1
      || (existing.mode & 0o7777) !== 0o600 || existing.uid !== owner.ownerUid) return readPublishedState(root, directory, path);
    if (!await isTrueFirstRunV1(root, owner)) return readPublishedState(root, directory, path);
    await unlink(path).catch(() => refuse("first_owner_state_refused"));
  }
  const temporary = join(directory, `.first-owner-${randomBytes(16).toString("hex")}.tmp`);
  let handle, owned;
  try {
    const check = await directoryCustodyV1(directory);
    handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    owned = await handle.stat();
    await handle.writeFile(bytes); await handle.chmod(0o600); await handle.sync();
    await check();
    try { await link(temporary, path); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    // Remove our second hard link before any reader checks the single-link rule.
    await removeOwnedFileV1(temporary, owned);
    const directoryHandle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch { refuse("first_owner_state_refused"); }
  finally {
    await handle?.close();
    if (owned) await removeOwnedFileV1(temporary, owned);
  }
  return readPublishedState(root, directory, path);
}
