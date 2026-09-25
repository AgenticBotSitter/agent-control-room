import { randomBytes } from "node:crypto";
import { link, lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export const MAC_LOCAL_TASK_RUNTIME_V1 = "control-room.mac-local-task-runtime/v1" as const;

/** One 32-byte key per role. A role key may feed several existing components
 * (the review key is the planner's review key, the quality key and the website
 * review key, which startup requires to be equal), but no two roles share a key. */
export const MAC_LOCAL_TASK_RUNTIME_KEY_ROLES_V1 = Object.freeze([
  "planning", "review", "harness", "results", "approvals", "deliveryReceipt",
] as const);
type KeyRole = typeof MAC_LOCAL_TASK_RUNTIME_KEY_ROLES_V1[number];

export type MacLocalHermesRunSettingsV1 = Readonly<{ profile: string; provider: string; model: string }>;

/** Owner-only, data-only runtime material for the mac-local task provider
 * (docs/claude/MAC_LOCAL_TASK_RUNTIME_TRUST_DECISION.md section 3). It never
 * comes from the browser, a task, or an environment variable. */
export type MacLocalTaskRuntimeV1 = Readonly<{
  schema: typeof MAC_LOCAL_TASK_RUNTIME_V1;
  keys: Readonly<Record<KeyRole, Uint8Array>>;
  hermes: MacLocalHermesRunSettingsV1;
}>;

const invalid = (): never => { throw new Error("mac_local_task_runtime_invalid"); };
const identifier = /^[A-Za-z0-9._:/-]{1,180}$/u;
const base64url = /^[A-Za-z0-9_-]{43}$/u;
const MAX_FILE_BYTES = 16 * 1024;

function exactKeys(value: unknown, names: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const record = value as Record<string, unknown>, keys = Object.keys(record);
  if (keys.length !== names.length || names.some(name => !Object.hasOwn(record, name))) invalid();
  return record;
}

function decodeKey(value: unknown): Uint8Array {
  if (typeof value !== "string" || !base64url.test(value)) invalid();
  const bytes = Buffer.from(value as string, "base64url");
  // Only the one canonical encoding of exactly 32 bytes is accepted.
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) invalid();
  return Uint8Array.from(bytes);
}

function hermesSettings(value: unknown): MacLocalHermesRunSettingsV1 {
  const record = exactKeys(value, ["profile", "provider", "model"]);
  if (![record.profile, record.provider, record.model].every(item => typeof item === "string" && identifier.test(item))) invalid();
  return Object.freeze({ profile: record.profile as string, provider: record.provider as string, model: record.model as string });
}

/** Validates parsed file content. Refuses unknown or missing fields, a
 * non-canonical or wrong-length key, and any two roles sharing a key. */
export function captureMacLocalTaskRuntimeV1(value: unknown): MacLocalTaskRuntimeV1 {
  const record = exactKeys(value, ["schema", "keys", "hermes"]);
  if (record.schema !== MAC_LOCAL_TASK_RUNTIME_V1) invalid();
  const encoded = exactKeys(record.keys, MAC_LOCAL_TASK_RUNTIME_KEY_ROLES_V1);
  const keys = Object.fromEntries(MAC_LOCAL_TASK_RUNTIME_KEY_ROLES_V1.map(role => [role, decodeKey(encoded[role])])) as Record<KeyRole, Uint8Array>;
  if (new Set(MAC_LOCAL_TASK_RUNTIME_KEY_ROLES_V1.map(role => encoded[role])).size !== MAC_LOCAL_TASK_RUNTIME_KEY_ROLES_V1.length) invalid();
  return Object.freeze({ schema: MAC_LOCAL_TASK_RUNTIME_V1, keys: Object.freeze(keys), hermes: hermesSettings(record.hermes) });
}

type Runtime = Readonly<{
  lstat: typeof lstat; readFile: typeof readFile; writeFile: typeof writeFile; link: typeof link; unlink: typeof unlink;
  randomBytes: (size: number) => Uint8Array; pid: number;
}>;
const production: Runtime = Object.freeze({ lstat, readFile, writeFile, link, unlink, randomBytes, pid: process.pid });

function runtimePath(protectedRoot: string) {
  if (typeof protectedRoot !== "string" || !isAbsolute(protectedRoot) || resolve(protectedRoot) !== protectedRoot) invalid();
  return { config: join(protectedRoot, "config"), file: join(protectedRoot, "config", "task-runtime.json") };
}

async function requirePrivateDirectories(runtime: Runtime, protectedRoot: string, config: string) {
  for (const directory of [protectedRoot, config]) {
    const entry = await runtime.lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0) invalid();
  }
}

/** Reads `<protected>/config/task-runtime.json`. The file must be a private
 * (no group or other access) regular file, not a symlink, below private
 * directories. Content never appears in an error. */
export async function loadMacLocalTaskRuntimeFromRootV1(protectedRoot: string, runtime: Runtime = production): Promise<MacLocalTaskRuntimeV1> {
  const { config, file } = runtimePath(protectedRoot);
  try {
    await requirePrivateDirectories(runtime, protectedRoot, config);
    const entry = await runtime.lstat(file);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0 || entry.size > MAX_FILE_BYTES) invalid();
    return captureMacLocalTaskRuntimeV1(JSON.parse(await runtime.readFile(file, "utf8")));
  } catch { return invalid(); }
}

/** Creates the file once with fresh keys. An existing file is validated and
 * kept, never regenerated or overwritten: rotating these keys would orphan
 * every stored plan, run and result. An existing invalid file is refused. */
export async function createMacLocalTaskRuntimeFileV1(protectedRoot: string, hermes: MacLocalHermesRunSettingsV1,
  runtime: Runtime = production): Promise<"created" | "existing"> {
  const { config, file } = runtimePath(protectedRoot);
  const settings = hermesSettings(hermes);
  await requirePrivateDirectories(runtime, protectedRoot, config).catch(invalid);
  try { await runtime.lstat(file); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") invalid();
    const keys = Object.fromEntries(MAC_LOCAL_TASK_RUNTIME_KEY_ROLES_V1.map(role => [role,
      Buffer.from(runtime.randomBytes(32)).toString("base64url")]));
    const body = { schema: MAC_LOCAL_TASK_RUNTIME_V1, keys, hermes: settings };
    captureMacLocalTaskRuntimeV1(body);
    const temporary = `${file}.new-${runtime.pid}-${Buffer.from(runtime.randomBytes(8)).toString("hex")}`;
    await runtime.writeFile(temporary, `${JSON.stringify(body)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      // link() refuses an existing target, so a concurrent creator can never be overwritten.
      await runtime.link(temporary, file);
    } catch (linkError) {
      if ((linkError as NodeJS.ErrnoException)?.code !== "EEXIST") throw linkError;
    } finally { await runtime.unlink(temporary).catch(() => {}); }
    await loadMacLocalTaskRuntimeFromRootV1(protectedRoot, runtime);
    return "created";
  }
  await loadMacLocalTaskRuntimeFromRootV1(protectedRoot, runtime);
  return "existing";
}
